//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside turn_panic_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"strings"
	"testing"
)

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
