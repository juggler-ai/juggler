//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// A client's edits group into undo steps by when the user made them, not by
// when the worker got round to applying them. The worker applies each frame
// when it reaches the front of its inbox, and on a loaded machine two deletes a
// user made milliseconds apart can arrive further apart than the capture
// window — which split them into two undo steps, so one Undo restored only one.
//
// The sleep below is the condition under test, not a wait for anything: it
// puts the second frame's arrival outside the window, and a slower machine
// only puts it further outside.

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

const clientA = "client-a"

// clientEditWorker returns a running worker holding three items and a client
// doc in step with it, with the capture window shut so the next edit opens a
// group of its own.
func clientEditWorker(t *testing.T) (*ConversationWorker, *ConversationDocument) {
	t.Helper()
	w, client := startAttachableWorker(t)
	for _, id := range []string{"second", "third"} {
		w.Document().AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: id, Content: id})
	}
	if err := client.ApplySyncUpdate(w.Document().GetStateUpdate(client.GetStateVector())); err != nil {
		t.Fatalf("bringing the client up to date failed: %v", err)
	}
	w.SendFromClient(clientA, "stop-undo-capturing", json.RawMessage(`{}`))
	barrier(t, w)
	return w, client
}

// barrier returns once the worker has handled everything queued before it. It
// is not the test-harness ping, which closes the capture window — exactly the
// thing these tests must leave alone.
func barrier(t *testing.T, w *ConversationWorker) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), barrierBudget)
	defer cancel()
	if err := w.SendAndWait(ctx, "get-yjs-state", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("barrier: %v", err)
	}
}

// deleteLastFromClient deletes the client's last item and sends the edit as
// clientA's yjs-sync, stamped with sinceEditMs (nil ⇒ unstamped).
func deleteLastFromClient(t *testing.T, w *ConversationWorker, client *ConversationDocument, sinceEditMs *int) {
	t.Helper()
	before := client.GetStateVector()
	client.DeleteMessages([]int{client.GetItemsLength() - 1})
	payload, err := json.Marshal(YjsSyncMessage{
		Type: msgYjsSync, Bytes: client.GetStateUpdate(before), SinceEditMs: sinceEditMs,
	})
	if err != nil {
		t.Fatalf("marshalling yjs-sync: %v", err)
	}
	w.SendFromClient(clientA, "yjs-sync", payload)
	barrier(t, w)
}

// arriveLate puts the next frame's arrival outside the worker's capture window.
func arriveLate() { time.Sleep(2 * undoCaptureTimeoutMs * time.Millisecond) }

func ms(n int) *int { return &n }

func TestClientEditsMadeTogetherAreOneUndoStep(t *testing.T) {
	w, client := clientEditWorker(t)
	height := w.tracker.UndoStackLen()

	deleteLastFromClient(t, w, client, nil)
	arriveLate()
	deleteLastFromClient(t, w, client, ms(3))

	if got := w.tracker.UndoStackLen() - height; got != 1 {
		t.Fatalf("two deletes made 3ms apart added %d undo steps, want 1", got)
	}
	w.tracker.Undo()
	if got := w.Document().GetItemsLength(); got != 3 {
		t.Fatalf("one undo left %d items, want all 3 back", got)
	}
}

// The client's clock only joins a group the client's own previous edit opened.
// An explicit boundary, or another writer's group on top, still separates.
func TestClientEditsMadeTogetherKeepEveryOtherBoundary(t *testing.T) {
	t.Run("stop-undo-capturing", func(t *testing.T) {
		w, client := clientEditWorker(t)
		height := w.tracker.UndoStackLen()

		deleteLastFromClient(t, w, client, nil)
		w.SendFromClient(clientA, "stop-undo-capturing", json.RawMessage(`{}`))
		deleteLastFromClient(t, w, client, ms(3))

		if got := w.tracker.UndoStackLen() - height; got != 2 {
			t.Fatalf("an explicit boundary between the deletes gave %d undo steps, want 2", got)
		}
	})

	t.Run("worker write in between", func(t *testing.T) {
		w, client := clientEditWorker(t)
		height := w.tracker.UndoStackLen()

		deleteLastFromClient(t, w, client, nil)
		w.tracker.AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "reply", Content: "reply"})
		if err := client.ApplySyncUpdate(w.Document().GetStateUpdate(client.GetStateVector())); err != nil {
			t.Fatalf("bringing the client up to date failed: %v", err)
		}
		arriveLate()
		deleteLastFromClient(t, w, client, ms(3))

		if got := w.tracker.UndoStackLen() - height; got != 3 {
			t.Fatalf("delete, worker append, delete gave %d undo steps, want 3", got)
		}
	})

	t.Run("slow client", func(t *testing.T) {
		w, client := clientEditWorker(t)
		height := w.tracker.UndoStackLen()

		deleteLastFromClient(t, w, client, nil)
		deleteLastFromClient(t, w, client, ms(10*undoCaptureTimeoutMs))

		if got := w.tracker.UndoStackLen() - height; got != 2 {
			t.Fatalf("deletes made seconds apart gave %d undo steps, want 2", got)
		}
	})
}
