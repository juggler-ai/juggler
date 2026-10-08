//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"testing"
	"time"
)

// A dispatched turn runs on a goroutine of its own, so a panic in it is not
// caught by handleMessage's recover. Unrecovered, it ends the process: every
// conversation, not just the one that hit the bug. These tests panic a turn and
// require the worker to come to rest with the panic reported in the document.

// TestTurnPanicSettlesTheRunAsAnError panics a sub-thread's turn at the point
// the provider is called. The run must settle as an error, so a parent parked on
// it is told rather than left waiting, and the thread's claim must be released.
func TestTurnPanicSettlesTheRunAsAnError(t *testing.T) {
	w := NewConversationWorker("conv-turn-panic", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	child := insertThreadWithOpts(w, threadOpts{goal: "read a", userMessage: "look at a"})
	w.turn.thread.itemID = child
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(child)

	w.setMockResponses([]MockResponse{{Panic: "boom in the turn"}})
	feedContextAndTools(t, w)
	w.driveStrategyLoop(t, "", true)

	assertRestedAfterPanic(t, w, child)

	items := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(child))
	last := items[len(items)-1]
	if last.Type != ItemTypeError || !strings.Contains(last.Content, "boom in the turn") {
		t.Errorf("the thread's last item is %s %q, want an error naming the panic", last.Type, last.Content)
	}

	ycrdtMu.Lock()
	status, _ := latestRunOutcomeLocked(findThreadYMap(w.doc.getItems(), child))
	ycrdtMu.Unlock()
	if status != runStatusError {
		t.Errorf("the panicked run settled as %q, want %q", status, runStatusError)
	}
}

// TestTurnPanicAtRootReportsAndRests is the same at the root, which has no run
// record to settle: the error lands in the root transcript and the conversation
// rests.
func TestTurnPanicAtRootReportsAndRests(t *testing.T) {
	w := NewConversationWorker("conv-turn-panic-root", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	w.setMockResponses([]MockResponse{{Panic: "boom at root"}})
	feedContextAndTools(t, w)
	w.driveStrategyLoop(t, "hello", false)

	assertRestedAfterPanic(t, w, "")
	if !rootHasErrorContaining(w, "boom at root") {
		t.Errorf("no error item naming the panic in the root transcript")
	}
}

// TestTurnPanicOutsideTheStrategyLoopIsContained panics a turn's body outside
// the strategy loop's own recovery, which is where a panic in finishStrategyRun
// lands. The backstop in runTurn must still retire the turn and rest the
// conversation rather than end the process.
func TestTurnPanicOutsideTheStrategyLoopIsContained(t *testing.T) {
	w := NewConversationWorker("conv-turn-panic-backstop", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	r := w.currentRun()
	r.storeState(StateIdle)

	if !r.claimLLM("") {
		t.Fatal("could not claim the root")
	}
	tr := r.beginTurn("")
	tr.t.processingStartedAt.Store(time.Now().UnixMilli())
	tr.storeState(StateProcessing)
	r.runTurn(tr, func(*run) { panic("boom in the backstop") })
	w.quiesce(t)

	assertRestedAfterPanic(t, w, "")
	if !rootHasErrorContaining(w, "boom in the backstop") {
		t.Errorf("no error item naming the panic in the root transcript")
	}
}

// TestDocLockUsableAfterPanic pins the check every recover makes before it
// carries on: a lock that frees within the grace is usable, and one that stays
// held is not. A panic between a bare Lock and Unlock leaves the process-wide
// doc lock held for ever, and a recovery that went on to write the document
// would freeze every conversation behind it instead of ending the process.
func TestDocLockUsableAfterPanic(t *testing.T) {
	var free watchedMutex
	if !free.acquirableWithin(50 * time.Millisecond) {
		t.Error("a free lock was reported unusable")
	}

	var briefly watchedMutex
	briefly.Lock()
	go func() {
		time.Sleep(10 * time.Millisecond)
		briefly.Unlock()
	}()
	if !briefly.acquirableWithin(2 * time.Second) {
		t.Error("a lock released within the grace was reported unusable")
	}

	var wedged watchedMutex
	wedged.Lock()
	if wedged.acquirableWithin(50 * time.Millisecond) {
		t.Error("a lock nobody releases was reported usable")
	}
	wedged.Unlock()
}

func assertRestedAfterPanic(t *testing.T, w *ConversationWorker, threadID string) {
	t.Helper()
	if w.sched.hasLive() {
		t.Errorf("a turn is still live after the panic")
	}
	if got := w.anyRunState(); got != StateIdle {
		t.Errorf("conversation state after the panic = %v, want %v", got, StateIdle)
	}
	if got := w.threadActivity(threadID); got != ActivityNone {
		t.Errorf("thread %q activity after the panic = %q, want none: its claim was never released", threadID, got)
	}
}

func rootHasErrorContaining(w *ConversationWorker, text string) bool {
	for _, it := range w.doc.GetItems() {
		if it.Type == ItemTypeError && strings.Contains(it.Content, text) {
			return true
		}
	}
	return false
}
