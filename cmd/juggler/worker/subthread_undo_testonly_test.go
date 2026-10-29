//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside subthread_undo_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"testing"
	"time"
)

// TestPromotePendingIntoSubthreadIsUndoable pins undo parity between the root and
// sub-thread branches of promotePendingItems: a queued message promoted into a
// sub-thread is undoable just like one promoted into root. Before the fix the
// sub-thread branch committed untracked, so the promoted message could not be
// undone.
func TestPromotePendingIntoSubthreadIsUndoable(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	innerID, arr := nestThreads(t, w, 1)
	if arr == nil {
		t.Fatal("could not build sub-thread")
	}

	w.enqueuePendingMessage(innerID, UserMessageInput{Text: "queued question"})
	if !w.hasPendingItems(innerID) {
		t.Fatal("message was not queued")
	}

	if n := w.currentRun().promotePendingItems(innerID, restDrain(time.Now())); n != 1 {
		t.Fatalf("promoted %d, want 1", n)
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 1 || got[0].Content != "queued question" {
		t.Fatalf("after promote sub-thread items = %s, want the promoted message", itemIDs(got))
	}

	// One undo removes the promoted message; the thread survives.
	if !w.tracker.Undo() {
		t.Fatal("promotion into a sub-thread was not tracked (nothing to undo)")
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 0 {
		t.Fatalf("after undo sub-thread items = %s, want empty", itemIDs(got))
	}
	if w.doc.GetThreadItemsArray(innerID) == nil {
		t.Fatal("thread container was removed by the undo — only the promoted message should be")
	}

	// Redo restores the promoted message.
	if !w.tracker.Redo() {
		t.Fatal("promotion into a sub-thread was not redoable")
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 1 || got[0].Content != "queued question" {
		t.Fatalf("after redo sub-thread items = %s, want the promoted message restored", itemIDs(got))
	}
}
