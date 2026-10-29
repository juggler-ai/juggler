//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// Cancellation and stale-tool cleanup: parking a cancel while real work is in
// flight, and never leaving a running or pending tool action stranded.

// TestCancelStaleToolActions verifies that CancelStaleToolActions marks in-flight
// tool-action items as interrupted based on their state.
func TestCancelStaleToolActions(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Insert tool-action items with different states
	resultDone, _ := json.Marshal(map[string]any{"content": "done"})

	items := []ConversationItem{
		// Item 0: needs evaluation (no state) → should be interrupted
		{Type: ItemTypeToolAction, ItemID: "ta-0", ToolUseID: "tu-0", ToolName: "bash", State: ""},
		// Item 1: running → should be interrupted
		{Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1", ToolName: "bash", State: StateRunning},
		// Item 2: pending approval → should NOT be interrupted
		{Type: ItemTypeToolAction, ItemID: "ta-2", ToolUseID: "tu-2", ToolName: "bash", State: StatePending},
		// Item 3: completed → should NOT be interrupted
		{Type: ItemTypeToolAction, ItemID: "ta-3", ToolUseID: "tu-3", ToolName: "bash", State: StateCompleted, Result: resultDone},
	}
	for i, item := range items {
		w.doc.InsertMessage(i, item)
	}

	// Call CancelStaleToolActions
	w.CancelStaleToolActions("")

	// Verify results
	updatedItems := w.doc.GetItems()
	if len(updatedItems) != 4 {
		t.Fatalf("Expected 4 items, got %d", len(updatedItems))
	}

	// Item 0: should be interrupted
	if len(updatedItems[0].Result) == 0 {
		t.Error("Item 0 (no approval, no result): expected interrupted result, got nil")
	} else {
		var r map[string]any
		_ = json.Unmarshal(updatedItems[0].Result, &r)
		if r["content"] != "Interrupted" {
			t.Errorf("Item 0: expected content 'Interrupted', got %v", r["content"])
		}
	}

	// Item 1: should be interrupted
	if len(updatedItems[1].Result) == 0 {
		t.Error("Item 1 (approved, no result): expected interrupted result, got nil")
	} else {
		var r map[string]any
		_ = json.Unmarshal(updatedItems[1].Result, &r)
		if r["content"] != "Interrupted" {
			t.Errorf("Item 1: expected content 'Interrupted', got %v", r["content"])
		}
	}

	// Item 2: should NOT be interrupted (pending)
	if len(updatedItems[2].Result) != 0 {
		t.Errorf("Item 2 (pending, no result): should not be interrupted, got result: %s", updatedItems[2].Result)
	}

	// Item 3: should NOT be interrupted (already has result)
	var r3 map[string]any
	_ = json.Unmarshal(updatedItems[3].Result, &r3)
	if r3["content"] != "done" {
		t.Errorf("Item 3 (approved, has result): expected original result 'done', got %v", r3["content"])
	}

	w.doc.Destroy()
}

// TestCancelToolActionsIsScopedToItsSubtree pins the per-thread half of
// cancellation: a cancel names the thread it applies to, and everything outside
// that subtree is somebody else's live work. Before the three entry points took
// a subtree root, one thread coming to rest stamped "Interrupted" on every
// running tool in the conversation, including a sibling's.
func TestCancelToolActionsIsScopedToItsSubtree(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	runningTool := func(id string) ConversationItem {
		return ConversationItem{
			Type: ItemTypeToolAction, ItemID: "ta-" + id, ToolUseID: "tu-" + id,
			ToolName: "bash", State: StateRunning,
		}
	}
	nestedA, err := json.Marshal([]ConversationItem{runningTool("a")})
	if err != nil {
		t.Fatalf("marshal thread A items: %v", err)
	}
	nestedB, err := json.Marshal([]ConversationItem{runningTool("b")})
	if err != nil {
		t.Fatalf("marshal thread B items: %v", err)
	}
	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeThread, ItemID: "t-a", Items: nestedA})
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeThread, ItemID: "t-b", Items: nestedB})
	w.doc.InsertMessage(2, runningTool("root"))

	interrupted := func(threadItemID string) bool {
		arr := w.doc.GetThreadItemsArray(threadItemID)
		if arr == nil {
			t.Fatalf("thread %s has no items array", threadItemID)
		}
		items := w.doc.GetItemsFromArray(arr)
		if len(items) != 1 {
			t.Fatalf("thread %s: expected 1 item, got %d", threadItemID, len(items))
		}
		return items[0].State == StateCancelled
	}

	w.CancelStaleToolActions("t-a")
	if !interrupted("t-a") {
		t.Error("the named thread's running tool must be interrupted")
	}
	if interrupted("t-b") {
		t.Error("a sibling thread's running tool must survive another thread's cancel")
	}
	if root := w.doc.GetItems(); root[2].State == StateCancelled {
		t.Error("a root tool must survive a sub-thread's cancel")
	}

	// "" is the root, and every thread hangs off it — so the whole conversation.
	w.CancelStaleToolActions("")
	if !interrupted("t-b") {
		t.Error("a root-scoped cancel must reach every thread")
	}
	if root := w.doc.GetItems(); root[2].State != StateCancelled {
		t.Error("a root-scoped cancel must reach the root's own tools")
	}
}

// TestFinalizeStuckRunningTool verifies the shared finalizer the
// tool-execution-report rule uses: it stamps a tool-action cancelled+interrupted
// IFF it is running with no result, and leaves every other shape untouched — the
// anti-race guard that keeps it compatible with the worker-single-writer rule.
func TestFinalizeStuckRunningTool(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	resultDone, _ := json.Marshal(map[string]any{"content": "done"})
	items := []ConversationItem{
		// Item 0: running, no result → the wedge shape → should be finalized.
		{Type: ItemTypeToolAction, ItemID: "ta-0", ToolUseID: "tu-0", ToolName: "bash", State: StateRunning},
		// Item 1: approved (a fresh re-run) → must NOT be clobbered.
		{Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1", ToolName: "bash", State: StateApproved},
		// Item 2: running WITH a result → already terminal-ish; leave alone.
		{Type: ItemTypeToolAction, ItemID: "ta-2", ToolUseID: "tu-2", ToolName: "bash", State: StateRunning, Result: resultDone},
		// Item 3: pending approval → leave alone.
		{Type: ItemTypeToolAction, ItemID: "ta-3", ToolUseID: "tu-3", ToolName: "bash", State: StatePending},
	}
	for i, item := range items {
		w.doc.InsertMessage(i, item)
	}

	// Item 0: the wedge — finalizes and reports true (epoch 0 = state-only guard).
	if !w.finalizeStuckRunningToolOnField("tu-0", "runningEpoch", 0, "test") {
		t.Error("tu-0 (running, no result): expected finalize to write, got false")
	}
	// Item 1: approved re-run — no write, reports false.
	if w.finalizeStuckRunningToolOnField("tu-1", "runningEpoch", 0, "test") {
		t.Error("tu-1 (approved): must not be finalized (would clobber a re-run)")
	}
	// Item 2: running with a result — no write.
	if w.finalizeStuckRunningToolOnField("tu-2", "runningEpoch", 0, "test") {
		t.Error("tu-2 (running, has result): must not be finalized")
	}
	// Item 3: pending — no write.
	if w.finalizeStuckRunningToolOnField("tu-3", "runningEpoch", 0, "test") {
		t.Error("tu-3 (pending): must not be finalized")
	}
	// Unknown id — no write, no panic.
	if w.finalizeStuckRunningToolOnField("tu-missing", "runningEpoch", 0, "test") {
		t.Error("tu-missing: must not report a write")
	}

	updated := w.doc.GetItems()
	// Item 0 now cancelled + Interrupted.
	if updated[0].State != StateCancelled {
		t.Errorf("tu-0: expected state %q, got %q", StateCancelled, updated[0].State)
	}
	var r0 map[string]any
	_ = json.Unmarshal(updated[0].Result, &r0)
	if r0["content"] != "Interrupted" || r0["cancelled"] != true {
		t.Errorf("tu-0: expected Interrupted+cancelled result, got %v", r0)
	}
	// Item 1 still approved, no result.
	if updated[1].State != StateApproved || len(updated[1].Result) != 0 {
		t.Errorf("tu-1: expected untouched approved/no-result, got state=%q result=%s", updated[1].State, updated[1].Result)
	}
	// Item 2 keeps its original result and running state.
	var r2 map[string]any
	_ = json.Unmarshal(updated[2].Result, &r2)
	if updated[2].State != StateRunning || r2["content"] != "done" {
		t.Errorf("tu-2: expected untouched running/done, got state=%q result=%v", updated[2].State, r2)
	}
	// Item 3 still pending, no result.
	if updated[3].State != StatePending || len(updated[3].Result) != 0 {
		t.Errorf("tu-3: expected untouched pending/no-result, got state=%q result=%s", updated[3].State, updated[3].Result)
	}
}

// TestFinalizeStuckRunningTool_EpochGuard verifies the ABA guard: a finalize
// carrying a stale execution generation must NOT clobber a running tool that a
// re-run re-claimed under a fresh generation, while a finalize carrying the
// matching generation still finalizes the genuine wedge.
func TestFinalizeStuckRunningTool_EpochGuard(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-0", ToolUseID: "tu-0", ToolName: "bash", State: StateRunning,
	})
	// The current execution's generation (the per-incarnation runningEpoch counter
	// claimRunning increments). Set it the way claimRunning would.
	const currentEpoch = 7.0
	w.doc.UpdateToolActionFieldsRecursive("tu-0", map[string]any{"runningEpoch": currentEpoch})

	// A finalize from a PRIOR execution (stale generation) must be ignored — this is
	// the ABA case where a re-run already re-claimed the id to a fresh running.
	if w.finalizeStuckRunningToolOnField("tu-0", "runningEpoch", currentEpoch-1, "stale") {
		t.Error("stale-epoch finalize must not clobber a re-claimed running tool")
	}
	if it, _ := findToolItem(w.doc.GetItems(), "tu-0"); it.State != StateRunning {
		t.Errorf("tu-0 must still be running after a stale-epoch finalize, got %q", it.State)
	}

	// A finalize carrying the CURRENT generation finalizes the genuine wedge.
	if !w.finalizeStuckRunningToolOnField("tu-0", "runningEpoch", currentEpoch, "current") {
		t.Error("matching-epoch finalize must finalize the wedge")
	}
	if it, _ := findToolItem(w.doc.GetItems(), "tu-0"); it.State != StateCancelled {
		t.Errorf("tu-0 must be cancelled after a matching-epoch finalize, got %q", it.State)
	}
}

// TestFinalizeStuckRunningTool_UnstampedEpochIsAGeneration covers a caller that
// observed the tool with no generation stamp at all: 0 is what it saw, not "don't
// know". A claim since then stamps an epoch (claimRunning starts at 1), so a doc
// now carrying one is a different execution and must be left running.
func TestFinalizeStuckRunningTool_UnstampedEpochIsAGeneration(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-0", ToolUseID: "tu-0", ToolName: "bash", State: StateRunning,
	})
	// The re-claim that landed between the caller's observation and its finalize.
	w.doc.UpdateToolActionFieldsRecursive("tu-0", map[string]any{"runningEpoch": 1.0})

	if w.finalizeStuckRunningToolOnField("tu-0", "runningEpoch", 0, "unstamped") {
		t.Error("a finalize that saw no epoch must not clobber an execution that has since been stamped")
	}
	if it, _ := findToolItem(w.doc.GetItems(), "tu-0"); it.State != StateRunning {
		t.Errorf("tu-0 must still be running, got %q", it.State)
	}
}

// TestPureApprovalCancelPreservesWarmSession verifies that cancelling a turn
// parked PURELY on tool approval — nothing executing, e.g. an AskUserQuestion
// awaiting the user's answer — releases the provider session (always
// warm-preserving) and hands off to the reducer (the reconcile bit) so a queued
// turn continues, rather than parking. Keeping the resume anchor warm lets the
// re-run resume via the provider's regimeResumeDelta and deliver the fresh
// answer to the model instead of cold-starting.
func TestPureApprovalCancelPreservesWarmSession(t *testing.T) {
	w := NewConversationWorker("test-pure-approval-cancel", "user:test")

	// Record that the worker released the provider session.
	var called bool
	w.SetCancelLLMSession(func(_, _ string) {
		called = true
	})

	// A turn parked in awaiting_llm with a single tool-action awaiting approval
	// and nothing executing anywhere — the AskUserQuestion-awaiting-answer shape.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "ask me",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "Asking.",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-ask", ToolUseID: "tu-ask",
		ToolName: "AskUserQuestion", State: StatePending,
	})

	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
	})
	w.currentRun().storeState(StateIdle)

	// Precondition: a lone pending tool is a pure-approval block.
	if !w.blockedOnlyByApprovals("") {
		t.Fatal("precondition: a lone pending tool must make blockedOnlyByApprovals=true")
	}

	w.currentRun().handleCancel(cancelReasonUnspecified)

	if !called {
		t.Fatal("expected handleCancel to release the provider session")
	}
	// Pure-approval cancel hands to the reducer (continue what's queued) rather
	// than parking: it raises the reconcile bit and deliberately leaves activity at
	// awaiting_llm so the reducer can run, rather than clearing it to idle.
	if !w.sched.reconcilePending() {
		t.Error("pure-approval cancel: expected the reconcile bit set (hand off to reducer)")
	}
	if got := w.getActivity(); got != ActivityAwaitingLLM {
		t.Errorf("pure-approval cancel: expected activity preserved as %q for the reducer, got %q",
			ActivityAwaitingLLM, got)
	}

	w.doc.Destroy()
}
