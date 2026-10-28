//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Stream-parser state machine for the claude CLI's stream-json output. The
// CLI is always spawned with --include-partial-messages, so stream_event
// envelopes are the sole content path; assistant envelopes are ignored.
// Wire-format types live in protocol.go.

package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/jlog"
)

// transientCLIError marks a turn failure caused by the CLI's infrastructure
// (the process died without a terminal stop reason, or its stream stalled)
// rather than a definitive API result. These are safe to re-attempt: the
// turn-level retry in dispatchTurnWithRetry re-runs the dispatch when it sees
// one (and nothing has streamed yet). A clean API error — rate-limit
// exhaustion the CLI reported in-band, a 400 — is a plain error and is never
// retried.
//
// It declares its kind to the worker (DeclaredFailure), since its text cannot:
// what it was, and whether this client already spent its own retries on it.
type transientCLIError struct {
	msg string
	// kind is what the failure was, as the worker's retry policy reads it.
	kind provider.FailureKind
	// retried is set when dispatchTurnWithRetry surfaces the failure after
	// spending its own retries on it, so the worker does not multiply them.
	retried bool
	// processExited is true when the CLI process has terminated (the
	// "exited unexpectedly" case), so finalizeTurn may enrich the message
	// with the captured process exit status. False for a stall, where the
	// process is still up (and teardown, not the CLI, would end it).
	processExited bool
	// diag is an optional exit-status annotation ("exit status 1",
	// "signal: killed") filled in by finalizeTurn once the dead CLI is reaped.
	diag string
	// ladderExhausted marks the retryLadderCap failure: the CLI was alive and
	// retrying the whole time, so the upstream is persistently overloaded
	// rather than the process having died. Re-dispatching immediately would
	// just re-enter the same ladder, so the turn-level retry skips these —
	// they still count as stalls for the circuit breaker.
	ladderExhausted bool
}

func (e *transientCLIError) Error() string {
	if e.diag != "" {
		return e.msg + " (" + e.diag + ")"
	}
	return e.msg
}

// DeclaredFailure is the failure as the worker's retry policy reads it. An
// exhausted ladder is always reported as already retried: the CLI spent the
// whole ladder on this request.
func (e *transientCLIError) DeclaredFailure() provider.Failure {
	return provider.Failure{Kind: e.kind, ProviderRetried: e.retried || e.ladderExhausted}
}

// isTransientCLIError reports whether err (or anything it wraps) is a
// transientCLIError — CLI infrastructure failed rather than the API returning
// a definitive result. Drives the circuit-breaker's stall bookkeeping.
func isTransientCLIError(err error) bool {
	var t *transientCLIError
	return errors.As(err, &t)
}

// isRetryableCLIError reports whether a transient failure is worth
// re-dispatching immediately. Everything transient qualifies except an
// exhausted retry ladder, where the CLI already spent retryLadderCap retrying
// this exact request — a fresh dispatch would only repeat it.
func isRetryableCLIError(err error) bool {
	var t *transientCLIError
	return errors.As(err, &t) && !t.ladderExhausted
}

// isLadderExhaustedError reports whether err is the retryLadderCap failure: the
// UPSTREAM was persistently overloaded, as distinct from this CLI session being
// wedged. The two look alike from a distance and must not be treated alike —
// see the circuit-breaker bookkeeping in dispatchTurnWithRetry.
func isLadderExhaustedError(err error) bool {
	var t *transientCLIError
	return errors.As(err, &t) && t.ladderExhausted
}

// annotateExit attaches an exit-status diagnostic (e.g. "exit status 1",
// "signal: killed") to err when err is a process-exit transientCLIError.
// Returns err unchanged for any other error or an empty diag.
func annotateExit(err error, diag string) error {
	if diag == "" {
		return err
	}
	var te *transientCLIError
	if errors.As(err, &te) && te.processExited {
		te.diag = diag
	}
	return err
}

// stallNoOutputMsg is the idle-stall error text, assembled from the two markers
// the worker's transient classifier matches on (utils.StallMarker /
// StallDroppedMarker) so this provider's wording cannot drift out of that
// contract. Takes the idle window that elapsed; the stderr variant appends the
// CLI's own last words.
const stallNoOutputMsg = "claude CLI " + utils.StallMarker + ": no output for %s (" +
	utils.StallDroppedMarker + ", e.g. across system sleep)"

// retryLadderCap bounds how long a single turn may sit in the CLI's own in-band
// backoff ladder without making progress. The CLI retries an overloaded
// upstream (HTTP 529) itself, announcing each attempt as a system/api_retry
// line. Those lines are LIVENESS, not PROGRESS: they keep resetting the idle
// watchdog, so the silence watchdog alone can never end a turn whose
// upstream is persistently overloaded — the turn would run until the worker's
// 30-minute LLMTimeout backstop with the UI still claiming to receive.
//
// Generous enough to ride out a normal backoff ladder (which recovers in tens
// of seconds, and disarms the cap the moment it does), short enough to report a
// genuinely unavailable upstream while the user is still watching — and short
// enough to pre-empt the CLI's own give-up, which takes about five minutes to
// arrive as an in-band 529 the worker then retries from scratch. A package var
// so tests can shrink it.
var retryLadderCap = 2 * time.Minute

// turnResult holds the results from a single CLI invocation.
type turnResult struct {
	InputTokens      int
	OutputTokens     int
	CacheReadTokens  int
	CacheWriteTokens int
	StopReason       provider.StopReason
	SessionID        string // captured from system/init; used for --resume
	Blocks           []provider.ContentBlock

	// usageFromStream is set the first time a stream_event (message_start
	// or message_delta) reports usage for the current API call. The
	// trailing `result` / `system/result` envelopes can carry usage that
	// is cumulative across all API calls the persistent CLI process has
	// served in the session — overwriting the per-call number with that
	// would make `anchoredTokens` grow without bound across a long
	// tool-use loop (we observed 8754k after a long LLM loop, ~40× the
	// real context window). When this flag is true, we keep the
	// stream-event numbers and ignore the result-envelope ones.
	usageFromStream bool

	// streamed records that this read has seen a stream_event, and resultSeen
	// that it has seen a `result` envelope — between them, whether the read
	// ended in a way that leaves the query's envelope still to come.
	streamed   bool
	resultSeen bool

	// Per-block accumulators for the stream-event parser; the CLI is always
	// spawned with --include-partial-messages so this is the sole content
	// path. Lazily initialised on the first stream_event.
	partialBlocks map[int]*partialBlock

	// progress tracks running output-token estimate during the stream so
	// the UI's "Receiving..." spinner can show a live count. Owned by a
	// single goroutine for the duration of one stream.
	progress *provider.ProgressEmitter

	// Per-API-call tool tallies, reset at every message_start. A juggler turn
	// can span several API calls, and the tool_use pause decision is about the
	// call that just ended: dispatchableThisCall counts tool_use blocks emitted
	// for juggler to execute, cliServedThisCall counts blocks the CLI answers
	// itself (unparseable tool input). A pause with the first at zero and the
	// second above it parks nothing on our side — see onStopReason.
	dispatchableThisCall int
	cliServedThisCall    int

	// retryNotices counts system/api_retry lines seen this turn — the CLI
	// announcing its own in-band backoff against an overloaded upstream. The
	// read loop watches this to tell "alive but retrying" apart from "making
	// progress"; see retryLadderCap.
	retryNotices int

	// Calls to a tool name missing the mcp__juggler__ prefix, which the CLI
	// rejects on its own side. bareNameThisCall is per API call, reset at every
	// message_start like the tallies above; bareNameRounds counts the calls this
	// read loop whose every tool call was one of them, and bareNames the names
	// seen, for the error. A read loop ends at the first round that dispatches a
	// tool, so these only ever describe rounds with nothing to show for them.
	// See maxBareToolNameRounds.
	bareNameThisCall int
	bareNameRounds   int
	bareNames        []string

	// lastModelOutputAt is when the last stream_event arrived — the model
	// producing something, as opposed to the CLI's own bookkeeping lines.
	// otherLines counts the other content lines since then and lastOtherLine
	// names the latest (type/subtype); they reset the idle watchdog without
	// being progress, so a stranded-call release reports them. See
	// Client.releaseStrandedCalls.
	lastModelOutputAt time.Time
	otherLines        int
	lastOtherLine     string
}

// maxBareToolNameRounds is how many consecutive rounds of bare-name tool calls a
// turn is allowed before it is abandoned as unusable output.
//
// The CLI answers a bare name with "No such tool available: <name>", which
// never mentions the prefix, and the model has to work the rest out. Usually it
// does on the very next round. When it doesn't, it tends to read the rejection
// as that tool being broken and try a different bare name instead, working down
// the tool list, and can end the turn telling the user the tools are down. A
// fresh sample of the same request is far more likely to use the names it was
// given than the one that has already failed this way, so the provider abandons
// the turn and the worker sends it again. A model that ends its turn after any
// bare round without reaching a real tool is treated the same way (see the
// end_turn arm): that answer comes from a model that couldn't investigate.
const maxBareToolNameRounds = 2

// unusableBareNameOutput is the error a turn is abandoned with once the model's
// bare-name calls have used up maxBareToolNameRounds, or it gave up after one.
func unusableBareNameOutput(result *turnResult) error {
	return &provider.UnusableOutputError{Message: fmt.Sprintf(
		"the model called tools by names this session doesn't serve (%s) and did not recover; its turn was discarded",
		strings.Join(result.bareNames, ", "))}
}

// partialBlock accumulates a single content block's incremental data as
// stream_event deltas arrive. Finalised on content_block_stop.
type partialBlock struct {
	kind      string // "text" | "thinking" | "tool_use"
	text      string // accumulated text or thinking text
	signature string // for thinking blocks
	toolID    string
	toolName  string
	toolJSON  strings.Builder // accumulated input_json_delta payload
}

// readUntilPauseOrComplete reads from the active session until we see one of:
//   - tool_use     (early return, CLI is paused inside MCP awaiting our results)
//   - end_turn     (the LLM turn finished; CLI may still be alive idling on stdin)
//   - empty_response
//   - the CLI exits (one-shot -p mode, or unexpected death)
//
// Detecting end_turn from the stream itself (rather than waiting for stdout to
// close) is what lets persistent CLI processes survive across juggler turns.
func (c *Client) readUntilPauseOrComplete(ctx context.Context, callback provider.StructuredStreamCallback) (res *turnResult, toolUses int, err error) {
	if c.activeSession == nil {
		return nil, 0, fmt.Errorf("no active session")
	}

	// Named returns exist for this: every exit from the loop below — clean
	// pause, end_turn, stall, CLI death, cancel — reports how long it read for
	// and why it stopped, so a turn that ends without a visible error still
	// leaves a trace of which arm it took.
	armedAt := time.Now()
	defer func() {
		var stop provider.StopReason
		if res != nil {
			stop = res.StopReason
		}
		jlog.Debug("claudecode read loop exited after %v (stop=%q toolUses=%d err=%v)",
			time.Since(armedAt).Round(time.Millisecond), stop, toolUses, err)
	}()

	// Capture the live-CLI stream channels up front. Every caller reaches here
	// with a live CLI; if there is none, content stays nil and the select
	// below blocks on it exactly as the old zero-value field did.
	var content chan string
	var scanErr <-chan error
	if lc := c.activeSession.live; lc != nil {
		content = lc.content
		scanErr = lc.scanErr
	}

	result := &turnResult{progress: provider.NewProgressEmitter(callback)}
	toolUseCount := 0

	// Idle watchdog: reset on every line. If it fires, the CLI has gone silent
	// without completing the turn — treat it as a dropped connection (most
	// commonly the machine slept mid-request and the TCP connection died)
	// rather than blocking until the worker's coarse LLMTimeout backstop. The
	// CLI streams incrementally under --include-partial-messages (content
	// deltas, and api_retry events during its own backoff), so a long stretch
	// of total silence is the connection, not the model thinking.
	//
	// The window is the same one every other streaming provider arms, user
	// setting included: this transport is a subprocess rather than a socket,
	// but the failure it guards against and the setting that tunes it are
	// shared. Resolved once per read loop and reused for the error text, so
	// the reported timeout is the one that actually fired.
	idleTimeout := utils.EffectiveStreamIdleTimeout()
	idle := time.NewTimer(idleTimeout)
	defer idle.Stop()

	ladder := newRetryLadder()
	defer ladder.timer.Stop()

	// Stranded-call sweep: see releaseStrandedCalls. Polled rather than timed
	// off any one event, because what ends the wait is an absence — of model
	// output, while a call stays parked.
	strandedSweep := time.NewTicker(strandedCallGrace / 4)
	defer strandedSweep.Stop()

	for {
		select {
		case <-ctx.Done():
			return result, toolUseCount, ctx.Err()

		case <-strandedSweep.C:
			c.releaseStrandedCalls(result, armedAt, callback)

		case <-ladder.timer.C:
			ladder.armed = false
			return result, toolUseCount, ladderExhaustedError()

		case <-idle.C:
			return result, toolUseCount, c.idleStallError(idleTimeout)

		case line, ok := <-content:
			resetTimer(idle, idleTimeout)
			if !ok {
				return result, toolUseCount, c.streamClosedError(result, scanErr)
			}
			if line == "" {
				continue
			}
			count, done, err := c.consumeLine(line, result, callback, ladder)
			if err != nil {
				return result, toolUseCount, err
			}
			toolUseCount += count
			if done {
				return result, toolUseCount, nil
			}
		}
	}
}

// releaseStrandedCalls is the read loop's recovery for a tool round that can
// never complete. While this loop runs, every tool result juggler holds for the
// turn has already been delivered, and the CLI's next call would end the loop at
// its pause. So a tools/call still parked after strandedCallGrace with no model
// output is one none of those results answered — a tool-delivery desync, however
// it arose — and the CLI is blocked on it with nothing coming. Left alone, both
// sides wait until the server restarts; the CLI's own bookkeeping lines can keep
// the idle watchdog fed throughout. Answering the call lets the CLI carry on and
// tells the model what happened.
func (c *Client) releaseStrandedCalls(result *turnResult, armedAt time.Time, callback provider.StructuredStreamCallback) {
	quietSince := armedAt
	if result.lastModelOutputAt.After(quietSince) {
		quietSince = result.lastModelOutputAt
	}
	if time.Since(quietSince) < strandedCallGrace {
		return
	}
	lc := c.liveProcess()
	if lc == nil || lc.control == nil {
		return
	}
	n := lc.control.releaseStrandedCalls(strandedCallGrace)
	if n == 0 {
		return
	}
	jlog.Error("claudecode: answered %d stranded tools/call(s) the CLI was blocked on with no model output for %v — a tool-delivery desync; %d other line(s) arrived meanwhile (last: %q) (uuid=%s)",
		n, time.Since(quietSince).Round(time.Second), result.otherLines, result.lastOtherLine, shortID(c.activeSession.sessionUUID))
	_, _ = callback(provider.StreamChunk{
		Type:    provider.ContentBlockTypeStatus,
		Content: "A tool result went missing — the model has been told, so it can retry",
	})
}

// consumeLine feeds one stdout line to the parser and reports whether the turn
// is over: the model paused on tool_use (the CLI is parked inside MCP awaiting
// our results), or the stream itself announced end_turn / empty_response while
// a persistent CLI keeps running. It also moves the retry-ladder clock.
func (c *Client) consumeLine(line string, result *turnResult, callback provider.StructuredStreamCallback, ladder *retryLadder) (toolUses int, done bool, err error) {
	noticesBefore := result.retryNotices
	pause, count, err := c.processStreamLineWithEarlyReturn(line, result, callback)
	if err != nil {
		return 0, false, err
	}

	// A retry notice re-armed the idle window without the turn having moved.
	// Put it on the ladder clock instead; any line that carries real progress
	// takes it back off.
	if result.retryNotices > noticesBefore {
		ladder.arm()
	} else {
		ladder.disarm()
	}

	if pause {
		result.StopReason = provider.StopReasonToolUse
		return count, true, nil
	}
	switch result.StopReason {
	case provider.StopReasonEndTurn, provider.StopReasonEmptyResponse:
		if !result.resultSeen {
			if live := c.liveProcess(); live != nil {
				live.resultOwed = true
			}
		}
		return count, true, nil
	}
	return count, false, nil
}

// liveProcess is the running CLI's plumbing, or nil when there is none.
func (c *Client) liveProcess() *liveCLI {
	if c.activeSession == nil {
		return nil
	}
	return c.activeSession.live
}

// passOverQueryTrailer consumes the `result` envelope of a query whose turn has
// already been returned, and reports whether it did.
//
// A read returns at the stream's end_turn, so the envelope the CLI writes after
// it is read by whoever reads next — the autonomous drain, or the next Submit
// when no drain is running. To that reader it looks like a whole turn: an
// instant end_turn with no content, carrying usage summed over every API call of
// the finished query (millions of tokens after a long tool-use run). Taken as a
// resumed session's first turn, that charged the run its previous query's whole
// cost and ended the turn before the model's real reply had been read.
//
// Only a clean envelope is passed over, and only as the first thing a read
// meets: a failure in that position is the CLI reporting one, and ends the turn
// as it always has. What the envelope teaches beyond usage — the model's window,
// that the login works — is still learned from it.
func (c *Client) passOverQueryTrailer(msg *StreamMessage, result *turnResult) bool {
	live := c.liveProcess()
	if live == nil || !live.resultOwed {
		return false
	}
	live.resultOwed = false
	if result.streamed || msg.IsError || msg.Subtype != "success" {
		return false
	}
	jlog.Debug("claudecode: passed over the previous query's result envelope (it closes a turn already returned)")
	c.learnModelUsage(msg)
	markClaudeLoginConfirmed()
	return true
}

// retryLadder is the retryLadderCap clock. The first api_retry notice of a
// stretch arms it and the next line carrying real progress disarms it. It
// starts stopped, so a turn that never sees a retry notice is never subject to
// it.
type retryLadder struct {
	timer *time.Timer
	armed bool
}

func newRetryLadder() *retryLadder {
	t := time.NewTimer(retryLadderCap)
	stopTimer(t)
	return &retryLadder{timer: t}
}

// arm starts the cap unless a stretch of retries already has it running.
func (l *retryLadder) arm() {
	if l.armed {
		return
	}
	l.timer.Reset(retryLadderCap)
	l.armed = true
}

// disarm stops the cap, so the next stretch of retries gets a fresh one.
func (l *retryLadder) disarm() {
	if !l.armed {
		return
	}
	stopTimer(l.timer)
	l.armed = false
}

// stopTimer stops t and drains a tick it has already delivered, so a later
// Reset starts a clean window.
func stopTimer(t *time.Timer) {
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
}

// resetTimer restarts t for d, discarding any tick it delivered meanwhile.
func resetTimer(t *time.Timer, d time.Duration) {
	stopTimer(t)
	t.Reset(d)
}

// ladderExhaustedError is the retryLadderCap failure: the CLI stayed alive and
// kept retrying, so the upstream is overloaded rather than the process dead.
func ladderExhaustedError() error {
	return &transientCLIError{
		msg: fmt.Sprintf("claude CLI "+utils.StallMarker+": %s of provider retries with no progress (upstream persistently overloaded)",
			retryLadderCap),
		kind:            provider.FailureOverloaded,
		ladderExhausted: true,
	}
}

// idleStallError is the idle-watchdog failure, carrying the CLI's own last
// words when it wrote any to stderr.
func (c *Client) idleStallError(idleTimeout time.Duration) error {
	if stderr := c.drainedStderr(); stderr != "" {
		return &transientCLIError{msg: fmt.Sprintf(stallNoOutputMsg+": %s", idleTimeout, stderr), kind: provider.FailureStalled}
	}
	return &transientCLIError{msg: fmt.Sprintf(stallNoOutputMsg, idleTimeout), kind: provider.FailureStalled}
}

// cliExitError is the failure of a CLI process that died before completing the
// turn. Its kind is unknown on purpose: the commonest cause is the account's
// usage limit, which no retry clears, but a crash or a dropped connection is
// indistinguishable from here.
func cliExitError(msg string) *transientCLIError {
	return &transientCLIError{msg: msg, kind: provider.FailureUnknown, processExited: true}
}

// noUsableToolCallError is the failure of a turn the CLI stopped for tool_use
// without a call anything could act on. Another sample usually produces one.
func noUsableToolCallError() *transientCLIError {
	return &transientCLIError{msg: "claude CLI stopped for tool_use but emitted no usable tool call", kind: provider.FailureUnusableOutput}
}

// streamClosedError decides what it means that the reader closed the content
// channel (the CLI exited, or the reader stopped). A scan error is surfaced as
// itself. A turn that already has its stop reason ended cleanly. One that has
// none did not: the CLI died for an external reason (usage-limit / quota
// exhaustion, auth failure, crash), and that is reported as an error so the
// worker shows it rather than silently completing the turn.
func (c *Client) streamClosedError(result *turnResult, scanErr <-chan error) error {
	select {
	case err := <-scanErr:
		return fmt.Errorf("scanner error: %w", err)
	default:
	}
	if result.StopReason != "" {
		return nil
	}
	if stderr := c.drainedStderr(); stderr != "" {
		return cliExitError(fmt.Sprintf("claude CLI exited unexpectedly: %s", stderr))
	}
	return cliExitError("claude CLI exited unexpectedly without completing the turn (possible usage-limit / quota exhaustion — check `claude` directly)")
}

// drainedStderr is what the CLI has written to stderr since it was last
// drained, trimmed; empty when there is no session.
func (c *Client) drainedStderr() string {
	if c.activeSession == nil {
		return ""
	}
	return strings.TrimSpace(c.activeSession.drainStderr())
}

// processStreamLineWithEarlyReturn processes a line but returns early on tool_use.
// Returns (shouldPause, toolUseCount, error).
func (c *Client) processStreamLineWithEarlyReturn(line string, result *turnResult, callback provider.StructuredStreamCallback) (bool, int, error) {
	var msg StreamMessage
	if err := json.Unmarshal([]byte(line), &msg); err != nil {
		return false, 0, nil // Skip malformed lines
	}

	// Capture session id from any event that carries one — system/init is the
	// canonical source on a fresh spawn, but we also accept it from result
	// events as a safety net.
	if msg.SessionID != "" && result.SessionID == "" {
		result.SessionID = msg.SessionID
	}

	if msg.Type == "stream_event" {
		result.lastModelOutputAt = time.Now()
		result.otherLines = 0
	} else {
		result.otherLines++
		result.lastOtherLine = msg.Type + "/" + msg.Subtype
	}

	switch msg.Type {
	case "system":
		c.onSystemLine(&msg, line, result, callback)
	case "result":
		if c.passOverQueryTrailer(&msg, result) {
			return false, 0, nil
		}
		result.resultSeen = true
		return false, 0, c.onResultLine(&msg, result)
	case "stream_event":
		// A new query is streaming, so any envelope owed by the last one is not
		// coming: the CLI writes it before anything of the next.
		result.streamed = true
		if live := c.liveProcess(); live != nil {
			live.resultOwed = false
		}
		return c.handleStreamEvent(msg.Event, result, callback)
	case "control_request", "control_response", "control_cancel_request":
		return false, 0, c.onControlLine(&msg)
	}
	// Note: the CLI also emits a final `assistant` envelope after the
	// stream_event sequence with the fully-assembled message. It is ignored
	// here — the stream-event parser already finalised blocks at each
	// content_block_stop, usage at message_delta, and stop_reason at
	// message_delta — re-feeding it would only re-emit content to the UI.

	return false, 0, nil
}

// onSystemLine handles a `system` envelope: a retry notice, the turn's result
// summary, or the CLI's init.
func (c *Client) onSystemLine(msg *StreamMessage, line string, result *turnResult, callback provider.StructuredStreamCallback) {
	switch msg.Subtype {
	case "api_retry":
		onRetryNotice(line, result, callback)
	case "result":
		if len(msg.Result) > 0 {
			onSystemResult(msg.Result, result)
		}
	case "init":
		// The CLI has booted and loaded the session — the slow spawn/resume
		// work is over and we now wait on the model. Replace the spinner's
		// "Starting"/"Reconnecting" description with the per-turn activity
		// (a plain "Waiting for response", or "Processing conversation history"
		// on a cold start with prior history).
		waiting := c.turnWaitingDescription
		if waiting == "" {
			waiting = activityWaiting
		}
		emitActivity(callback, waiting)
	}
}

// onRetryNotice counts a system/api_retry line (the CLI retrying an overloaded
// upstream, HTTP 529) and surfaces it to the UI as a status.
func onRetryNotice(line string, result *turnResult, callback provider.StructuredStreamCallback) {
	var retry struct {
		Attempt      int     `json:"attempt"`
		MaxRetries   int     `json:"max_retries"`
		RetryDelayMs float64 `json:"retry_delay_ms"`
		ErrorStatus  int     `json:"error_status"`
		Error        string  `json:"error"`
	}
	result.retryNotices++
	if json.Unmarshal([]byte(line), &retry) != nil {
		return
	}
	delaySec := int(retry.RetryDelayMs/1000 + 0.5)
	statusMsg := fmt.Sprintf("Rate limited (HTTP %d) — retrying (%d/%d, waiting %ds)",
		retry.ErrorStatus, retry.Attempt, retry.MaxRetries, delaySec)
	_, _ = callback(provider.StreamChunk{
		Type:    provider.ContentBlockTypeStatus,
		Content: statusMsg,
	})
}

// onSystemResult reads a system/result envelope's usage and stop reason.
func onSystemResult(raw json.RawMessage, result *turnResult) {
	var rc ResultContent
	if json.Unmarshal(raw, &rc) != nil {
		return
	}
	adoptEnvelopeUsage(result, "system/result",
		rc.InputTokens, rc.CacheReadInputTokens, rc.CacheCreationInputTokens, rc.OutputTokens)
	// The result envelope repeats the API's own stop_reason, in the
	// vocabulary provider.StopReason is modelled on; a value with
	// no constant there carries through as itself.
	result.StopReason = provider.StopReason(rc.StopReason)
}

// adoptEnvelopeUsage logs the usage a `result` or `system/result` envelope
// reports and adopts it only when no stream_event has reported per-call
// numbers. Those envelopes can carry usage cumulative across every API call the
// persistent CLI has served; see turnResult.usageFromStream.
func adoptEnvelopeUsage(result *turnResult, source string, input, cacheRead, cacheWrite, output int) {
	jlog.Debug("claudecode usage[%s]: input=%d cacheRead=%d cacheWrite=%d output=%d total=%d (usageFromStream=%v)",
		source, input, cacheRead, cacheWrite, output, input+cacheRead+cacheWrite, result.usageFromStream)
	if result.usageFromStream {
		return
	}
	result.InputTokens = input
	result.OutputTokens = output
	result.CacheReadTokens = cacheRead
	result.CacheWriteTokens = cacheWrite
}

// onResultLine handles the `result` envelope that ends a turn: its usage, the
// model-info it teaches us, and whether the turn succeeded.
func (c *Client) onResultLine(msg *StreamMessage, result *turnResult) error {
	if u := msg.Usage; u != nil {
		adoptEnvelopeUsage(result, "result",
			u.InputTokens, u.CacheReadInputTokens, u.CacheCreationInputTokens, u.OutputTokens)
	}
	c.learnModelUsage(msg)
	switch msg.Subtype {
	case "success":
		return onResultSuccess(msg, result)
	case "error":
		// CLI exhausted retries or hit a fatal error — return as a proper error.
		// A CLI that has no usable credential answers here with bare text and no
		// status, so the text is the only signal there is.
		var errStr string
		if json.Unmarshal(msg.Result, &errStr) == nil && errStr != "" {
			return cliAPIError(msg.APIErrorStatus, errStr)
		}
		return errors.New("claude CLI returned an error")
	}
	return nil
}

// learnModelUsage updates the model spec cache from the CLI's modelUsage report
// so ListModelsWithInfo serves the model's true context window / max output
// without us tracking Anthropic's release notes. Key by the canonical alias
// (matching ListModelsWithInfo's base IDs and the CLI --model arg), not the raw
// configured string, or the warm value lands under a key the list never reads.
//
// modelUsage is keyed by FULL model id and a single turn routinely bills MORE
// than the requested model — the CLI runs a background model (e.g. haiku) for
// quota/summary work and reports its usage alongside. Learning from every entry
// stamps the wrong (smaller) window onto the requested alias,
// nondeterministically thanks to Go's randomized map iteration; that is exactly
// what stuck fable at 200k. selectModelUsage attributes the report to the model
// this turn actually ran as. A per-turn flip then self-heals on the next turn
// (true window != cached => update + persist + rebroadcast), so a stuck cache
// recovers on its own.
func (c *Client) learnModelUsage(msg *StreamMessage) {
	alias := c.modelAlias()
	if mu, ok := selectModelUsage(msg.ModelUsage, alias); ok {
		updateCachedModelInfo(alias, mu.ContextWindow, mu.MaxOutputTokens)
	}
}

// onResultSuccess handles result/success, which means the CLI ran without
// crashing — NOT that the underlying API call succeeded. The CLI signals API
// failures via top-level is_error / api_error_status while keeping
// subtype="success", and stuffs the error text into Result. Without surfacing
// this, the worker would see an empty end_turn and treat it as a normal
// (silent) completion.
func onResultSuccess(msg *StreamMessage, result *turnResult) error {
	if msg.IsError {
		var errStr string
		_ = json.Unmarshal(msg.Result, &errStr)
		if errStr == "" {
			errStr = fmt.Sprintf("claude CLI API call failed (HTTP %d)", msg.APIErrorStatus)
		}
		return cliAPIError(msg.APIErrorStatus, errStr)
	}
	// A clean result proves the CLI is signed in and served a turn.
	// Unlock the passive /usage poll, and clear any earlier expiry so a
	// user who has just signed back in isn't still told they haven't.
	markClaudeLoginConfirmed()
	var resultStr string
	if json.Unmarshal(msg.Result, &resultStr) == nil && resultStr == "" {
		result.StopReason = provider.StopReasonEmptyResponse
	} else {
		result.StopReason = provider.StopReasonEndTurn
	}
	return nil
}

// cliAPIError is the error for a turn the CLI reported as failed. An
// authentication failure is the one thing here the user can fix, and the CLI's
// own wording is addressed to someone sitting at its command line, so it is
// typed (and the login marked expired) for the worker to lead with what to do
// while still showing this text underneath. A 400 over the transcript's tool
// sequence is typed too, so the turn can rebuild the session. Any other status
// becomes an APIError the worker classifies by it; a server-side failure the CLI
// reports has already been through the CLI's own retries, and says so. With no
// status, the text is all there is.
func cliAPIError(status int, text string) error {
	if authErr := classifyClaudeAuthFailure(status, text); authErr != nil {
		markClaudeLoginExpired()
		return authErr
	}
	if isRejectedTranscriptText(status, text) {
		return &rejectedTranscriptError{text: text}
	}
	// A subscription cap states when it lifts only in its text. Read as a
	// dated rate limit, it rests the conversation until then instead of being
	// retried into, and the row can offer to continue at that time.
	var cause error
	if status != 0 {
		cause = &provider.APIError{Provider: "claudecode", Status: status, Message: text}
	}
	if limited := usageLimitError(text, cause, time.Now()); limited != nil {
		return limited
	}
	if status == 0 {
		return errors.New(text)
	}
	apiErr := &provider.APIError{Provider: "claudecode", Status: status, Message: text}
	if status < 500 {
		return apiErr
	}
	failure := provider.ClassifyFailure(apiErr)
	failure.ProviderRetried = true
	return &provider.FailureError{Failure: failure, Message: text, Cause: apiErr}
}

// rejectedTranscriptError is a 400 the API returned over the conversation's
// tool_use/tool_result sequence: a call without its result, a result without
// its call, or a result placed after other content in its turn. The CLI sends
// its session file as that history, so while the session lives every resume of
// it is refused the same way — the conversation is stuck until the session is
// abandoned. Juggler's own history is a separate record, and a session rebuilt
// from it (synthetic_resume.go) does not inherit a malformation the CLI's
// file acquired, so finalizeTurn drops the session and dispatchTurnWithRetry
// rebuilds it once.
type rejectedTranscriptError struct{ text string }

func (e *rejectedTranscriptError) Error() string { return e.text }

// isRejectedTranscriptText recognises that 400. The CLI replaces the API's
// message with its own ("API Error: 400 due to tool use concurrency issues.
// Run /rewind…"); the API's own wording names `tool_use` or `tool_result`.
func isRejectedTranscriptText(status int, text string) bool {
	if strings.Contains(text, "tool use concurrency") {
		return true
	}
	if status != 400 && !strings.Contains(text, "400") {
		return false
	}
	return strings.Contains(text, "tool_use") || strings.Contains(text, "tool_result")
}

// isRejectedTranscriptError reports whether err is a rejectedTranscriptError.
func isRejectedTranscriptError(err error) bool {
	var r *rejectedTranscriptError
	return errors.As(err, &r)
}

// onControlLine routes the CLI's control traffic to the stdio control
// protocol, when the session has one.
func (c *Client) onControlLine(msg *StreamMessage) error {
	var control *controlProtocol
	if c.activeSession != nil && c.activeSession.live != nil {
		control = c.activeSession.live.control
	}
	switch msg.Type {
	case "control_request":
		// CLI asking us to do something (typically: invoke an MCP tool
		// via mcp_message). Dispatch through the stdio control protocol;
		// tools/call responses are emitted later when the worker hands
		// us the result via the next StreamMessage call.
		if control != nil {
			if err := control.handleControlRequest(msg); err != nil {
				return fmt.Errorf("control_request: %w", err)
			}
		}
	case "control_response":
		// CLI replying to an outbound control_request we sent (today
		// only initialize). Match by request_id and unblock the parked
		// sender.
		if control != nil {
			control.handleControlResponse(msg)
		}
	case "control_cancel_request":
		// CLI cancelling a pending outbound control_request. We don't
		// emit cancellable outbound requests today; logged for forensics
		// if it ever fires.
		jlog.Debug("CLI sent control_cancel_request for id=%s — no-op", msg.RequestID)
	}
	return nil
}
