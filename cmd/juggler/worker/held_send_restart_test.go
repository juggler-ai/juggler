//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"

	"juggler/cmd/juggler/core"
)

// A held send outlives the server: the held-send index names every conversation
// with something queued, and the startup load brings each one back, so a send
// scheduled in a conversation nobody reopens still fires — and a message a
// restart stranded in a queue is answered.

// heldStore is a project's conversation folders on disk, as the session store
// lays them out, and the path provider and save a Manager is wired with. Its
// known conversations are fixed at construction.
type heldStore struct {
	project string
	known   map[string]bool
}

func newHeldStore(t *testing.T, ids ...string) *heldStore {
	t.Helper()
	s := &heldStore{project: t.TempDir(), known: map[string]bool{}}
	for _, id := range ids {
		s.known[id] = true
	}
	return s
}

func (s *heldStore) dir(id string) string {
	return filepath.Join(s.project, ".juggler", "conversations", id)
}

func (s *heldStore) wire(m *Manager) {
	m.SetPathProvider(func(id string) (string, bool) {
		if !s.known[id] {
			return "", false
		}
		return s.dir(id), true
	})
	m.SetSaveBinary(func(id string, data []byte) error {
		if err := os.MkdirAll(s.dir(id), 0o755); err != nil {
			return err
		}
		return os.WriteFile(core.ConvDocPath(s.dir(id)), data, 0o644)
	})
}

// writeDoc saves doc as the conversation's file on disk.
func (s *heldStore) writeDoc(t *testing.T, id string, doc *ConversationDocument) {
	t.Helper()
	if err := os.MkdirAll(s.dir(id), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(core.ConvDocPath(s.dir(id)), doc.ToState(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// index reads the project's held-send index from disk.
func (s *heldStore) index(t *testing.T) map[string]heldIndexEntry {
	t.Helper()
	data, err := os.ReadFile(heldIndexPath(s.project))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]heldIndexEntry
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("the index is not JSON: %v\n%s", err, data)
	}
	return out
}

// awaitIndex waits for the index's entry for id to be present or gone.
func (s *heldStore) awaitIndex(t *testing.T, id string, present bool) heldIndexEntry {
	t.Helper()
	deadline := time.Now().Add(quiesceTimeout)
	for {
		e, ok := s.index(t)[id]
		if ok == present {
			return e
		}
		if time.Now().After(deadline) {
			t.Fatalf("index entry for %s present=%v, want %v (index %v)", id, ok, present, s.index(t))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

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

var testModel = &core.ModelRef{Provider: "test", Model: "test"}

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

// loadedWorker runs the startup load and returns the conversation's worker.
func loadedWorker(t *testing.T, m *Manager, store *heldStore, id string) *ConversationWorker {
	t.Helper()
	m.LoadHeldConversations(store.project)
	w := m.Get(id)
	if w == nil {
		t.Fatalf("the startup load left %s unloaded", id)
	}
	return w
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

// strandedDoc is a conversation whose root queue holds an untimed message on
// an idle thread — what a restart leaves of a message queued behind a turn the
// restart killed.
func strandedDoc(t *testing.T, id, text string) *ConversationDocument {
	t.Helper()
	doc := NewConversationDocument(id, "user:test")
	t.Cleanup(doc.Destroy)
	doc.SetMetadata(keyDefaultModelConfig, map[string]any{"provider": "test", "model": "test"})
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := doc.ensurePendingArrayLocked("")
	arr.Insert(0, ycrdt.ArrayAny{conversationItemToYMap(newUserItem(UserMessageInput{Text: text}))})
	return doc
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

func docQueuedLabels(doc *ConversationDocument, threadItemID string) []string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := doc.getPendingArrayLocked(threadItemID)
	if arr == nil {
		return nil
	}
	return labelsOf(doc.getItemsFromArrayLocked(arr))
}

// TestACloneDropsHeldSends: a copy of a conversation does not carry its
// scheduled sends, or each would fire twice, once in each copy. A message
// queued untimed is carried like the rest of the conversation.
func TestACloneDropsHeldSends(t *testing.T) {
	doc := NewConversationDocument("conv-clone-src", "user:test")
	t.Cleanup(doc.Destroy)
	held := pendingHold{NotBefore: fakeEpoch.Add(time.Hour)}.stamp("send-timed")
	runEnd := pendingHold{RunEnd: true}.stamp("send-run-end")
	ycrdtMu.Lock()
	arr := doc.ensurePendingArrayLocked("")
	for _, v := range []*ycrdt.YMap{
		conversationItemToYMap(newUserItem(UserMessageInput{Text: "untimed"})),
		stampedItemYMap(newSkillToolAction("a-skill"), held),
		stampedItemYMap(newUserItem(UserMessageInput{Text: "timed"}), held),
		conversationItemToYMap(ConversationItem{Type: "context", ItemID: "ctx-ahead-of-run-end"}),
		stampedItemYMap(newUserItem(UserMessageInput{Text: "run-end"}), runEnd),
	} {
		arr.Insert(arr.GetLength(), ycrdt.ArrayAny{v})
	}
	ycrdtMu.Unlock()

	stripped, changed, err := WithoutHeldSends(doc.ToState())
	if err != nil || !changed {
		t.Fatalf("WithoutHeldSends = changed %v, err %v; want a changed state", changed, err)
	}
	clone := NewConversationDocument("conv-clone-src", "user:test")
	t.Cleanup(clone.Destroy)
	if err := clone.LoadFromState(stripped); err != nil {
		t.Fatal(err)
	}
	requireLabels(t, "the clone's queue", docQueuedLabels(clone, ""), []string{"untimed"})

	if _, changed, _ := WithoutHeldSends(clone.ToState()); changed {
		t.Error("a state with no held sends was reported changed")
	}
}
