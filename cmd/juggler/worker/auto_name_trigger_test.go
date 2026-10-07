//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// pushAssistant appends a root assistant item, giving the fold something
// conversational to relocate.
func pushAssistant(w *ConversationWorker, content string) {
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		w.doc.ensureItems().Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{
			Type: ItemTypeAssistant, ItemID: generateItemID(), Content: content,
		})})
	}, w.doc.authorID)
}

type autoNameCall struct {
	convID, firstMessage, provider, model, thinking string
	force                                           bool
}

// newAutoNameWorker builds an idle worker with a resolvable default model and a
// recording auto-namer installed.
func newAutoNameWorker(t *testing.T, id string, calls *[]autoNameCall) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker(id, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "prov-A", "model": "model-A", "thinking": "high"})
	w.SetAutoNamer(func(convID, firstMessage, provider, model, thinking string, force bool) {
		*calls = append(*calls, autoNameCall{convID, firstMessage, provider, model, thinking, force})
	})
	return w
}

func sendMsg(t *testing.T, w *ConversationWorker, msg SendMessageMessage) {
	t.Helper()
	payload, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	w.currentRun().handleSendMessage(payload)
}

// requestAutoName delivers a request-auto-name message with the given force.
func requestAutoName(t *testing.T, w *ConversationWorker, force bool) {
	t.Helper()
	payload, err := json.Marshal(RequestAutoNameMessage{Type: "request-auto-name", Force: force})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	w.handleRequestAutoName(payload)
}

// TestAutoNameFiresOnFirstRootMessage pins the fire guard: the first user
// message on the root thread signals the auto-namer exactly once, with the
// message text and the resolved primary model.
func TestAutoNameFiresOnFirstRootMessage(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-first", &calls)

	sendMsg(t, w, SendMessageMessage{Text: "Add a dark mode toggle"})

	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 auto-name call, got %d", len(calls))
	}
	got := calls[0]
	want := autoNameCall{"conv-first", "Add a dark mode toggle", "prov-A", "model-A", "high", false}
	if got != want {
		t.Fatalf("auto-name call = %+v, want %+v", got, want)
	}
}

// TestRequestAutoNameFiresForceFromFirstMessage pins the manual "auto-name now"
// path: it re-derives from the conversation's first user message and signals the
// namer with force=true (the enable gate and Task-N guard are the server's to
// bypass).
func TestRequestAutoNameFiresForceFromFirstMessage(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-force", &calls)

	w.currentRun().addUserMessage(UserMessageInput{Text: "Refactor the auth layer"})

	requestAutoName(t, w, true)

	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 auto-name call, got %d", len(calls))
	}
	got := calls[0]
	want := autoNameCall{"conv-force", "Refactor the auth layer", "prov-A", "model-A", "high", true}
	if got != want {
		t.Fatalf("force auto-name call = %+v, want %+v", got, want)
	}
}

// TestRequestAutoNameNoOpWithoutUserMessage verifies a manual request before any
// user message is a no-op — there is nothing to summarise.
func TestRequestAutoNameNoOpWithoutUserMessage(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-force-empty", &calls)

	requestAutoName(t, w, true)

	if len(calls) != 0 {
		t.Fatalf("expected no auto-name call without a user message, got %+v", calls)
	}
}

// TestAutoNameDoesNotFireWhenUserMessageExists pins the once-only guard: a
// conversation that already holds a user message (a reconnect, or a second
// send) does not re-trigger naming.
func TestAutoNameDoesNotFireWhenUserMessageExists(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-existing", &calls)

	// Seed a prior root user message directly, then send another while idle.
	w.currentRun().addUserMessage(UserMessageInput{Text: "an earlier message"})

	sendMsg(t, w, SendMessageMessage{Text: "another message"})

	if len(calls) != 0 {
		t.Fatalf("expected no auto-name call when a user message already exists, got %+v", calls)
	}
}

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

// TestAutoNameDoesNotFireOnContinuation verifies an explicit Continue (no new
// user text) never triggers naming.
func TestAutoNameDoesNotFireOnContinuation(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-continue", &calls)

	sendMsg(t, w, SendMessageMessage{IsContinuation: true})

	if len(calls) != 0 {
		t.Fatalf("expected no auto-name call on continuation, got %+v", calls)
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

// TestAutoNameDoesNotFireOnEmptyText verifies a text-less first message does not
// trigger naming — there is nothing to summarise.
func TestAutoNameDoesNotFireOnEmptyText(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-empty", &calls)

	// Whitespace-only text with an attachment: not "empty" (so it reaches the
	// add-message block), but there is no text to name from.
	sendMsg(t, w, SendMessageMessage{Text: "   ", Attachments: []AssetRef{{ID: "sha", Mime: "image/png"}}})

	if len(calls) != 0 {
		t.Fatalf("expected no auto-name call on text-less message, got %+v", calls)
	}
}
