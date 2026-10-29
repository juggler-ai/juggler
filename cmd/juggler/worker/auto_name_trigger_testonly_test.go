//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside auto_name_trigger_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"testing"
)

// A compaction folds the conversation's user messages into a summary thread,
// emptying the root items array. The next message must NOT be read as the
// conversation's first: that is what retitled a tab mid-session, so a user who
// asked to commit after a long task ended up with "Commit changes", "Commit
// changes 2", "Commit changes 3" across their tabs.
func TestAutoNameDoesNotFireAfterCompactionFold(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-compacted", &calls)
	feedCompactionContextAndTools(w)

	sendMsg(t, w, SendMessageMessage{Text: "the original task"})
	if len(calls) != 1 {
		t.Fatalf("auto-name calls after the first message = %d, want 1", len(calls))
	}
	pushAssistant(w, "worked on it")

	if _, folded, err := w.currentRun().foldConversationForCompaction(false); err != nil || !folded {
		t.Fatalf("foldConversationForCompaction = (%v, %v), want a fold", folded, err)
	}
	for _, it := range w.doc.GetItems() {
		if it.Type == ItemTypeUser {
			t.Fatal("fold left a root user item; the test no longer covers the regression")
		}
	}

	sendMsg(t, w, SendMessageMessage{Text: "commit this"})

	if len(calls) != 1 {
		t.Fatalf("auto-name calls after a post-fold message = %d, want the original 1: %+v", len(calls), calls)
	}
}

// The opening message survives a fold inside the summary thread, so the tab
// bar's "Auto-name" button still has something to name a compacted
// conversation from — and never names it after the compaction prompt.
func TestRequestAutoNameReadsThroughCompactionFold(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-compacted-force", &calls)
	feedCompactionContextAndTools(w)

	sendMsg(t, w, SendMessageMessage{Text: "the original task"})
	pushAssistant(w, "worked on it")
	if _, folded, err := w.currentRun().foldConversationForCompaction(false); err != nil || !folded {
		t.Fatalf("foldConversationForCompaction = (%v, %v), want a fold", folded, err)
	}

	calls = nil
	requestAutoName(t, w, true)

	if len(calls) != 1 {
		t.Fatalf("forced auto-name calls = %d, want 1", len(calls))
	}
	if calls[0].firstMessage != "the original task" {
		t.Fatalf("firstMessage = %q, want the folded opening message", calls[0].firstMessage)
	}
}

// newDispatchWorker builds an auto-name worker ready to dispatch a thread: the
// root items array a real conversation is seeded with, plus standing answers for
// the engine round-trips a dispatched run makes — without them every dispatch
// parks in its reply slot for the full timeout.
func newDispatchWorker(t *testing.T, id string, calls *[]autoNameCall) *ConversationWorker {
	t.Helper()
	w := newAutoNameWorker(t, id, calls)
	w.doc.ensureItems()
	feedCompactionContextAndTools(w)
	return w
}

// A `run: subthread` command typed into an empty tab is a first user action that
// appends no root user message, so the send-message trigger never sees it. Its
// prompt is what the conversation is about, and naming from it is what keeps the
// tab from sitting at "Untitled N" for the whole run.
func TestAutoNameFiresOnFirstRootSubthreadDispatch(t *testing.T) {
	var calls []autoNameCall
	w := newDispatchWorker(t, "conv-subthread", &calls)

	if _, err := w.currentRun().dispatchThread(threadSpec{Goal: "Plan", Prompt: "Plan the migration"}); err != nil {
		t.Fatalf("dispatchThread: %v", err)
	}
	w.quiesce(t)

	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 auto-name call, got %d: %+v", len(calls), calls)
	}
	got := calls[0]
	want := autoNameCall{"conv-subthread", "Plan the migration", "prov-A", "model-A", "high", false}
	if got != want {
		t.Fatalf("auto-name call = %+v, want %+v", got, want)
	}
}

// The once-only guard spans both triggers: having named the tab from a dispatched
// subthread's prompt, the root message that usually follows must not retitle it.
func TestAutoNameDoesNotRefireAfterSubthreadDispatch(t *testing.T) {
	var calls []autoNameCall
	w := newDispatchWorker(t, "conv-subthread-then-message", &calls)

	if _, err := w.currentRun().dispatchThread(threadSpec{Goal: "Plan", Prompt: "Plan the migration"}); err != nil {
		t.Fatalf("dispatchThread: %v", err)
	}
	w.quiesce(t)
	sendMsg(t, w, SendMessageMessage{Text: "now do the first step"})

	if len(calls) != 1 {
		t.Fatalf("auto-name calls = %d, want the original 1: %+v", len(calls), calls)
	}
}

// A thread dispatched into an existing thread is a detail of that thread's work,
// not the conversation's subject, so it names nothing.
func TestAutoNameDoesNotFireOnNestedDispatch(t *testing.T) {
	var calls []autoNameCall
	w := newDispatchWorker(t, "conv-nested-dispatch", &calls)

	parentID, err := w.currentRun().spawnThread(threadSpec{Goal: "parent", Prompt: "existing work"}, toolSpawn{})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	if _, err := w.currentRun().dispatchThread(threadSpec{Goal: "child", Prompt: "a nested task", ParentThreadItemID: parentID}); err != nil {
		t.Fatalf("dispatchThread: %v", err)
	}
	w.quiesce(t)

	if len(calls) != 0 {
		t.Fatalf("expected no auto-name call for a nested dispatch, got %+v", calls)
	}
}
