//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Warm-append resume: deliver a parked tool_use's result by appending it into
// the CLI's OWN warm session file and re-resuming the same uuid, instead of
// cold-rebuilding the whole history under a fresh synthetic uuid.
//
// This is the warm path for a tool_result-bearing delta when the live CLI is
// gone — a user cancel that tore the parked CLI down then typed a new message,
// or the parked tool's answer arriving after a process restart. In both the
// resumed transcript ends on a dangling assistant tool_use the CLI would have
// answered over its (by-then-closed) control stream, so the result can NOT be
// piped on stdin (it has no open tools/call to bind to and is silently dropped —
// see deltaCarriesToolResult). Writing it into the session file is the only warm
// delivery: the unchanged prefix cache-hits and only the appended result plus
// the trailing user turn are fresh.

package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// runWarmAppendResume dispatches regimeResumeAppendResult. It tears down any
// live/parked CLI (so the warm session file isn't held open), appends the
// delta's leading tool_results into that file to close the dangling tool_use,
// then --resumes the same warm uuid and pipes the non-tool_result tail (the
// user's interjected message; a continuation nudge if the delta was results
// only) on stdin.
//
// Every uncertainty falls back to a full fresh synthetic resume (today's
// behaviour) — so warm-append is strictly an optimisation and never worse than
// the cold path it replaces: a missing/unreadable warm file, a tail entry that
// isn't the expected dangling tool_use, or any spawn/stdin failure all degrade
// to startFreshSession.
func (c *Client) runWarmAppendResume(ctx context.Context, req provider.MessageRequest, deltaStart, deltaEnd int, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	tailStart, ok := pairedResultResumeSplit(req.Messages, deltaStart, deltaEnd)
	if !ok {
		// Classification and dispatch disagree — should be unreachable. Be safe.
		return c.coldStartFallback(ctx, req, callback, "warm-append-split-lost")
	}

	// Snapshot the warm session file BEFORE the teardown below. A CLI parked on a
	// tools/call writes nothing until that call is answered, so what is on disk
	// now is the file's last good state. Appending to the snapshot rather than to
	// whatever the file has become by the time we read it means a dying CLI's
	// final writes can neither race us nor survive us.
	snapshot := c.snapshotWarmSession()

	// We are about to mutate the warm session file and re-resume it, so no live
	// CLI may be holding it. Tear down any parked/live process first (no-op if
	// none); the resume anchor (uuid/sentCount/sentHash + sidecar) survives.
	c.activeSession.tearDownLiveCLI()
	c.activeSession.pendingTools = nil

	pairedResults := req.Messages[deltaStart:tailStart]
	if err := c.appendToolResultsToWarmSession(pairedResults, snapshot); err != nil {
		return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("warm-append-failed: %v", err))
	}

	// Build the stdin tail: the non-tool_result delta (typically the user's
	// interjected message). When the delta was tool_results only (the parked
	// tool's answer with nothing newly typed), pipe the continuation nudge so
	// the model has a user turn to respond to — mirroring
	// moveTrailingToolResultsToHistory's empty-tail handling on the cold path.
	tail := req.Messages[tailStart:deltaEnd]
	stdinMsgs := tail
	if len(stdinMsgs) == 0 {
		stdinMsgs = []provider.Message{{Type: "user", Content: continuationNudgeForRequest(req)}}
	}
	lines, err := c.formatMessagesAsStreamJSONLines(stdinMsgs, c.activeSession.sessionUUID)
	if err != nil || len(lines) == 0 {
		return c.coldStartFallback(ctx, req, callback,
			fmt.Sprintf("warm-append-tail-unserializable: err=%v lines=%d", err, len(lines)))
	}
	payload := []byte(strings.Join(lines, "\n") + "\n")

	// Spinner feedback for the pre-first-token wait: the warm file is loaded by
	// a freshly-spawned --resume process, whose system/init flips the spinner.
	emitActivity(callback, activityReconnecting)

	if err := c.ensurePersistentCLI(req); err != nil {
		return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("warm-append-spawn-failed: %v", err))
	}
	if err := c.writeStdinDelta(payload); err != nil {
		// Stdin write failure ≈ process died between spawn and write. Recycle and
		// retry once, then fall back to fresh.
		jlog.Debug("warm-append: stdin write failed (%v) — respawning and retrying", err)
		c.activeSession.tearDownLiveCLI()
		if err := c.ensurePersistentCLI(req); err != nil {
			return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("warm-append-respawn-failed: %v", err))
		}
		if err := c.writeStdinDelta(payload); err != nil {
			return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("warm-append-stdin-failed: %v", err))
		}
	}
	c.recordConsumedRequest(req)

	jlog.Debug("=== CLAUDECODE WARM-APPEND RESUME (uuid=%s, %d paired result(s), %d tail msg(s)) ===",
		c.activeSession.sessionUUID, len(pairedResults), len(tail))

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// warmSessionPath is the CLI's own session file for the active warm uuid, or ""
// when there is no uuid to resume or no ~/.claude/projects dir for the cwd.
func (c *Client) warmSessionPath() string {
	if c.activeSession == nil || c.activeSession.sessionUUID == "" {
		return ""
	}
	dir := projectsDir(c.workingDir)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, c.activeSession.sessionUUID+".jsonl")
}

// snapshotWarmSession reads the warm session file while the CLI is still parked
// on its tools/call — the last moment the file is guaranteed quiescent. Returns
// nil on any problem, so the caller simply reads the file itself instead.
func (c *Client) snapshotWarmSession() []byte {
	path := c.warmSessionPath()
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return data
}

// appendToolResultsToWarmSession appends a single `user: tool_result` entry —
// closing the warm transcript's dangling tool_use — to the CLI's own session
// file at ~/.claude/projects/<dir>/<sessionUUID>.jsonl, then atomically replaces
// it. The appended entry reuses the native session shape (newSyntheticEntry) and
// chains to the file's current last entry.
//
// snapshot is the file's contents read before any teardown touched it; nil means
// read it from disk now. Writing snapshot+entry over the file discards anything
// a dying CLI journalled in between.
//
// It refuses (returns an error, so the caller cold-starts fresh) unless the file
// exists AND ends on assistant tool_use entries that the results answer exactly,
// one for one — the guard that keeps the file's tool_use→tool_result adjacency
// valid. The one tail it will cut back past is one that already answers the very
// calls these results are for (dropTeardownWreckage): those answers are stale by
// construction, and stand in the way of the real ones.
func (c *Client) appendToolResultsToWarmSession(results []provider.Message, snapshot []byte) error {
	if c.activeSession == nil || c.activeSession.sessionUUID == "" {
		return fmt.Errorf("no warm session uuid to append to")
	}
	path := c.warmSessionPath()
	if path == "" {
		return fmt.Errorf("no ~/.claude/projects dir for working dir %q", c.workingDir)
	}

	data := snapshot
	if len(data) == 0 {
		var err error
		if data, err = os.ReadFile(path); err != nil {
			return fmt.Errorf("read warm session %s: %w", path, err)
		}
	}
	trimmed := bytes.TrimRight(data, "\n")
	if len(trimmed) == 0 {
		return fmt.Errorf("warm session %s is empty", path)
	}
	blocks := toolResultBlocks(results)
	if len(blocks) == 0 {
		return fmt.Errorf("no tool_result blocks to append")
	}
	appending := make(map[string]bool, len(blocks))
	for _, b := range blocks {
		appending[b.ToolUseID] = true
	}

	lines := bytes.Split(trimmed, []byte("\n"))
	dangling, err := trailingToolUses(lines)
	if err != nil {
		healed, ok := dropTeardownWreckage(lines, appending)
		if !ok {
			return fmt.Errorf("warm session %s: %w", path, err)
		}
		healedDangling, healErr := trailingToolUses(healed)
		if healErr != nil {
			return fmt.Errorf("warm session %s: %w", path, err)
		}
		jlog.Debug("warm-append: dropped %d trailing entr(ies) an abandoned call left behind (%v) — resuming warm",
			len(lines)-len(healed), err)
		lines, dangling = healed, healedDangling
	}

	entries, err := pairResultsWithToolUses(blocks, dangling, c.activeSession.sessionUUID, c.workingDir)
	if err != nil {
		return fmt.Errorf("warm session %s: %w", path, err)
	}

	body := bytes.Join(lines, []byte("\n"))
	out := make([]byte, 0, len(body)+1)
	out = append(out, body...)
	for _, entry := range entries {
		line, err := json.Marshal(entry)
		if err != nil {
			return fmt.Errorf("marshal append entry: %w", err)
		}
		out = append(out, '\n')
		out = append(out, line...)
	}
	out = append(out, '\n')

	// Atomic replace so a torn write can never corrupt the warm session: write a
	// sibling temp then rename over the original (the CLI is dead, so no reader
	// races us).
	tmp := path + ".juggler-append.tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return fmt.Errorf("write temp session: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace warm session: %w", err)
	}
	return nil
}

// isMessageEntry reports whether a session entry type is one of the two that
// carry conversation. Everything else the CLI writes into the file is a record
// ABOUT the session rather than a turn in it, and a tail scan looking for the
// call the CLI parked on must walk straight past it.
//
// Those records are not all uuid-less, so "has a uuid" cannot stand in for "is a
// message": `attachment` (the total_tokens_reminder written after nearly every
// user entry, plus tool/agent/skill listing deltas) and `system` (local_command
// output) carry a uuid and a parentUuid exactly like a real turn. A scan that
// stops on one reads the file as ending on something other than the tool_use the
// CLI is parked on — which cold-starts a fully warm session.
func isMessageEntry(entryType string) bool {
	return entryType == "user" || entryType == "assistant"
}

// danglingToolUse is one trailing assistant tool_use entry awaiting a result:
// the uuid an answering entry chains to, and the tool_use IDs it carries.
type danglingToolUse struct {
	uuid string
	ids  []string
}

// trailingToolUses returns the run of assistant tool_use entries the warm file
// ends on, oldest first — every call the CLI is parked on.
//
// The CLI journals one entry PER CONTENT BLOCK, so an assistant turn that calls
// two tools in parallel ends the file with two chained assistant entries, one
// tool_use each. Reading only the last entry sees only the last call, and a
// result for the other one looks like it belongs to a different turn — which
// cold-started every multi-tool turn there has ever been. The run stops at the
// first entry that is not an assistant tool_use (the turn's text or thinking
// block, or the user turn before it), so it never reaches back past the message
// the results answer.
//
// The CLI's own records are skipped on the way (isMessageEntry): it interleaves
// last-prompt, ai-title, mode, queue-operation, attachment and system entries
// into the file, so the physically-last line is routinely not a message at all,
// and a transcript ending on a parked tool_use commonly has a last-prompt or an
// attachment written after it. The thread is reconstructed by walking parentUuid
// from the leaf, and the entry this appends becomes the new leaf, so skipping
// them is sound.
func trailingToolUses(lines [][]byte) ([]danglingToolUse, error) {
	var run []danglingToolUse
	var tailType string
	for i := len(lines) - 1; i >= 0; i-- {
		var probe struct {
			UUID string `json:"uuid"`
			Type string `json:"type"`
		}
		if err := json.Unmarshal(lines[i], &probe); err != nil {
			// An unparseable line is not something we can reason about: stop
			// rather than reaching past it for an anchor that may not be real.
			break
		}
		if probe.UUID == "" || !isMessageEntry(probe.Type) {
			continue // one of the CLI's own records, not a turn in the conversation
		}
		uuid, ids, err := parseToolUseEntry(lines[i])
		if err != nil {
			if tailType == "" {
				tailType = err.Error()
			}
			break
		}
		run = append([]danglingToolUse{{uuid: uuid, ids: ids}}, run...)
	}
	if len(run) == 0 {
		if tailType == "" {
			tailType = "no message entry to append to"
		}
		return nil, fmt.Errorf("%s", tailType)
	}
	return run, nil
}

// pairResultsWithToolUses builds the session entries that close the dangling
// tool_uses, mirroring the CLI's own layout: one `user` entry per tool_use
// entry, each chained to the entry it answers, the last of them left as the leaf.
//
// It refuses unless results and dangling calls correspond exactly. A result with
// no matching call would break tool_use→tool_result adjacency; a call left
// without a result would leave the rebuilt assistant turn half-answered, which
// the API rejects outright. Either way the caller cold-starts instead.
func pairResultsWithToolUses(blocks []warmToolResultBlock, dangling []danglingToolUse, sessionUUID, workingDir string) ([]map[string]any, error) {
	byID := make(map[string]warmToolResultBlock, len(blocks))
	for _, b := range blocks {
		byID[b.ToolUseID] = b
	}
	answered := map[string]bool{}
	now := time.Now()
	entries := make([]map[string]any, 0, len(dangling))
	for _, d := range dangling {
		mine := make([]warmToolResultBlock, 0, len(d.ids))
		for _, id := range d.ids {
			b, ok := byID[id]
			if !ok {
				return nil, fmt.Errorf("dangling tool_use %s has no result to close it", id)
			}
			mine = append(mine, b)
			answered[id] = true
		}
		entries = append(entries, newSyntheticEntry("user", mine, newSyntheticSessionUUID(), d.uuid,
			sessionUUID, workingDir, now))
	}
	for _, b := range blocks {
		if !answered[b.ToolUseID] {
			return nil, fmt.Errorf("tool_result %s does not match the warm file's dangling tool_use", b.ToolUseID)
		}
	}
	return entries, nil
}

// teardownAbortResultText marks a tool_result Juggler synthesised for a parked
// tools/call it abandoned, rather than one a tool actually produced. A session
// file ending on it ends on a result that answers nothing: the tool was never
// aborted, only deferred — waiting on an approval, or on the next process.
const teardownAbortResultText = "tool execution aborted: conversation session ended"

// dropTeardownWreckage cuts a warm session file back to its dangling assistant
// tool_use by removing a stale answer to the calls in appending — the tool_use
// IDs whose results are about to be written — and everything after it, reporting
// whether it found one.
//
// A teardown closes a parked tools/call one of two ways, and both leave a `user`
// tool_result where warm-append needs the tool_use: Juggler's own abandoned-call
// marker (teardownAbortResultText), or text the CLI synthesises for itself on
// its way down ("(<tool> completed with no output)" and the like). Keying on the
// text can only ever chase the wording of the day, so the cut is keyed on
// identity instead: warm-append runs only while holding an UNDELIVERED result
// for exactly these calls, so an entry that answers one of them answers it with
// something no tool produced. It is stale by construction — a genuine result
// consumed as real conversation could not still be undelivered here — and
// whatever turn was built on it reached nobody.
//
// An entry qualifies when every one of its content blocks is a tool_result AND
// either every one of those blocks answers a call in appending, or the entry is
// an abandoned-call marker (which answers nothing at all, so it goes whatever id
// it carries). A user turn holding any other block is real history: if one
// block fails the test, nothing is cut.
//
// Wreckage is a RUN of qualifying user entries, not one: the CLI journals one
// entry per content block, so a turn parked on several calls at once is closed
// with one stale answer each. The cut goes back to the oldest of them, and the
// first assistant entry behind one is the dangling tool_use they answer — the
// anchor itself, never something to walk past.
//
// The scan walks back from the file's end, skipping the CLI's own records
// (isMessageEntry) — the attachment it writes straight after the very
// tool_result being cut among them. Before any wreckage is found it also walks
// past assistant entries, a turn stranded on the far side of the stale answers.
// Any user turn that does not qualify means real conversation continued past
// this point: the scan stops, and nothing beyond wreckage already found is cut.
func dropTeardownWreckage(lines [][]byte, appending map[string]bool) ([][]byte, bool) {
	cut := -1
scan:
	for i := len(lines) - 1; i >= 0; i-- {
		var probe struct {
			UUID string `json:"uuid"`
			Type string `json:"type"`
		}
		if err := json.Unmarshal(lines[i], &probe); err != nil {
			// An unparseable line is not something we can reason about: stop here
			// and keep whatever run has already been positively classified.
			break scan
		}
		switch {
		case probe.UUID == "" || !isMessageEntry(probe.Type):
			continue // a record about the session — not a turn in it
		case probe.Type == "assistant" && cut < 0:
			continue // a turn stranded on the far side of the stale answers
		case probe.Type == "user" && (answersOnlyCalls(lines[i], appending) || isTeardownAbortEntry(lines[i])):
			cut = i // one stale answer per parked call: keep walking for its siblings
		default:
			break scan
		}
	}
	if cut < 0 {
		return nil, false
	}
	return lines[:cut], true
}

// answersOnlyCalls reports whether a session entry is a user turn whose content
// is nothing but tool_results for the calls in appending — the calls whose real
// results are about to be written. Every block must be one: a user turn that
// also carries a genuine unrelated result is real history.
func answersOnlyCalls(line []byte, appending map[string]bool) bool {
	var e struct {
		Message struct {
			Content []struct {
				Type      string `json:"type"`
				ToolUseID string `json:"tool_use_id"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &e); err != nil || len(e.Message.Content) == 0 {
		return false
	}
	for _, b := range e.Message.Content {
		if b.Type != "tool_result" || !appending[b.ToolUseID] {
			return false
		}
	}
	return true
}

// isTeardownAbortEntry reports whether a session entry is a user turn whose
// content is nothing but abandoned-call markers. Every block must be one: a
// user turn that also carries a genuine result is real history. A marker answers
// nothing, so it qualifies for cutting on its text alone, without its call
// having to be one whose result is being appended.
func isTeardownAbortEntry(line []byte) bool {
	var e struct {
		Message struct {
			Content []struct {
				Type    string          `json:"type"`
				IsError bool            `json:"is_error"`
				Content json.RawMessage `json:"content"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &e); err != nil || len(e.Message.Content) == 0 {
		return false
	}
	for _, b := range e.Message.Content {
		if b.Type != "tool_result" || !b.IsError || !bytes.Contains(b.Content, []byte(teardownAbortResultText)) {
			return false
		}
	}
	return true
}

// parseToolUseEntry decodes one JSONL entry and returns its uuid (the parent for
// an answering result) plus the tool_use IDs it carries, in order. Errors unless
// the entry is an assistant turn containing at least one tool_use — the caller
// reads that error as "the run of dangling calls ends here".
func parseToolUseEntry(line []byte) (uuid string, toolUseIDs []string, err error) {
	var e struct {
		UUID    string `json:"uuid"`
		Type    string `json:"type"`
		Message struct {
			Content []struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &e); err != nil {
		return "", nil, fmt.Errorf("unparseable last entry: %w", err)
	}
	if e.UUID == "" {
		return "", nil, fmt.Errorf("last entry has no uuid")
	}
	if e.Type != "assistant" {
		return "", nil, fmt.Errorf("last entry is %q, not an assistant tool_use", e.Type)
	}
	var ids []string
	for _, b := range e.Message.Content {
		if b.Type == "tool_use" && b.ID != "" {
			ids = append(ids, b.ID)
		}
	}
	if len(ids) == 0 {
		return "", nil, fmt.Errorf("last entry carries no tool_use to close")
	}
	return e.UUID, ids, nil
}

// warmToolResultBlock is a tool_result content block as the CLI journals it.
// Content is the result text, or — when the tool returned images — the array
// of a text block followed by image blocks that the CLI itself writes for an
// MCP tool's image result. Nesting the images inside the tool_result, rather
// than beside it, keeps the entry nothing but tool_results, so a parallel
// call's results stay first in the user turn the CLI rebuilds.
type warmToolResultBlock struct {
	Type      string `json:"type"`
	ToolUseID string `json:"tool_use_id,omitempty"`
	Content   any    `json:"content,omitempty"`
	IsError   bool   `json:"is_error,omitempty"`
}

// toolResultBlocks converts the delta's paired tool-result messages into
// tool_result content blocks for the appended session entry.
func toolResultBlocks(results []provider.Message) []warmToolResultBlock {
	var blocks []warmToolResultBlock
	for _, m := range results {
		if m.Type != "tool-result" {
			continue
		}
		block := warmToolResultBlock{Type: "tool_result", ToolUseID: m.ToolUseID, IsError: m.IsError}
		var inner []anthropic.APIContentBlock
		if m.Content != "" {
			inner = append(inner, anthropic.APIContentBlock{Type: "text", Text: m.Content})
		}
		if withImages := anthropic.AppendImageBlocks(inner, m.Parts); len(withImages) > len(inner) {
			block.Content = withImages
		} else if m.Content != "" {
			block.Content = m.Content
		}
		blocks = append(blocks, block)
	}
	return blocks
}
