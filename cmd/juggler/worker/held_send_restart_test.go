//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"

	"juggler/cmd/juggler/core"
	"juggler/internal/atomicio"
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
	data, err := atomicio.RobustReadFile(heldIndexPath(s.project))
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

var testModel = &core.ModelRef{Provider: "test", Model: "test"}

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

// TestHeldIndexWritesOutlastAReader: every write and the final removal of the
// index land while another process keeps opening the file — a scanner, the
// search indexer, or a test polling it. Windows refuses to replace or delete a
// file someone has open, for as long as they have it open.
func TestHeldIndexWritesOutlastAReader(t *testing.T) {
	store := newHeldStore(t)
	path := heldIndexPath(store.project)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
				_, _ = os.ReadFile(path)
			}
		}
	}()
	defer func() { close(stop); <-done }()

	x := newHeldSendIndex()
	const n = 20
	for i := range n {
		id := fmt.Sprintf("conv-%d", i)
		x.publish(store.project, id, heldIndexEntry{Due: true}, true)
		if _, ok := store.index(t)[id]; !ok {
			t.Fatalf("write %d did not reach the index on disk", i)
		}
	}
	for i := range n {
		x.publish(store.project, fmt.Sprintf("conv-%d", i), heldIndexEntry{}, false)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the emptied index is still on disk (stat err %v)", err)
	}
}
