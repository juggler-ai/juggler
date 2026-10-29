//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside held_send_restart_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"testing"
	"time"
)

// heldManager is a Manager over store whose workers run on fc, answer with
// replies and have their engine requests answered.
func heldManager(t *testing.T, store *heldStore, fc *fakeClock, replies ...string) *Manager {
	t.Helper()
	stop := make(chan struct{})
	m := newManager(func(w *ConversationWorker) {
		fc.install(w)
		scriptReplies(w, replies...)
		feedEngine(w, stop)
	})
	store.wire(m)
	t.Cleanup(func() {
		m.Shutdown()
		close(stop)
	})
	return m
}

// queueTimedSend seeds a conversation in a first server's Manager, queues a
// send for at, and shuts that server down.
func queueTimedSend(t *testing.T, store *heldStore, fc *fakeClock, id, text string, at time.Time) {
	t.Helper()
	m := heldManager(t, store, fc)
	if err := m.SeedNewConversation(id, "Held", store.project, "2026-10-26T00:00:00Z", testModel); err != nil {
		t.Fatalf("SeedNewConversation: %v", err)
	}
	payload, err := json.Marshal(SendMessageMessage{Type: "send-message", Text: text, NotBefore: at.UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	m.Get(id).SendFromClient("client-A", "send-message", payload)
	fc.awaitArm(t, at)
	if got := store.awaitIndex(t, id, true); got.NotBefore != at.UnixMilli() {
		t.Errorf("index entry = %+v, want notBefore %d", got, at.UnixMilli())
	}
	m.Shutdown()
}

// TestHeldSendFiresAfterARestart: a send scheduled before the server stopped
// fires at its time in the next server, with nobody opening the conversation.
// Then it leaves the index, and the conversation's removal does too.
func TestHeldSendFiresAfterARestart(t *testing.T) {
	const id = "conv-held-restart"
	store := newHeldStore(t, id)
	fc := newFakeClock()
	at := fakeEpoch.Add(time.Hour)
	queueTimedSend(t, store, fc, id, "good morning", at)

	m := heldManager(t, store, fc, "good morning to you")
	w := loadedWorker(t, m, store, id)
	fc.fire(fc.awaitArm(t, at))
	awaitTranscript(t, w, []string{ItemTypeUser + ":good morning", ItemTypeAssistant + ":good morning to you"})
	store.awaitIndex(t, id, false)
}

// TestOverdueHeldSendFiresOnLoad: a send whose time passed while the server
// was down fires as soon as it is loaded.
func TestOverdueHeldSendFiresOnLoad(t *testing.T) {
	const id = "conv-held-overdue"
	store := newHeldStore(t, id)
	fc := newFakeClock()
	at := fakeEpoch.Add(time.Hour)
	queueTimedSend(t, store, fc, id, "while you were out", at)

	later := at.Add(10 * time.Minute)
	fc.set(later)
	m := heldManager(t, store, fc, "back now")
	w := loadedWorker(t, m, store, id)
	fc.fire(fc.awaitArm(t, later))
	awaitTranscript(t, w, []string{ItemTypeUser + ":while you were out", ItemTypeAssistant + ":back now"})
}

// TestStrandedQueuedMessageIsAnsweredOnLoad: an untimed queued message under an
// idle thread is promoted and answered when the conversation loads.
func TestStrandedQueuedMessageIsAnsweredOnLoad(t *testing.T) {
	const id = "conv-stranded"
	store := newHeldStore(t, id)
	store.writeDoc(t, id, strandedDoc(t, id, "are you there"))
	newHeldSendIndex().publish(store.project, id, heldIndexEntry{Due: true}, true)

	fc := newFakeClock()
	m := heldManager(t, store, fc, "I am")
	w := loadedWorker(t, m, store, id)
	fc.fire(fc.awaitArm(t, fakeEpoch))
	awaitTranscript(t, w, []string{ItemTypeUser + ":are you there", ItemTypeAssistant + ":I am"})
	store.awaitIndex(t, id, false)
}

// TestHeldIndexForgetsRemovedAndMissingConversations: an entry for a
// conversation that no longer exists is discarded by the startup load, which
// loads nothing for it; a conversation removed later leaves the index.
func TestHeldIndexForgetsRemovedAndMissingConversations(t *testing.T) {
	const id, gone = "conv-held-removed", "conv-held-gone"
	store := newHeldStore(t, id)
	fc := newFakeClock()
	at := fakeEpoch.Add(time.Hour)
	queueTimedSend(t, store, fc, id, "later", at)
	newHeldSendIndex().publish(store.project, gone, heldIndexEntry{NotBefore: at.UnixMilli()}, true)

	m := heldManager(t, store, fc)
	loadedWorker(t, m, store, id)
	if m.Get(gone) != nil {
		t.Error("the startup load loaded a conversation that does not exist")
	}
	if _, ok := store.index(t)[gone]; ok {
		t.Error("the index still lists a conversation that does not exist")
	}
	fc.awaitArm(t, at)

	m.Remove(id)
	store.awaitIndex(t, id, false)
}

// TestClientInitAfterStartupLoadAttachesToTheLoadedWorker: a viewer opening a
// conversation the startup load brought back reaches that same worker and is
// sent its state, the queued send included.
func TestClientInitAfterStartupLoadAttachesToTheLoadedWorker(t *testing.T) {
	const id = "conv-held-attach"
	store := newHeldStore(t, id)
	fc := newFakeClock()
	at := fakeEpoch.Add(time.Hour)
	queueTimedSend(t, store, fc, id, "queued for later", at)

	m := heldManager(t, store, fc)
	w := loadedWorker(t, m, store, id)
	fc.awaitArm(t, at)

	client := newMsgChan()
	if !m.HandleMessageWithClient(id, "client-A", "init", initPayload(t, id, nil), client.callback) {
		t.Fatal("the client's init was refused")
	}
	if m.Get(id) != w {
		t.Fatal("the client's init reached a different worker than the startup load made")
	}
	doc := NewConversationDocument(id, "user:client")
	t.Cleanup(doc.Destroy)
	if err := doc.ApplySyncUpdate(waitForYjsSync(t, client)); err != nil {
		t.Fatal(err)
	}
	requireLabels(t, "the client's queue", docQueuedLabels(doc, ""), []string{"queued for later"})
}
