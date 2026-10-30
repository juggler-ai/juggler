//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The UndoManager keeps every item a tracked transaction deletes, so an undo
// can bring it back, and y-crdt releases that hold only in Clear. A deleted
// item whose undo entry has gone — pruned past the stack cap, dropped with the
// redo stack by a fresh edit, consumed by the undo that restored it — can never
// be restored again, yet would keep its full content in memory and in every
// save for the life of the worker. These tests overwrite a tool-action's
// displayData the way a client's tracked edit does and count the deleted items
// still holding content.

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// deletedWithContent counts the deleted items in doc that still hold their
// content — the ones garbage collection has not reduced to a tombstone. Items
// are counted by length, since adjacent deleted values merge into one struct.
func deletedWithContent(doc *ConversationDocument) int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	n := 0
	for _, structs := range doc.doc.Store.Clients {
		for _, s := range *structs {
			item, ok := s.(*ycrdt.Item)
			if !ok || !item.Deleted() {
				continue
			}
			if _, gone := item.Content.(*ycrdt.ContentDeleted); !gone {
				n += int(item.Length)
			}
		}
	}
	return n
}

// keepFixture is a worker doc holding one tool-action, its tracker, and a
// client doc in step with it.
type keepFixture struct {
	doc, client *ConversationDocument
	tracker     *OperationTracker
}

func newKeepFixture(t *testing.T, maxGroups int) *keepFixture {
	t.Helper()
	doc := NewConversationDocument("keep-conv", "user:test")
	t.Cleanup(doc.Destroy)
	tracker := NewOperationTracker(doc)
	tracker.maxGroups = maxGroups
	tracker.InsertMessage(0, ConversationItem{Type: ItemTypeToolAction, ItemID: "ta", ToolUseID: "tu"})
	client := NewConversationDocument("keep-conv", "user:client")
	t.Cleanup(client.Destroy)
	if err := client.ApplySyncUpdate(doc.GetStateUpdate(client.GetStateVector())); err != nil {
		t.Fatalf("syncing the client: %v", err)
	}
	return &keepFixture{doc: doc, client: client, tracker: tracker}
}

// overwrite replaces the tool-action's displayData from the client with a new
// Y.Map holding output — the shape the engine's updateItemField writes — as
// one undo group of its own.
func (f *keepFixture) overwrite(t *testing.T, output string) {
	t.Helper()
	f.tracker.StopCapturing()
	before := f.client.GetStateVector()
	ycrdtMu.Lock()
	m, ok := f.client.getItems().Get(0).(*ycrdt.YMap)
	if ok {
		f.client.doc.Transact(func(_ *ycrdt.Transaction) {
			// Yjs deletes a replaced Y.Map's entries along with it; y-crdt's
			// ContentType.Delete does not, so the client spells it out.
			if old, ok := m.Get(keyDisplayData).(*ycrdt.YMap); ok {
				for key := range old.GetMap() {
					old.Delete(key)
				}
			}
			dd := ycrdt.NewYMap(nil)
			m.Set(keyDisplayData, dd)
			dd.Set("output", output)
		}, f.client.authorID)
	}
	ycrdtMu.Unlock()
	if !ok {
		t.Fatal("the client holds no tool-action to write")
	}
	f.tracker.ApplyClientEdit(clientA, f.client.GetStateUpdate(before), nil)
}

func (f *keepFixture) output(t *testing.T) string {
	t.Helper()
	items := f.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("doc holds %d items, want the one tool-action", len(items))
	}
	var dd struct {
		Output string `json:"output"`
	}
	if len(items[0].DisplayData) > 0 {
		if err := json.Unmarshal(items[0].DisplayData, &dd); err != nil {
			t.Fatalf("decoding displayData %s: %v", items[0].DisplayData, err)
		}
	}
	return dd.Output
}

func version(i int) string { return fmt.Sprintf("v%d:%s", i, strings.Repeat("x", 1000)) }

// An overwrite whose undo entry has been pruned past the cap can never be
// undone, so the content it replaced must not stay in the doc. Each of the
// maxGroups entries still on the stack keeps one replaced displayData (the map
// and its output string); nothing older may.
func TestUndoPrunedPastCapReleasesWhatItKept(t *testing.T) {
	const maxGroups = 5
	f := newKeepFixture(t, maxGroups)
	for i := range 40 {
		f.overwrite(t, version(i))
	}
	if n, limit := deletedWithContent(f.doc), 2*maxGroups; n > limit {
		t.Errorf("%d deleted items still hold content after 40 overwrites with an undo cap of %d, want at most %d", n, maxGroups, limit)
	}
	if size := len(f.doc.GetStateUpdate(nil)); size > 30_000 {
		t.Errorf("encoded doc is %d bytes after 40 overwrites of a 1 KB value with an undo cap of %d, want under 30000", size, maxGroups)
	}
}

// The entries the cap leaves on the stack still undo and redo in full: what
// was released was only ever what nothing could restore. Each message is
// deleted as an undo step of its own, and only the last maxGroups deletions
// stay on the stack.
func TestUndoAfterCapRestoresTheMostRecentEntries(t *testing.T) {
	const maxGroups = 5
	const count = 20
	doc := NewConversationDocument("keep-conv", "user:test")
	t.Cleanup(doc.Destroy)
	tracker := NewOperationTracker(doc)
	tracker.maxGroups = maxGroups
	for i := range count {
		tracker.InsertMessage(i, ConversationItem{Type: ItemTypeUser, ItemID: fmt.Sprintf("m%d", i), Content: version(i)})
	}
	tracker.DeleteMessages([]int{count - 1})
	perDeletion := deletedWithContent(doc)
	for i := count - 2; i >= 0; i-- {
		tracker.DeleteMessages([]int{i})
	}
	if n, limit := deletedWithContent(doc), maxGroups*perDeletion; n > limit {
		t.Errorf("%d deleted items still hold content after %d deletions with an undo cap of %d, want at most %d (%d per deletion)", n, count, maxGroups, limit, perDeletion)
	}
	// The deletions still on the stack are of m4..m0, the last made, and undo
	// brings them back last-deleted-first: m0, then m1 after it ...
	for k := 1; k <= maxGroups; k++ {
		if !tracker.Undo() {
			t.Fatalf("undo %d of %d changed nothing", k, maxGroups)
		}
		items := doc.GetItems()
		if len(items) != k {
			t.Fatalf("after undo %d the doc holds %d items, want %d", k, len(items), k)
		}
		if got, want := items[k-1].Content, version(k-1); got != want {
			t.Fatalf("after undo %d the last item reads %.4q, want %.4q", k, got, want)
		}
	}
	if tracker.CanUndo() {
		t.Error("the stack still offers an undo past its cap")
	}
	for i, item := range doc.GetItems() {
		if want := version(i); item.Content != want {
			t.Errorf("restored item %d reads %.4q, want %.4q", i, item.Content, want)
		}
	}
	for k := 1; k <= maxGroups; k++ {
		if !tracker.Redo() {
			t.Fatalf("redo %d of %d changed nothing", k, maxGroups)
		}
	}
	if n := len(doc.GetItems()); n != 0 {
		t.Errorf("after redoing every undo the doc holds %d items, want 0", n)
	}
}

// A fresh edit after an undo drops the redo stack, and an undo consumes the
// entry it reverts; what only those entries kept can never come back.
func TestUndoReleasesWhatDroppedEntriesKept(t *testing.T) {
	f := newKeepFixture(t, 100)
	for i := range 10 {
		f.overwrite(t, version(i))
		if !f.tracker.Undo() {
			t.Fatalf("undo of overwrite %d changed nothing", i)
		}
	}
	f.overwrite(t, version(99))
	// The live stack is the tool-action's insertion and the last overwrite,
	// which keeps the one displayData it replaced.
	if n := deletedWithContent(f.doc); n > 2 {
		t.Errorf("%d deleted items still hold content after ten undone overwrites and a fresh edit, want at most 2", n)
	}
	if !f.tracker.Undo() {
		t.Fatal("undo of the fresh edit changed nothing")
	}
	if got := f.output(t); got != "" {
		t.Errorf("undoing the fresh edit left output %.4q, want the tool-action's original empty displayData", got)
	}
	if !f.tracker.Redo() {
		t.Fatal("redo of the fresh edit changed nothing")
	}
	if got, want := f.output(t), version(99); got != want {
		t.Errorf("after redo output starts %.4q, want %.4q", got, want)
	}
}
