//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// checkForNewThreads: which doc-inserted threads the reducer picks up and runs,
// and which it must ignore — completed, unflagged, busy, or cancelled.

func TestCheckForNewThreads_IgnoresThreadWithoutFlag(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)

	// Create a thread WITHOUT needsStrategyRun (simulates /thread command)
	threadID := insertThreadWithOpts(w, threadOpts{goal: "User thread", userMessage: "Hello world"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// checkForNewThreads should NOT process this thread
	w.currentRun().checkForNewThreads()

	// Worker should still be idle (didn't start processing)
	if w.currentRun().loadState() != StateIdle {
		t.Errorf("worker state = %v, want StateIdle (should not process thread without flag)", w.currentRun().loadState())
	}

	// Thread should have no result
	threadYMap := w.doc.GetThreadYMap(threadID)
	result, _ := threadYMap.Get("result").(string)
	if result != "" {
		t.Errorf("thread should have no result, got %q", result)
	}

	w.doc.Destroy()
}

func TestCheckForNewThreads_IgnoresCompletedThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)

	// Create a thread with needsStrategyRun AND a result (already completed, single transaction)
	threadID := insertThreadWithOpts(w, threadOpts{
		goal: "Done thread", needsStrategyRun: true, userMessage: "Summarize", result: "Already summarized",
	})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// checkForNewThreads should NOT process this (already has result)
	w.currentRun().checkForNewThreads()

	// Result should be unchanged
	threadYMap := w.doc.GetThreadYMap(threadID)
	result, _ := threadYMap.Get("result").(string)
	if result != "Already summarized" {
		t.Errorf("thread result = %q, want %q", result, "Already summarized")
	}

	w.doc.Destroy()
}

// TestCheckForNewThreads_IgnoresWhenBusy: a write-capable turn already live is
// what makes the conversation busy for a pickup — the registry's one writer slot
// is taken — so the thread is neither claimed nor dispatched, and its one-shot
// trigger stays armed for the reducer pass after that turn retires.
func TestCheckForNewThreads_IgnoresWhenBusy(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	busy := w.currentRun().beginTurn("") // a root turn is streaming
	t.Cleanup(func() {
		w.sched.unregister(busy.t)
		w.sched.releaseActivity()
	})

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Queued thread", needsStrategyRun: true, userMessage: "Summarize"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	if w.currentRun().checkForNewThreads() {
		t.Fatal("checkForNewThreads picked a thread up beside a live write-capable turn")
	}
	if n := len(w.sched.dispatchQueue); n != 0 {
		t.Fatalf("%d run(s) dispatched while the worker was busy, want 0", n)
	}
	if got := w.threadActivity(threadID); got != ActivityNone {
		t.Errorf("thread claimed while the worker was busy: activity = %q", got)
	}
	ymap := w.doc.GetThreadYMap(threadID)
	ycrdtMu.Lock()
	armed, _ := ymap.Get("needsStrategyRun").(bool)
	ycrdtMu.Unlock()
	if !armed {
		t.Error("needsStrategyRun was consumed by a pickup that never ran")
	}
	if !w.sched.reconcilePending() {
		t.Error("a refused pickup left no reconcile armed to revisit it")
	}
}

func TestHandleItemsChange_CancelsWhenCurrentThreadDeleted(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Continuation"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	// Simulate worker mid-processing on this thread
	w.currentRun().storeState(StateProcessing)
	w.turn.thread.itemID = threadID

	// Delete the thread from the doc (simulates browser deletion via Yjs sync)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		w.doc.ensureItems().Delete(ycrdt.Number(0), 1)
	}, w.doc.authorID)

	w.currentRun().handleItemsChange()

	if w.currentRun().loadState() != StateCancelling {
		t.Errorf("worker state = %v, want StateCancelling after current thread deleted", w.currentRun().loadState())
	}

	w.doc.Destroy()
}

// =============================================================================
// STREAMING INTEGRITY TESTS
//
// These tests exercise the REAL streaming path: queueStreamChunk → channel →
// worker goroutine → processStreamChunk. The mock path (popMockResponse) calls
// processStreamChunk directly on the same goroutine, completely bypassing the
// channel — which is why it never caught the dropped-chunks bug.
// =============================================================================
