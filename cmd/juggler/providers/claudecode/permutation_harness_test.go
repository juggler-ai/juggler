//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Permutation harness for claudecode tool-delivery fidelity.
//
// The fixed fake-CLI modes in keepalive_test.go each hard-code one tool
// scenario. This file replaces that with ONE scriptable fake (fakeModeScript)
// whose per-turn behaviour is described by a JSON script, plus a pairing tape
// and an invariant checker, so we can drive MANY permutations through a REAL
// fake subprocess and assert the same property over all of them:
//
//	every tool_use_id is answered exactly once, with ITS OWN result —
//	never crossed to another call, never dropped, never duplicated.
//
// The tape is the observable that makes this checkable. The fake records, on
// stdout, every tools/call it emits (request_id → the tool_use_id it mirrors)
// and, on stdin, every control_response the provider writes back (request_id →
// the result text it carried). Because each scenario feeds a UNIQUE result text
// "RESULT::<id>" per tool, a crossed delivery shows up as RESULT::X landing on
// the call the fake emitted for Y — caught with no per-scenario oracle beyond
// "these ids should each be delivered."
//
// The fake can also deliberately INTRODUCE desync, which is how the harness
// reproduces the production corruption conditions end-to-end rather than by
// hand-seeding in-memory state:
//   - arg-drift: the tool_use block carries different args than the matching
//     tools/call (a resume/restart re-serialises args to different bytes), so
//     the provider's (name+args) key misses and the same-tool-name fallback
//     must still deliver to the right call (control_protocol.go).
//   - orphan park: a tools/call with no corresponding tool_use block (a CLI
//     stream-length asymmetry — the documented "+1 shift"), which the worker
//     never drives; discardStaleBuffers must error-release it at the turn
//     boundary so it can't poison a later same-tool call (dispatch.go).

package claudecode

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/provider"
)

// ─── script + tape wire formats ─────────────────────────────────────────────

const (
	envFakeScript = "JUGGLER_FAKE_CLAUDE_SCRIPT" // inline JSON behaviour script
	envFakeTape   = "JUGGLER_FAKE_CLAUDE_TAPE"   // path the pairing tape is appended to
	envFakeState  = "JUGGLER_FAKE_CLAUDE_STATE"  // path the next-turn cursor persists to (across spawns)
)

// scriptCall is one tool the fake emits in a turn. ID is the tool_use_id put on
// the tool_use block; an empty ID means "emit the tools/call but NO tool_use
// block" — an orphan park the worker will never drive. UseArgs go on the
// tool_use block (what the provider records in pendingTools); CallArgs go on the
// tools/call params (what the CLI parks on). When CallArgs is nil it defaults to
// UseArgs; setting them differently models arg-drift across a resume/restart.
type scriptCall struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	UseArgs  map[string]any `json:"useArgs,omitempty"`
	CallArgs map[string]any `json:"callArgs,omitempty"`
}

// scriptTurn is one tool round (one tool_use pause). Calls empty ⇒ a text-only
// end_turn turn. Continues=true means another round follows in the SAME LLM turn:
// once this round's results are fed, the fake emits the next round's tool_use
// instead of end_turn (the model calling a second tool after seeing the first
// result), so discardStaleBuffers does NOT run between them.
type scriptTurn struct {
	Calls     []scriptCall `json:"calls,omitempty"`
	Continues bool         `json:"continues,omitempty"`
	// WakeCalls models an UNSOLICITED / autonomous turn (a scheduled wake or
	// monitor the model armed earlier) that fires WHILE this round's real Calls
	// are still parked and undelivered. After parking Calls, the fake emits these
	// as a SEPARATE mini-turn — their own tool_use blocks + tools/call + a second
	// message_delta(stop_reason=tool_use) — without ending the current turn and
	// WITHOUT counting them toward `outstanding` (the worker never drives them:
	// they are not in pendingTools, exactly like an autonomous turn's tools the
	// foreground turn cannot answer). The load-bearing part is that the wake's
	// first tools/call parks while the real Calls are still parked and
	// undelivered, opening a NEW generation (openNewGenerationLocked) PAST the
	// still-parked real Calls — the precondition the autonomous-vs-parked
	// hypothesis needs.
	WakeCalls []scriptCall `json:"wakeCalls,omitempty"`
	// ExitAfterAnswer makes the fake process exit ABRUPTLY (os.Exit, no end_turn)
	// the moment this round's real calls have all been answered — modelling the
	// CLI dying after a tool result was fed but before it streamed any
	// continuation content. The turn-level retry (dispatchTurnWithRetry) must then
	// recover WITHOUT re-delivering the already-answered result a second time.
	ExitAfterAnswer bool `json:"exitAfterAnswer,omitempty"`
	// PauseBeforePark flips this round's wire order to emit the
	// stop_reason=tool_use pause BEFORE the tools/call parks, instead of after.
	// This is the order seen in production single-tool rounds (logs show the pause
	// processed seconds before the park) and the precondition for the multi-CLI
	// stall: the pause closes the round (latching roundClosed) while the call is
	// still unparked, so a result delivered before the starved reader parks must
	// open the new generation itself or it strands a generation behind its call.
	// The default (false) keeps the park-before-pause order the rest of the suite
	// relies on. Mutually exclusive with WakeCalls (which has its own ordering).
	PauseBeforePark bool `json:"pauseBeforePark,omitempty"`
}

type fakeScript struct {
	Turns []scriptTurn `json:"turns"`
}

// tapeRecord is one line of the pairing tape. Event "emit" records a tools/call
// the fake sent (ReqID → ToolID it mirrors); event "answer" records a
// control_response the provider wrote back (ReqID → result Text).
type tapeRecord struct {
	Event  string `json:"event"`
	ReqID  string `json:"reqID"`
	ToolID string `json:"toolID,omitempty"`
	Name   string `json:"name,omitempty"`
	Text   string `json:"text,omitempty"`
}

// realCalls returns the calls in a turn that carry a tool_use_id — i.e. the ones
// the worker will actually drive and feed a result for. Orphan parks (empty ID)
// are excluded: the worker never sees them, so the fake must not wait on them.
func (s scriptTurn) realCalls() []scriptCall {
	var out []scriptCall
	for _, c := range s.Calls {
		if c.ID != "" {
			out = append(out, c)
		}
	}
	return out
}

// ─── the scriptable fake CLI (runs in the re-exec'd helper process) ──────────

// runScriptedFake is the fakeModeScript body. It speaks the real stdio control
// protocol: each user stdin line drives the next scripted turn (emitting
// tool_use blocks + matching tools/call control_requests, or a terminal text
// turn), and once the provider has answered every real call this turn it emits
// the end_turn that unblocks the continuation. Every tools/call and every
// control_response is appended to the pairing tape.
func runScriptedFake(out *bufio.Writer, sessionID string) {
	emit(out, map[string]any{"type": "system", "subtype": "init", "session_id": sessionID})

	var script fakeScript
	_ = json.Unmarshal([]byte(os.Getenv(envFakeScript)), &script)
	tapePath := os.Getenv(envFakeTape)
	statePath := os.Getenv(envFakeState)

	// reqToTool maps reqID → toolID for the calls parked in the CURRENT turn, so
	// an inbound control_response can be taped against the tool it answers.
	reqToTool := map[string]string{}
	// cursor is the index of the next scripted round to emit. It persists across
	// spawns (statePath) so a round that was parked then cut short by a
	// cancel/restart isn't re-emitted by the respawned process — the warm
	// --resume continues with the FOLLOWING round, as the real model would.
	cursor := loadFakeCursor(statePath)
	parkedIdx := 0   // index of the round currently parked (for its end_turn label)
	jrpcID := 0      // monotonic JSONRPC id across the whole process
	outstanding := 0 // real calls parked this round, not yet answered
	received := 0

	emitToolsCall := func(reqID, name string, args map[string]any) {
		jrpcID++
		emit(out, map[string]any{
			"type":       "control_request",
			"request_id": reqID,
			"request": map[string]any{
				"subtype":     "mcp_message",
				"server_name": "juggler",
				"message": map[string]any{
					"jsonrpc": "2.0", "id": jrpcID, "method": "tools/call",
					"params": map[string]any{"name": mcpToolPrefix + name, "arguments": args},
				},
			},
		})
	}

	// startTurn emits the tool_use blocks + tools/call requests for turn idx, or
	// a terminal text turn when it has no real calls. Returns the number of real
	// (worker-driven) calls parked, which the control_response handler counts
	// down before emitting end_turn.
	startTurn := func(idx int, turn scriptTurn) int {
		real := turn.realCalls()
		if len(real) == 0 {
			emitTextTurn(out, fmt.Sprintf("done %d", idx), 1000)
			return 0
		}
		// All tool_use blocks first, then a tools/call per call, then a single
		// message_delta(stop_reason=tool_use) — mirroring the real CLI's stream
		// shape: each round dispatches its tools/call control_requests BEFORE the
		// stop_reason=tool_use pause that closes the assistant message. (This
		// ordering is load-bearing: the generation boundary is the first park
		// AFTER a pause, so a round's park must precede its own pause or it would
		// land a generation behind its result — the production strand this
		// harness must reproduce, not paper over.)
		blockIdx := 0
		for _, call := range turn.Calls {
			if call.ID == "" {
				continue // orphan: tools/call only, no tool_use block
			}
			emitToolUseBlock(out, blockIdx, call.ID, mcpToolPrefix+call.Name, call.UseArgs)
			blockIdx++
		}
		// A tools/call per call (orphans included), each tagged with a unique
		// request_id and taped against the tool_use_id it mirrors.
		emitParks := func() {
			for i, call := range turn.Calls {
				reqID := fmt.Sprintf("fake-%d-%d", idx, i)
				callArgs := call.CallArgs
				if callArgs == nil {
					callArgs = call.UseArgs
				}
				reqToTool[reqID] = call.ID
				appendTape(tapePath, tapeRecord{Event: "emit", ReqID: reqID, ToolID: call.ID, Name: call.Name})
				emitToolsCall(reqID, call.Name, callArgs)
			}
		}
		emitPause := func() {
			emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
				"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"},
			}})
		}
		// PauseBeforePark models the production single-tool wire order (pause closes
		// the message before the tools/call is dispatched); the default emits the
		// park first, then the pause.
		if turn.PauseBeforePark {
			emitPause()
			emitParks()
		} else {
			emitParks()
			emitPause()
		}
		// Autonomous wake: emit the WakeCalls as a SEPARATE unsolicited mini-turn
		// right after the real calls have parked, but before any result is fed.
		// Its first tools/call parks while the real round is still parked and
		// undelivered — opening a NEW generation (openNewGenerationLocked) that
		// bumps the generation past the real Calls still parked above, and trips
		// the out-of-band detector (a round opened while blocked on a parked
		// call). The wake's blocks start at index 0, mirroring a fresh CLI
		// message; its tools/call get `wake-` request_ids and tape records so a
		// cross-delivery onto them is caught by checkToolPairing. None are counted
		// in the returned real total. As above, tools/call precede the pause.
		if len(turn.WakeCalls) > 0 {
			wblock := 0
			for _, call := range turn.WakeCalls {
				emitToolUseBlock(out, wblock, call.ID, mcpToolPrefix+call.Name, call.UseArgs)
				wblock++
			}
			for i, call := range turn.WakeCalls {
				reqID := fmt.Sprintf("wake-%d-%d", idx, i)
				callArgs := call.CallArgs
				if callArgs == nil {
					callArgs = call.UseArgs
				}
				reqToTool[reqID] = call.ID
				appendTape(tapePath, tapeRecord{Event: "emit", ReqID: reqID, ToolID: call.ID, Name: call.Name})
				emitToolsCall(reqID, call.Name, callArgs)
			}
			emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
				"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"},
			}})
		}
		return len(real)
	}

	// emitRound emits the round at idx (a tool park or an inline text turn),
	// records it as the parked round, and advances + persists the cursor.
	emitRound := func(idx int) {
		parkedIdx = idx
		cursor = idx + 1
		// Advance the persisted cursor at PARK time, not at end_turn: if this
		// round is cut short by a cancel/restart before its result is fed, the
		// respawned process resumes at the FOLLOWING round, not re-emitting this.
		saveFakeCursor(statePath, cursor)
		outstanding = startTurn(idx, script.Turns[idx])
		received = 0
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(line, &env) != nil {
			continue
		}
		switch env.Type {
		case "user":
			if cursor >= len(script.Turns) {
				continue // exhausted script; ignore further prompts
			}
			emitRound(cursor)
		case "control_response":
			reqID := fakeExtractRequestID(line)
			appendTape(tapePath, tapeRecord{Event: "answer", ReqID: reqID, Text: fakeExtractToolResultText(line)})
			if outstanding == 0 {
				continue // stray (e.g. an orphan error-released after end_turn)
			}
			received++
			if received < outstanding {
				continue
			}
			// Crash-after-feed: the result was just answered; die abruptly with no
			// end_turn (a CLI that vanished mid-continuation). The tape already
			// records this round's answer, so a retry that re-delivers it would show
			// as a duplicate; a retry that pairs it into rebuilt history will not.
			if script.Turns[parkedIdx].ExitAfterAnswer {
				out.Flush()
				os.Exit(1)
			}
			// This round is fully answered. If it continues the same LLM turn,
			// emit the NEXT round's tool_use (the model calling another tool after
			// seeing this result) WITHOUT waiting for a user line and WITHOUT an
			// intervening end_turn — so no turn-boundary cleanup runs between them.
			// Otherwise end the turn and wait for the next user prompt.
			if script.Turns[parkedIdx].Continues && cursor < len(script.Turns) {
				emitRound(cursor)
				continue
			}
			emitTextTurn(out, fmt.Sprintf("done %d", parkedIdx), 1000)
			outstanding, received = 0, 0
			reqToTool = map[string]string{}
		}
	}
}

// appendTape writes one pairing record as a JSONL line. Best-effort: a tape
// write failure in the lone-goroutine fake must not panic it.
func appendTape(path string, rec tapeRecord) {
	if path == "" {
		return
	}
	b, _ := json.Marshal(&rec)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}

// loadFakeCursor reads the persisted next-turn index, or 0 if absent. Lets a
// respawned fake (warm --resume after a cancel/restart) continue the script
// instead of restarting it.
func loadFakeCursor(path string) int {
	if path == "" {
		return 0
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var cur struct {
		NextTurn int `json:"nextTurn"`
	}
	if json.Unmarshal(data, &cur) != nil {
		return 0
	}
	return cur.NextTurn
}

func saveFakeCursor(path string, nextTurn int) {
	if path == "" {
		return
	}
	b, _ := json.Marshal(map[string]int{"nextTurn": nextTurn})
	_ = os.WriteFile(path, b, 0o644)
}

// ─── tape reader + invariant checker (run in the test process) ───────────────

var resultTextRE = regexp.MustCompile(`RESULT::(\S+)`)

func readTape(t *testing.T, path string) []tapeRecord {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read tape: %v", err)
	}
	var out []tapeRecord
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var rec tapeRecord
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("decode tape line %q: %v", line, err)
		}
		out = append(out, rec)
	}
	return out
}

// checkToolPairing is the pure invariant: given the recorded tape and the ids
// the scenario expected delivered, it returns a violation message per breach (an
// empty slice means the pairing was perfect). Factored out of assertToolPairing
// so the checker itself is unit-testable against hand-built corrupt tapes — a
// checker with no teeth would pass every scenario silently. It enforces:
//
//   - Every delivered "RESULT::X" text landed on the call the fake emitted for X
//     (no cross-delivery). This needs no per-scenario oracle — the result text
//     names the call it belongs to.
//   - Each expected id was answered with its OWN result exactly once (no drop,
//     no duplicate delivery).
//   - No orphan call (empty tool_use_id) ever received a RESULT:: payload.
func checkToolPairing(tape []tapeRecord, deliveredIDs []string) []string {
	var violations []string

	reqToTool := map[string]string{}
	for _, r := range tape {
		if r.Event == "emit" {
			reqToTool[r.ReqID] = r.ToolID
		}
	}

	gotResultFor := map[string]int{} // tool_use_id → count of RESULT:: deliveries
	for _, r := range tape {
		if r.Event != "answer" {
			continue
		}
		m := resultTextRE.FindStringSubmatch(r.Text)
		if m == nil {
			continue // an abort/error release (orphan or interrupted) — not a RESULT
		}
		deliveredID := m[1]                // the id encoded in the result text
		landedOn, ok := reqToTool[r.ReqID] // the call that actually received it
		switch {
		case !ok:
			violations = append(violations, fmt.Sprintf("result %q delivered to unknown request_id %q (no emit recorded)", r.Text, r.ReqID))
		case landedOn == "":
			violations = append(violations, fmt.Sprintf("result %q delivered to an ORPHAN call (request_id %q) — a stash orphan poisoned a real result", r.Text, r.ReqID))
		case landedOn != deliveredID:
			violations = append(violations, fmt.Sprintf("CROSS-DELIVERY: result for %q landed on the call for %q (request_id %q)", deliveredID, landedOn, r.ReqID))
		default:
			gotResultFor[deliveredID]++
		}
	}

	for _, id := range deliveredIDs {
		switch gotResultFor[id] {
		case 1: // exactly once — correct
		case 0:
			violations = append(violations, fmt.Sprintf("tool %q was never delivered its result (dropped/stranded)", id))
		default:
			violations = append(violations, fmt.Sprintf("tool %q received its result %d times (duplicate delivery)", id, gotResultFor[id]))
		}
	}
	return violations
}

// assertToolPairing reads the tape written by a scripted-fake run and fails the
// test with one error per pairing violation.
func assertToolPairing(t *testing.T, tapePath string, deliveredIDs ...string) {
	t.Helper()
	for _, v := range checkToolPairing(readTape(t, tapePath), deliveredIDs) {
		t.Error(v)
	}
}

// ─── test-process driver ─────────────────────────────────────────────────────

// installScriptedFake points the package at the test binary acting as a scripted
// fake claude, passing the behaviour script inline and a per-test tape path.
// Returns the tape path the invariant checker reads.
func installScriptedFake(t *testing.T, script fakeScript) (tapePath string) {
	t.Helper()
	scriptJSON, err := json.Marshal(&script)
	if err != nil {
		t.Fatalf("marshal script: %v", err)
	}
	dir := t.TempDir()
	tapePath = dir + "/pairing.tape.jsonl"
	restore := SetBinaryPathForTesting(fakeCLIPath,
		envFakeClaude+"=1",
		envFakeMode+"="+fakeModeScript,
		envFakeSession+"=uuid-script",
		envFakeScript+"="+string(scriptJSON),
		envFakeTape+"="+tapePath,
		envFakeState+"="+dir+"/cursor.json",
	)
	t.Cleanup(restore)
	return tapePath
}

// submission is one user prompt and the LLM turn it triggers. rounds is the
// sequence of tool rounds the turn goes through before ending: one element ⇒ a
// normal single-round tool turn; several ⇒ a multi-round turn (the model calls
// another tool after seeing each result, with NO end_turn between rounds — the
// case discardStaleBuffers does not clean up mid-flight). rounds empty ⇒ a
// text-only turn. cancel ⇒ interrupt at the first park instead of feeding.
type submission struct {
	rounds [][]scriptCall
	cancel bool
	// pauseBeforePark flips every round in this submission to the production
	// single-tool wire order (stop_reason=tool_use pause emitted before the
	// tools/call park). See scriptTurn.PauseBeforePark.
	pauseBeforePark bool
}

// toolScenario describes one permutation: a sequence of user submissions.
type toolScenario struct {
	name string
	subs []submission
}

// script flattens the scenario into the fake's per-round program, marking every
// round but the last in a multi-round submission as Continues so the fake
// auto-emits the next round instead of ending the turn.
func (sc toolScenario) script() fakeScript {
	var turns []scriptTurn
	for _, sub := range sc.subs {
		if len(sub.rounds) == 0 {
			turns = append(turns, scriptTurn{}) // text turn
			continue
		}
		for j, calls := range sub.rounds {
			turns = append(turns, scriptTurn{
				Calls:           calls,
				Continues:       j < len(sub.rounds)-1,
				PauseBeforePark: sub.pauseBeforePark,
			})
		}
	}
	return fakeScript{Turns: turns}
}

// deliveredIDs returns every real tool_use_id the scenario expects to be cleanly
// delivered: orphans (no id) and cancelled submissions are excluded, since those
// calls are error-released, not answered with their result.
func (sc toolScenario) deliveredIDs() []string {
	var ids []string
	for _, sub := range sc.subs {
		if sub.cancel {
			continue
		}
		for _, round := range sub.rounds {
			for _, c := range (scriptTurn{Calls: round}).realCalls() {
				ids = append(ids, c.ID)
			}
		}
	}
	return ids
}

// driveToolScenario runs the scenario against the scripted fake subprocess. For
// each submission it sends the user prompt, then reacts to whatever the fake
// parks: it feeds "RESULT::<id>" for every pending tool and loops as long as the
// turn keeps parking more tool rounds, until end_turn. The message list grows
// cumulatively so submissions 2+ resume warm. It is deliberately reactive — it
// trusts pendingTools, not the script — so a mis-park surfaces as a pending-id
// mismatch and a mis-delivery surfaces on the tape.
func driveToolScenario(t *testing.T, c *Client, convID string, sc toolScenario) {
	t.Helper()
	ctx := context.Background()
	var convo []provider.Message

	send := func(msgs []provider.Message) (*provider.StreamResult, error) {
		return c.streamMessage(ctx, provider.MessageRequest{
			ConversationID: convID, SystemPrompt: "sys", Messages: msgs,
		}, nopCallback())
	}

	for si, sub := range sc.subs {
		convo = append(convo, userMsg(fmt.Sprintf("q%d", si)))
		res, err := send(convo)
		if err != nil {
			t.Fatalf("%s sub %d (prompt): %v", sc.name, si, err)
		}

		if len(sub.rounds) == 0 { // text turn
			if res.StopReason != "end_turn" {
				t.Fatalf("%s sub %d: text turn StopReason = %q, want end_turn", sc.name, si, res.StopReason)
			}
			convo = append(convo, assistantMsg("ack"))
			continue
		}

		if res.StopReason != "tool_use" {
			t.Fatalf("%s sub %d: StopReason = %q, want tool_use", sc.name, si, res.StopReason)
		}

		// Cancel axis: interrupt at the first park. The parked call is
		// error-released (never gets its RESULT); the session stays warm and the
		// next submission must resume cleanly. The committed prefix is whatever we
		// fed, which convo already equals, so the next submission is a warm delta.
		if sub.cancel {
			conv, err := c.OpenConversation(ctx, convID)
			if err != nil {
				t.Fatalf("%s sub %d: OpenConversation: %v", sc.name, si, err)
			}
			conv.Cancel("")
			continue
		}

		// Feed every parked round in turn until the model ends the turn.
		roundIdx := 0
		for res.StopReason == "tool_use" {
			if roundIdx >= len(sub.rounds) {
				t.Fatalf("%s sub %d: parked round %d beyond script (%d rounds)", sc.name, si, roundIdx, len(sub.rounds))
			}
			wantIDs := idsOf((scriptTurn{Calls: sub.rounds[roundIdx]}).realCalls())
			if got := pendingIDs(c.activeSession); !equalStrings(got, wantIDs) {
				t.Fatalf("%s sub %d round %d: pendingTools = %v, want %v", sc.name, si, roundIdx, got, wantIDs)
			}
			for _, p := range c.activeSession.pendingTools {
				convo = append(convo, toolUseMsg(p.ID, p.Name))
			}
			for _, p := range c.activeSession.pendingTools {
				convo = append(convo, toolResultMsg(p.ID, "RESULT::"+p.ID))
			}
			res, err = send(convo)
			if err != nil {
				t.Fatalf("%s sub %d round %d (feed): %v", sc.name, si, roundIdx, err)
			}
			roundIdx++
		}
		if res.StopReason != "end_turn" {
			t.Fatalf("%s sub %d: final StopReason = %q, want end_turn", sc.name, si, res.StopReason)
		}
		convo = append(convo, assistantMsg("ack"))
	}

	c.dropSession(convID)
}

func idsOf(calls []scriptCall) []string {
	ids := []string{}
	for _, c := range calls {
		if c.ID != "" {
			ids = append(ids, c.ID)
		}
	}
	return ids
}

func pendingIDs(sess *activeSession) []string {
	if sess == nil {
		return nil
	}
	ids := make([]string, len(sess.pendingTools))
	for i, p := range sess.pendingTools {
		ids[i] = p.ID
	}
	return ids
}

func equalStrings(a, b []string) bool {
	return slices.Equal(a, b)
}

// TestToolDeliveryPermutations drives a matrix of tool-delivery shapes through a
// real scripted fake subprocess and asserts the same fidelity invariant over all
// of them: every tool_use_id is answered exactly once with its own result, never
// crossed, dropped, or duplicated. Each scenario exercises a different stressor
// of the (name+args)-keyed FIFO router and the turn-boundary orphan clear.
func TestToolDeliveryPermutations(t *testing.T) {
	scenarios := []toolScenario{
		{
			name: "single",
			subs: []submission{{rounds: [][]scriptCall{{bashCall("t1", "echo 1")}}}},
		},
		{
			name: "parallel-distinct",
			subs: []submission{{rounds: [][]scriptCall{{
				bashCall("t1", "echo 1"), bashCall("t2", "echo 2"), bashCall("t3", "echo 3"),
			}}}},
		},
		{
			// Two calls with IDENTICAL (name+args): the content key cannot tell
			// them apart, so correctness rests on FIFO arrival order.
			name: "parallel-identical-args",
			subs: []submission{{rounds: [][]scriptCall{{
				bashCall("t1", "git status"), bashCall("t2", "git status"),
			}}}},
		},
		{
			// The tool_use block records args A in pendingTools while the
			// tools/call parks args B — arg-drift across a resume/restart. The
			// exact-key match misses; the same-tool-name fallback must deliver.
			name: "arg-drift",
			subs: []submission{{rounds: [][]scriptCall{{driftCall("t1", "echo A", "echo B-drifted")}}}},
		},
		{
			// An orphan tools/call (no tool_use block) parks alongside a real
			// call. The worker never drives the orphan; discardStaleBuffers must
			// error-release it at end_turn so it can't be drained by a later
			// same-tool call. The next turn's real call must get ITS result.
			name: "orphan-park-then-clean-turn",
			subs: []submission{
				{rounds: [][]scriptCall{{bashCall("t1", "echo 1"), orphanCall("ghost")}}},
				{rounds: [][]scriptCall{{bashCall("t2", "echo 2")}}},
			},
		},
		{
			// Two sequential single-tool turns on the same warm CLI: the parked
			// queue spans the session while pendingTools is rebuilt per turn, so
			// the consuming FIFO must answer the right call each turn.
			name: "cross-turn-sequential",
			subs: []submission{
				{rounds: [][]scriptCall{{bashCall("t1", "echo 1")}}},
				{rounds: [][]scriptCall{{bashCall("t2", "echo 2")}}},
			},
		},
		{
			// A text turn between two tool turns must not disturb the pairing.
			name: "tool-text-tool",
			subs: []submission{
				{rounds: [][]scriptCall{{bashCall("t1", "echo 1")}}},
				{},
				{rounds: [][]scriptCall{{bashCall("t2", "echo 2")}}},
			},
		},
		{
			// Cancel a parked tool, then continue: the cancelled call (t1) is
			// error-released and must NEVER have its (absent) result crossed to
			// the next turn's call (t2), which resumes warm and gets its own.
			name: "cancel-then-continue",
			subs: []submission{
				{rounds: [][]scriptCall{{bashCall("t1", "echo 1")}}, cancel: true},
				{rounds: [][]scriptCall{{bashCall("t2", "echo 2")}}},
			},
		},
		{
			// MULTI-ROUND turn: the model calls t1, sees the result, then calls t2
			// in the SAME turn (no end_turn between). pendingTools is rebuilt per
			// round; the parked queue must not leak round 1 into round 2.
			name: "multi-round",
			subs: []submission{{rounds: [][]scriptCall{
				{bashCall("t1", "echo 1")},
				{bashCall("t2", "echo 2")},
			}}},
		},
		{
			// THE BUG HUNT: a multi-round turn where round 1 leaves an orphan
			// parked and round 2's real call has DRIFTED args. discardStaleBuffers
			// only runs at end_turn, so round 1's orphan is still parked when
			// round 2's result arrives; with arg-drift the exact-key match misses
			// and the same-tool-name fallback could drain the STALE orphan instead
			// of round 2's real call — a mid-turn cross-delivery the turn-boundary
			// clear cannot prevent. The invariant must hold or this is a real bug.
			name: "multi-round-orphan-then-drift",
			subs: []submission{{rounds: [][]scriptCall{
				{bashCall("t1", "echo 1"), orphanCall("stale-ghost")},
				{driftCall("t2", "echo 2", "echo 2-drifted")},
			}}},
		},
		{
			// Same hazard without drift: round 1 orphan is same-tool as round 2's
			// real call. Exact-key should still match round 2 first; this guards
			// that the orphan isn't preferred by position.
			name: "multi-round-orphan-then-clean",
			subs: []submission{{rounds: [][]scriptCall{
				{bashCall("t1", "echo 1"), orphanCall("stale-ghost")},
				{bashCall("t2", "echo 2")},
			}}},
		},
		{
			// THE BUG HUNT (exact-key path): round 1's orphan has the SAME args as
			// round 2's real call. Round 2's exact-key match would, by FIFO, pick
			// the OLDER orphan over the real call — a cross-delivery on the exact
			// path, not the name fallback. Generation scoping must exclude the
			// prior-round orphan so round 2's own call is matched.
			name: "multi-round-orphan-identical-args",
			subs: []submission{{rounds: [][]scriptCall{
				{bashCall("t1", "echo 1"), orphanCall("echo 2")},
				{bashCall("t2", "echo 2")},
			}}},
		},
		{
			// Three tool rounds in one turn, each leaving a same-tool orphan
			// behind: stresses that generation scoping keeps every round paired to
			// its own call as orphans accumulate across the turn.
			name: "multi-round-deep-orphans",
			subs: []submission{{rounds: [][]scriptCall{
				{bashCall("t1", "echo 1"), orphanCall("echo 9")},
				{bashCall("t2", "echo 2"), orphanCall("echo 9")},
				{bashCall("t3", "echo 3")},
			}}},
		},
		{
			// PRODUCTION WIRE ORDER: the stop_reason=tool_use pause is emitted
			// before the tools/call park (the order the logs show for single-tool
			// rounds). The pause latches roundClosed while the call is unparked, so
			// the park opens the new generation — the result must still pair. End to
			// end proof the provider handles the real ordering, which the rest of
			// the suite (park-before-pause) never exercises.
			name: "pause-before-park-single",
			subs: []submission{{
				rounds:          [][]scriptCall{{bashCall("t1", "echo 1")}},
				pauseBeforePark: true,
			}},
		},
		{
			// The same wire order across a multi-round turn: every round closes its
			// message before its call parks, so each round's park opens its own
			// generation. Each result must pair with its own call with no strand.
			name: "pause-before-park-multi-round",
			subs: []submission{{
				rounds: [][]scriptCall{
					{bashCall("t1", "echo 1")},
					{bashCall("t2", "echo 2")},
				},
				pauseBeforePark: true,
			}},
		},
	}

	for _, sc := range scenarios {
		sc := sc
		t.Run(sc.name, func(t *testing.T) {
			tapePath := installScriptedFake(t, sc.script())
			c := mkClient(t, "claude-sonnet-4-6")
			driveToolScenario(t, c, "conv-"+sc.name, sc)
			assertToolPairing(t, tapePath, sc.deliveredIDs()...)
		})
	}
}

// TestCheckToolPairingHasTeeth proves the invariant checker actually detects the
// failure modes the harness exists to catch — a checker that silently passes
// every corrupt tape would make every permutation above meaningless. Each case
// hand-builds a tape exhibiting one breach and asserts checkToolPairing reports
// it; the clean tape must report nothing.
func TestCheckToolPairingHasTeeth(t *testing.T) {
	emit := func(req, id string) tapeRecord { return tapeRecord{Event: "emit", ReqID: req, ToolID: id} }
	answer := func(req, text string) tapeRecord { return tapeRecord{Event: "answer", ReqID: req, Text: text} }

	cases := []struct {
		name      string
		tape      []tapeRecord
		delivered []string
		wantClean bool
		wantMatch string
	}{
		{
			name:      "clean",
			tape:      []tapeRecord{emit("r1", "t1"), emit("r2", "t2"), answer("r1", "RESULT::t1"), answer("r2", "RESULT::t2")},
			delivered: []string{"t1", "t2"},
			wantClean: true,
		},
		{
			name:      "cross-delivery",
			tape:      []tapeRecord{emit("r1", "t1"), emit("r2", "t2"), answer("r1", "RESULT::t2"), answer("r2", "RESULT::t1")},
			delivered: []string{"t1", "t2"},
			wantMatch: "CROSS-DELIVERY",
		},
		{
			name:      "dropped",
			tape:      []tapeRecord{emit("r1", "t1"), emit("r2", "t2"), answer("r1", "RESULT::t1")},
			delivered: []string{"t1", "t2"},
			wantMatch: "never delivered",
		},
		{
			name:      "duplicate",
			tape:      []tapeRecord{emit("r1", "t1"), answer("r1", "RESULT::t1"), answer("r1", "RESULT::t1")},
			delivered: []string{"t1"},
			wantMatch: "received its result 2 times",
		},
		{
			name:      "orphan-poisoned",
			tape:      []tapeRecord{emit("r1", ""), answer("r1", "RESULT::t1")},
			delivered: nil,
			wantMatch: "ORPHAN",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := checkToolPairing(tc.tape, tc.delivered)
			if tc.wantClean {
				if len(got) != 0 {
					t.Fatalf("clean tape reported violations: %v", got)
				}
				return
			}
			if len(got) == 0 {
				t.Fatalf("corrupt tape (%s) reported NO violation — checker has no teeth", tc.name)
			}
			if !strings.Contains(strings.Join(got, " | "), tc.wantMatch) {
				t.Fatalf("violation %v did not mention %q", got, tc.wantMatch)
			}
		})
	}
}

// TestToolDeliveryInterjection covers the queued/interjected-user-message axis:
// the user types a new message while a tool is parked. This routes the turn AWAY
// from regimeContinue. Specifically, when the continuation carries the parked
// tool's result PLUS a trailing user message, classifyRegime picks warm-append
// (regimeResumeAppendResult): the delta carries a tool_result that closes the
// warm transcript's dangling tool_use, so it can't be piped as a stdin delta
// (see regime.go deltaCarriesToolResult) but CAN be paired into the warm session
// file. The parked tools/call is abandoned over the control protocol (teardown
// error-releases it), the result is appended into the file and the same uuid
// re-resumed (cache stays warm), and a NEW control protocol instance is spun up.
// (When no real ~/.claude session file exists — as in this scripted fake — the
// append finds nothing and the dispatch falls back to a fresh synthetic resume,
// same observable outcome.)
//
// The fidelity invariant under interjection: an abandoned tool's parked call
// must NEVER absorb a real RESULT:: over the control protocol (it is error-
// released, then its result is delivered through rebuilt history instead), no
// result is ever crossed onto another call, and any tool that IS cleanly
// delivered (an earlier round, or a later normal turn) gets its own result
// exactly once. Abandoned ids are therefore excluded from the checker's
// deliveredIDs, and asserted-absent from the tape via assertNotDeliveredLive.
func TestToolDeliveryInterjection(t *testing.T) {
	// assertRoutedAway confirms the interjecting continuation does NOT route to
	// regimeContinue, and matches the expected away-regime — the behaviour the
	// rest of the scenario's assertions depend on.
	assertRoutedAway := func(t *testing.T, c *Client, msgs []provider.Message, want streamRegime, label string) {
		t.Helper()
		dec := classifyRegime(c.activeSession, c.model, "sys", msgs, c.activeSession.hasLiveCLI())
		if dec.Regime == regimeContinue {
			t.Fatalf("%s: classifyRegime = regimeContinue; an interjection MUST route away from continue", label)
		}
		if dec.Regime != want {
			t.Fatalf("%s: classifyRegime = %d (reason=%q), want %d", label, dec.Regime, dec.Reason, want)
		}
	}

	// ── single parked tool, then interjection ───────────────────────────────
	t.Run("single-then-interject", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1")}}, // turn 0: parks t1
			{}, // turn 1: interjection response (text end_turn)
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-interject-single"

		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t1"}) {
			t.Fatalf("pending = %v, want [t1]", got)
		}

		// Interjection: t1's result closes the warm transcript's dangling tool_use
		// and a trailing user message follows. Routes to warm-append
		// (regimeResumeAppendResult): the result is paired into the warm session
		// file and the user message piped on stdin; t1's parked call is abandoned
		// (error-released) on the old wire, never delivered live.
		cont := []provider.Message{
			userMsg("q0"),
			toolUseMsg("t1", "bash"),
			toolResultMsg("t1", "RESULT::t1"),
			userMsg("actually, never mind — do this instead"),
		}
		assertRoutedAway(t, c, cont, regimeResumeAppendResult, "single interjection")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("interjection turn: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape) // nothing delivered live this scenario
		assertNotDeliveredLive(t, tape, "t1")
		c.dropSession(convID)
	})

	// ── parallel parked tools, then interjection ────────────────────────────
	t.Run("parallel-then-interject", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1"), bashCall("t2", "echo 2")}}, // turn 0: parks t1,t2
			{}, // turn 1: interjection response
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-interject-parallel"

		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t1", "t2"}) {
			t.Fatalf("pending = %v, want [t1 t2]", got)
		}

		// Both results present (closing the warm transcript's dangling t1+t2), then
		// a trailing user message → warm-append (regimeResumeAppendResult). Both
		// parked calls are abandoned; neither result crosses the wire.
		cont := []provider.Message{
			userMsg("q0"),
			toolUseMsg("t1", "bash"),
			toolUseMsg("t2", "bash"),
			toolResultMsg("t1", "RESULT::t1"),
			toolResultMsg("t2", "RESULT::t2"),
			userMsg("stop, do something else"),
		}
		assertRoutedAway(t, c, cont, regimeResumeAppendResult, "parallel interjection")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("interjection turn: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape)
		assertNotDeliveredLive(t, tape, "t1", "t2")
		c.dropSession(convID)
	})

	// ── interjection, then a LATER turn that uses a real tool ────────────────
	// The session must keep working after an interjection: the later turn parks
	// a fresh tool that gets ITS OWN result over the (now new) control protocol,
	// never the abandoned tool's.
	t.Run("interject-then-later-real-tool", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1")}}, // turn 0: parks t1 (abandoned)
			{}, // turn 1: interjection response (text)
			{Calls: []scriptCall{bashCall("t3", "echo 3")}}, // turn 2: later real tool
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-interject-later"

		// Park t1.
		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
		}

		// Interject (abandons t1's parked call, warm-appends its result).
		cont := []provider.Message{
			userMsg("q0"),
			toolUseMsg("t1", "bash"),
			toolResultMsg("t1", "RESULT::t1"),
			userMsg("never mind"),
		}
		assertRoutedAway(t, c, cont, regimeResumeAppendResult, "interjection before later tool")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("interjection turn: StopReason = %q, want end_turn", res.StopReason)
		}

		// Later turn extends the committed history with a fresh user prompt; it
		// resumes warm and parks t3, which must get its own result cleanly.
		later := append(append([]provider.Message{}, cont...), assistantMsg("ack"), userMsg("q2"))
		if res := sendMsg(t, c, convID, later); res.StopReason != "tool_use" {
			t.Fatalf("later turn park t3: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t3"}) {
			t.Fatalf("later pending = %v, want [t3]", got)
		}
		feed := append(append([]provider.Message{}, later...), toolUseMsg("t3", "bash"), toolResultMsg("t3", "RESULT::t3"))
		assertRegime(t, c, feed, regimeContinue, "", "later turn feed t3")
		if res := sendMsg(t, c, convID, feed); res.StopReason != "end_turn" {
			t.Fatalf("later turn feed t3: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape, "t3") // t3 delivered exactly once to its own call
		assertNotDeliveredLive(t, tape, "t1")
		c.dropSession(convID)
	})

	// ── multi-round turn: round 1 completes, then interjection before round 2 ─
	// t1 (round 1) is cleanly delivered over the control protocol; t2 (round 2)
	// is parked when the user interjects, so it is abandoned. t1 must keep its
	// own result; t2 must not be delivered live.
	t.Run("multiround-interject-before-round2", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1")}, Continues: true}, // round 1
			{Calls: []scriptCall{bashCall("t2", "echo 2")}},                  // round 2 (parked, abandoned)
			{}, // interjection response (text)
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-interject-multiround"

		// Park round 1 (t1).
		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
		}
		// Feed t1 → regimeContinue delivers RESULT::t1, model parks round 2 (t2).
		feed1 := []provider.Message{
			userMsg("q0"),
			toolUseMsg("t1", "bash"),
			toolResultMsg("t1", "RESULT::t1"),
		}
		assertRegime(t, c, feed1, regimeContinue, "", "round-1 feed (clean continue)")
		if res := sendMsg(t, c, convID, feed1); res.StopReason != "tool_use" {
			t.Fatalf("round 1 feed: StopReason = %q, want tool_use (round 2 parks)", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t2"}) {
			t.Fatalf("round 2 pending = %v, want [t2]", got)
		}

		// Interject before feeding round 2: t2's result (closing the warm
		// transcript's dangling t2) + a trailing user msg → warm-append
		// (regimeResumeAppendResult). t2's parked call is abandoned.
		cont := append(append([]provider.Message{}, feed1...),
			toolUseMsg("t2", "bash"),
			toolResultMsg("t2", "RESULT::t2"),
			userMsg("hold on — different question"),
		)
		assertRoutedAway(t, c, cont, regimeResumeAppendResult, "interjection before round 2")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("interjection turn: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape, "t1") // t1 (round 1) delivered exactly once
		assertNotDeliveredLive(t, tape, "t2")
		c.dropSession(convID)
	})
}

// TestToolDeliveryRestart covers the restart-mid-park axis: the live CLI is torn
// down (app quit+restart, crash, watchdog re-exec) while a tool is parked, then
// the conversation continues. Tearing down the live CLI abandons the parked
// tools/call via control.teardown() AND clears pendingTools (sidecar-rebuild
// semantics — doTearDownLiveCLI nils s.live + s.pendingTools, cli_lifecycle.go),
// so the next turn cannot route through regimeContinue (no live CLI, no
// pendingTools). A continuation carrying the parked tool's result therefore
// routes to regimeStartFresh: the delta carries a tool_result, which cannot be
// piped as a stdin delta (regime.go deltaCarriesToolResult), so the result is
// paired into rebuilt history by the synthetic resume and a BRAND-NEW
// controlProtocol instance is spun up for the respawned CLI.
//
// The cross-instance guarantee this exercises: a pre-restart parked call lives on
// the OLD (now-torn-down) controlProtocol; the respawned CLI gets a fresh one. The
// abandoned tool's tools/call is never re-emitted (the fake's persisted cursor has
// advanced past it), so its RESULT:: can never appear on the tape at all — proving
// no post-restart result can reach a pre-restart call.
//
// Invariant in every case: no RESULT:: is crossed onto another call; a tool
// abandoned by the restart is never delivered over the control protocol (excluded
// from deliveredIDs, asserted-absent via assertNotDeliveredLive); any tool cleanly
// delivered — before the restart, or on a later warm turn — gets its own result
// exactly once.
func TestToolDeliveryRestart(t *testing.T) {
	// restart models a real app restart / crash / watchdog re-exec mid-park: it
	// drives tearDownLiveCLI exactly as runPersistentResumeTurn/handleCancel do,
	// which error-releases the parked tools/call on the OLD control protocol and
	// drops pendingTools. The resume anchor + sessionUUID survive, as they would
	// when the session is rebuilt from the sidecar after a restart.
	restart := func(t *testing.T, c *Client) {
		t.Helper()
		c.activeSession.tearDownLiveCLI()
		if c.activeSession.hasLiveCLI() {
			t.Fatal("restart: live CLI still attached after tearDownLiveCLI")
		}
		if got := pendingIDs(c.activeSession); len(got) != 0 {
			t.Fatalf("restart: pendingTools survived teardown = %v (a sidecar rebuild drops them)", got)
		}
	}

	// ── park a tool, restart, continue feeding its result ───────────────────
	t.Run("park-restart-continue", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1")}}, // turn 0: parks t1
			{}, // turn 1: post-restart fresh-resume response (text end_turn)
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-restart-single"

		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t1"}) {
			t.Fatalf("pending = %v, want [t1]", got)
		}

		restart(t, c)

		// Continue feeding t1's result. No live CLI + a tool_result-bearing delta
		// whose result closes the warm transcript's dangling t1 → warm-append
		// (regimeResumeAppendResult): the result is paired into the warm session
		// file and the same uuid re-resumed; t1 is NOT delivered over the (new)
		// control protocol. (The scripted fake writes no real ~/.claude session
		// file, so the dispatch falls back to a fresh synthetic resume — same
		// observable outcome — but the classification is warm-append.)
		cont := []provider.Message{
			userMsg("q0"),
			toolUseMsg("t1", "bash"),
			toolResultMsg("t1", "RESULT::t1"),
		}
		assertRegime(t, c, cont, regimeResumeAppendResult, "", "continue after restart")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("post-restart continue: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape) // nothing delivered live this scenario
		assertNotDeliveredLive(t, tape, "t1")
		c.dropSession(convID)
	})

	// ── restart mid-park, then a follow-up turn with a NEW tool ──────────────
	// The session must keep working after a restart: the later turn parks a fresh
	// tool that gets ITS OWN result cleanly over the new control protocol via
	// regimeContinue, never the abandoned tool's.
	t.Run("restart-then-later-real-tool", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1")}}, // turn 0: parks t1 (abandoned)
			{}, // turn 1: post-restart response (text)
			{Calls: []scriptCall{bashCall("t3", "echo 3")}}, // turn 2: later real tool
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-restart-later"

		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
		}
		restart(t, c)

		cont := []provider.Message{
			userMsg("q0"),
			toolUseMsg("t1", "bash"),
			toolResultMsg("t1", "RESULT::t1"),
		}
		assertRegime(t, c, cont, regimeResumeAppendResult, "", "continue after restart")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("post-restart continue: StopReason = %q, want end_turn", res.StopReason)
		}

		// Later turn extends the committed history with a fresh user prompt; it
		// resumes warm and parks t3, which must get its own result cleanly.
		later := append(append([]provider.Message{}, cont...), assistantMsg("ack"), userMsg("q2"))
		assertRegime(t, c, later, regimeResumeDelta, "", "later warm resume")
		if res := sendMsg(t, c, convID, later); res.StopReason != "tool_use" {
			t.Fatalf("later park t3: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t3"}) {
			t.Fatalf("later pending = %v, want [t3]", got)
		}
		feed := append(append([]provider.Message{}, later...), toolUseMsg("t3", "bash"), toolResultMsg("t3", "RESULT::t3"))
		assertRegime(t, c, feed, regimeContinue, "", "later feed t3")
		if res := sendMsg(t, c, convID, feed); res.StopReason != "end_turn" {
			t.Fatalf("later feed t3: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape, "t3") // t3 delivered exactly once to its own call
		assertNotDeliveredLive(t, tape, "t1")
		c.dropSession(convID)
	})

	// ── parallel tools parked, restart, continue ────────────────────────────
	t.Run("parallel-restart-continue", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1"), bashCall("t2", "echo 2")}}, // turn 0: parks t1,t2
			{}, // turn 1: post-restart response
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-restart-parallel"

		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t1", "t2"}) {
			t.Fatalf("pending = %v, want [t1 t2]", got)
		}

		restart(t, c)

		// Both results present, no live CLI, and they close the warm transcript's
		// dangling t1+t2 → warm-append (regimeResumeAppendResult): both results are
		// paired into the warm file. Both parked calls were error-released by
		// teardown; neither result crosses the new wire.
		cont := []provider.Message{
			userMsg("q0"),
			toolUseMsg("t1", "bash"),
			toolUseMsg("t2", "bash"),
			toolResultMsg("t1", "RESULT::t1"),
			toolResultMsg("t2", "RESULT::t2"),
		}
		assertRegime(t, c, cont, regimeResumeAppendResult, "", "continue after restart (parallel)")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("post-restart continue: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape)
		assertNotDeliveredLive(t, tape, "t1", "t2")
		c.dropSession(convID)
	})

	// ── multi-round turn: round 0 delivered, restart before round 1's feed ───
	// t1 (round 0) is cleanly delivered over the OLD control protocol; t2 (round
	// 1) is parked when the CLI is torn down, so it is abandoned. t1 must keep its
	// own result; t2 must never be delivered live on the new control protocol.
	t.Run("multiround-restart-between-rounds", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1")}, Continues: true}, // round 0: t1 (delivered live)
			{Calls: []scriptCall{bashCall("t2", "echo 2")}},                  // round 1: t2 (parked, abandoned)
			{}, // turn 2: post-restart response (text)
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-restart-multiround"

		// Park round 0 (t1).
		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
		}
		// Feed t1 → regimeContinue delivers RESULT::t1 over the OLD control
		// protocol; the model then parks round 1 (t2).
		feed1 := []provider.Message{
			userMsg("q0"),
			toolUseMsg("t1", "bash"),
			toolResultMsg("t1", "RESULT::t1"),
		}
		assertRegime(t, c, feed1, regimeContinue, "", "round-0 feed (clean continue)")
		if res := sendMsg(t, c, convID, feed1); res.StopReason != "tool_use" {
			t.Fatalf("round 0 feed: StopReason = %q, want tool_use (round 1 parks)", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t2"}) {
			t.Fatalf("round 1 pending = %v, want [t2]", got)
		}

		// Restart between round 1's park and its feed: t2's parked call is error-
		// released on the OLD control protocol.
		restart(t, c)

		cont := append(append([]provider.Message{}, feed1...),
			toolUseMsg("t2", "bash"),
			toolResultMsg("t2", "RESULT::t2"),
		)
		assertRegime(t, c, cont, regimeResumeAppendResult, "", "continue round 1 after restart")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("post-restart continue: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape, "t1") // t1 delivered exactly once, before the restart
		assertNotDeliveredLive(t, tape, "t2")
		c.dropSession(convID)
	})
}

// TestToolDeliveryConcurrent stresses the two-goroutine concurrency core of the
// control protocol under -race: the always-on stdout READER (reader.go —
// handleControlRequest parks each tools/call, handleControlResponse routes acks,
// and noteToolUsePause latches each stop_reason=tool_use pause so the next park
// opens a new round) racing the WORKER (streamMessage's deliverNextToolResult /
// writeUserDelta / discardStaleBuffers), on ONE session's controlProtocol. That
// reader-vs-worker overlap on a single session is the real production race
// surface. Both goroutines mutate the protocol's state ONLY through the single
// runOnActor mailbox (no mutex — controlProtocol.run is the sole owner), so this
// test exists to shake out, under -race, any unsynchronised field access OR any
// FIFO/generation correctness break when many park / deliver / pause commands
// interleave on that mailbox.
//
// The genuine concurrency window is INTRA-session and INTRA-round: while the
// worker delivers round N's results (deliverNextToolResult), the reader is still
// parking round N's tools/call frames (recordPendingToolCall) — the documented
// result-before-call stash race — and both entries are stamped with the same
// currentGeneration (opened at this round's first park). The scripted fake's outstanding-count
// gating serialises ROUND boundaries (round N+1's tool_use is only emitted after
// every round-N control_response is received), so generations never overlap; what
// overlaps is the park/deliver/stash traffic WITHIN a generation. That is exactly
// the overlap deliverNextToolResultLocked / recordPendingToolCallLocked /
// openNewGenerationLocked must survive, and -race instruments every field touch on it.
//
// SINGLE-CONFIG by necessity: installScriptedFake sets PACKAGE-GLOBAL state
// (SetBinaryPathForTesting's claudeBinaryPath + testExtraSpawnEnv, plus the global
// fake script/tape/state env), so iterations run STRICTLY SEQUENTIALLY and this
// test never calls t.Parallel — each iteration installs its own fake+tape, drives
// one session to completion (reader and worker goroutines overlap inside that one
// drive), and asserts the fidelity invariant before the next iteration clobbers
// the globals. Cross-session parallelism is deliberately NOT attempted: it cannot
// be made race-free while the fake config is a single global, and it would not add
// coverage — the production race is the intra-session reader/worker overlap, which
// each drive already exercises. Stress instead comes from breadth (15 parallel
// parks in one round → a deep same-key FIFO answered while later calls still park)
// and depth (many rounds → many generation bumps interleaved with
// deliveries), repeated over an internal loop; raise -count to widen the search.
func TestToolDeliveryConcurrent(t *testing.T) {
	// highFanout parks 15 parallel tool calls in ONE round: three interleaved
	// identical-(name,args) clusters ("git status", "ls -la") plus distinct
	// "echo i" calls. The identical clusters share a match key, so correctness
	// rests entirely on FIFO arrival order — and that FIFO is consumed by the
	// worker (deliverNextToolResult) while the reader is still appending later
	// parks (recordPendingToolCall) to the same slice. A deep same-key queue
	// maximises the window for a park/deliver interleaving to mis-pair under race.
	highFanout := func() toolScenario {
		var calls []scriptCall
		for i := 0; i < 15; i++ {
			id := fmt.Sprintf("h%02d", i)
			var cmd string
			switch i % 3 {
			case 0:
				cmd = "git status" // identical-args cluster A
			case 1:
				cmd = "ls -la" // identical-args cluster B
			default:
				cmd = fmt.Sprintf("echo %d", i) // distinct args
			}
			calls = append(calls, bashCall(id, cmd))
		}
		return toolScenario{
			name: "high-fanout-single-round",
			subs: []submission{{rounds: [][]scriptCall{calls}}},
		}
	}

	// multiRoundFanout builds ONE multi-round LLM turn (no end_turn between rounds,
	// so discardStaleBuffers never runs mid-flight) of `rounds` rounds, each parking
	// two real calls + one same-tool ORPHAN. Every round adds a generation
	// bump, and the shape is built to defeat anything but correct generation scoping:
	//   - realB carries identical args ("shared") in EVERY round, so the same exact
	//     match key has a live entry in every generation at once — only generation
	//     scoping keeps round k's "shared" result from draining an earlier round's
	//     leftover same-key call.
	//   - round k's orphan args ("echo k+1") equal round k+1's realA args, so the
	//     stale prior-round orphan is a same-key DECOY for the next round's real
	//     call. Generation scoping must make that older-generation orphan invisible
	//     to round k+1's exact-key match; otherwise realA's result poisons the
	//     orphan — a mid-turn cross-delivery the end_turn-only discardStaleBuffers
	//     cannot prevent. This is the generation-scoping path's load-bearing job,
	//     here driven concurrently across many rounds.
	multiRoundFanout := func(rounds int) toolScenario {
		var rs [][]scriptCall
		for k := 0; k < rounds; k++ {
			rs = append(rs, []scriptCall{
				bashCall(fmt.Sprintf("m%02dA", k), fmt.Sprintf("echo %d", k)),
				bashCall(fmt.Sprintf("m%02dB", k), "shared"),
				orphanCall(fmt.Sprintf("echo %d", k+1)), // same-key decoy for round k+1's realA
			})
		}
		return toolScenario{
			name: "multiround-high-fanout",
			subs: []submission{{rounds: rs}},
		}
	}

	// stress drives `iters` independent sessions through sc, each on a fresh
	// fake+tape+client, asserting the fidelity invariant after every drive. The
	// reader/worker overlap lives inside each driveToolScenario call; the loop just
	// repeats it so a low-probability interleaving has many chances to surface under
	// -race. Sequential by necessity (shared global fake config). Bails on the first
	// broken iteration with its index, so a flake is pinned rather than averaged out.
	stress := func(t *testing.T, sc toolScenario, iters int) {
		t.Helper()
		for i := 0; i < iters; i++ {
			tapePath := installScriptedFake(t, sc.script())
			c := mkClient(t, "claude-sonnet-4-6")
			convID := fmt.Sprintf("conv-%s-%d", sc.name, i)
			driveToolScenario(t, c, convID, sc)
			assertToolPairing(t, tapePath, sc.deliveredIDs()...)
			if t.Failed() {
				t.Fatalf("%s: fidelity invariant broke on iteration %d/%d (see violations above)", sc.name, i, iters)
			}
		}
	}

	// HIGH-FANOUT single round: stresses the park/deliver FIFO with many entries.
	t.Run("high-fanout-single-round", func(t *testing.T) {
		stress(t, highFanout(), 10)
	})

	// MULTI-ROUND high fanout: forces many generation bumps interleaved with
	// deliveries, with same-key decoys across generations that only generation
	// scoping can keep correctly paired.
	t.Run("multiround-high-fanout", func(t *testing.T) {
		stress(t, multiRoundFanout(6), 8)
	})
}

// TestToolDeliveryAutonomousVsParked is the autonomous-vs-parked hypothesis: an
// UNSOLICITED tool_use turn (a scheduled wake / monitor the model armed earlier)
// fires WHILE an earlier round's real tool is still parked and undelivered.
//
// The tool-round generation advances at the first tools/call park after a pause
// (openNewGenerationLocked, gated by roundClosed). The wake's first park lands
// while the earlier round's real call is still parked and undelivered, so it
// opens a generation PAST that real call. When the worker then delivers the real
// call's result, deliverNextToolResultLocked only matches entries of the CURRENT
// generation (parkedIndexByKey/parkedIndexByName scope on generation ==
// cp.currentGeneration) — so the older-generation parked call is INVISIBLE: the
// exact-key match misses and, because the wake call shares the tool name, the
// same-tool name fallback drains the WAKE call instead. The real tool's result is
// cross-delivered to the autonomous call and the real tool is stranded.
//
// Reachability through the provider flow: the autonomous drain does NOT gate the
// generation bump. On a tool_use pause maybeStartAutonomousDrain declines to
// start a consumer (autonomous_turn.go), but the reader is always-on and latches
// the pause (noteToolUsePause) straight off the raw stdout line whether or not any
// consumer is active — so the wake's first park opens a new generation even while
// the foreground turn has already returned and nothing is reading s.content.
//
// RESOLUTION: this interleaving is UNREACHABLE in production — the CLI cannot
// emit a tool_use turn while blocked on a parked tools/call (the autonomous-turn
// drain rests on the same fact; see autonomous_turn.go). So generation scoping is
// correct for every reachable flow, and the provider does NOT try to recover the
// stranded delivery (the stranded call's round is ambiguous from content alone).
// What it MUST do — and what this test now asserts — is never let the violation
// pass silently: openNewGenerationLocked detects "a new tool round opened while a
// tool is still parked and nothing was delivered for it" and logs it loudly,
// counting it in outOfBandRounds. The sub-tests prove the detector is both
// SENSITIVE (fires on the wake-mid-park interleaving) and SPECIFIC (a normal
// multi-round turn — even one leaving a lingering orphan — does NOT trip it,
// because a delivery happened that round).
func TestToolDeliveryAutonomousVsParked(t *testing.T) {
	// waitParked blocks until the control protocol reaches the precondition the
	// hypothesis needs — `wantParked` calls parked AND currentGeneration at
	// `wantGen` — or fails on a deadline. This pins the interleaving
	// deterministically (the wake's pause absorbed and its call parked under the
	// bumped generation, the real call still parked under the older one) instead
	// of racing the always-on reader against the worker's delivery. State is read
	// through the actor (runOnActor) so -race sees no unsynchronised access.
	waitParked := func(t *testing.T, cp *controlProtocol, wantParked, wantGen int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			var parked, gen int
			cp.runOnActor(func() { parked, gen = len(cp.parkedCalls), cp.currentGeneration })
			if parked >= wantParked && gen >= wantGen {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("control protocol did not reach parked>=%d gen>=%d (got parked=%d gen=%d)", wantParked, wantGen, parked, gen)
			}
			time.Sleep(time.Millisecond) // tight poll of a real condition, not a timing bodge
		}
	}

	// waitTapeAnswers blocks until the tape has recorded `want` control_response
	// answers. The fake records an answer asynchronously when it reads a
	// control_response off its stdin, which can lag the worker's deliver call (the
	// continuation's foreground read returns off already-buffered autonomous
	// content, before the fake has consumed the response). Awaiting the tape's own
	// observable keeps the assertion deterministic without a fixed sleep.
	waitTapeAnswers := func(t *testing.T, tapePath string, want int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			n := 0
			for _, r := range readTape(t, tapePath) {
				if r.Event == "answer" {
					n++
				}
			}
			if n >= want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("tape did not record %d answer(s) (got %d)", want, n)
			}
			time.Sleep(time.Millisecond) // tight poll of a real condition, not a timing bodge
		}
	}

	// SPECIFIC: a normal multi-round turn must NOT trip the detector — even one
	// that leaves a lingering orphan, because a delivery happened that round
	// (deliveredSinceGenAdvance is true when round 2's first park opens a new
	// generation, since round 1's real result was already delivered).
	t.Run("normal-multiround-does-not-trip-detector", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1"), {Name: "bash", CallArgs: map[string]any{"command": "ghost"}}}, Continues: true},
			{Calls: []scriptCall{bashCall("t2", "echo 2")}},
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-gen-specificity"

		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("round 0 park: StopReason = %q, want tool_use", res.StopReason)
		}
		cp := c.activeSession.live.control
		// Feed round 0 (t1); the orphan lingers. The model then parks round 1 (t2).
		cont1 := []provider.Message{userMsg("q0"), toolUseMsg("t1", "bash"), toolResultMsg("t1", "RESULT::t1")}
		if res := sendMsg(t, c, convID, cont1); res.StopReason != "tool_use" {
			t.Fatalf("round 1 park: StopReason = %q, want tool_use", res.StopReason)
		}
		// Feed round 1 (t2) → end_turn.
		cont2 := append(append([]provider.Message{}, cont1...), toolUseMsg("t2", "bash"), toolResultMsg("t2", "RESULT::t2"))
		if res := sendMsg(t, c, convID, cont2); res.StopReason != "end_turn" {
			t.Fatalf("turn end: StopReason = %q, want end_turn", res.StopReason)
		}
		if n := cp.outOfBandRoundCount(); n != 0 {
			t.Fatalf("normal multi-round (with a lingering orphan) FALSE-tripped the out-of-band detector: %d", n)
		}
		c.dropSession(convID)
		assertToolPairing(t, tape, "t1", "t2")
	})

	// SENSITIVE: the wake-mid-park interleaving (unreachable in production) must be
	// DETECTED and logged. Turn 0 parks the REAL tool t1, then fires an autonomous
	// wake calling the SAME tool with DIFFERENT args (aut1); the wake's pause bumps
	// the generation, parking aut1 one generation AHEAD of t1.
	t.Run("autonomous-wake-mid-park-is-detected", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{
				Calls:     []scriptCall{bashCall("t1", "echo 1")},
				WakeCalls: []scriptCall{bashCall("aut1", "echo AUTONOMOUS")},
			},
			{}, // post-feed text turn
		}})
		c := mkClient(t, "claude-sonnet-4-6")
		convID := "conv-autonomous-vs-parked"

		// Park t1. The foreground read returns at t1's tool_use pause; pendingTools
		// is built from t1's block only (the wake block streams after and stays
		// buffered in s.content with no consumer, since the drain doesn't start on
		// tool_use).
		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t1"}) {
			t.Fatalf("pending = %v, want [t1]", got)
		}

		// t1 parked at gen 0 (its park precedes its own pause, the first round);
		// the wake's first park opens gen 1 (aut1 @ gen 1) while t1 is still parked
		// and undelivered — the exact state that hides t1 from delivery and trips
		// the out-of-band detector.
		cp := c.activeSession.live.control
		waitParked(t, cp, 2, 1)

		// Deliver t1's result. The advancing generation hides t1 (gen 0), so this
		// turn's delivery is degraded (t1 cross-delivered/stranded) — ACCEPTED,
		// because the input cannot occur in production. The continuation returns off
		// buffered autonomous content, so its StopReason is not asserted.
		cont := []provider.Message{userMsg("q0"), toolUseMsg("t1", "bash"), toolResultMsg("t1", "RESULT::t1")}
		_ = sendMsg(t, c, convID, cont)
		waitTapeAnswers(t, tape, 1)

		// The contract violation must NOT pass silently: openNewGenerationLocked must have
		// detected and logged the out-of-band round.
		if n := cp.outOfBandRoundCount(); n < 1 {
			t.Fatalf("wake-mid-park was not detected (outOfBandRounds=%d); the invariant violation would pass silently", n)
		}
		c.dropSession(convID)
	})
}

// TestToolDeliveryModelChange covers the model-swap axis: changing c.model
// (the user picking a different model) around a parked tool. A claude --resume
// against a different model shares no prompt cache, so classifyRegime forces a
// fresh start (regime.go:138 model-changed) — BUT only after the
// continuationCovers/liveCLI short-circuit (regime.go:134), which is
// model-independent. The three sub-tests pin where the swap is honoured and
// where it is deliberately ignored, and assert the fidelity invariant holds in
// every case: no result is ever crossed, and a tool abandoned by a fresh start
// is never delivered live on the new control protocol.
//
// No production change is expected here — this is coverage of existing routing.
func TestToolDeliveryModelChange(t *testing.T) {
	// ── A model swap while the tool feed COVERS every parked call and the CLI is
	// still live short-circuits to regimeContinue (regime.go:134, model-
	// independent) BEFORE the model-changed branch — so the parked tool is fed
	// over the original model's warm CLI and the swap takes effect only on the
	// next turn. The swap is deliberately ignored mid-feed; fidelity still holds.
	t.Run("live-feed-of-parked-tool-ignores-swap-and-continues", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1")}}, // turn 0: parks t1 on the original model
			{}, // turn 1: post-feed response (text end_turn)
		}})
		c := mkClient(t, "sonnet")
		convID := "conv-model-livefeed"

		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t1"}) {
			t.Fatalf("pending = %v, want [t1]", got)
		}

		// User switches model while t1 is parked.
		c.model = "opus"

		cont := []provider.Message{userMsg("q0"), toolUseMsg("t1", "bash"), toolResultMsg("t1", "RESULT::t1")}
		// continuationCovers(t1) && liveCLI ⇒ regimeContinue, with NO reason,
		// despite sess.model("sonnet") != c.model("opus").
		assertRegime(t, c, cont, regimeContinue, "", "feed parked tool after swap")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("feed t1 after swap: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape, "t1") // t1 delivered exactly once to its own call
		c.dropSession(convID)
	})

	// ── B model swap at a clean turn boundary (no tool parked) routes the next
	// turn to regimeStartFresh/model-changed; the new model's fresh CLI parks its
	// own tool and delivers its own result cleanly.
	t.Run("swap-at-turn-boundary-starts-fresh-on-new-model", func(t *testing.T) {
		// Each turn's post-feed end_turn is emitted INLINE by the fake (it does
		// not consume a scripted round); only a tool PARK advances the cursor. So
		// the two parks are adjacent rounds: round 0 = t1 (sonnet), round 1 = t2
		// (the fresh opus spawn reads the persisted cursor and parks it).
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1")}}, // round 0: parks t1 (sonnet)
			{Calls: []scriptCall{bashCall("t2", "echo 2")}}, // round 1: fresh opus turn parks t2
		}})
		c := mkClient(t, "sonnet")
		convID := "conv-model-boundary"

		// Complete a clean tool turn on sonnet.
		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
		}
		feed1 := []provider.Message{userMsg("q0"), toolUseMsg("t1", "bash"), toolResultMsg("t1", "RESULT::t1")}
		assertRegime(t, c, feed1, regimeContinue, "", "feed t1 on sonnet")
		if res := sendMsg(t, c, convID, feed1); res.StopReason != "end_turn" {
			t.Fatalf("feed t1: StopReason = %q, want end_turn", res.StopReason)
		}

		// User switches to opus; next user turn must cold-start (no shared cache).
		c.model = "opus"
		later := append(append([]provider.Message{}, feed1...), assistantMsg("ack"), userMsg("q2"))
		assertRegime(t, c, later, regimeStartFresh, "model-changed", "first opus turn")
		if res := sendMsg(t, c, convID, later); res.StopReason != "tool_use" {
			t.Fatalf("opus park t2: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t2"}) {
			t.Fatalf("opus pending = %v, want [t2]", got)
		}
		feed2 := append(append([]provider.Message{}, later...), toolUseMsg("t2", "bash"), toolResultMsg("t2", "RESULT::t2"))
		assertRegime(t, c, feed2, regimeContinue, "", "feed t2 on opus")
		if res := sendMsg(t, c, convID, feed2); res.StopReason != "end_turn" {
			t.Fatalf("feed t2 on opus: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape, "t1", "t2") // each delivered once to its own call
		c.dropSession(convID)
	})

	// ── C model swap while a tool is parked AND the live CLI is gone (restart):
	// the continuation cannot continue (no pendingTools) and the model differs, so
	// the model-changed branch (regime.go:138) wins over delta-tool-result
	// (:160) — regimeStartFresh/model-changed. The abandoned tool's result is
	// paired into rebuilt history, never delivered live on the new wire.
	t.Run("swap-after-abandoned-park-starts-fresh-model-changed", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{Calls: []scriptCall{bashCall("t1", "echo 1")}}, // turn 0: parks t1 (sonnet), abandoned
			{}, // turn 1: post-restart fresh opus response (text)
		}})
		c := mkClient(t, "sonnet")
		convID := "conv-model-abandoned"

		if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
			t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
		}

		// Restart drops the live CLI + pendingTools (sidecar rebuild keeps the
		// resume anchor + sessionUUID), exactly as the restart test models it.
		c.activeSession.tearDownLiveCLI()
		if c.activeSession.hasLiveCLI() {
			t.Fatal("live CLI still attached after tearDownLiveCLI")
		}
		if got := pendingIDs(c.activeSession); len(got) != 0 {
			t.Fatalf("pendingTools survived teardown = %v", got)
		}

		// User switches to opus, then continues feeding t1's result.
		c.model = "opus"
		cont := []provider.Message{userMsg("q0"), toolUseMsg("t1", "bash"), toolResultMsg("t1", "RESULT::t1")}
		// No live CLI ⇒ no continue; sess.model("sonnet") != c.model("opus") ⇒
		// model-changed is reported BEFORE delta-tool-result.
		assertRegime(t, c, cont, regimeStartFresh, "model-changed", "continue after restart+swap")
		if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
			t.Fatalf("post-restart+swap continue: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape) // nothing delivered live this scenario
		assertNotDeliveredLive(t, tape, "t1")
		c.dropSession(convID)
	})
}

// TestToolDeliveryRetryAfterFeed pins the tool-result-in-flight ∩ turn-retry
// intersection: a continue turn feeds a parked tool's result, then the CLI dies
// without end_turn BEFORE streaming any continuation content. Delivering a
// result is a WRITE to the CLI, not a streamed chunk, so dispatchTurnWithRetry's
// `streamed` gate is still false and the turn is retried (unlike
// TestRetry_NoRetryAfterStreamedContent, where streamed text suppresses it). The
// fidelity contract: the retry must recover the turn WITHOUT delivering the
// already-answered result a second time — on retry the live CLI is gone, so the
// continuation routes to regimeStartFresh/delta-tool-result and the result is
// paired into rebuilt history, never re-answered over a control protocol.
//
// No production change expected — this asserts the existing retry + regime
// machinery composes correctly when a result is in flight at the crash.
func TestToolDeliveryRetryAfterFeed(t *testing.T) {
	fastRetryBackoff(t)

	// Round 0 parks t1 and CRASHES the moment t1's result is fed (ExitAfterAnswer)
	// — no end_turn. Round 1 is the retry's fresh-start response: the respawned
	// CLI reads the persisted cursor (advanced past t1 at park time) and emits a
	// clean text end_turn, so the turn recovers.
	tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
		{Calls: []scriptCall{{ID: "t1", Name: "bash", UseArgs: map[string]any{"command": "echo 1"}}}, ExitAfterAnswer: true},
		{}, // retry's fresh-start response (text end_turn)
	}})
	c := mkClient(t, "sonnet")
	convID := "conv-retry-after-feed"

	if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "tool_use" {
		t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
	}
	if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t1"}) {
		t.Fatalf("pending = %v, want [t1]", got)
	}

	// Feed t1's result. The CLI answers it (taped), then exits without end_turn.
	// Nothing streamed this attempt ⇒ the turn is retried; the retry cold-starts
	// fresh and ends cleanly. The whole retry happens inside this one call.
	cont := []provider.Message{userMsg("q0"), toolUseMsg("t1", "bash"), toolResultMsg("t1", "RESULT::t1")}
	if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
		t.Fatalf("feed t1 (crash+retry): StopReason = %q, want end_turn (retry must recover the turn)", res.StopReason)
	}

	// t1 must be answered EXACTLY ONCE: emitted once in round 0, answered once
	// before the crash, and never re-delivered by the retry (which pairs it into
	// rebuilt history instead). checkToolPairing flags a duplicate answer.
	assertToolPairing(t, tape, "t1")
	c.dropSession(convID)
}

// TestToolDeliverySidecarColdResume is the "responds to my deleted message"
// territory: a tool is parked, then the PROCESS restarts — the in-memory
// activeSession (and with it pendingTools and the live CLI) is gone, and the
// session is rebuilt from the on-disk sidecar. pendingTools is in-memory only,
// so it cannot survive; a continuation carrying the parked tool's result can
// neither continue (no live CLI) nor resume-delta (a dangling tool_result can't
// be piped on stdin). It classifies as warm-append (regimeResumeAppendResult):
// the result closes the warm transcript's dangling tool_use and is paired into
// the session file, never crossed onto some other call over a control protocol
// that no longer exists. Here the test rebuilds from the sidecar WITHOUT a real
// ~/.claude session file on disk, so the warm append finds nothing and the
// dispatch falls back to the fresh synthetic resume — which still relocates the
// result into rebuilt history (asserted below via planSyntheticSession).
func TestToolDeliverySidecarColdResume(t *testing.T) {
	// round 0: a clean text turn captures the sessionUUID and writes the sidecar.
	// round 1: parks t1 (pendingTools live in memory only). round 2: the post-
	// cold-resume fresh-start response (text end_turn).
	tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
		{},
		{Calls: []scriptCall{bashCall("t1", "echo 1")}},
		{},
	}})
	c := mkClient(t, "sonnet")
	convID := "conv_sidecar_coldresume" // must match convIDRe (^conv_…) so ScanConvDirs indexes the folder

	// Per-conversation folder so the modern sidecar path resolves (ScanConvDirs)
	// and finalizeTurn actually persists the sidecar — exactly as in production.
	convDir := filepath.Join(c.workingDir, ".juggler", "perm--"+convID)
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	// Turn 0: text turn → sidecar written.
	if res := sendMsg(t, c, convID, []provider.Message{userMsg("q0")}); res.StopReason != "end_turn" {
		t.Fatalf("turn 0: StopReason = %q, want end_turn", res.StopReason)
	}
	sidecar := filepath.Join(convDir, "claude_session.json")
	if _, err := os.Stat(sidecar); err != nil {
		t.Fatalf("precondition: turn 0 did not write the sidecar at %s: %v", sidecar, err)
	}

	// Turn 1: park t1. pendingTools is in-memory state only.
	conv1 := []provider.Message{userMsg("q0"), assistantMsg("ack"), userMsg("q1")}
	if res := sendMsg(t, c, convID, conv1); res.StopReason != "tool_use" {
		t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
	}
	if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t1"}) {
		t.Fatalf("pending = %v, want [t1]", got)
	}

	// Simulate a process restart: drop the in-memory session, keep the sidecar
	// (closeSession is exactly what the server does on shutdown/eviction).
	c.closeSession()
	if c.activeSession != nil {
		t.Fatal("closeSession must drop the in-memory session")
	}

	// The continuation carries t1's tool_result. The session is rebuilt from the
	// sidecar: it has the sessionUUID but NO pendingTools and NO live CLI.
	cont := append(append([]provider.Message{}, conv1...), toolUseMsg("t1", "bash"), toolResultMsg("t1", "RESULT::t1"))

	loaded := loadDiskSession(c.workingDir, convID, c.workingDir, "")
	if loaded == nil || loaded.sessionUUID == "" {
		t.Fatal("sidecar no longer yields a resumable session after the restart")
	}
	if got := pendingIDs(loaded); len(got) != 0 {
		t.Fatalf("pendingTools must not survive a process restart; rebuilt session has %v", got)
	}
	dec := classifyRegime(loaded, c.model, "sys", cont, loaded.hasLiveCLI())
	if dec.Regime != regimeResumeAppendResult {
		t.Fatalf("cold-resume regime = (%d,%q), want regimeResumeAppendResult", dec.Regime, dec.Reason)
	}

	// With no real ~/.claude session file, the warm append falls back to a fresh
	// synthetic resume, which must relocate t1's tool_result into history — there
	// is no control protocol to answer it over, so the only way the model sees
	// the result is paired into the resumed transcript.
	plan := planSyntheticSession(cont, nil)
	if plan == nil {
		t.Fatal("planSyntheticSession returned nil for a tool_result-bearing cold-resume delta")
	}
	foundInHistory := false
	for _, m := range plan.historyToFile {
		for _, b := range m.Content {
			if b.Type == "tool_result" && b.ToolUseID == "t1" {
				foundInHistory = true
			}
		}
	}
	if !foundInHistory {
		t.Fatalf("t1's tool_result was not paired into rebuilt history; historyToFile=%+v", plan.historyToFile)
	}

	// Drive it end to end: the cold resume must recover the turn cleanly.
	if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
		t.Fatalf("cold-resume continue: StopReason = %q, want end_turn", res.StopReason)
	}

	assertToolPairing(t, tape) // t1 never delivered live (abandoned by the restart)
	assertNotDeliveredLive(t, tape, "t1")
	c.dropSession(convID)
}

// TestToolDeliverySyntheticResumeMultiTool exercises the synthetic-resume
// transcript rebuild (planSyntheticSession / moveTrailingToolResultsToHistory /
// repairOrphanToolUses) over COMPLEX multi-tool, multi-round histories — the gap
// the existing synthetic_resume_test.go cases (single dangling tool) leave open.
// A cold start (divergence, sidecar rebuild, model change) rebuilds the whole
// transcript from juggler's own history; if that rebuild mis-pairs a tool_result
// with the wrong tool_use, drops one, or duplicates one, the resumed model sees a
// corrupt transcript (Anthropic rejects, or the model answers the wrong call).
//
// The fidelity invariant mirrors the live one (checkToolPairing) but over the
// REBUILT API transcript: every tool_use id is answered by exactly one
// tool_result with the SAME id, every tool_result closes a tool_use that
// preceded it, and no id is dropped or duplicated. This is a pure assertion on
// the plan (the authoritative producer of historyToFile); writeSyntheticSession
// only serialises it, and the spawn path is already covered by the restart /
// sidecar cold-resume tests.
func TestToolDeliverySyntheticResumeMultiTool(t *testing.T) {
	// scanPairing walks the rebuilt transcript (history + the stdin tail) in order
	// and returns per-id tool_use / tool_result counts plus the first ordering
	// violation (a tool_result whose tool_use has not yet appeared).
	scanPairing := func(history []anthropic.APIMessage, tail []anthropic.APIContentBlock) (uses, results map[string]int, orderErr string) {
		uses, results = map[string]int{}, map[string]int{}
		seenUse := map[string]bool{}
		walk := func(content []anthropic.APIContentBlock) {
			for _, b := range content {
				switch b.Type {
				case "tool_use":
					uses[b.ID]++
					seenUse[b.ID] = true
				case "tool_result":
					results[b.ToolUseID]++
					if !seenUse[b.ToolUseID] && orderErr == "" {
						orderErr = fmt.Sprintf("tool_result for %q appears before its tool_use", b.ToolUseID)
					}
				}
			}
		}
		for _, m := range history {
			walk(m.Content)
		}
		walk(tail)
		return uses, results, orderErr
	}

	use := func(id string) provider.Message { return toolUseMsg(id, "bash") }
	res := func(id string) provider.Message { return toolResultMsg(id, "RESULT::"+id) }

	cases := []struct {
		name     string
		messages []provider.Message
		wantIDs  []string
	}{
		{
			// Two parallel tools, all paired inline, then a trailing parallel round
			// whose results must be relocated into history together (not crossed).
			name: "parallel-rounds-trailing-parallel",
			messages: []provider.Message{
				userMsg("kick off"),
				use("A1"), use("A2"),
				res("A1"), res("A2"),
				use("B1"), use("B2"),
				res("B1"), res("B2"),
			},
			wantIDs: []string{"A1", "A2", "B1", "B2"},
		},
		{
			// Sequential single-tool rounds with a trailing open single tool.
			name: "sequential-rounds-trailing-single",
			messages: []provider.Message{
				userMsg("start"),
				use("S1"), res("S1"),
				use("S2"), res("S2"),
				use("S3"), res("S3"),
			},
			wantIDs: []string{"S1", "S2", "S3"},
		},
		{
			// Mixed widths: a parallel round, a sequential round, then a trailing
			// 3-wide parallel round — the relocation must keep all three together
			// and each paired with its own id.
			name: "mixed-widths-trailing-triple",
			messages: []provider.Message{
				userMsg("go"),
				use("P1"), use("P2"),
				res("P1"), res("P2"),
				use("Q1"), res("Q1"),
				use("R1"), use("R2"), use("R3"),
				res("R1"), res("R2"), res("R3"),
			},
			wantIDs: []string{"P1", "P2", "Q1", "R1", "R2", "R3"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := planSyntheticSession(tc.messages, nil)
			if plan == nil {
				t.Fatalf("planSyntheticSession returned nil for a multi-tool history")
			}
			uses, results, orderErr := scanPairing(plan.historyToFile, plan.tailContent)
			if orderErr != "" {
				t.Fatalf("rebuilt transcript ordering broken: %s", orderErr)
			}
			// Bijection: exactly the expected ids, each used once and answered once.
			if len(uses) != len(tc.wantIDs) {
				t.Fatalf("rebuilt tool_use ids = %v, want exactly %v", uses, tc.wantIDs)
			}
			for _, id := range tc.wantIDs {
				if uses[id] != 1 {
					t.Errorf("tool_use %q appears %d time(s) in rebuilt transcript, want 1", id, uses[id])
				}
				if results[id] != 1 {
					t.Errorf("tool_result for %q appears %d time(s) in rebuilt transcript, want 1 (dropped/duplicated/crossed)", id, results[id])
				}
			}
			// No stray tool_result that does not close one of the expected tool_uses.
			for id, n := range results {
				if !slices.Contains(tc.wantIDs, id) {
					t.Errorf("rebuilt transcript has %d tool_result(s) for unexpected id %q", n, id)
				}
			}
		})
	}
}

// TestToolDeliveryDivergencePermutations covers the prefix-divergence axis:
// edit-in-place, shrink/rollback, and branch-switch deltas against a captured
// session prefix (canResumeWithDelta / diagnoseDivergence, regime.go:179). The
// classification subtests pin the regime + reason each delta shape yields; the
// final subtest drives an edit-in-place that lands WHILE a tool is parked and
// asserts the fidelity invariant — the divergence abandons the parked tool
// (fresh start) and that tool is never delivered live on the new control
// protocol. No production change expected.
func TestToolDeliveryDivergencePermutations(t *testing.T) {
	// ── classification: each divergence shape against a captured 3-message prefix.
	t.Run("classification-no-tool-parked", func(t *testing.T) {
		installScriptedFake(t, fakeScript{Turns: []scriptTurn{{}}}) // one text turn captures the prefix
		c := mkClient(t, "sonnet")
		convID := "conv_divergence_class"

		base := []provider.Message{userMsg("u1"), assistantMsg("a1"), userMsg("u2")}
		if res := sendMsg(t, c, convID, base); res.StopReason != "end_turn" {
			t.Fatalf("baseline turn: StopReason = %q, want end_turn", res.StopReason)
		}
		if got := c.activeSession.sentCount; got != 3 {
			t.Fatalf("baseline sentCount = %d, want 3 (cases below assume it)", got)
		}

		// Warm linear extension → resume the warm session with a delta.
		warm := append(append([]provider.Message{}, base...), assistantMsg("a2"), userMsg("u3"))
		assertRegime(t, c, warm, regimeResumeDelta, "", "warm linear extension")

		// Edit-in-place: same length, an earlier message's content changed.
		edit := []provider.Message{userMsg("EDITED"), assistantMsg("a1"), userMsg("u2")}
		assertRegime(t, c, edit, regimeStartFresh, "diverged", "edit-in-place")

		// Shrink / rollback: fewer messages than were last sent.
		shrink := []provider.Message{userMsg("u1"), assistantMsg("a1")}
		assertRegime(t, c, shrink, regimeStartFresh, "shrunk", "shrink/rollback")

		// Branch-switch: longer, but a prefix element diverges (different branch).
		branch := []provider.Message{userMsg("u1"), assistantMsg("a1"), userMsg("DIFFERENT"), assistantMsg("x"), userMsg("u3")}
		assertRegime(t, c, branch, regimeStartFresh, "diverged", "branch-switch")

		// No new messages: identical to what was sent — treated as divergent so the
		// caller starts fresh rather than re-sending an empty delta.
		assertRegime(t, c, base, regimeStartFresh, "no-new-msgs", "no-new-msgs")

		c.dropSession(convID)
	})

	// ── fidelity: an edit-in-place divergence arrives WHILE t1 is parked. The
	// divergent delta does not cover t1, so continuationCovers is false; the
	// changed prefix routes to regimeStartFresh/diverged, abandoning t1. t1 must
	// never be delivered live on the new control protocol.
	t.Run("edit-in-place-mid-parked-tool", func(t *testing.T) {
		tape := installScriptedFake(t, fakeScript{Turns: []scriptTurn{
			{}, // round 0: baseline text (captures prefix)
			{Calls: []scriptCall{bashCall("t1", "echo 1")}}, // round 1: parks t1 (warm extension)
			{}, // round 2: post-divergence fresh-start response
		}})
		c := mkClient(t, "sonnet")
		convID := "conv_divergence_parked"

		base := []provider.Message{userMsg("u1"), assistantMsg("a1"), userMsg("u2")}
		if res := sendMsg(t, c, convID, base); res.StopReason != "end_turn" {
			t.Fatalf("baseline: StopReason = %q, want end_turn", res.StopReason)
		}

		// Warm extension parks t1.
		park := append(append([]provider.Message{}, base...), assistantMsg("a2"), userMsg("u3"))
		if res := sendMsg(t, c, convID, park); res.StopReason != "tool_use" {
			t.Fatalf("park t1: StopReason = %q, want tool_use", res.StopReason)
		}
		if got := pendingIDs(c.activeSession); !equalStrings(got, []string{"t1"}) {
			t.Fatalf("pending = %v, want [t1]", got)
		}

		// User edits the FIRST message while t1 is still parked — a divergence that
		// does not feed t1.
		diverged := append([]provider.Message{userMsg("EDITED")}, park[1:]...)
		assertRegime(t, c, diverged, regimeStartFresh, "diverged", "edit-in-place mid-park")
		if res := sendMsg(t, c, convID, diverged); res.StopReason != "end_turn" {
			t.Fatalf("divergent continue: StopReason = %q, want end_turn", res.StopReason)
		}

		assertToolPairing(t, tape) // t1 abandoned, nothing delivered live
		assertNotDeliveredLive(t, tape, "t1")
		c.dropSession(convID)
	})
}
