//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// The spinner's elapsed-time anchor: which waits count toward it, which are
// excluded (approval prompts, frozen gaps), and when it resets to zero.

// startedAtMillis reads processingState.startedAt from the doc as int64,
// coercing whatever numeric shape ycrdt round-trips it to.
func startedAtMillis(t *testing.T, w *ConversationWorker) int64 {
	t.Helper()
	state := w.readProcessingState()
	if state == nil {
		t.Fatal("processingState absent")
	}
	switch v := state["startedAt"].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case int:
		return int64(v)
	default:
		t.Fatalf("startedAt missing or non-numeric: %T %v", state["startedAt"], state["startedAt"])
		return 0
	}
}

// startedAtPresent reports whether processingState carries a startedAt anchor.
// The spinner's elapsed digit renders only when it is present, so its absence is
// how "show no timer" (idle, or parked on an approval) is expressed.
func startedAtPresent(t *testing.T, w *ConversationWorker) bool {
	t.Helper()
	state := w.readProcessingState()
	if state == nil {
		return false
	}
	_, ok := state["startedAt"]
	return ok
}

// TestApprovalWaitHidesThenExcludesElapsedTimer verifies the approval-wait
// accounting: when a turn parks PURELY on a human approval the worker REMOVES
// startedAt (so every client shows no elapsed digit while awaiting), and when the
// user approves and work resumes the worker advances startedAt FORWARD by the
// wait and writes it back — so the digit reappears counting active work with the
// deliberation excluded, never snapping to 0. Mirrors the parked→approved edge: a
// lone pending tool-action the user then approves (state=approved → executing).
func TestApprovalWaitHidesThenExcludesElapsedTimer(t *testing.T) {
	w := NewConversationWorker("test-approval-wait", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "do it",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "May I?",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-pend", ToolUseID: "tu-pend",
		ToolName: "bash", State: StatePending,
	})

	// A turn that began a minute ago and is now parked awaiting approval.
	oldAnchor := time.Now().Add(-60 * time.Second).UnixMilli()
	w.turn.processingStartedAt.Store(oldAnchor)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
		"startedAt":    oldAnchor,
	})

	// Tick 1: parked→ enter edge. startedAt is removed (digit hidden) and the
	// in-memory wait marker is set; the in-memory anchor is left intact so a
	// cancel-at-prompt loses nothing.
	w.currentRun().updateApprovalWaitAnchor()
	if !w.turn.wasBlockedOnApprovals {
		t.Fatal("parked on a lone pending tool: expected wasBlockedOnApprovals=true")
	}
	if startedAtPresent(t, w) {
		t.Error("on entering an approval park: expected startedAt to be removed (digit hidden)")
	}
	if w.turn.approvalWaitStartedAt.Load() == 0 {
		t.Error("on entering an approval park: expected approvalWaitStartedAt to be recorded")
	}
	if w.turn.processingStartedAt.Load() != oldAnchor {
		t.Errorf("while parked: in-memory anchor must not move, got %d want %d", w.turn.processingStartedAt.Load(), oldAnchor)
	}

	// Simulate a 10s deliberation by backdating the in-memory wait marker.
	waitMs := int64(10_000)
	w.turn.approvalWaitStartedAt.Store(time.Now().UnixMilli() - waitMs)

	// The user approves: the pending tool becomes approved (executing).
	if !w.doc.UpdateToolActionFieldsRecursive("tu-pend", map[string]any{"state": StateApproved}) {
		t.Fatal("failed to mark tu-pend approved")
	}

	// Tick 2: parked→working edge. startedAt reappears, advanced forward by ~the
	// wait, so the elapsed digit excludes the deliberation but never snaps to 0.
	w.currentRun().updateApprovalWaitAnchor()
	if w.turn.wasBlockedOnApprovals {
		t.Error("after approve: expected wasBlockedOnApprovals=false (work executing)")
	}
	if w.turn.approvalWaitStartedAt.Load() != 0 {
		t.Error("after approve: expected approvalWaitStartedAt to be cleared")
	}
	if !startedAtPresent(t, w) {
		t.Fatal("after approve: expected startedAt to reappear")
	}
	got := startedAtMillis(t, w)
	if got != w.turn.processingStartedAt.Load() {
		t.Errorf("after approve: doc startedAt (%d) must match in-memory anchor (%d)", got, w.turn.processingStartedAt.Load())
	}
	// startedAt should have advanced by ~waitMs (allow generous slack for the
	// real elapsed between backdating and the resume tick).
	advance := got - oldAnchor
	if advance < waitMs-2_000 || advance > waitMs+5_000 {
		t.Errorf("after approve: startedAt should advance by ~%dms (the wait), advanced %dms", waitMs, advance)
	}
}

// TestAutoApproveLeavesElapsedTimerUntouched verifies that a tool which is
// auto-approved — Unevaluated→Approved without ever sitting in StatePending —
// neither hides nor advances the elapsed-time anchor. The timer keeps counting
// the running turn; only a genuine human approval at a prompt is accounted for.
func TestAutoApproveLeavesElapsedTimerUntouched(t *testing.T) {
	w := NewConversationWorker("test-autoapprove-timer", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "go",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-auto", ToolUseID: "tu-auto",
		ToolName: "bash", State: StateUnevaluated,
	})

	oldAnchor := time.Now().Add(-30 * time.Second).UnixMilli()
	w.turn.processingStartedAt.Store(oldAnchor)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityCallingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
		"startedAt":    oldAnchor,
	})

	// Tick 1: an unevaluated tool is neither pending nor executing — not a park.
	w.currentRun().updateApprovalWaitAnchor()
	if w.turn.wasBlockedOnApprovals {
		t.Fatal("unevaluated tool: expected wasBlockedOnApprovals=false")
	}

	// Engine auto-approves: Unevaluated→Approved, never pending.
	if !w.doc.UpdateToolActionFieldsRecursive("tu-auto", map[string]any{"state": StateApproved}) {
		t.Fatal("failed to mark tu-auto approved")
	}

	// Tick 2: now executing, but the turn was never parked on approval, so the
	// digit is never hidden and the anchor must NOT move.
	w.currentRun().updateApprovalWaitAnchor()
	if w.turn.approvalWaitStartedAt.Load() != 0 {
		t.Error("auto-approve must never record an approval wait")
	}
	if w.turn.processingStartedAt.Load() != oldAnchor {
		t.Errorf("auto-approve must not move the anchor: got %d want %d", w.turn.processingStartedAt.Load(), oldAnchor)
	}
	if got := startedAtMillis(t, w); got != oldAnchor {
		t.Errorf("auto-approve must not touch doc startedAt: got %d want %d", got, oldAnchor)
	}
}

// TestFrozenGapExcludesSuspendedTimeFromElapsed verifies the general frozen-gap
// detector: when a liveness tick lands far later than its interval — meaning the
// process wasn't running (system sleep, VM/host hibernate, a stop-the-world pause)
// — the excess dead time is pushed out of the elapsed anchor, so the digit resumes
// counting only wall-clock time the process was actually alive. Deliberately not
// sleep-specific: the detector observes missed ticks, whatever their cause.
func TestFrozenGapExcludesSuspendedTimeFromElapsed(t *testing.T) {
	w := NewConversationWorker("test-frozen-gap", "user:test")
	defer w.doc.Destroy()

	// A turn that began a minute ago, actively running (anchor in memory + doc).
	oldAnchor := time.Now().Add(-60 * time.Second).UnixMilli()
	w.turn.processingStartedAt.Store(oldAnchor)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":  ActivityCallingLLM,
		"status":    "streaming",
		"startedAt": oldAnchor,
	})

	// First tick just seeds the clock's previous tick — no comparison point yet, no change.
	w.currentRun().detectFrozenGap()
	if w.turn.processingStartedAt.Load() != oldAnchor {
		t.Fatalf("first tick must not move the anchor: got %d want %d", w.turn.processingStartedAt.Load(), oldAnchor)
	}

	// Simulate the process having been frozen for 30s: backdate the last tick so
	// this tick lands 30s + one interval later than expected.
	frozenMs := int64(30_000)
	w.liveness.prevTickMs = time.Now().UnixMilli() - frozenMs - livenessInterval.Milliseconds()

	w.currentRun().detectFrozenGap()

	// The anchor must advance by ~the frozen span, so `now - startedAt` sheds the
	// dead time instead of counting it.
	advance := w.turn.processingStartedAt.Load() - oldAnchor
	if advance < frozenMs-2_000 || advance > frozenMs+2_000 {
		t.Errorf("frozen gap: anchor should advance by ~%dms, advanced %dms", frozenMs, advance)
	}
	if got := startedAtMillis(t, w); got != w.turn.processingStartedAt.Load() {
		t.Errorf("frozen gap: doc startedAt (%d) must match in-memory anchor (%d)", got, w.turn.processingStartedAt.Load())
	}
}

// TestFrozenGapIgnoredWhenIdleOrParked verifies the detector is inert when there
// is no actively-running turn to correct: idle (no anchor) and parked-on-approval
// (the approval-wait mechanism already excludes the whole park, this freeze
// included, so advancing here too would double-count it).
func TestFrozenGapIgnoredWhenIdleOrParked(t *testing.T) {
	w := NewConversationWorker("test-frozen-gap-inert", "user:test")
	defer w.doc.Destroy()

	backdate := func() {
		w.liveness.prevTickMs = time.Now().UnixMilli() - 30_000 - livenessInterval.Milliseconds()
	}

	// Idle: no anchor. A large gap must not create one.
	w.turn.processingStartedAt.Store(0)
	w.currentRun().detectFrozenGap() // seed
	backdate()
	w.currentRun().detectFrozenGap()
	if w.turn.processingStartedAt.Load() != 0 {
		t.Errorf("idle: frozen gap must not set an anchor, got %d", w.turn.processingStartedAt.Load())
	}

	// Parked on an approval: anchor present but approvalWaitStartedAt set. The
	// detector must leave the anchor alone (the approval-wait path owns exclusion).
	oldAnchor := time.Now().Add(-60 * time.Second).UnixMilli()
	w.turn.processingStartedAt.Store(oldAnchor)
	w.turn.approvalWaitStartedAt.Store(time.Now().UnixMilli())
	backdate()
	w.currentRun().detectFrozenGap()
	if w.turn.processingStartedAt.Load() != oldAnchor {
		t.Errorf("parked: frozen gap must not move the anchor, got %d want %d", w.turn.processingStartedAt.Load(), oldAnchor)
	}
}
