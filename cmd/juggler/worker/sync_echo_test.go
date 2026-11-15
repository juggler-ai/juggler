//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// A client's yjs-sync is fanned out to every other client and never back to
// the one that wrote it: it already holds those ops, and the engine writes
// every tool result, diff and preview, so an echo doubles the traffic of
// everything it does. What the worker writes in response — the undo state a
// tracked edit moves — is the worker's own, and reaches the writer too.

import (
	"encoding/json"
	"reflect"
	"testing"
)

const echoedContent = "written by client A"

// replay applies every yjs-sync among frames to a document seeded with base,
// and returns it: what a client holding base ends up with after those frames.
func replay(t *testing.T, base []byte, frames [][]byte) *ConversationDocument {
	t.Helper()
	shadow := NewConversationDocument("conv-attach", "user:shadow")
	if err := shadow.ApplySyncUpdate(base); err != nil {
		t.Fatalf("seeding the shadow doc failed: %v", err)
	}
	for _, raw := range frames {
		var msg YjsSyncMessage
		if json.Unmarshal(raw, &msg) != nil || msg.Type != "yjs-sync" {
			continue
		}
		if err := shadow.ApplySyncUpdate(msg.Bytes); err != nil {
			t.Fatalf("applying a received yjs-sync failed: %v", err)
		}
	}
	return shadow
}

func TestClientSyncIsNotEchoedToItsSender(t *testing.T) {
	w, writer := startAttachableWorker(t)

	a := newMsgChan()
	w.SetCallback("client-a", a.callback)
	b := newMsgChan()
	w.SetCallback("client-b", b.callback)
	quiesce(t, w, a, b)

	// Both shadows start from what the worker holds now, which is what both
	// clients hold once the traffic above has been drained.
	base := w.Document().ToState()
	if err := writer.ApplySyncUpdate(base); err != nil {
		t.Fatalf("bringing client A up to date failed: %v", err)
	}
	before := writer.GetStateVector()
	writer.AppendMessage(ConversationItem{Type: ItemTypeUser, ItemID: "from-a", Content: echoedContent})
	payload, err := json.Marshal(YjsSyncMessage{Type: "yjs-sync", Bytes: writer.GetStateUpdate(before)})
	if err != nil {
		t.Fatalf("marshalling the client sync: %v", err)
	}

	w.SendFromClient("client-a", "yjs-sync", payload)

	aFrames := rawFramesUntilBarrier(t, w, a)
	bFrames := rawFramesUntilBarrier(t, w, b)
	if !docHasContent(replay(t, base, bFrames), echoedContent) {
		t.Fatal("client B never received client A's edit")
	}
	aView := replay(t, base, aFrames)
	if docHasContent(aView, echoedContent) {
		t.Fatal("client A's own edit was echoed back to it")
	}
	// The edit is tracked, so the worker moved the undo state in answer to it.
	// That write is the worker's, and A must have it.
	if reflect.DeepEqual(replay(t, base, nil).GetMetadata(keyUndoState), w.Document().GetMetadata(keyUndoState)) {
		t.Fatal("precondition: client A's edit should have moved the worker's undo state")
	}
	if got, want := aView.GetMetadata(keyUndoState), w.Document().GetMetadata(keyUndoState); !reflect.DeepEqual(got, want) {
		t.Fatalf("client A missed the worker's undo-state write: has %v, worker has %v", got, want)
	}

	// A write of the worker's own reaches everyone, the last writer included.
	base = w.Document().ToState()
	w.Document().AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "from-worker", Content: "written by the worker"})
	for name, mc := range map[string]*msgChan{"A": a, "B": b} {
		if !docHasContent(replay(t, base, rawFramesUntilBarrier(t, w, mc)), "written by the worker") {
			t.Fatalf("client %s never received the worker's write", name)
		}
	}
}
