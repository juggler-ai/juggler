//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Turn-level retry for transient CLI failures: when the claude CLI process
// dies without emitting a terminal stop reason (crash / quota-kill / dropped
// connection), juggler re-attempts the turn a bounded number of times — but
// only when nothing has been streamed to the UI yet, so a retry can never
// duplicate already-shown content.

package claudecode

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// fastRetryBackoff shrinks the retry backoff to keep tests quick, restoring
// the production value on cleanup.
func fastRetryBackoff(t *testing.T) {
	t.Helper()
	old := cliRetryBackoff
	cliRetryBackoff = time.Millisecond
	t.Cleanup(func() { cliRetryBackoff = old })
}

// TestRetry_TransientCLIExitRecovers: the first spawn dies after init with no
// terminal result; the bounded retry re-spawns and the second attempt
// completes the turn. The turn must succeed (no error surfaced to the worker)
// and the trace must show at least two spawns.
func TestRetry_TransientCLIExitRecovers(t *testing.T) {
	fastRetryBackoff(t)
	tracePath := installFakeClaude(t, fakeModeFlakeFirst, "uuid-flake")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-flake"

	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, nopCallback())
	if err != nil {
		t.Fatalf("expected retry to recover the transient exit, got error: %v", err)
	}
	if res.StopReason != "end_turn" {
		t.Fatalf("StopReason = %q, want end_turn", res.StopReason)
	}

	trace := readTrace(t, tracePath)
	if len(trace) < 2 {
		t.Fatalf("expected ≥2 spawns (one failed + one retry), got %d", len(trace))
	}
	c.dropSession(convID)
}

// TestRetry_TransientCLIExitGivesUp: every spawn dies after init. The retry
// must exhaust its bounded budget and surface the transient error (so the UI
// shows it) rather than looping forever. The number of spawns is capped at
// cliMaxRetries+1.
func TestRetry_TransientCLIExitGivesUp(t *testing.T) {
	fastRetryBackoff(t)
	tracePath := installFakeClaude(t, fakeModeAlwaysExit, "uuid-dead")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-dead"

	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, nopCallback())
	if err == nil {
		t.Fatalf("expected an error after the retry budget is exhausted, got nil (res=%+v)", res)
	}
	if !strings.Contains(err.Error(), "exited unexpectedly") {
		t.Fatalf("error = %q, want the unexpected-exit transient error", err)
	}
	if res == nil || res.StopReason != "error" {
		t.Fatalf("expected StopReason=error result, got %+v", res)
	}

	trace := readTrace(t, tracePath)
	if got, want := len(trace), cliMaxRetries+1; got != want {
		t.Fatalf("spawned %d times, want exactly %d (one initial + %d retries)", got, want, cliMaxRetries)
	}
	// The retries are spent, and the error says so: the worker must not
	// multiply them by its own.
	if f := provider.ClassifyFailure(err); !f.ProviderRetried {
		t.Errorf("ClassifyFailure = %+v, want ProviderRetried after the retry budget was spent", f)
	}
	c.dropSession(convID)
}

// TestRetry_OverloadedUpstreamSurfacesWithoutColdStart is the counterpart to
// the wedged-session test below, and the two together draw the line the client
// has to hold. Both look identical from a distance — a --resume that produces
// no answer — but the causes are opposite:
//
//   - wedged session: the CLI is silent, so ABANDON the uuid and cold-start.
//   - overloaded upstream: the CLI is healthy and streaming retry notices, so
//     the session and its prompt cache are fine. Cold-starting would throw away
//     a warm 100k-token cache and re-send a LARGER request into the very
//     upstream that is already refusing traffic. Report it instead.
func TestRetry_OverloadedUpstreamSurfacesWithoutColdStart(t *testing.T) {
	fastRetryBackoff(t)
	prevIdle, prevLadder := utils.StreamIdleTimeout, retryLadderCap
	// A silence window long enough that only the ladder cap can end this turn:
	// the notices never stop arriving, so the idle watchdog never fires.
	utils.StreamIdleTimeout = 30 * time.Second
	retryLadderCap = 300 * time.Millisecond
	t.Cleanup(func() { utils.StreamIdleTimeout, retryLadderCap = prevIdle, prevLadder })

	tracePath := installFakeClaude(t, fakeModeLadderOnResume, "uuid-ladder-resume")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv_ladder_resume"
	ctx := context.Background()

	if err := os.MkdirAll(filepath.Join(c.workingDir, ".juggler", "ladder--"+convID), 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	// Turn 1: bare fresh start; captures uuid-ladder-resume and succeeds.
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1 should succeed, got: %v", err)
	}
	c.activeSession.tearDownLiveCLI()

	// Turn 2: the resume finds an overloaded upstream and retries forever.
	start := time.Now()
	_, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello"), assistantMsg("turn 1"), userMsg("again")},
	}, nopCallback())
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("turn 2 should surface the overload, not hang or silently succeed")
	}
	if !strings.Contains(err.Error(), "overloaded") {
		t.Errorf("error should name the overloaded upstream, got: %v", err)
	}
	// The CLI spent the whole ladder retrying; another round from the worker
	// would re-enter the same ladder once per attempt.
	if f := provider.ClassifyFailure(err); f.Kind != provider.FailureOverloaded || !f.ProviderRetried {
		t.Errorf("ClassifyFailure = %+v, want overloaded and already retried", f)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("turn 2 took %v — the ladder cap did not bound the wait", elapsed)
	}

	// The breaker must NOT have been charged: nothing about this session is
	// wedged, and a later genuine stall deserves its full allowance.
	if c.consecutiveStalls != 0 {
		t.Errorf("consecutiveStalls = %d, want 0 — an overloaded upstream is not evidence of a wedged session", c.consecutiveStalls)
	}
	// Every spawn stayed on the warm uuid; no cache-torching cold start.
	for i, rec := range readTrace(t, tracePath) {
		if i > 0 && rec.ResumeID != "uuid-ladder-resume" {
			t.Errorf("spawn #%d resumed %q — an overload must not trigger a cold start", i, rec.ResumeID)
		}
	}
	c.dropSession(convID)
}

// TestRetry_WedgedResumeColdStartsInsteadOfLockingUp models the production
// lock-up: a CLI-side session whose --resume stalls forever (a backed-up stdin
// queue / corrupt transcript). Re-resuming the same wedged uuid every turn
// leaves the user staring at "receiving…" indefinitely. After a bounded number
// of consecutive stalls the client must ABANDON the wedged uuid and cold-start
// fresh (a synthetic --resume under a NEW uuid rebuilt from juggler's own
// history), so the turn recovers instead of locking up.
func TestRetry_WedgedResumeColdStartsInsteadOfLockingUp(t *testing.T) {
	fastRetryBackoff(t)
	prevIdle := utils.StreamIdleTimeout
	// The wedged --resume emits nothing, so it stalls deterministically at ANY
	// idle window; but the SAME window also bounds the healthy cold-start's
	// first-output latency. Keep it well above CI scheduling jitter (a 150ms
	// window flaked on loaded runners — the fresh session's first text turn
	// hadn't arrived yet) so the recovery path isn't throttled into a false stall.
	utils.StreamIdleTimeout = time.Second
	t.Cleanup(func() { utils.StreamIdleTimeout = prevIdle })

	tracePath := installFakeClaude(t, fakeModeWedgeOnResume, "uuid-wedge")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv_wedge"
	ctx := context.Background()

	// Build the per-conversation folder so ScanConvDirs indexes it and the
	// sidecar persists/reloads across every retry attempt — exactly as in
	// production. Without this the test sidecar can't be reloaded and turn 2
	// would cold-start for the wrong reason (a test artifact, not the breaker).
	if err := os.MkdirAll(filepath.Join(c.workingDir, ".juggler", "wedge--"+convID), 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	// Turn 1: bare fresh start; captures uuid-wedge and succeeds.
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1 should succeed, got: %v", err)
	}

	// Tear down the live CLI so the next turn must FRESH --resume uuid-wedge —
	// exactly the production wedge shape (idle CLI reaped; next turn cold-resumes
	// the saved uuid, which stalls).
	c.activeSession.tearDownLiveCLI()

	// Turn 2: every --resume uuid-wedge stalls. The breaker must escalate to a
	// cold start so the turn SUCCEEDS rather than surfacing a stall error.
	start := time.Now()
	res, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello"), assistantMsg("turn 1"), userMsg("again")},
	}, nopCallback())
	if err != nil {
		t.Fatalf("turn 2 should recover via cold-start, got error: %v", err)
	}
	if res.StopReason != "end_turn" {
		t.Fatalf("turn 2 StopReason = %q, want end_turn", res.StopReason)
	}
	// Two wedge stalls (~1 idle window + teardown grace each) precede the cold
	// start, so the deterministic cost is a few seconds. The bound only needs to
	// be far below the production LLMTimeout backstop to prove the breaker
	// escalated rather than riding the coarse timeout.
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("turn 2 took %v — breaker did not escalate promptly", elapsed)
	}

	// The recovery spawn must have abandoned the wedged uuid: the final spawn is
	// a synthetic --resume under a fresh uuid (not uuid-wedge, not bare).
	trace := readTrace(t, tracePath)
	last := trace[len(trace)-1]
	if last.ResumeID == "uuid-wedge" {
		t.Fatalf("recovery spawn still resumed the wedged uuid %q", last.ResumeID)
	}
	if last.ResumeID == "" {
		t.Fatalf("recovery spawn cold-started without synthetic resume (lost history)")
	}
	c.dropSession(convID)
}

// startRejectedTranscriptConv runs one good turn on a persisted conversation,
// so its sidecar names the fake's original uuid, then tears the CLI down so the
// next turn must --resume that uuid from disk.
func startRejectedTranscriptConv(t *testing.T, mode, uuid, convID string) (*Client, string) {
	t.Helper()
	fastRetryBackoff(t)
	tracePath := installFakeClaude(t, mode, uuid)
	c := mkClient(t, "claude-sonnet-4-6")
	if err := os.MkdirAll(filepath.Join(c.workingDir, ".juggler", "reject--"+convID), 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}
	if mode == fakeModeRejectOnResume {
		if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
			ConversationID: convID, SystemPrompt: "sys",
			Messages: []provider.Message{userMsg("hello")},
		}, nopCallback()); err != nil {
			t.Fatalf("turn 1 should succeed, got: %v", err)
		}
		c.activeSession.tearDownLiveCLI()
	}
	return c, tracePath
}

// TestRetry_RejectedTranscriptRebuildsSession: the CLI's session file holds a
// transcript the API refuses (a 400 over its tool_use/tool_result sequence), so
// every --resume of it fails identically and retrying it can never succeed.
// Juggler's own history is intact, so the turn must abandon that session and
// rebuild it from that history (a synthetic --resume under a new uuid), and the
// turn succeeds instead of the conversation staying stuck.
func TestRetry_RejectedTranscriptRebuildsSession(t *testing.T) {
	const convID = "conv_rejected"
	c, tracePath := startRejectedTranscriptConv(t, fakeModeRejectOnResume, "uuid-rejected", convID)

	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello"), assistantMsg("turn 1"), userMsg("again")},
	}, nopCallback())
	if err != nil {
		t.Fatalf("turn 2 should recover by rebuilding the session, got error: %v", err)
	}
	if res.StopReason != "end_turn" {
		t.Fatalf("turn 2 StopReason = %q, want end_turn", res.StopReason)
	}

	trace := readTrace(t, tracePath)
	last := trace[len(trace)-1]
	if last.ResumeID == "uuid-rejected" {
		t.Fatalf("recovery spawn still resumed the rejected session %q", last.ResumeID)
	}
	if last.ResumeID == "" {
		t.Fatalf("recovery spawn cold-started without synthetic resume (lost history)")
	}
	if c.activeSession == nil || c.activeSession.sessionUUID == "uuid-rejected" {
		t.Fatalf("session after recovery = %+v, want the rebuilt uuid", c.activeSession)
	}
	c.dropSession(convID)
}

// TestRetry_RejectedTranscriptRebuildsOnlyOnce: when the rebuilt session is
// refused too, the request itself is malformed and no session will fix it. The
// turn surfaces the API's error after a single rebuild rather than spending the
// whole retry budget re-sending the same rejected request.
func TestRetry_RejectedTranscriptRebuildsOnlyOnce(t *testing.T) {
	const convID = "conv_rejected_always"
	c, tracePath := startRejectedTranscriptConv(t, fakeModeRejectAlways, "uuid-rejected-always", convID)

	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello"), assistantMsg("turn 1"), userMsg("again")},
	}, nopCallback())
	if err == nil || !strings.Contains(err.Error(), "tool use concurrency") {
		t.Fatalf("err = %v, want the API's rejection surfaced", err)
	}
	if n := len(readTrace(t, tracePath)); n != 2 {
		t.Fatalf("spawns = %d, want 2 (the failed attempt and one rebuild)", n)
	}
	c.dropSession(convID)
}

// TestRetry_NoRetryAfterStreamedContent: the CLI streams a complete text
// block (the callback fires) and THEN dies without end_turn. Replaying the
// turn would re-stream that text, so the retry must be suppressed: exactly one
// spawn, and the error is surfaced.
func TestRetry_NoRetryAfterStreamedContent(t *testing.T) {
	fastRetryBackoff(t)
	tracePath := installFakeClaude(t, fakeModeStreamThenExit, "uuid-partial")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-partial"

	var streamed strings.Builder
	cb := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if chunk.Type == provider.ContentBlockTypeText {
			streamed.WriteString(chunk.Content)
		}
		return nil, nil
	}

	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, cb)
	if err == nil {
		t.Fatalf("expected the unexpected-exit error (no retry after streamed content), got nil (res=%+v)", res)
	}
	if streamed.String() != "half an answer" {
		t.Fatalf("streamed text = %q, want %q", streamed.String(), "half an answer")
	}

	trace := readTrace(t, tracePath)
	if len(trace) != 1 {
		t.Fatalf("spawned %d times, want exactly 1 (retry must not replay streamed content)", len(trace))
	}
	// Not retried here, so it is the worker's to retry: it discards the
	// streamed text before sending the request again.
	if f := provider.ClassifyFailure(err); f.ProviderRetried {
		t.Errorf("ClassifyFailure = %+v, want a failure the provider did not retry", f)
	}
	c.dropSession(convID)
}

// TestCLIFailuresDeclareTheirKind: each way a CLI turn fails names the kind the
// worker acts on, because the text alone cannot say it — a stall, a process
// that died, output nothing could act on, an upstream the CLI already retried.
func TestCLIFailuresDeclareTheirKind(t *testing.T) {
	c := &Client{}
	for _, tc := range []struct {
		name    string
		err     error
		want    provider.FailureKind
		retried bool
	}{
		{"idle stall", c.idleStallError(90 * time.Second), provider.FailureStalled, false},
		{"exhausted ladder", ladderExhaustedError(), provider.FailureOverloaded, true},
		{"exit", c.streamClosedError(&turnResult{}, make(chan error)), provider.FailureUnknown, false},
		{"no usable tool call", noUsableToolCallError(), provider.FailureUnusableOutput, false},
		{"529 after the CLI's ladder", cliAPIError(account{}, 529, "Overloaded"), provider.FailureOverloaded, true},
		{"500 after the CLI's ladder", cliAPIError(account{}, 500, "Internal server error"), provider.FailureServerError, true},
		{"400", cliAPIError(account{}, 400, "messages: text content blocks must be non-empty"), provider.FailureInvalidRequest, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := provider.ClassifyFailure(tc.err)
			if f.Kind != tc.want || f.ProviderRetried != tc.retried {
				t.Fatalf("ClassifyFailure(%v) = %+v, want kind %v, ProviderRetried %v", tc.err, f, tc.want, tc.retried)
			}
		})
	}
}

// TestRetry_CLIDeathAtBootReadsAsAnExit covers the boot-time half of the same
// failure the tests above drive mid-turn, and it is the half that used to
// escape the retry. A CLI that dies between the spawn and the first byte of
// stdin leaves juggler holding a broken pipe, and the two orderings — the
// write losing the race, or landing and the reader seeing EOF — are decided by
// process scheduling, so both must reach the same verdict: a transient exit,
// retryable, named as one.
func TestRetry_CLIDeathAtBootReadsAsAnExit(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer w.Close()
	// Nothing reads this stdin any more — exactly the state the CLI's pipe is
	// left in by a process that has exited.
	if err := r.Close(); err != nil {
		t.Fatalf("close read end: %v", err)
	}

	cp := newControlProtocol(w)
	defer cp.teardown()
	writeErr := cp.sendInitialize()
	if writeErr == nil {
		t.Fatal("writing to a pipe with no reader should have failed")
	}

	// No active session: a CLI that died this early has no stderr to drain.
	got := (&Client{}).cliBootError("attach control protocol", writeErr)
	if !isRetryableCLIError(got) {
		t.Fatalf("error = %v, want a retryable transient CLI error", got)
	}
	if !strings.Contains(got.Error(), "exited unexpectedly") {
		t.Fatalf("error = %q, want the unexpected-exit transient error", got)
	}
}

// TestRetry_BootFailureOfOurOwnMakingIsNotTransient is the counterpart: only
// the CLI's stdin going away means the CLI died. A tool set that won't marshal
// is juggler's own bug, and retrying it three times would only hide it.
func TestRetry_BootFailureOfOurOwnMakingIsNotTransient(t *testing.T) {
	got := (&Client{}).cliBootError("marshal tools", errors.New("bad tool schema"))
	if isTransientCLIError(got) {
		t.Fatalf("error = %v, want a plain (non-retryable) error", got)
	}
	if want := "marshal tools: bad tool schema"; got.Error() != want {
		t.Fatalf("error = %q, want %q", got, want)
	}
}
