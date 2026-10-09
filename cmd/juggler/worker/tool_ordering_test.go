//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// These tests guard the ordering of the calls one model turn emits. Calls are
// taken in emission order: consecutive read calls run together, and a write call
// waits for every call before it and holds back every call after it — so a turn
// that writes a script and then runs it never runs it first.

// insertToolBatch appends one turn's tool calls, in emission order, all sharing
// txnID. categories[i] is stamped as the engine's evaluation would stamp it; ""
// leaves a call unclassified.
func insertToolBatch(t *testing.T, w *ConversationWorker, txnID string, ids, categories []string) {
	t.Helper()
	items := make([]ConversationItem, len(ids))
	for i, id := range ids {
		items[i] = ConversationItem{
			Type: ItemTypeToolAction, ItemID: "ta-" + id, ToolUseID: id,
			ToolName: "bash", State: StateApproved, TransactionID: txnID,
		}
	}
	w.doc.InsertMessage(0, items...)
	for i, id := range ids {
		if categories[i] != "" {
			w.doc.UpdateToolActionFieldsRecursive(id, map[string]any{"category": categories[i]})
		}
	}
}

func setToolState(w *ConversationWorker, id, state string) {
	fields := map[string]any{"state": state}
	if state == StateRunning {
		fields["runningStartedAt"] = time.Now().Format(time.RFC3339)
	}
	w.doc.UpdateToolActionFieldsRecursive(id, fields)
}

func wantExecuted(t *testing.T, h *reattachHarness, step string, want map[string]int) {
	t.Helper()
	for id, n := range want {
		if got := h.executeCount(id); got != n {
			t.Fatalf("%s: execute-tool for %s = %d, want %d", step, id, got, n)
		}
	}
}

// TestToolOrdering_WriteWaitsForEarlierWrite is the motivating case: a turn
// writes a script with one bash call and runs it with the next. The second must
// not be commanded until the first has finished.
func TestToolOrdering_WriteWaitsForEarlierWrite(t *testing.T) {
	h := newReattachHarness(t, "conv-order-write-write")
	w := h.w
	insertToolBatch(t, w, "txn-1", []string{"tu-a", "tu-b"}, []string{"write", "write"})

	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "both approved", map[string]int{"tu-a": 1, "tu-b": 0})

	setToolState(w, "tu-a", StateRunning)
	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "first running", map[string]int{"tu-a": 1, "tu-b": 0})

	setToolState(w, "tu-a", StateCompleted)
	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "first completed", map[string]int{"tu-a": 1, "tu-b": 1})
}

// TestToolOrdering_ReadsRunTogetherBetweenWrites: [read, read, write, read] runs
// as three waves — the two reads together, then the write alone, then the read.
func TestToolOrdering_ReadsRunTogetherBetweenWrites(t *testing.T) {
	h := newReattachHarness(t, "conv-order-waves")
	w := h.w
	insertToolBatch(t, w, "txn-1",
		[]string{"tu-r1", "tu-r2", "tu-w", "tu-r3"},
		[]string{"read", "read", "write", "read"})

	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "wave 1", map[string]int{"tu-r1": 1, "tu-r2": 1, "tu-w": 0, "tu-r3": 0})

	setToolState(w, "tu-r1", StateCompleted)
	setToolState(w, "tu-r2", StateRunning)
	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "wave 1 half done", map[string]int{"tu-w": 0, "tu-r3": 0})

	setToolState(w, "tu-r2", StateCancelled)
	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "wave 2", map[string]int{"tu-w": 1, "tu-r3": 0})

	setToolState(w, "tu-w", StateCompleted)
	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "wave 3", map[string]int{"tu-r3": 1})
}

// TestToolOrdering_MetaCallsDoNotSerialize: only a write is a barrier. Meta
// calls (todo, plan, create_thread…) run alongside reads as they always have.
func TestToolOrdering_MetaCallsDoNotSerialize(t *testing.T) {
	h := newReattachHarness(t, "conv-order-meta")
	w := h.w
	insertToolBatch(t, w, "txn-1", []string{"tu-m", "tu-r"}, []string{"meta", "read"})

	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "meta + read", map[string]int{"tu-m": 1, "tu-r": 1})
}

// TestToolOrdering_BatchesAreIndependent: the order binds only the calls of one
// turn. A call from another turn, or one with no turn at all, is not held.
func TestToolOrdering_BatchesAreIndependent(t *testing.T) {
	h := newReattachHarness(t, "conv-order-batches")
	w := h.w
	insertToolBatch(t, w, "txn-1", []string{"tu-a"}, []string{"write"})
	insertToolBatch(t, w, "txn-2", []string{"tu-b"}, []string{"write"})
	insertToolBatch(t, w, "", []string{"tu-c"}, []string{"write"})

	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "separate turns", map[string]int{"tu-a": 1, "tu-b": 1, "tu-c": 1})
}

// TestToolOrdering_ParkedCallHoldsNothing: a call parked for the user is not
// running and may never run, and approvals can be given in any order — a call
// the user approves runs, whatever is still waiting on a decision above it.
// Once approved, the earlier call takes its place in the order again.
func TestToolOrdering_ParkedCallHoldsNothing(t *testing.T) {
	h := newReattachHarness(t, "conv-order-parked")
	w := h.w
	insertToolBatch(t, w, "txn-1", []string{"tu-a", "tu-b", "tu-c"}, []string{"write", "write", "write"})
	setToolState(w, "tu-a", StatePending)
	setToolState(w, "tu-c", StatePending)

	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "approved behind a parked call", map[string]int{"tu-b": 1})

	// tu-b is running, so approving tu-c queues it behind tu-b — while tu-a,
	// still parked, holds back neither.
	setToolState(w, "tu-b", StateRunning)
	setToolState(w, "tu-c", StateApproved)
	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "approved behind a running write", map[string]int{"tu-c": 0})

	setToolState(w, "tu-b", StateCompleted)
	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "running write finished", map[string]int{"tu-c": 1})
}

// TestToolOrdering_UnclassifiedCallIsABarrier: a call with no category could be
// a write. Calls after it wait — and waiting is not a failed delivery: however
// long the hold, it is neither counted against the attempts cap nor escalated,
// and the call is commanded once it is released.
func TestToolOrdering_UnclassifiedCallIsABarrier(t *testing.T) {
	h := newReattachHarness(t, "conv-order-unclassified")
	w := h.w
	insertToolBatch(t, w, "txn-1", []string{"tu-x", "tu-r"}, []string{"", "read"})
	setToolState(w, "tu-x", StateRunning)

	w.tools.redriveAfter = 0
	for i := 0; i < maxToolCommandAttempts+3; i++ {
		w.driveToolActions()
		h.flush(t)
	}
	wantExecuted(t, h, "held behind an unclassified call", map[string]int{"tu-r": 0})
	if it, ok := findToolItem(w.currentRun().getTargetItems(), "tu-r"); !ok || it.State != StateApproved {
		t.Fatalf("held call must stay approved, not be escalated: %+v (ok=%v)", it, ok)
	}

	setToolState(w, "tu-x", StateCompleted)
	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "released", map[string]int{"tu-r": 1})
}
