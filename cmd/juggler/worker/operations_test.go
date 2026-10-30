//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestItemInsertDeleteUndo tests basic item insert/delete with undo.
func TestItemInsertDeleteUndo(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert an item
	item := ConversationItem{
		Type:    "user",
		ItemID:  "msg1",
		Content: "Hello",
	}
	tracker.InsertMessage(0, item)

	if len(doc.GetItems()) != 1 {
		t.Fatal("Item should exist")
	}

	// Delete it
	tracker.DeleteMessages([]int{0})

	if len(doc.GetItems()) != 0 {
		t.Error("Item should be deleted")
	}

	// Undo should restore
	if !tracker.CanUndo() {
		t.Fatal("Should be able to undo")
	}
	tracker.Undo()

	if len(doc.GetItems()) != 1 {
		t.Error("Item should be restored after undo")
	}

	doc.Destroy()
}

// TestUndoMarksSurviveTheStackCap pins the merge marks against the undo stack's
// pruning from the front. On a full stack every push drops the oldest group,
// so an operation that adds several groups must still undo in one press, and a
// span longer than the cap merges what is left of it and says what it lost.
func TestUndoMarksSurviveTheStackCap(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := NewOperationTracker(doc)
	push := func(n int) {
		for range n {
			tracker.InsertMessage(len(doc.GetItems()), ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "turn"})
			tracker.StopCapturing()
		}
	}
	push(tracker.maxGroups + 5)

	t.Run("thread creation on a full stack is one undo", func(t *testing.T) {
		before := itemIDs(doc.GetItems())
		invocation := ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "go"}
		if _, err := tracker.CreateThread(threadCreation{Goal: "child", Invocation: &invocation}); err != nil {
			t.Fatalf("CreateThread: %v", err)
		}
		tracker.Undo()
		if after := itemIDs(doc.GetItems()); after != before {
			t.Fatalf("one Undo after CreateThread left root = %s, want %s", after, before)
		}
	})

	t.Run("a span outliving the cap merges what remains", func(t *testing.T) {
		mark := tracker.MarkUndoNext()
		push(tracker.maxGroups + 3)
		if out := tracker.MergeFromMark(mark); out.gone || out.lost != 3 {
			t.Fatalf("merge outcome = %+v, want lost 3", out)
		}
		if n := tracker.UndoStackLen(); n != 1 {
			t.Fatalf("undo stack holds %d groups after the merge, want 1", n)
		}
	})
}

// TestAppendRunStarterToThreadJoinsAnOpenRun pins the decide-and-append: a run
// starter goes in only when the thread's trailing run has settled (or it has
// none), and nowhere when the thread has gone.
func TestAppendRunStarterToThreadJoinsAnOpenRun(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := NewOperationTracker(doc)
	doc.InsertThread(0, "child")
	threadID := doc.GetItems()[0].ItemID

	tracker.AppendMessageToThread(threadID, ConversationItem{
		Type: ItemTypeUser, ItemID: "run-1", Content: "go", RunToolUseID: "tu-1",
	})
	if tracker.AppendRunStarterToThread(threadID, continuationMarker()) {
		t.Error("a starter must join the open run, not append beside it")
	}
	if n := len(doc.GetThreadItems(threadID)); n != 1 {
		t.Fatalf("thread holds %d items after a declined starter, want 1", n)
	}

	if err := doc.UpdateItemByIDInThread(threadID, "run-1", "runStatus", runStatusRest); err != nil {
		t.Fatal(err)
	}
	if !tracker.AppendRunStarterToThread(threadID, continuationMarker()) {
		t.Error("a settled run must take a starter for the next one")
	}
	items := doc.GetThreadItems(threadID)
	if len(items) != 2 || !items[1].Continuation {
		t.Errorf("thread items after the starter: %+v", items)
	}

	if tracker.AppendRunStarterToThread("gone", continuationMarker()) {
		t.Error("a thread that has gone takes nothing")
	}
}

// TestUndoRedoCycle tests rapid undo/redo cycles work correctly.
func TestUndoRedoCycle(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert an item
	item := ConversationItem{
		Type:    "user",
		ItemID:  "msg1",
		Content: "Test",
	}
	tracker.InsertMessage(0, item)

	// Delete it
	tracker.DeleteMessages([]int{0})

	// Cycle 5 times
	for i := range 5 {
		if !tracker.CanUndo() {
			t.Fatalf("Cycle %d: should be able to undo", i)
		}
		tracker.Undo()

		if len(doc.GetItems()) != 1 {
			t.Errorf("Cycle %d: undo didn't restore", i)
		}

		if !tracker.CanRedo() {
			t.Fatalf("Cycle %d: should be able to redo", i)
		}
		tracker.Redo()

		if len(doc.GetItems()) != 0 {
			t.Errorf("Cycle %d: redo didn't remove", i)
		}
	}

	doc.Destroy()
}

// TestThreadUndoRedoPreservesNestedItems tests that undo/redo of a thread item
// preserves the nested items Y.Array. This is a regression test for the bug
// where redo recreated thread Y.Maps without a proper Y.Array for nested items,
// causing thread columns to fail to open after undo+redo.
func TestThreadUndoRedoPreservesNestedItems(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert a thread via the document (simulates JS-side thread creation)
	nestedArr := doc.InsertThread(0, "Test thread")
	if nestedArr == nil {
		t.Fatal("InsertThread should return nested Y.Array")
	}

	// Get the thread's itemId so we can look it up later
	raw := doc.items.Get(0)
	threadYMap, ok := raw.(*ycrdt.YMap)
	if !ok {
		t.Fatal("Root item 0 should be a Y.Map")
	}
	threadItemID, _ := threadYMap.Get("itemId").(string)
	if threadItemID == "" {
		t.Fatal("Thread should have an itemId")
	}

	// Insert a child message into the thread's nested items
	doc.InsertMessageIntoArray(nestedArr, 0, ConversationItem{
		Type:    "user",
		ItemID:  "child-msg-1",
		Content: "Hello from inside the thread",
	})

	// Verify setup: thread exists with 1 nested item
	if doc.GetItemsLength() != 1 {
		t.Fatalf("Expected 1 root item, got %d", doc.GetItemsLength())
	}
	foundArr := doc.GetThreadItemsArray(threadItemID)
	if foundArr == nil {
		t.Fatal("Should find thread's nested items array")
	}
	if doc.GetItemsLengthFromArray(foundArr) != 1 {
		t.Fatalf("Expected 1 nested item, got %d", doc.GetItemsLengthFromArray(foundArr))
	}

	// Delete the thread (this snapshots the current state including nested items)
	tracker.DeleteMessages([]int{0})

	if doc.GetItemsLength() != 0 {
		t.Fatal("Thread should be deleted")
	}

	// Undo should restore the thread
	if !tracker.CanUndo() {
		t.Fatal("Should be able to undo delete")
	}
	tracker.Undo()

	if doc.GetItemsLength() != 1 {
		t.Fatal("Thread should be restored after undo")
	}

	// Verify the restored thread has a proper Y.Array for nested items
	restoredArr := doc.GetThreadItemsArray(threadItemID)
	if restoredArr == nil {
		t.Fatal("REGRESSION: Restored thread should have a nested items Y.Array, got nil")
	}

	// Verify nested items were preserved
	nestedItems := doc.GetItemsFromArray(restoredArr)
	if len(nestedItems) != 1 {
		t.Fatalf("REGRESSION: Expected 1 nested item after undo, got %d", len(nestedItems))
	}
	if nestedItems[0].ItemID != "child-msg-1" {
		t.Errorf("Expected nested item ID 'child-msg-1', got '%s'", nestedItems[0].ItemID)
	}
	if nestedItems[0].Content != "Hello from inside the thread" {
		t.Errorf("Expected nested item content preserved, got '%s'", nestedItems[0].Content)
	}

	// Redo should delete it again
	if !tracker.CanRedo() {
		t.Fatal("Should be able to redo")
	}
	tracker.Redo()

	if doc.GetItemsLength() != 0 {
		t.Fatal("Thread should be deleted after redo")
	}

	// Undo again to restore, then verify nested Y.Array survives a second round-trip
	tracker.Undo()

	restoredArr2 := doc.GetThreadItemsArray(threadItemID)
	if restoredArr2 == nil {
		t.Fatal("REGRESSION: Thread should still have nested items Y.Array after second undo")
	}
	nestedItems2 := doc.GetItemsFromArray(restoredArr2)
	if len(nestedItems2) != 1 {
		t.Fatalf("REGRESSION: Expected 1 nested item after second undo, got %d", len(nestedItems2))
	}

	doc.Destroy()
}

// TestGetThreadItemsArrayNested tests that GetThreadItemsArray finds threads
// nested inside other threads (not just root-level threads).
func TestGetThreadItemsArrayNested(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")

	// Insert a parent thread into root items
	parentNestedArr := doc.InsertThread(0, "Parent thread")
	if parentNestedArr == nil {
		t.Fatal("InsertThread should return nested Y.Array for parent")
	}

	// Get parent thread's itemId
	parentRaw := doc.items.Get(0)
	parentMap, ok := parentRaw.(*ycrdt.YMap)
	if !ok {
		t.Fatal("Root item 0 should be a Y.Map")
	}
	parentThreadID, _ := parentMap.Get("itemId").(string)
	if parentThreadID == "" {
		t.Fatal("Parent thread should have an itemId")
	}

	// Insert a child thread inside the parent thread's nested items
	childThreadID := generateItemID()
	doc.doc.Transact(func(_ *ycrdt.Transaction) {
		childItem := ConversationItem{
			Type:   ItemTypeThread,
			ItemID: childThreadID,
			Goal:   "Child thread",
		}
		childMap := conversationItemToYMap(childItem)
		childArr := ycrdt.NewYArray()
		childMap.Set("items", childArr)
		parentNestedArr.Push(ycrdt.ArrayAny{childMap})
	}, doc.authorID)

	// Verify: parent thread is found (root-level — should always work)
	if doc.GetThreadItemsArray(parentThreadID) == nil {
		t.Fatal("Should find parent thread in root items")
	}

	// Verify: child thread is found (nested — this is the bug)
	childArr := doc.GetThreadItemsArray(childThreadID)
	if childArr == nil {
		t.Fatal("Should find child thread nested inside parent thread")
	}

	doc.Destroy()
}

// TestThreadResultPreservedOnUndoRedo verifies that the "result" key on a thread Y.Map
// survives undo (delete) then redo (restore). The restored Y.Map must carry "result"
// (the key JS reads), not "threadResult" — otherwise threads restored via redo appear
// as still running.
func TestThreadResultPreservedOnUndoRedo(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert thread via tracker so the insertion is tracked for undo/redo.
	threadItemID := generateItemID()
	tracker.InsertMessage(0, ConversationItem{
		Type:   ItemTypeThread,
		ItemID: threadItemID,
		Goal:   "Test thread",
		Items:  json.RawMessage("[]"),
	})
	items := doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item, got %d", len(items))
	}

	// Set the result key on the thread Y.Map (simulates a settled run summarising it)
	threadYMap := findThreadYMap(doc.getItems(), threadItemID)
	if threadYMap == nil {
		t.Fatal("Thread Y.Map not found")
	}
	ycrdtMu.Lock()
	doc.doc.Transact(func(_ *ycrdt.Transaction) {
		threadYMap.Set("result", "Task done")
	}, doc.authorID)
	ycrdtMu.Unlock()

	// Verify result is set
	ycrdtMu.Lock()
	initialResult, _ := threadYMap.Get("result").(string)
	ycrdtMu.Unlock()
	if initialResult != "Task done" {
		t.Fatalf("Expected initial result 'Task done', got %q", initialResult)
	}

	// Undo: should remove the thread
	if !tracker.CanUndo() {
		t.Fatal("Should be able to undo")
	}
	tracker.Undo()

	if doc.GetItemsLength() != 0 {
		t.Fatal("Thread should be deleted after undo")
	}

	// Redo: should restore the thread with its result
	if !tracker.CanRedo() {
		t.Fatal("Should be able to redo")
	}
	tracker.Redo()

	if doc.GetItemsLength() != 1 {
		t.Fatal("Thread should be restored after redo")
	}

	// REGRESSION: restored thread Y.Map must have "result" key (not "threadResult")
	restoredYMap := findThreadYMap(doc.getItems(), threadItemID)
	if restoredYMap == nil {
		t.Fatal("Restored thread Y.Map not found")
	}
	ycrdtMu.Lock()
	restoredResult, _ := restoredYMap.Get("result").(string)
	ycrdtMu.Unlock()

	if restoredResult != "Task done" {
		t.Errorf("restored thread 'result' key = %q, want 'Task done'", restoredResult)
	}

	doc.Destroy()
}

// TestSubThreadDeleteUndoRestoresTrackedItems verifies that deleting a thread whose
// nested items were inserted via doc.InsertMessageIntoArray brings those
// items back after undo — including surviving a full undo→redo→undo cycle.
func TestSubThreadDeleteUndoRestoresTrackedItems(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)
	defer doc.Destroy()

	nestedArr := doc.InsertThread(0, "test-thread")
	threadID := doc.GetItems()[0].ItemID

	doc.InsertMessageIntoArray(nestedArr, 0, ConversationItem{Type: "rule", ItemID: "ctx-1", Content: "Rule 1"})
	doc.InsertMessageIntoArray(nestedArr, 1, ConversationItem{Type: "rule", ItemID: "ctx-2", Content: "Rule 2"})

	tracker.DeleteMessages([]int{0})
	if doc.GetItemsLength() != 0 {
		t.Fatal("thread should be deleted")
	}

	checkSubItems := func(label string) {
		if doc.GetItemsLength() != 1 {
			t.Fatalf("%s: expected 1 root item, got %d", label, doc.GetItemsLength())
		}
		arr := doc.GetThreadItemsArray(threadID)
		if arr == nil {
			t.Fatalf("%s: restored thread has no nested items array", label)
		}
		items := doc.GetItemsFromArray(arr)
		if len(items) != 2 {
			t.Fatalf("%s: expected 2 sub-items, got %d", label, len(items))
		}
		if items[0].ItemID != "ctx-1" || items[1].ItemID != "ctx-2" {
			t.Errorf("%s: wrong sub-item IDs: %q, %q", label, items[0].ItemID, items[1].ItemID)
		}
		// No duplicates across root + sub-thread
		seen := make(map[string]bool)
		for _, item := range doc.GetItems() {
			if seen[item.ItemID] {
				t.Errorf("%s: duplicate root itemID %q", label, item.ItemID)
			}
			seen[item.ItemID] = true
		}
		for _, item := range items {
			if seen[item.ItemID] {
				t.Errorf("%s: duplicate sub-thread itemID %q", label, item.ItemID)
			}
			seen[item.ItemID] = true
		}
	}

	tracker.Undo()
	checkSubItems("after first undo")

	// redo→undo round-trip must not produce duplicates
	tracker.Redo()
	if doc.GetItemsLength() != 0 {
		t.Fatal("after redo: thread should be gone again")
	}
	tracker.Undo()
	checkSubItems("after undo→redo→undo")
}
