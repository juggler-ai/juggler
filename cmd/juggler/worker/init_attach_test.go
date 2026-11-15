//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// Attaching to a worker that is already running is the common case — every
// client inits every conversation it opens — and these tests pin what it costs.
//
// A client that already holds the document says so with its Yjs state vector,
// and is answered with only the ops that vector does not cover. A client that
// sends none holds nothing, so it gets full state. Either answer is addressed
// to the attaching client alone: a document runs to megabytes, and
// broadcasting one on every attach charges it to every other viewer and to the
// engine too. Nor may the first case ever cost what the second does.

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

const attachedContent = "written before this client attached"

const missedContent = "written while this client was away"

// initPayload builds an init message for an existing conversation, with or
// without a state vector (nil ⇒ the field is omitted on the wire).
func initPayload(t *testing.T, convID string, vector []byte) json.RawMessage {
	t.Helper()
	payload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: convID, LoadFromDisk: true},
		StateVector:  vector,
	})
	if err != nil {
		t.Fatalf("marshalling init: %v", err)
	}
	return payload
}

// waitForYjsSync drains a client stream until it sees a yjs-sync, returning its
// bytes. Fails the test if none arrives.
func waitForYjsSync(t *testing.T, mc *msgChan) []byte {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case raw := <-mc.ch:
			var msg YjsSyncMessage
			if json.Unmarshal(raw, &msg) != nil || msg.Type != "yjs-sync" {
				continue
			}
			return msg.Bytes
		case <-deadline:
			t.Fatal("timed out waiting for yjs-sync")
			return nil
		}
	}
}

// startAttachableWorker returns a running, initialized worker holding one item,
// plus a client doc already in step with it.
func startAttachableWorker(t *testing.T) (*ConversationWorker, *ConversationDocument) {
	t.Helper()
	w := NewConversationWorker("conv-attach", "user:test")
	w.currentRun().Start(context.Background())
	t.Cleanup(w.currentRun().Stop)

	if err := w.SendAndWait(context.Background(), "init", initPayload(t, "conv-attach", nil)); err != nil {
		t.Fatalf("first init failed: %v", err)
	}
	w.Document().AppendMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "attached", Content: attachedContent,
	})

	client := NewConversationDocument("conv-attach", "user:client")
	if err := client.ApplySyncUpdate(w.Document().ToState()); err != nil {
		t.Fatalf("seeding the client doc failed: %v", err)
	}
	return w, client
}

// TestAttachWithStateVectorAnswersTheSenderWithADelta is the whole point of the
// state vector on init: only the ops the sender lacks, and only to the sender.
func TestAttachWithStateVectorAnswersTheSenderWithADelta(t *testing.T) {
	w, client := startAttachableWorker(t)

	asker := newMsgChan()
	w.SetCallback("client-asking", asker.callback)
	bystander := newMsgChan()
	w.SetCallback("client-bystander", bystander.callback)

	// The worker moves on while this client is away, so there is a real delta
	// to ask for.
	w.Document().AppendMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "missed", Content: missedContent,
	})
	// That write fans out to both registered clients on its own. Clear it, so
	// what each client receives below is the attach and only the attach.
	quiesce(t, w, asker, bystander)

	w.SendFromClient("client-asking", "init", initPayload(t, "conv-attach", client.GetStateVector()))

	update := waitForYjsSync(t, asker)
	if !isDelta(t, update, attachedContent) {
		t.Fatal("attach answered with full state; the state vector must reduce it to a delta")
	}
	if err := client.ApplySyncUpdate(update); err != nil {
		t.Fatalf("applying the delta failed: %v", err)
	}
	if !docHasContent(client, missedContent) {
		t.Fatal("the delta did not carry the op the client was missing")
	}
	if framesUntilBarrier(t, w, bystander).saw("yjs-sync") {
		t.Fatal("the attaching client's catch-up was broadcast; it must be addressed to that client alone")
	}
}

// TestAttachWithoutStateVectorAnswersTheSenderAlone pins the fallback a client
// with no document depends on — including SecondViewer in the browser suite,
// which subscribes with a vector-less init precisely to be sent everything —
// and that the whole document goes to that client only. A page load inits
// every conversation it shows, so a broadcast here would ship each document to
// every other viewer and the engine once per open tab per load.
func TestAttachWithoutStateVectorAnswersTheSenderAlone(t *testing.T) {
	w, _ := startAttachableWorker(t)

	asker := newMsgChan()
	w.SetCallback("client-asking", asker.callback)
	bystander := newMsgChan()
	w.SetCallback("client-bystander", bystander.callback)
	// Setting up the worker left traffic owed to every registered client — the
	// undo-state write that follows the seeded item is a broadcast of its own,
	// and it carries no item at all. Drain it, or the attach below is answered
	// by a frame written before it was ever sent.
	quiesce(t, w, asker, bystander)

	w.SendFromClient("client-asking", "init", initPayload(t, "conv-attach", nil))

	update := waitForYjsSync(t, asker)
	if isDelta(t, update, attachedContent) {
		t.Fatal("a vector-less attach must be answered with full state")
	}
	if framesUntilBarrier(t, w, bystander).saw("yjs-sync") {
		t.Fatal("a vector-less attach's full state was broadcast; it must be addressed to the attaching client alone")
	}
}

// TestAttachWithAnEmptyStateVectorStillGetsFullState covers the client that
// holds a document object but no ops in it — a freshly created stub about to
// load a conversation from disk. Its vector is not absent, merely empty, and
// the delta since an empty document is the whole document.
func TestAttachWithAnEmptyStateVectorStillGetsFullState(t *testing.T) {
	w, _ := startAttachableWorker(t)

	empty := NewConversationDocument("conv-attach", "user:empty")
	asker := newMsgChan()
	w.SetCallback("client-asking", asker.callback)
	quiesce(t, w, asker)

	w.SendFromClient("client-asking", "init", initPayload(t, "conv-attach", empty.GetStateVector()))

	update := waitForYjsSync(t, asker)
	if isDelta(t, update, attachedContent) {
		t.Fatal("an empty state vector must still yield the whole document")
	}
}
