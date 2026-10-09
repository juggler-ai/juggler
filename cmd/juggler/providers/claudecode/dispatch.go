//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Per-regime dispatch functions invoked from StreamMessage, plus the
// shared finalizeTurn bookkeeping that every regime ends in. The regime
// decision itself lives in regime.go; the stream-parser state machine in
// parser.go.

package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// Activity descriptions surfaced on the UI spinner during the otherwise-silent
// window between starting a turn and the model's first streamed token. Cold
// starts spend that window spawning the CLI, loading a synthetic-resume session,
// and running the MCP handshake — minutes, sometimes — with nothing else to show.
const (
	activityStarting          = "Starting Claude Code"
	activityReconnecting      = "Reconnecting Claude Code"
	activityProcessingHistory = "Processing conversation history"
	activityWaiting           = "Waiting for response"
	activityGenerating        = "Generating response"
)

// emitActivity forwards a transient, replaceable description to the UI spinner.
// This is the cold-start feedback path: before the first token nothing else
// streams, so without these the spinner sits on a static "Receiving..." for the
// whole wait and looks jammed. Best-effort — a dropped description (e.g. a
// cancelled callback) never affects turn correctness, and activity snapshots are
// not counted as streamed content so they never block a retry.
func emitActivity(callback provider.StructuredStreamCallback, msg string) {
	if callback == nil {
		return
	}
	_, _ = callback(provider.StreamChunk{Type: provider.ContentBlockTypeActivity, Content: msg})
}

// startFreshSession spawns a new CLI invocation in streaming-input mode
// (`--input-format stream-json`). We always use streaming input — never
// `-p <inline-JSON>` — because the stdio control protocol requires the
// CLI to be reading stdin.
//
// When the conversation has prior turns, we synthesise a JSONL session
// file (see synthetic_resume.go) and spawn with `--resume <uuid>` so the
// CLI loads the assistant history as its own. Without this the stream-json
// parser silently drops assistant blocks and Claude is trained to reject
// fed assistant content as injected — leaving the model amnesiac about
// its own prior tool_use calls. With no prior history we just spawn fresh
// and let the CLI mint a session_id we'll capture from system/init.
func (c *Client) startFreshSession(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("════════════════════════════════════════════════════════════════")
	jlog.Debug("=== CLAUDECODE FRESH SESSION (--input-format stream-json) ===")

	// Cold start: the CLI must spawn and load the (synthetic) session before
	// it emits anything. Surface that immediately so the spinner reflects the
	// real activity; the parser flips it to activityWaiting on system/init.
	emitActivity(callback, activityStarting)

	args := []string{"-p", "--input-format", "stream-json"}
	args = append(args, c.commonArgs(req.SystemPrompt)...)

	plan := planSyntheticSession(req.Messages, jugglerToolNameSet(req.Tools))
	if plan != nil {
		// Cold start carrying prior history: the slow segment is the API
		// re-ingesting the whole conversation (a guaranteed cache miss). Label
		// the post-boot wait so it reads as expensive-but-working rather than
		// jammed. A true first turn (plan == nil) keeps the generic activityWaiting.
		c.turnWaitingDescription = activityProcessingHistory
		path, err := writeSyntheticSession(c.workingDir, plan)
		if err != nil {
			jlog.Debug("synthetic resume: write failed (%v) — falling back to history-less cold start", err)
			plan = nil
			c.turnWaitingDescription = activityWaiting
		} else {
			jlog.Debug("synthetic resume: wrote %s (%d entries) — spawning with --resume %s",
				path, len(plan.historyToFile), plan.sessionUUID)
			args = append(args, "--resume", plan.sessionUUID)
		}
	}

	if err := c.spawnCLIPipes(args); err != nil {
		return nil, err
	}

	// Every failure from here on goes through finalizeTurn: a process exists,
	// so it has to be reaped and its exit status read, and the worker needs the
	// error carried on a StreamResult like any other failed turn.

	// Wire the stdio control protocol so the CLI can call back into our
	// in-process MCP server for tool execution.
	if err := c.attachControlProtocol(req.Tools); err != nil {
		return c.finalizeTurn(req, nil, c.cliBootError("attach control protocol", err))
	}

	if plan != nil {
		// Synthetic-resume path: file holds the history, only the tail user
		// turn goes on stdin.
		if err := c.writeStdinDelta(append(tailStdinLine(plan), '\n')); err != nil {
			return c.finalizeTurn(req, nil, c.cliBootError("write fresh-session tail message", err))
		}
	} else {
		// No plan: pipe whatever user-role messages the worker built.
		// formatMessagesAsStreamJSONLines drops assistant turns, so this is
		// lossless ONLY for a true first turn. Reaching it with assistant
		// history means every assistant turn and tool_use block is about to
		// be discarded, leaving the surviving tool_results orphaned and the
		// model amnesiac about its own tool calls — name it in the log rather
		// than let a context wipe pass silently.
		if hasAssistantHistory(req.Messages) {
			jlog.Info("⚠ claudecode: no synthetic plan for %d messages — discarding assistant history and every tool_use block",
				len(req.Messages))
		}
		lines, err := c.formatMessagesAsStreamJSONLines(req.Messages, "")
		if err != nil {
			return c.finalizeTurn(req, nil, fmt.Errorf("format stream-json messages: %w", err))
		}
		if len(lines) == 0 {
			return c.finalizeTurn(req, nil, fmt.Errorf("no user-role messages to send in fresh session"))
		}
		if err := c.writeStdinDelta([]byte(strings.Join(lines, "\n") + "\n")); err != nil {
			return c.finalizeTurn(req, nil, c.cliBootError("write fresh-session user messages", err))
		}
	}
	c.recordConsumedRequest(req)

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// cliBootError names a failure to hand a freshly spawned CLI its opening
// stdin traffic.
//
// A write to that stdin fails only when the pipe has broken, which means the
// CLI is no longer reading it — it died between the spawn and the first byte,
// on a crash at boot, an auth failure, a quota kill. That is the same event
// the parser reports when a CLI dies mid-turn, and it is reported the same
// way: as a transient exit, so the bounded retry re-spawns rather than the
// turn ending on a raw "broken pipe" the retry doesn't recognise. The CLI
// writes its reason for dying on stderr, so that goes in the message — it is
// the only account of the failure anyone gets.
//
// Anything else (a tool set that won't marshal, messages that won't
// serialise) is juggler's own fault, not the CLI's, and is returned as-is
// under `what` so the site is named.
func (c *Client) cliBootError(what string, err error) error {
	var we *stdinWriteError
	if !errors.As(err, &we) {
		return fmt.Errorf("%s: %w", what, err)
	}
	msg := "claude CLI exited unexpectedly before the turn was sent"
	if c.activeSession != nil {
		if stderr := strings.TrimSpace(c.activeSession.drainStderr()); stderr != "" {
			msg += ": " + stderr
		}
	}
	return &transientCLIError{msg: msg, processExited: true}
}

// attachControlProtocol constructs a controlProtocol bound to the active
// session's stdin and wires it to deliver the given tool list on
// tools/list. Fires the SDK→CLI initialize handshake. Caller is
// responsible for the session's existing setup; this only attaches the
// control layer.
func (c *Client) attachControlProtocol(tools []provider.ToolDefinition) error {
	if c.activeSession == nil || c.activeSession.live == nil || c.activeSession.live.stdin == nil {
		return fmt.Errorf("control protocol: no stdin on active session")
	}
	cp := newControlProtocol(c.activeSession.live.stdin)
	// Marshal tools once; cp.tools is invoked each time the CLI sends
	// tools/list. The list is stable per-session so we memoise.
	marshalled, err := toolDefsToMCPList(tools)
	if err != nil {
		return fmt.Errorf("marshal tools: %w", err)
	}
	// The tool count is the one number that distinguishes "the model chose not
	// to call anything" from "the model had nothing to call". Without it, an
	// empty tool set presents as the model narrating tool calls in prose, which
	// reads as a model fault and sends the search nowhere near the tool set.
	if len(marshalled) != len(tools) {
		jlog.Info("[claudecode] serving %d of %d tools on tools/list — %d withheld as malformed",
			len(marshalled), len(tools), len(tools)-len(marshalled))
	} else {
		jlog.Debug("[claudecode] serving %d tools on tools/list", len(marshalled))
	}
	cp.tools = func() ([]json.RawMessage, error) { return marshalled, nil }
	c.activeSession.live.control = cp
	// Record the tool-set fingerprint this CLI is being spawned with. The CLI
	// answers tools/list once and freezes it, so dispatchTurn compares a later
	// turn's req.Tools against this to decide whether a respawn is needed to
	// surface newly-discovered (or removed) MCP tools. See hashToolNames.
	c.activeSession.live.toolSig = hashToolNames(tools)
	// Launch the continuous stdout reader now that the control protocol is
	// attached: it demuxes control frames to the actor and forwards content
	// to s.content. Started before sendInitialize so the CLI's initialize
	// control_response is routed by the reader rather than lost.
	startStreamReader(c.activeSession)
	return cp.sendInitialize()
}

// runPersistentResumeTurn handles a juggler turn against a persistent
// `claude --resume <uuid> --input-format stream-json` process. If no live CLI
// is attached to the session, it spawns one. Delta messages are written to
// the still-open stdin; we never close stdin or the process at end_turn.
//
// On stdin write failure (process died between turns), we kill, respawn once,
// and retry. If that also fails, we drop the session and fall through to a
// fresh -p invocation.
func (c *Client) runPersistentResumeTurn(ctx context.Context, req provider.MessageRequest, deltaStart, deltaEnd int, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	delta := req.Messages[deltaStart:deltaEnd]
	deltaLines, err := c.formatMessagesAsStreamJSONLines(delta, c.activeSession.sessionUUID)
	if err != nil {
		return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("delta-unserializable: %v", err))
	}
	if len(deltaLines) == 0 {
		// The delta serialised to nothing, which means it carries no user-role
		// content: it is entirely assistant turns the CLI itself generated
		// (a regenerate re-sends the previous reply). Those are already in the
		// CLI's own --resume session — that is precisely why
		// formatMessagesAsStreamJSONLines drops assistant content in the
		// non-empty case too, so this is the same invariant applied to a delta
		// that happens to be all assistant. Nothing is missing from the CLI's
		// context and there is nothing to rebuild; cold-starting would
		// re-ingest the entire conversation to say something the session
		// already knows. Nudge the warm session to generate instead.
		//
		// The CLI's session file is the authority for its own output: if a
		// turn was killed mid-stream before the CLI flushed it, that fragment
		// is absent there and the model continues without it. Committed
		// history is unaffected, and every route by which non-CLI assistant
		// content could enter the delta (compaction, an in-place edit, a model
		// change) diverges the prefix and cold-starts before reaching here.
		jlog.Debug("Delta is assistant-only (%d msgs, already in the CLI's session) — nudging warm session", len(delta))
		return c.runResumeNudge(ctx, req, callback, true)
	}

	stdinPayload := []byte(strings.Join(deltaLines, "\n") + "\n")

	// Spinner feedback for the pre-first-token wait. A live CLI goes straight
	// to waiting on the model; a cold session must respawn first (and the
	// respawn's system/init will itself flip the spinner to activityWaiting).
	if c.activeSession.hasLiveCLI() {
		emitActivity(callback, activityWaiting)
	} else {
		emitActivity(callback, activityReconnecting)
	}

	// Ensure the persistent CLI is alive. ensurePersistentCLI is a no-op if it
	// already is.
	if err := c.ensurePersistentCLI(req); err != nil {
		return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("resume-spawn-failed: %v", err))
	}

	if err := c.writeStdinDelta(stdinPayload); err != nil {
		// Stdin write failure ≈ process is dead. Recycle and retry once.
		jlog.Debug("stdin write failed (%v) — respawning persistent CLI and retrying", err)
		c.activeSession.tearDownLiveCLI()
		if err := c.ensurePersistentCLI(req); err != nil {
			return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("resume-respawn-failed: %v", err))
		}
		if err := c.writeStdinDelta(stdinPayload); err != nil {
			return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("resume-stdin-failed: %v", err))
		}
	}
	c.recordConsumedRequest(req)

	jlog.Debug("=== CLAUDECODE RESUME TURN (uuid=%s, %d delta lines) ===",
		c.activeSession.sessionUUID, len(deltaLines))

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// runResumeNudge pipes a synthetic user message (continuationNudge) into the
// live --resume session when the worker has nothing new to send (typically:
// previous turn returned only thinking, or the user clicked Continue with no
// edits). The nudge is intentionally NOT added to req.Messages and does not
// advance heldCount or the decision prefix; the CLI's own --resume history
// silently absorbs the extra round-trip on its end. Cache stays warm.
//
// Falls back to a fresh start on any spawn/stdin failure — same shape as
// runPersistentResumeTurn's error handling.
func continuationNudgeForRequest(req provider.MessageRequest) string {
	if req.ExplicitContinuation {
		return explicitContinuationNudge
	}
	return continuationNudge
}

func (c *Client) runResumeNudge(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback, claimsRequest bool) (*provider.StreamResult, error) {
	nudge := []provider.Message{{Type: "user", Content: continuationNudgeForRequest(req)}}
	nudgeLines, err := c.formatMessagesAsStreamJSONLines(nudge, c.activeSession.sessionUUID)
	if err != nil || len(nudgeLines) == 0 {
		return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("nudge-unserializable: %v", err))
	}
	payload := []byte(strings.Join(nudgeLines, "\n") + "\n")

	// Spinner feedback for the pre-first-token wait (see runPersistentResumeTurn).
	if c.activeSession.hasLiveCLI() {
		emitActivity(callback, activityWaiting)
	} else {
		emitActivity(callback, activityReconnecting)
	}

	if err := c.ensurePersistentCLI(req); err != nil {
		return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("nudge-spawn-failed: %v", err))
	}
	if err := c.writeStdinDelta(payload); err != nil {
		c.activeSession.tearDownLiveCLI()
		if err := c.ensurePersistentCLI(req); err != nil {
			return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("nudge-respawn-failed: %v", err))
		}
		if err := c.writeStdinDelta(payload); err != nil {
			return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("nudge-stdin-failed: %v", err))
		}
	}
	if claimsRequest {
		// Assistant messages are part of Juggler's projection even though resumed
		// stdin formatting drops their content: the CLI generated and retained them.
		c.recordConsumedRequest(req)
	}

	jlog.Debug("=== CLAUDECODE NUDGE TURN (uuid=%s) === (no-new-msgs; piped continuationNudge)",
		c.activeSession.sessionUUID)

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// continueSession feeds tool results to the existing live CLI and continues
// reading the same LLM turn. No new CLI is spawned. Threading the full
// MessageRequest through (rather than just ConversationID + Messages) is
// load-bearing for resume bookkeeping: finalizeTurn captures the system
// prompt in the prefix hash on success, so the next turn won't be flagged as
// diverged when the prompt is unchanged.
func (c *Client) continueSession(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("=== CLAUDECODE CONTINUE SESSION (mid-turn tool result feed) ===")

	if c.activeSession.live == nil || c.activeSession.live.control == nil {
		return nil, fmt.Errorf("continueSession: no control protocol attached")
	}

	toolResults := c.extractToolResults(req.Messages)
	jlog.Debug("Feeding %d tool results via stdio control protocol", len(toolResults))
	for _, result := range toolResults {
		// The worker feeds results in pendingTools order, and the CLI parks
		// tools/call in that same order, so each result answers the FRONT of
		// the control protocol's unanswered queue. We still resolve the meta to
		// (a) discard a result whose id isn't in this turn's pendingTools and
		// (b) supply the recorded key for the divergence diagnostic.
		var meta pendingToolMeta
		for i := range c.activeSession.pendingTools {
			if c.activeSession.pendingTools[i].ID == result.ToolUseID {
				meta = c.activeSession.pendingTools[i]
				break
			}
		}
		if meta.ID == "" {
			jlog.Debug("No pending-tool meta for %s; result will be discarded", result.ToolUseID)
			continue
		}
		// Idempotent delivery backstop: each tool_use_id is answered exactly once, so
		// a second feed of an already-fed id is a duplicate re-feed — dropped, loudly,
		// before it can become a stash orphan. With the resultFedTurn cure in place no
		// re-feed reaches here in a reachable flow; see doc.go's "Tool-delivery desync".
		if c.activeSession.fedResultIDs[result.ToolUseID] {
			jlog.Error("claudecode: refusing to re-feed tool result for %s (already delivered this turn) — worker/engine re-emitted a duplicate result; dropping to prevent a stash orphan (delivery-desync genesis)", result.ToolUseID)
			continue
		}
		if _, err := c.activeSession.live.control.deliverNextToolResult(makeMCPMatchKey(meta.Name, meta.Args), result); err != nil {
			return nil, fmt.Errorf("deliver tool-result for %s: %w", result.ToolUseID, err)
		}
		if c.activeSession.fedResultIDs == nil {
			c.activeSession.fedResultIDs = make(map[string]bool)
		}
		c.activeSession.fedResultIDs[result.ToolUseID] = true
	}
	c.recordConsumedRequest(req)

	// Tool results are fed; the model now resumes the paused turn. Surface the
	// wait so the spinner isn't a static "Receiving..." while it thinks.
	emitActivity(callback, activityWaiting)

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// extractToolResults extracts tool results from messages for sending to MCP.
// Results are returned in pendingTools order, which matches the order the
// CLI will issue tools/call requests. Message-array order can differ (e.g.
// the user approved Tool B before Tool A), which would pair wrong results
// with wrong tool calls if we iterated by message position instead.
func (c *Client) extractToolResults(messages []provider.Message) []*provider.ToolResult {
	resultByID := make(map[string]*provider.ToolResult)
	for _, msg := range messages {
		if msg.Type == "tool-result" {
			status := provider.ResultStatusSuccess
			if msg.IsError {
				status = provider.ResultStatusError
			}
			resultByID[msg.ToolUseID] = &provider.ToolResult{
				ToolUseID:    msg.ToolUseID,
				Content:      msg.Content,
				ResultStatus: status,
				Parts:        msg.Parts,
			}
		}
	}

	var results []*provider.ToolResult
	for _, t := range c.activeSession.pendingTools {
		if r, ok := resultByID[t.ID]; ok {
			results = append(results, r)
		}
	}
	return results
}

func (s *activeSession) captureSentPrefix(systemPrompt string, messages []provider.Message) {
	stable := stablePrefixCount(messages)
	s.heldCount = len(messages)
	s.sentCount = stable
	s.sentHash = hashRequestPrefix(systemPrompt, messages, stable)
	s.sentSystemHash = hashSystemPrompt(systemPrompt)
	s.sentMsgHashes = hashMessages(messages, stable)
}

// recordConsumedRequest advances Juggler's projection immediately after the CLI
// accepts a complete request write. heldCount guards rollback across everything
// consumed; sentCount and the element hashes retain the stable-prefix decision
// boundary so volatile trailing context can be replaced on the next turn.
func (c *Client) recordConsumedRequest(req provider.MessageRequest) {
	if c.activeSession == nil {
		return
	}
	c.activeSession.captureSentPrefix(req.SystemPrompt, req.Messages)
	if c.activeSession.sessionUUID != "" {
		c.saveSidecar(req.ConversationID, c.activeSession)
	}
}

// finalizeTurn handles response bookkeeping common to fresh and resume turns:
// error cleanup, session-uuid capture, usage metadata, and sidecar persistence.
//
// Provider-boundary normalisation: the claude CLI reports input_tokens as
// the *fresh-only* portion of the prompt (everything that wasn't a cache
// hit or cache write). For the rest of juggler — UI cache display,
// transaction blob accounting, cost-tracking — we want the consistent
// "total prompt tokens sent" semantic that openai/gemini providers
// already produce. So we sum fresh + cache_read + cache_creation here
// and report that as StreamResult.InputTokens. CachedTokens stays the
// cache-read subset; CacheWriteTokens stays the cache-creation subset.
func (c *Client) finalizeTurn(req provider.MessageRequest, turn *turnResult, err error) (*provider.StreamResult, error) {
	if turn != nil && turn.SessionID != "" && c.activeSession != nil && c.activeSession.sessionUUID == "" {
		c.activeSession.sessionUUID = turn.SessionID
		c.saveSidecar(req.ConversationID, c.activeSession)
	}
	if err != nil {
		// The write-time projection already records the consumed request for every
		// error shape. Tear down the process, preserve that sidecar, and surface
		// whatever usage arrived before the failure.
		var inTok, outTok int
		var cacheR, cacheW *int
		if turn != nil {
			inTok, outTok = turn.InputTokens+turn.CacheReadTokens+turn.CacheWriteTokens, turn.OutputTokens
			cacheR, cacheW = provider.Reported(turn.CacheReadTokens), provider.Reported(turn.CacheWriteTokens)
		}
		// releaseSession's contract (kill the live CLI, KEEP the anchor so a
		// retry --resumes warm), inlined so we can read the reaped process's
		// exit status in between and enrich an unexpected-exit error with it
		// before the handle is dropped.
		//
		// Where that anchor lives decides whether the handle may go. The root
		// thread's is on disk, so dropping the handle costs nothing: the next turn
		// loads the sidecar and resumes by uuid. A SUB-THREAD has no sidecar at all
		// — its session is in-memory by design (see loadSidecar/saveSidecar) — so
		// the handle IS the anchor, and dropping it turns every hard error into a
		// full cold start of a session that was only ever one process away. Keep it
		// and let the next turn resume: the CLI is dead either way, which is all the
		// error required, and classifyRegime reads hasLiveCLI() rather than the
		// handle to decide how to restart.
		c.activeSession.tearDownLiveCLI()
		if c.activeSession != nil {
			err = annotateExit(err, c.activeSession.exitDiag)
		}
		// Output abandoned as unusable is the exception, for sub-threads too: the
		// CLI's transcript holds the calls it rejected, which juggler's history
		// never saw, and resuming it would hand them straight back to the model
		// the worker is about to re-ask. The retry starts clean instead.
		var unusable *provider.UnusableOutputError
		if errors.As(err, &unusable) {
			c.dropSession(req.ConversationID)
		} else if c.threadID == "" {
			c.activeSession = nil
		}
		return &provider.StreamResult{
			StopReason:       provider.StopReasonError,
			InputTokens:      inTok,
			OutputTokens:     outTok,
			CachedTokens:     cacheR,
			CacheWriteTokens: cacheW,
		}, err
	}

	// Refresh lastUsedAt so the sweeper sees recent activity even on
	// freshly-spawned sessions that hadn't been touched at StreamMessage entry.
	c.activeSession.lastUsedAt = time.Now()

	if turn.StopReason == provider.StopReasonToolUse {
		// Mid-LLM-turn pause. It reports its usage exactly as the end_turn arm
		// below does, because it is a round-trip like any other: the prompt it
		// sent is fresh + cache read + cache write, cache read / cache write are
		// the subsets of that, and the output is what it generated.
		//
		// Every consumer of these numbers describes ONE round-trip — the
		// transaction blob behind the footer pill, the admission anchor, the
		// [turn tokens] line — and none of them sums InputTokens across the
		// round-trips of a turn, so a per-pause count inflates nothing. The
		// cumulative blow-up that once made a turn read 40× its window came from
		// the result envelope's session-wide totals, and turnResult.usageFromStream
		// is what holds those back.
		//
		// Reporting less than the call sent is not the safe side of that: a
		// paused round-trip is where an agentic turn comes to rest, so it is the
		// blob the footer anchors on, and a pill that states the cache-creation
		// delta as the context size understates a quarter-million-token prompt as
		// a few thousand.
		var pending []pendingToolMeta
		for _, block := range turn.Blocks {
			if block.Type != provider.ContentBlockTypeToolUse {
				continue
			}
			// Canonicalize args by marshaling block.ToolInput (a Go map);
			// Go's json.Marshal sorts map keys recursively, giving the
			// MCP router a stable key for matching against the CLI's
			// tools/call payload (which goes through the same Marshal path).
			argsJSON, err := json.Marshal(block.ToolInput)
			if err != nil {
				argsJSON = []byte("{}")
			}
			pending = append(pending, pendingToolMeta{
				ID:   block.ToolUseID,
				Name: block.ToolName,
				Args: argsJSON,
			})
		}
		if len(pending) == 0 {
			// Defensive: a tool_use stop that parked nothing. The parser
			// suppresses this pause and reads on for the CLI's recovery round,
			// so reaching here means the stop reason arrived by some other route
			// — and the round ran no tool while claiming to be waiting on one.
			//
			// It must surface as a turn failure. Reporting the bare tool_use stop
			// instead is indistinguishable from a finished turn to the worker: if
			// the round streamed any text at all the barren-turn retry doesn't
			// engage either, and the conversation simply stops — no tool, no
			// error, spinner to idle. Transient, so an attempt that streamed
			// nothing is retried silently and one that already streamed surfaces.
			// The anchor is no longer safe to resume, so the sidecar goes too.
			c.dropSession(req.ConversationID)
			return &provider.StreamResult{
				StopReason:       provider.StopReasonError,
				InputTokens:      turn.InputTokens + turn.CacheReadTokens + turn.CacheWriteTokens,
				OutputTokens:     turn.OutputTokens,
				CachedTokens:     provider.Reported(turn.CacheReadTokens),
				CacheWriteTokens: provider.Reported(turn.CacheWriteTokens),
			}, &transientCLIError{msg: "claude CLI stopped for tool_use but emitted no usable tool call"}
		}
		c.activeSession.pendingTools = pending
		// Clock start for the idle sweeper's parked ceiling: from here the CLI
		// is blocked on stdin, so its stillness is ours and not its own.
		c.activeSession.parkedAt = time.Now()
		// Stash the snapshot for diagnostic logging only — never returned.
		c.activeSession.inputTokens = turn.InputTokens
		c.activeSession.outputTokens = turn.OutputTokens
		c.activeSession.cacheReadTokens = turn.CacheReadTokens
		c.activeSession.cacheWriteTokens = turn.CacheWriteTokens
		c.activeSession.model = c.model
		c.activeSession.lastCacheRead = turn.CacheReadTokens
		c.activeSession.lastTurnAt = time.Now()
		if c.activeSession.sessionUUID != "" {
			c.saveSidecar(req.ConversationID, c.activeSession)
		}
		// The CLI is now blocked on stdin waiting for our control_response
		// for each pending tools/call. Stdio has no transport timeout, so
		// the CLI patiently waits for as long as the user takes to
		// approve. No watchdog needed: the only bound is the idle sweeper's
		// parked ceiling, which reclaims the subprocess of a park nobody ever
		// answers (see reapIdleCLI). Per-conv state lives on
		// c.activeSession (set in-place above) — no broadcast needed.
		jlog.Debug("Session paused: %d pending tool IDs (uuid=%s, in=%d out=%d cacheWrite=%d)",
			len(pending), c.activeSession.sessionUUID, turn.InputTokens, turn.OutputTokens, turn.CacheWriteTokens)
		// The whole prompt this call sent, with its cache subsets, and the output
		// it produced (see the note above). The output count is as final as the
		// input one: a pause is a completed API call whose message_delta carried
		// both, not a stream caught mid-flight. Withholding it would leave the
		// conversation's output total reading near zero, since an agentic turn
		// pauses at every tool batch and reaches end_turn once.
		return &provider.StreamResult{
			StopReason:       turn.StopReason,
			InputTokens:      turn.InputTokens + turn.CacheReadTokens + turn.CacheWriteTokens,
			OutputTokens:     turn.OutputTokens,
			CachedTokens:     provider.Reported(turn.CacheReadTokens),
			CacheWriteTokens: provider.Reported(turn.CacheWriteTokens),
		}, nil
	}

	// End of LLM turn. The CLI's stream events report CUMULATIVE usage for
	// the whole API call (input set once at message_start, output growing
	// monotonically), so turn.InputTokens etc. already hold the final
	// authoritative numbers. Normalise input to "total prompt tokens
	// sent" (fresh + cache read + cache write) for the rest of juggler;
	// keep `fresh` separate for the diagnostic hit-ratio log.
	stopReason := turn.StopReason
	fresh := turn.InputTokens
	cacheR := turn.CacheReadTokens
	cacheW := turn.CacheWriteTokens
	in := fresh + cacheR + cacheW
	out := turn.OutputTokens

	// Stream-json mode: CLI keeps idling on stdin for the next turn. Just
	// clear the per-turn scratch fields; the process, stdin, and scanner
	// channels stay alive.
	c.activeSession.pendingTools = nil
	c.activeSession.fedResultIDs = nil
	// The LLM turn is fully resolved, so anything still in the control
	// protocol's pairing buffers is an orphan from a tool desync this turn.
	// Clear it here (alongside pendingTools) so one desync can't poison the
	// rest of the warm session by leaving a stale result for a later same-tool
	// call to drain via the name fallback — see discardStaleBuffers.
	if c.activeSession.live != nil && c.activeSession.live.control != nil {
		if s, p := c.activeSession.live.control.discardStaleBuffers(); s > 0 || p > 0 {
			jlog.Error("claudecode turn boundary: discarded %d orphaned stashed result(s) + %d orphaned parked call(s) — a tool desync occurred this turn (results may have been mispaired); blast radius bounded to this turn (uuid=%s)",
				s, p, c.activeSession.sessionUUID)
		}
	}
	c.activeSession.inputTokens = 0
	c.activeSession.outputTokens = 0
	c.activeSession.cacheReadTokens = 0
	c.activeSession.cacheWriteTokens = 0
	c.activeSession.model = c.model
	c.activeSession.lastCacheRead = cacheR
	c.activeSession.lastTurnAt = time.Now()

	if c.activeSession.sessionUUID != "" {
		c.saveSidecar(req.ConversationID, c.activeSession)
		jlog.Debug("claudecode turn: conv=%s in=%d fresh=%d out=%d cacheRead=%d cacheWrite=%d hitRatio=%s msgsInReq=%d sentCount=%d uuid=%s blocks=%s stop=%s",
			shortID(req.ConversationID), in, fresh, out, cacheR, cacheW,
			cacheHitRatio(fresh, cacheR), len(req.Messages), c.activeSession.sentCount,
			shortID(c.activeSession.sessionUUID), blockHistogram(turn.Blocks), stopReason)
	} else {
		// No UUID captured — can't resume, drop entirely.
		jlog.Debug("No session_id captured from stream; dropping session")
		c.deleteSidecar(req.ConversationID)
		c.activeSession = nil
	}

	return &provider.StreamResult{
		StopReason:       stopReason,
		InputTokens:      in,
		OutputTokens:     out,
		CachedTokens:     provider.Reported(cacheR),
		CacheWriteTokens: provider.Reported(cacheW),
	}, nil
}
