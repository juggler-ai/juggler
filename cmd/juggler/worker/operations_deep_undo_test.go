//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// nestThreads builds `depth` nested threads under the worker's root items and
// returns the innermost thread's item id and its nested items Y.Array. The
// scaffold is created under the untracked internal origin so it never lands on
// the undo stack — the caller drives the tracked operation under test.
func nestThreads(t *testing.T, w *ConversationWorker, depth int) (string, *ycrdt.YArray) {
	t.Helper()
	ids := make([]string, depth)
	for i := range ids {
		ids[i] = generateItemID()
	}
	ycrdtMu.Lock()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		parent := w.doc.ensureItems()
		for _, id := range ids {
			thread := conversationItemToYMap(ConversationItem{Type: ItemTypeThread, ItemID: id, Goal: "nest"})
			arr := ycrdt.NewYArray()
			thread.Set("items", arr)
			parent.Push(ycrdt.ArrayAny{thread})
			parent = arr
		}
	}, w.doc.txOrigin())
	ycrdtMu.Unlock()
	innerID := ids[len(ids)-1]
	return innerID, w.doc.GetThreadItemsArray(innerID)
}

// assertRecoveryFoldUndoableAtDepth folds a recovery summary into a thread items
// array nested `depth` levels deep, then asserts one undo reverses the whole fold
// (restoring the seven pre-fold items in order and removing the summary thread)
// and redo re-applies it as one unit. The zombie this guards: at depth ≥2 the
// UndoManager delete filter refused to tombstone the re-inserted summary thread,
// so undo restored the folded prefix beside a lingering summary.
func assertRecoveryFoldUndoableAtDepth(t *testing.T, depth int) {
	t.Helper()
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	innerID, arr := nestThreads(t, w, depth)
	if arr == nil {
		t.Fatalf("could not build depth-%d thread", depth)
	}
	w.doc.InsertMessageIntoArray(arr, 0, recoveryTestItems()...)
	w.thread.itemID = innerID
	w.thread.itemsArray = arr
	w.tracker.EnsureInitialized()

	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.tryContextRecovery(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 5 || !got[0].BoundedCompaction {
		t.Fatalf("post-fold depth-%d items = %s, want a summary thread plus four suffix items", depth, itemIDs(got))
	}

	// One undo restores every pre-fold item in order and removes the summary
	// thread. A lingering summary here is the depth-2 zombie.
	if !w.tracker.Undo() {
		t.Fatalf("recovery fold at depth %d left nothing to undo", depth)
	}
	got := w.doc.GetItemsFromArray(arr)
	wantIDs := []string{"old-0", "old-1", "old-2", "old-3", "recent-0", "recent-1", "recent-2"}
	if len(got) != len(wantIDs) {
		t.Fatalf("after undoing the depth-%d fold: %s, want the seven pre-fold items restored", depth, itemIDs(got))
	}
	for i, want := range wantIDs {
		if got[i].ItemID != want {
			t.Fatalf("restored[%d] = %q, want %q", i, got[i].ItemID, want)
		}
		if got[i].BoundedCompaction {
			t.Fatalf("summary thread survived the undo (depth-%d zombie): %s", depth, itemIDs(got))
		}
	}

	// Redo re-applies the fold atomically.
	if !w.tracker.Redo() {
		t.Fatalf("recovery fold at depth %d was not redoable", depth)
	}
	if re := w.doc.GetItemsFromArray(arr); len(re) != 5 || !re[0].BoundedCompaction {
		t.Fatalf("after redo at depth %d: %s, want the fold re-applied as one unit", depth, itemIDs(re))
	}
}

// TestContextRecoveryFoldUndoableAtDepth2 is the confirmed zombie repro turned
// assertion: a recovery fold two levels deep must be atomically undoable.
func TestContextRecoveryFoldUndoableAtDepth2(t *testing.T) {
	assertRecoveryFoldUndoableAtDepth(t, 2)
}

// TestContextRecoveryFoldUndoableAtDepth3 proves the generalized filter climbs an
// arbitrary chain (not just a second hard-coded hop) by folding one level deeper.
func TestContextRecoveryFoldUndoableAtDepth3(t *testing.T) {
	assertRecoveryFoldUndoableAtDepth(t, 3)
}

// TestDeepArrayItemInsertUndoRedoRoundTrip isolates the delete filter from
// recovery: a plain tracked insert into a depth-2 items array must round-trip
// through undo (tombstone the deep element) and redo (restore it). Before the
// filter generalization the deep element could not be tombstoned, so undo left
// it in place.
func TestDeepArrayItemInsertUndoRedoRoundTrip(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	_, arr := nestThreads(t, w, 2)
	if arr == nil {
		t.Fatal("could not build depth-2 thread")
	}

	// Tracked insert of a plain message into the depth-2 items array, bracketed as
	// its own undo group.
	w.tracker.StopCapturing()
	ycrdtMu.Lock()
	ycrdt.Transact(w.doc.doc, func(_ *ycrdt.Transaction) {
		arr.Insert(0, ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{
			Type: ItemTypeUser, ItemID: "deep-msg", Content: "hi",
		})})
	}, w.doc.authorID, true)
	ycrdtMu.Unlock()
	w.tracker.StopCapturing()

	if got := w.doc.GetItemsFromArray(arr); len(got) != 1 || got[0].ItemID != "deep-msg" {
		t.Fatalf("pre-undo depth-2 items = %s, want [deep-msg]", itemIDs(got))
	}
	if !w.tracker.Undo() {
		t.Fatal("depth-2 insert left nothing to undo")
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 0 {
		t.Fatalf("after undo depth-2 items = %s, want empty (deep element not tombstoned)", itemIDs(got))
	}
	if !w.tracker.Redo() {
		t.Fatal("depth-2 insert was not redoable")
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 1 || got[0].ItemID != "deep-msg" {
		t.Fatalf("after redo depth-2 items = %s, want [deep-msg] restored", itemIDs(got))
	}
}
