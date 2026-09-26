//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Who gets blamed when a tool never advances. The worker cannot see the engine
// directly — it dispatches commands into a mailbox and watches the doc for
// progress — so a command that goes unanswered has two very different causes:
//
//   - the engine received it and DECLINED to act on the TOOL (an unknown tool, a
//     worker-managed manifest, an execution already in flight). It says so, in an
//     evaluate-noact/execute-noact trace. The tool really is stuck and failing it
//     is the right recovery: the parked turn unblocks and the model sees why.
//   - the engine received it and could not REACH the tool — it holds no loaded
//     copy of the conversation yet. It says so too, in the same shape of trace,
//     and it is not lying: it is alive, running handlers, and busy loading. The
//     identical command re-driven after the load lands succeeds, so failing the
//     tool here fails one that was about to run.
//   - the engine is GONE — its realm suspended or wedged behind a socket that
//     still looks healthy. Nothing was ever delivered. Failing the tool here
//     blames a tool that was never tried, and does it again for every tool in
//     every conversation until the app is restarted.
//
// Per-tool trace receipt is what separates the first from the last: an
// engine-trace names the toolUseId it acted on, and answeredSincePrevDispatch
// asks whether one arrived for THIS tool since the dispatch before last. Both
// halves matter. A conversation-wide test is satisfied by a sibling tool in the
// same parallel batch, and an "ever, during this phase" test is satisfied by a
// single trace in the first millisecond of a 30-second phase — which is precisely
// the residue a laptop that slept leaves behind.
//
// The trace's `reason` is what separates the first from the second, and nothing
// else can: both are declines, arriving at the same rate, from an engine that is
// equally alive. These tests pin that all three are treated differently, that
// none of the weaker signals can pass for a live one, and that the reason
// vocabulary the verdict rests on still matches the engine's.

// driveToEscalation drives the worker enough times to exhaust
// maxToolCommandAttempts, stopping early once the tool has been terminated.
// traceReason is the `reason` the engine answers each command with: "" for an
// engine that engaged with the tool, an engineUnreachableReasons value for one
// that could not reach it, and traceNothing for an engine that says nothing at
// all. Staleness is forced through the redriveInterval clock seam — no sleeps.
func driveToEscalation(h *reattachHarness, traceReason string) {
	h.w.redriveInterval = 0
	for i := 0; i <= maxToolCommandAttempts+1; i++ {
		if traceReason != traceNothing {
			// The engine is alive and answering FOR THIS TOOL: it is declining the
			// command, not missing it. Stamped through the tracker rather than by
			// dispatching an engine-trace message, so the test is coupled to the
			// liveness signal rather than to the trace payload shape —
			// TestEngineTrace_StampsThePerToolReceipt covers the payload.
			event := "evaluate-noact"
			if traceReason == "" {
				event = "evaluate-done" // an acting trace carries no reason
			}
			h.w.tools.recordTrace("tu-1", event, traceReason, time.Now())
		}
		h.w.driveToolActions()
		if it, ok := findToolItem(h.w.currentRun().getTargetItems(), "tu-1"); ok && it.State == StateCompleted {
			return
		}
	}
}

// traceNothing is driveToEscalation's "the engine never answers" sentinel. It is
// not a reason value: "" is a real one, the acting traces' absent reason.
const traceNothing = "\x00none"

// insertApprovedTool puts one approved tool-action in the doc, ready to be
// commanded.
func insertApprovedTool(h *reattachHarness) {
	h.w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})
}

// TestEngineMute_ToolIsNotBlamed is the worker half of the reproduction. With an
// engine registered that has never once spoken about this conversation, the
// commands provably never landed — so the tool must be left alone for the turn's
// own timeout to resolve honestly, not failed with a message that blames the
// engine for "never handling" a command it never received.
func TestEngineMute_ToolIsNotBlamed(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-mute")
	insertApprovedTool(h)

	// The engine registered (SetEngineClientID in the harness) and never traced.
	if !h.w.lastEngineTraceAt.IsZero() {
		t.Fatal("harness precondition: engine must not have traced")
	}

	driveToEscalation(h, traceNothing)
	h.flush(t)

	it, ok := findToolItem(h.w.currentRun().getTargetItems(), "tu-1")
	if !ok {
		t.Fatal("tu-1 disappeared")
	}
	if it.State == StateCompleted {
		t.Fatalf("a tool was failed on behalf of an engine that has never spoken: "+
			"state=%q. Nothing was delivered, so the tool is not what is broken — "+
			"the engine link is, and every later tool will be failed the same way "+
			"until the app restarts", it.State)
	}
}

// TestEngineDeclining_ToolStillEscalates is the other half, and the guard
// against over-fixing. An engine that IS reaching its handlers and declining the
// command must still have the tool failed past maxToolCommandAttempts: the tool
// genuinely is stuck, and doc.go's rule stands — degrade to a recoverable error,
// never an infinite wait.
func TestEngineDeclining_ToolStillEscalates(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-declining")
	insertApprovedTool(h)

	driveToEscalation(h, "")
	h.flush(t)

	it, ok := findToolItem(h.w.currentRun().getTargetItems(), "tu-1")
	if !ok {
		t.Fatal("tu-1 disappeared")
	}
	if it.State != StateCompleted {
		t.Fatalf("a live engine declining the command must still terminate the tool "+
			"so the parked turn unblocks: got state=%q", it.State)
	}

	// The provider must see an isError tool-result, or a parked CLI hangs.
	found, isErr := toolResultIsError(h.w.currentRun().buildMessages(nil), "tu-1")
	if !found || !isErr {
		t.Fatalf("escalated tool must feed an isError tool-result (found=%v isError=%v)", found, isErr)
	}
}

// TestEngineMute_FailureNamesTheEngine: whatever eventually fails a tool held
// behind a mute engine must say the engine is unavailable. The current wording
// reads as a tool-level fault and sends every report chasing the tool.
func TestEngineMute_FailureNamesTheEngine(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-mute-wording")
	insertApprovedTool(h)

	driveToEscalation(h, traceNothing)
	h.flush(t)

	it, ok := findToolItem(h.w.currentRun().getTargetItems(), "tu-1")
	if !ok || it.State != StateCompleted {
		return // not failed at all — TestEngineMute_ToolIsNotBlamed covers that
	}
	text := toolResultText(h.w.currentRun().buildMessages(nil), "tu-1")
	if !strings.Contains(strings.ToLower(text), "engine") ||
		strings.Contains(text, "never handled this command") {
		t.Fatalf("a mute-engine failure must name the engine as unavailable, not "+
			"read as the tool's own fault: %q", text)
	}
}

// TestEngineWentSilentMidPhase_ToolIsNotBlamed is the sleep/wake reproduction.
// The engine answers the first command and then stops — its realm suspended with
// the laptop, while the WebSocket stays open in the network process below it, so
// the engine remains registered and the worker keeps dispatching into something
// that cannot run a handler.
//
// A single early trace must not license failing the tool for the whole rest of
// the phase. If it does, escalation (~30s) beats the server's own recovery
// (engineLivenessWindow + engineReconnectGrace, ~50s) every time, and the user
// sees a tool blamed for an engine that was about to be fetched back.
func TestEngineWentSilentMidPhase_ToolIsNotBlamed(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-silent-mid-phase")
	insertApprovedTool(h)
	h.w.redriveInterval = 0

	// One trace, answering the first command, then silence for good. A sibling
	// tool still executing would keep the conversation-wide signal just as warm.
	h.w.driveToolActions()
	h.w.tools.recordTrace("tu-1", "evaluate-done", "", time.Now())
	h.w.lastEngineTraceAt = time.Now()

	for i := 0; i <= maxToolCommandAttempts+1; i++ {
		h.w.driveToolActions()
	}
	h.flush(t)

	it, ok := findToolItem(h.w.currentRun().getTargetItems(), "tu-1")
	if !ok {
		t.Fatal("tu-1 disappeared")
	}
	if it.State == StateCompleted {
		t.Fatalf("a tool was failed on the strength of one trace at the head of the "+
			"phase: state=%q. The engine has answered nothing since, so the commands "+
			"are landing nowhere — holding is what gives eviction, reconnect and "+
			"engine reload time to put an engine back", it.State)
	}
}

// TestEngineTrace_StampsThePerToolReceipt pins the wire contract the verdict now
// rests on: an engine-trace carries the toolUseId it acted on, and the worker
// records it against that tool. Nothing else in the worker decodes the payload,
// so a rename on the engine side would otherwise silently downgrade every
// escalation to "the engine never answered".
func TestEngineTrace_StampsThePerToolReceipt(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-trace-receipt")
	insertApprovedTool(h)
	h.w.redriveInterval = 0
	h.w.driveToolActions() // create the bookkeeping entry the trace stamps

	h.w.handleEngineTrace([]byte(`{"event":"execute-noact","toolUseId":"tu-1","reason":"no-thread"}`))

	if h.w.tools.lastTracedAt("tu-1").IsZero() {
		t.Fatal("an engine-trace naming tu-1 did not stamp tu-1's receipt — check " +
			"the toolUseId field name against sendEngineTrace in the engine")
	}
	if h.w.lastEngineTraceAt.IsZero() {
		t.Fatal("engine-trace must still stamp the conversation-wide receipt")
	}
	if !h.w.tools.lastTracedAt("tu-other").IsZero() {
		t.Fatal("a trace for tu-1 stamped an unrelated tool's receipt")
	}
}

// TestCommandArrival_IsNotEngagement pins the one thing that separates "the
// command landed" from "the engine reached the tool", because a diagnostic that
// blurs them silently deletes the 60-second unproven hold for every tool.
//
// command-recv is emitted the instant a command arrives, BEFORE the engine's
// preamble — and that preamble can sit for a minute awaiting a conversation load,
// having reached no tool at all. recordTrace's default is engagement (the acting
// traces carry no reason), so an arrival trace counts as an answer unless it is
// classified out, and the tool is then failed at the attempt cap instead of held
// while the engine finishes loading. That is the exact user-visible fault the hold
// exists to prevent: a tool blamed for an engine that was about to run it.
func TestCommandArrival_IsNotEngagement(t *testing.T) {
	tick := time.Now()
	tr := newToolCommandTracker()

	tr.recordDispatch("tu-1", StateApproved, tick)
	tr.recordTrace("tu-1", "command-recv", "", tick)
	tr.recordDispatch("tu-1", StateApproved, tick)

	if tr.answeredSincePrevDispatch("tu-1") {
		t.Error("a command-recv trace counted as the engine ENGAGING with the tool. " +
			"It is emitted on arrival, before the engine has looked at anything, so " +
			"this removes the unproven hold for every tool in the system and fails " +
			"tools that were about to run. Classify it in engineLivenessOnlyEvents")
	}
	// It is still liveness: the command demonstrably reached a handler, which is
	// what distinguishes a mute engine from a slow one.
	if tr.lastTracedAt("tu-1").IsZero() {
		t.Error("a command-recv trace did not stamp the tool's receipt at all; " +
			"arrival is the strongest evidence there is that the engine is alive")
	}

	// The slow-preamble trace says the same thing more loudly — an engine still
	// inside its preamble has by definition not reached the tool.
	tr2 := newToolCommandTracker()
	tr2.recordDispatch("tu-2", StateApproved, tick)
	tr2.recordTrace("tu-2", "preamble-slow", "", tick)
	tr2.recordDispatch("tu-2", StateApproved, tick)
	if tr2.answeredSincePrevDispatch("tu-2") {
		t.Error("a preamble-slow trace counted as engagement — it reports the engine " +
			"still loading, which is the opposite of having reached the tool")
	}
}

// TestEngineAnswered_IsNotDecidedByTheClock pins that the engine-answered tests
// order traces against commands by counting dispatches, never by comparing
// timestamps. Every event below carries the SAME instant, which is what a
// platform whose clock ticks in milliseconds hands back for a whole drive
// (Windows reads a ~1-15ms-granular counter): a trace answering a command at once
// is stamped identically to the command it answers, and a comparison of stamps
// reads an engine replying instantly as one that never replied — the verdict that
// holds a genuinely stuck tool for a minute and then blames the engine link.
func TestEngineAnswered_IsNotDecidedByTheClock(t *testing.T) {
	tick := time.Now() // one clock tick, spanning every event below
	tr := newToolCommandTracker()

	tr.recordDispatch("tu-1", StateApproved, tick)
	tr.recordTrace("tu-1", "evaluate-done", "", tick)
	tr.recordDispatch("tu-1", StateApproved, tick)
	if !tr.answeredSincePrevDispatch("tu-1") {
		t.Fatal("an engine that engaged with the previous command reads as mute when " +
			"the trace and that command share one clock tick")
	}

	tr.recordTrace("tu-1", "evaluate-noact", "conv-not-loaded", tick)
	tr.recordDispatch("tu-1", StateApproved, tick)
	unreachable, reason := tr.unreachableSincePrevDispatch("tu-1")
	if !unreachable || reason != "conv-not-loaded" {
		t.Fatalf("an unreachable decline of the previous command was lost inside its own "+
			"tick: unreachable=%v reason=%q", unreachable, reason)
	}

	// Silence is still silence: two more commands, nothing answering either.
	tr.recordDispatch("tu-1", StateApproved, tick)
	tr.recordDispatch("tu-1", StateApproved, tick)
	if tr.answeredSincePrevDispatch("tu-1") {
		t.Fatal("a trace from four commands ago still counts as the engine answering the last one")
	}
	if unreachable, _ := tr.unreachableSincePrevDispatch("tu-1"); unreachable {
		t.Fatal("an engine that declined four commands ago and fell silent still reads as unreachable")
	}
}

// TestEngineUnreachableDecline_ToolIsHeldNotBlamed is the tab-switch /
// cold-engine reproduction. The engine is alive and answering every command,
// but only to say it has no loaded copy of this conversation to run the tool
// against. That is the engine's loading window, not a broken tool, and the same
// command lands as soon as the load completes.
//
// Counting those declines as "the engine is answering for this tool" is what
// made this the worst case of all three: it switches OFF the hold, so the tool
// is failed at the attempt cap (~30s) — sooner than a mute engine, whose silence
// buys it a minute — while the engine's own load is allowed 60s to finish.
func TestEngineUnreachableDecline_ToolIsHeldNotBlamed(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-unreachable")
	insertApprovedTool(h)

	driveToEscalation(h, "conv-not-loaded")
	h.flush(t)

	it, ok := findToolItem(h.w.currentRun().getTargetItems(), "tu-1")
	if !ok {
		t.Fatal("tu-1 disappeared")
	}
	if it.State == StateCompleted {
		t.Fatalf("a tool was failed while the engine was still telling us it had not "+
			"loaded the conversation: state=%q. The engine is alive and its own load "+
			"has %s to finish — failing at the attempt cap blames the tool for a "+
			"command that was never refused, and does it faster than for an engine "+
			"that says nothing at all", it.State, engineUnreachableHold)
	}
}

// TestEngineUnreachableDecline_FailureNamesTheReason: an engine still declining
// this way past engineUnreachableHold does have the tool failed — doc.go's rule
// stands, degrade to a recoverable error rather than wait forever — but the
// message must carry the word the engine used. "Acknowledged the request but
// never carried it out" is untrue here and points the reader at the tool; the
// reason token is the one part of the message worth grepping the log for.
func TestEngineUnreachableDecline_FailureNamesTheReason(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-unreachable-waited-out")
	insertApprovedTool(h)
	h.w.redriveInterval = 0
	h.w.driveToolActions() // open the bookkeeping entry so the phase can be aged

	// Age the phase past the hold. The state never changes across the drive below,
	// so recordDispatch preserves this start stamp.
	h.w.tools.entry("tu-1").firstDispatchedAt = time.Now().Add(-2 * engineUnreachableHold)

	driveToEscalation(h, "conv-not-loaded")
	h.flush(t)

	it, ok := findToolItem(h.w.currentRun().getTargetItems(), "tu-1")
	if !ok || it.State != StateCompleted {
		t.Fatalf("a tool held for an unreachable engine must still be failed once the "+
			"hold elapses, or the turn parks forever: state=%q", it.State)
	}
	text := toolResultText(h.w.currentRun().buildMessages(nil), "tu-1")
	if !strings.Contains(text, "conv-not-loaded") {
		t.Fatalf("the failure must keep the reason the engine gave — it is what "+
			"separates a conversation the engine never loaded from a copy missing the "+
			"tool: %q", text)
	}
	if strings.Contains(text, "never carried it out") {
		t.Fatalf("the engine never refused this tool, so it must not be reported as "+
			"one it declined to carry out: %q", text)
	}
}

// TestEngineNoActReasons_AreAllClassified pins the vocabulary the verdict rests
// on, in both directions, against the engine source itself.
//
// engineUnreachableReasons is a wire contract with JS, and its failure mode is
// silent both ways: a reason renamed in the engine stops matching and its tool
// goes back to being blamed for the engine's loading window, while a NEW no-act
// exit added there defaults to "the engine engaged with this tool" — the harsher
// verdict — with nothing to show for it. Neither shows up as an error anywhere.
// So read the engine's own trace calls and require every reason to have been
// classified deliberately, one way or the other.
func TestEngineNoActReasons_AreAllClassified(t *testing.T) {
	const protocols = "../../../web/js/services/worker-manager-protocols.js"
	src, err := os.ReadFile(protocols)
	if err != nil {
		t.Fatalf("read %s: %v", protocols, err)
	}

	// Reasons that mean the engine DID reach the tool: the tool is what is stuck,
	// so the attempt cap applies and no hold is wanted. Listed rather than assumed
	// so that adding one is a decision, not a default.
	engaged := map[string]bool{
		"in-flight":         true,
		"already-executing": true,
	}

	found := map[string]bool{}
	for _, m := range regexp.MustCompile(`sendEngineTrace\([^\n]*?reason:\s*'([^']+)'`).FindAllSubmatch(src, -1) {
		found[string(m[1])] = true
	}
	if len(found) < len(engineUnreachableReasons)+len(engaged) {
		t.Fatalf("found only %d no-act reasons in %s (%v) — expected at least %d. "+
			"Either the trace call shape changed and this scan now matches nothing "+
			"useful, or reasons were removed without updating this test",
			len(found), protocols, found, len(engineUnreachableReasons)+len(engaged))
	}

	for reason := range found {
		if engineUnreachableReasons[reason] || engaged[reason] {
			continue
		}
		t.Errorf("the engine emits no-act reason %q, which the worker has never heard "+
			"of, so it is being treated as the tool's own fault by default. Decide: if "+
			"it means the engine could not REACH the tool, add it to "+
			"engineUnreachableReasons (tool_command_state.go) so the tool is held while "+
			"the engine recovers; if it means the engine reached the tool and declined, "+
			"add it to this test's `engaged` list", reason)
	}
	for reason := range engineUnreachableReasons {
		if !found[reason] {
			t.Errorf("the worker classifies %q as an unreachable-engine decline, but no "+
				"trace in %s emits it. If the engine renamed it, the rename silently "+
				"turned that decline back into a tool failure", reason, protocols)
		}
	}
}

// toolResultText returns the text content of a tool-result the worker built for
// the provider.
func toolResultText(messages []map[string]any, toolUseID string) string {
	for _, m := range messages {
		if m["type"] != "tool-result" {
			continue
		}
		if id, _ := m["toolUseId"].(string); id == toolUseID {
			s, _ := m["content"].(string)
			return s
		}
	}
	return ""
}
