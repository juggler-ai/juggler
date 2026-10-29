//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside pending_promote_hold_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"testing"
	"time"
)

// TestPromoteLeavesTheQueueWhenThereIsNowhereToPutIt: a thread with no items
// array to promote into keeps its queue. It stands in for the thread that a
// viewer deleted mid-promotion, which can only be reached through the race.
func TestPromoteLeavesTheQueueWhenThereIsNowhereToPutIt(t *testing.T) {
	w := NewConversationWorker("conv-promote-no-target", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	// A thread item inserted without Items gets no nested items array.
	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeThread, ItemID: "th-1"})
	w.enqueuePendingMessage("th-1", UserMessageInput{Text: "queued question"})
	if !w.hasPendingItems("th-1") {
		t.Fatal("message was not queued")
	}

	if n := w.currentRun().promotePendingItems("th-1", restDrain(time.Now())); n != 0 {
		t.Fatalf("promoted %d into a thread with no items array, want 0", n)
	}
	if !w.hasPendingItems("th-1") {
		t.Fatal("the queue was emptied with nowhere to put its messages: they are lost")
	}
}
