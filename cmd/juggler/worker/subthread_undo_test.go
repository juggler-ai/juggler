//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
)

// TestSubthreadTurnContentIsUndoable pins that a sub-thread turn's content is
// captured for undo exactly like a root turn's. The strategy loop appends turn
// content via insertTargetMessage; in a sub-thread that content used to commit
// under the untracked origin, so it could never be undone. One undo must remove
// the whole turn's content while leaving the thread container in place, and redo
// must restore it.
func TestSubthreadTurnContentIsUndoable(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	innerID, arr := nestThreads(t, w, 1)
	if arr == nil {
		t.Fatal("could not build sub-thread")
	}
	w.thread.itemID = innerID
	w.thread.itemsArray = arr

	// A sub-thread turn: an assistant message plus a tool-action, appended the way
	// the strategy loop does. Both land in one undo group (the assistant is
	// non-auxiliary and opens the group; the auxiliary tool-action attaches).
	w.insertTargetMessage(w.getTargetItemsLength(),
		ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "working on it"},
		ConversationItem{Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1", ToolName: "read_file", State: StateCompleted},
	)
	if got := w.doc.GetItemsFromArray(arr); len(got) != 2 {
		t.Fatalf("pre-undo sub-thread items = %s, want [a-1, ta-1]", itemIDs(got))
	}

	// One undo removes the whole turn's content; the thread container survives.
	if !w.tracker.Undo() {
		t.Fatal("sub-thread turn content was not tracked (nothing to undo)")
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 0 {
		t.Fatalf("after undo sub-thread items = %s, want empty", itemIDs(got))
	}
	if w.doc.GetThreadItemsArray(innerID) == nil {
		t.Fatal("thread container was removed by the undo — only its turn content should be")
	}

	if !w.tracker.Redo() {
		t.Fatal("sub-thread turn content was not redoable")
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 2 || got[0].ItemID != "a-1" || got[1].ItemID != "ta-1" {
		t.Fatalf("after redo sub-thread items = %s, want [a-1, ta-1] restored", itemIDs(got))
	}
}

// TestCreateThreadIsAtomicallyUndoable pins that a whole thread creation — the
// container, the cloned seed context, and the seed prompt — is one undo unit.
// The seeds and seed prompt used to commit untracked, so undoing a fresh thread
// (or redoing it) left the child empty or orphaned. One undo removes the entire
// child; redo restores it with all its seeded content.
func TestCreateThreadIsAtomicallyUndoable(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()
	// Give root a canonical starting-context run (system prompt, agents, memory)
	// so the child has real seeds to clone. AppendMessage commits untracked, so
	// root content is not itself on the undo stack.
	seedableRoot(w.doc, "identity")
	rootBefore := w.doc.GetItemsLength()

	threadID, err := w.createThread(CreateThreadOptions{Goal: "child", Prompt: "do the thing"})
	if err != nil {
		t.Fatal(err)
	}
	if got := w.doc.GetItemsLength(); got != rootBefore+1 {
		t.Fatalf("root items after create = %d, want %d (one thread added)", got, rootBefore+1)
	}
	childArr := w.doc.GetThreadItemsArray(threadID)
	if childArr == nil {
		t.Fatal("thread was not created")
	}
	// Three seeds (system prompt, agents, memory) plus the seed prompt.
	if got := w.doc.GetItemsFromArray(childArr); len(got) != 4 {
		t.Fatalf("child items after create = %s, want 3 seeds + seed prompt", itemIDs(got))
	}

	// One undo removes the whole child — container, seeds, and seed prompt.
	if !w.tracker.Undo() {
		t.Fatal("createThread produced no undo group")
	}
	if got := w.doc.GetItemsLength(); got != rootBefore {
		t.Fatalf("after undo root items = %d, want %d (thread fully removed)", got, rootBefore)
	}
	if w.doc.GetThreadItemsArray(threadID) != nil {
		t.Fatal("thread (or its seeds) survived the undo — creation was not atomic")
	}

	// Redo restores the thread and all its seeded content as one unit.
	if !w.tracker.Redo() {
		t.Fatal("createThread was not redoable")
	}
	restored := w.doc.GetThreadItemsArray(threadID)
	if restored == nil {
		t.Fatal("thread was not restored by redo")
	}
	if got := w.doc.GetItemsFromArray(restored); len(got) != 4 {
		t.Fatalf("after redo child items = %s, want 3 seeds + seed prompt restored", itemIDs(got))
	}
}

// TestPromotePendingIntoSubthreadIsUndoable pins undo parity between the root and
// sub-thread branches of promotePendingItems: a queued message promoted into a
// sub-thread is undoable just like one promoted into root. Before the fix the
// sub-thread branch committed untracked, so the promoted message could not be
// undone.
func TestPromotePendingIntoSubthreadIsUndoable(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	innerID, arr := nestThreads(t, w, 1)
	if arr == nil {
		t.Fatal("could not build sub-thread")
	}

	w.enqueuePendingMessage(innerID, UserMessageInput{Text: "queued question"})
	if !w.hasPendingItems(innerID) {
		t.Fatal("message was not queued")
	}

	if n := w.promotePendingItems(innerID); n != 1 {
		t.Fatalf("promoted %d, want 1", n)
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 1 || got[0].Content != "queued question" {
		t.Fatalf("after promote sub-thread items = %s, want the promoted message", itemIDs(got))
	}

	// One undo removes the promoted message; the thread survives.
	if !w.tracker.Undo() {
		t.Fatal("promotion into a sub-thread was not tracked (nothing to undo)")
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 0 {
		t.Fatalf("after undo sub-thread items = %s, want empty", itemIDs(got))
	}
	if w.doc.GetThreadItemsArray(innerID) == nil {
		t.Fatal("thread container was removed by the undo — only the promoted message should be")
	}

	// Redo restores the promoted message.
	if !w.tracker.Redo() {
		t.Fatal("promotion into a sub-thread was not redoable")
	}
	if got := w.doc.GetItemsFromArray(arr); len(got) != 1 || got[0].Content != "queued question" {
		t.Fatalf("after redo sub-thread items = %s, want the promoted message restored", itemIDs(got))
	}
}
