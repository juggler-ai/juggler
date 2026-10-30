//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The reducer drain after every run-loop event, held to settling. A pass that
// can do nothing must not ask for another: the drain runs after EVERY event, so
// a pass that re-raises the reconcile bit unconditionally turns each event into
// maxReconcilePasses full walks of the document, and on a large conversation
// that is the whole loop's time.

import (
	"fmt"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// fanOutBeyondCeiling builds a conversation whose root turn spawned one more
// read-only child than may run together, every child parked on a completed tool
// batch and so an ActionCallLLM target. The first maxConcurrentReadOnlyThreads
// children are published as live and mid-call; the last is the one admission
// keeps waiting. It returns the children in document order and the live turns.
func fanOutBeyondCeiling(t *testing.T, name string) (*ConversationWorker, []string, []*turnState) {
	t.Helper()
	w := NewConversationWorker(name, "user:test")
	t.Cleanup(func() {
		w.sched.releaseActivity()
		w.doc.Destroy()
	})
	w.actor.bind()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "compare these",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send four agents.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})

	children := make([]string, 0, maxConcurrentReadOnlyThreads+1)
	for i := 0; i <= maxConcurrentReadOnlyThreads; i++ {
		id := insertThreadWithOpts(w, threadOpts{
			goal: fmt.Sprintf("read %d", i), userMessage: "look", llmCreated: true, delegated: true,
		})
		setThreadKey(w, id, keyReadOnly, true)
		appendToThread(w, id,
			ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "I'll grep for it."},
			ConversationItem{
				Type: ItemTypeToolAction, ItemID: generateItemID(),
				ToolUseID: fmt.Sprintf("tu-%d", i), ToolName: "grep",
				State: StateCompleted, Result: resultJSON("ok"),
			},
		)
		children = append(children, id)
	}

	// The root is parked on its children.
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	turns := make([]*turnState, 0, maxConcurrentReadOnlyThreads)
	for _, id := range children[:maxConcurrentReadOnlyThreads] {
		if !w.claimLLM(id) {
			t.Fatalf("claiming running child %s", id)
		}
		ts := newTurnState()
		ts.thread.itemID = id
		w.registerLiveRun(id, ts)
		turns = append(turns, ts)
	}
	if w.canAdmitThread(children[maxConcurrentReadOnlyThreads]) {
		t.Fatal("fixture: the last child was admissible; it must be waiting on the read-only ceiling")
	}
	return w, children, turns
}

// setThreadKey writes one key on a thread's map, under the document lock.
func setThreadKey(w *ConversationWorker, threadItemID, key string, value any) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(w.doc.getItems(), threadItemID)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) { m.Set(key, value) }, w.doc.authorID)
}

// TestDrainSettlesWhileAChildWaitsOnTheReadOnlyCeiling is the incident shape: a
// root parked on more read-only children than may run at once. Every pass offers
// the waiting child to admission and is refused, and a refusal changes nothing a
// second pass would read — so an unrelated event must cost one pass, not the
// drain's cap.
func TestDrainSettlesWhileAChildWaitsOnTheReadOnlyCeiling(t *testing.T) {
	w, _, _ := fanOutBeyondCeiling(t, "test-drain-ceiling")
	r := w.currentRun()

	// An unrelated event: a liveness tick, a save, a sync — anything that marks.
	r.sched.markReconcile(reconcileItemsChange)
	if passes := r.drainReconcile(); passes > 2 {
		t.Fatalf("one event cost %d reducer passes (cap %d), want at most 2: a pass whose dispatch admission "+
			"refused re-raised the reconcile bit, so every event spins the drain to its cap while the "+
			"refusal stands (last raised by %s)", passes, maxReconcilePasses, r.sched.lastReconcileReason())
	}
	if r.sched.reconcilePending() {
		t.Fatalf("the drain ended with a pass still pending (last raised by %s)", r.sched.lastReconcileReason())
	}
}

// TestDrainSettlesWhileADocDrivenThreadWaitsOnTheCeiling is the same refusal
// reached through the other entry: a needsStrategyRun thread the pickup
// (checkForNewThreads, run at the top of every pass) cannot admit yet.
func TestDrainSettlesWhileADocDrivenThreadWaitsOnTheCeiling(t *testing.T) {
	w, _, _ := fanOutBeyondCeiling(t, "test-drain-ceiling-pickup")
	r := w.currentRun()
	// Stamped read-only in the transaction that inserts it, and left to the
	// drain: a pickup run before the stamp lands would admit it as a writer.
	pickup := insertReadOnlyChild(w, "read more", "look")
	if r.sched.runOn(pickup) != nil || w.canAdmitThread(pickup) {
		t.Fatal("fixture: the doc-driven thread was admissible; it must be waiting on the read-only ceiling")
	}

	r.sched.markReconcile(reconcileItemsChange)
	if passes := r.drainReconcile(); passes > 2 {
		t.Fatalf("one event cost %d reducer passes (cap %d), want at most 2: the doc-driven pickup re-raised "+
			"the reconcile bit for a thread admission refused, so every pass asks for another "+
			"(last raised by %s)", passes, maxReconcilePasses, r.sched.lastReconcileReason())
	}
}

// TestCeilingWaiterIsDispatchedWhenASiblingRetires is the other half: a refused
// child that asks for no retry is still dispatched, because a retiring run is
// what frees the slot and retirement asks for the pass.
func TestCeilingWaiterIsDispatchedWhenASiblingRetires(t *testing.T) {
	w, children, turns := fanOutBeyondCeiling(t, "test-drain-ceiling-retire")
	r := w.currentRun()
	waiting := children[maxConcurrentReadOnlyThreads]

	r.sched.markReconcile(reconcileItemsChange)
	r.drainReconcile()
	if r.sched.runOn(waiting) != nil {
		t.Fatal("fixture: the waiting child was dispatched over the ceiling")
	}

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "found it"}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)

	// The first child finishes: its run settles, its claim goes, its turn retires.
	setThreadKey(w, children[0], keyResult, "done")
	w.releaseLLM(children[0])
	r.finishRetiredTurn(turns[0])
	r.drainReconcile()

	live := r.sched.runOn(waiting)
	if live == nil {
		t.Fatal("the child waiting on the read-only ceiling was not dispatched when a sibling retired: " +
			"a refused dispatch asks for no retry, so retirement has to")
	}
	select {
	case <-live.t.finished:
	case <-time.After(quiesceTimeout):
		t.Fatalf("the dispatched child's turn never finished\n%s", allGoroutineStacks())
	}
}
