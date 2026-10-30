//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside worker_pending_queue_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestQueuedMessageJoinsToolResultContinuation pins turn composition for a
// message typed while a tool is running (parked in the pending "type while
// busy" queue). The strategy loop promotes the queue at EVERY turn boundary —
// including a tool-result continuation — so the queued message is delivered at
// the earliest opportunity: spliced in after the completed tool batch, riding
// the SAME turn that delivers the tool results, not deferred to end-of-run.
// The splice is append-only (the promoted item lands after the tool batch), so
// stateless providers' prefix caches are unaffected; claudecode pays a warm
// resume respawn, an accepted price for prompt delivery.
//
// Observable proof at the worker layer: ONE LLM turn runs, and the promoted
// queued user item lands after the completed tool action but BEFORE that
// turn's assistant reply.
func TestQueuedMessageJoinsToolResultContinuation(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Seed a completed tool batch awaiting the model's reaction: user asked,
	// assistant called a tool, the tool has completed. The user's original
	// message is already stamped (it drove the first turn).
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "run bash",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll run that.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateCompleted, Result: resultJSON("ok"),
		TransactionID: "txn-0",
	})
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	// User types a follow-up while the tool was running — parked in the queue.
	w.enqueuePendingMessage("", UserMessageInput{Text: "queued follow-up"})

	// ONE scripted turn: the tool-result continuation with the queued message
	// spliced in. If the queued message were deferred to a second turn, the
	// loop would run again and fail on the exhausted script.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "reply to tools and follow-up"}}, StopReason: "end_turn"},
	})

	stop := make(chan struct{})
	defer close(stop)
	feedEngine(w, stop)

	// Drive the reducer exactly as the event loop would after the tool completes.
	w.sched.markReconcile(reconcileTestDriven)
	w.quiesce(t)

	// Exactly the one scripted turn must have run.
	if n := w.mock().remaining(); n != 0 {
		t.Fatalf("expected the single scripted turn consumed, %d left — the queued message was not promoted into the tool-result continuation", n)
	}

	// Full item sequence: the promoted queued user message lands after the
	// completed tool action and BEFORE the turn's assistant reply, proving it
	// was spliced into the continuation rather than deferred.
	items := w.doc.GetItems()
	gotTypes := make([]string, len(items))
	for i, it := range items {
		gotTypes[i] = it.Type
	}
	// u-1 "run bash" / a-1 "I'll run that." / ta-1 completed /
	// promoted "queued follow-up" / the single turn's reply.
	wantTypes := []string{
		ItemTypeUser,
		ItemTypeAssistant,
		ItemTypeToolAction,
		ItemTypeUser,
		ItemTypeAssistant,
	}
	if len(gotTypes) != len(wantTypes) {
		t.Fatalf("item count = %d, want %d; types=%v full=%+v", len(gotTypes), len(wantTypes), gotTypes, items)
	}
	for i := range wantTypes {
		if gotTypes[i] != wantTypes[i] {
			t.Fatalf("item[%d] type = %q, want %q; full types=%v", i, gotTypes[i], wantTypes[i], gotTypes)
		}
	}
	if items[3].Content != "queued follow-up" {
		t.Errorf("item[3] (promoted queued message) content = %q, want %q", items[3].Content, "queued follow-up")
	}
	if items[4].Content != "reply to tools and follow-up" {
		t.Errorf("item[4] (turn reply) content = %q, want %q", items[4].Content, "reply to tools and follow-up")
	}
	if w.hasPendingItems("") {
		t.Errorf("pending queue should be drained after the queued message was promoted")
	}
}

// TestMessageQueuedAsATurnEndsIsAnswered pins the intake gate against the end of
// a turn. The loop decides to stop when its queue is empty, but it keeps its
// claim for a while after that, until finishStrategyRun releases it. A send that
// arrives in that window sees the thread busy and is queued, and the loop will
// not look at its queue again. The finishing run's last look, taken after the
// release, is what answers it.
func TestMessageQueuedAsATurnEndsIsAnswered(t *testing.T) {
	w := NewConversationWorker("conv-queued-at-turn-end", "user:test")
	defer w.doc.Destroy()
	r := w.currentRun()
	r.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "answer to the late message"}}, StopReason: "end_turn"},
	})
	stop := make(chan struct{})
	defer close(stop)
	feedEngine(w, stop)

	if !r.claimLLM("") {
		t.Fatal("could not claim the root")
	}
	tr := r.beginTurn("")
	tr.storeState(StateProcessing)
	r.runTurn(tr, func(tr *run) {
		// The loop has already found its queue empty and returned. The send lands
		// now, through the intake gate exactly as handleSendMessage asks it.
		busy, queued := tr.queueIfBusy("", func() []ConversationItem {
			return []ConversationItem{newUserItem(UserMessageInput{Text: "late message"})}
		})
		if !busy || !queued {
			t.Errorf("queueIfBusy on a claimed root = busy %v, queued %v; want both", busy, queued)
		}
		tr.finishStrategyRun()
	})
	w.quiesce(t)

	if w.hasPendingItems("") {
		t.Fatal("the late message is still queued under an idle conversation")
	}
	if n := w.mock().remaining(); n != 0 {
		t.Fatalf("%d scripted turn(s) left; the late message was never answered", n)
	}
	items := w.doc.GetItems()
	if len(items) < 2 || items[len(items)-2].Content != "late message" ||
		items[len(items)-1].Content != "answer to the late message" {
		t.Errorf("transcript does not end with the late message and its answer: %+v", items)
	}
}

// TestContextQueuedAloneLandsWithoutATurn pins what a queued context item with
// no message behind it asks for. The user ran a shell command from the
// composer while a turn was in flight, so its output was queued rather than
// written under the running turn. When the turn ends the output must land in
// the transcript, where the user's next message will find it — and nothing
// more: it is not a message, and answering it would spend a model call the user
// ran the command to avoid.
func TestContextQueuedAloneLandsWithoutATurn(t *testing.T) {
	w := NewConversationWorker("conv-context-queued-alone", "user:test")
	defer w.doc.Destroy()
	r := w.currentRun()
	r.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	// One turn's worth of script, so a turn wrongly started is answered and
	// shows up as a consumed response rather than as an exhausted-script error.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "nobody asked"}}, StopReason: "end_turn"},
	})
	stop := make(chan struct{})
	defer close(stop)
	feedEngine(w, stop)

	if !r.claimLLM("") {
		t.Fatal("could not claim the root")
	}
	tr := r.beginTurn("")
	tr.storeState(StateProcessing)
	r.runTurn(tr, func(tr *run) {
		enqueuePendingItemForTest(w, "", ConversationItem{
			Type: "shell-output", ItemID: "SHELL_1", IsNew: true,
			Data: json.RawMessage(`{"command":"echo hi","output":"hi","exitCode":0}`),
		})
		tr.finishStrategyRun()
	})
	w.quiesce(t)

	if w.hasPendingItems("") {
		t.Fatal("the queued output is still queued under an idle conversation")
	}
	found := false
	for _, it := range w.doc.GetItems() {
		if it.ItemID == "SHELL_1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the queued output never reached the transcript: %+v", w.doc.GetItems())
	}
	if n := w.mock().remaining(); n != 1 {
		t.Fatalf("a model turn ran for a context item queued with no message (%d scripted response(s) left, want 1)", n)
	}
	if a := w.currentRun().threadActivity(""); a != ActivityNone {
		t.Fatalf("the conversation was left %q, not at rest, by a context item queued with no message", a)
	}
}

// TestPromotePendingKeepsReadGroupedWithMessage verifies the guarantee the
// "queue reads with the message" fix depends on: when a mid-turn @-mention
// enqueues a file-content read onto pendingItems ahead of the queued user
// message, promoting the queue lands the read immediately before its message
// (grouped, in order) with its context-item payload intact — never separated by
// the in-flight turn's output.
func TestPromotePendingKeepsReadGroupedWithMessage(t *testing.T) {
	w := NewConversationWorker("conv-pending-read-group", "user:test")
	defer w.doc.Destroy()

	// Some in-flight turn output already sits in items.
	w.doc.InsertMessage(w.doc.GetItemsLength(), ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "working",
		Timestamp: time.Now().Format(time.RFC3339),
	})

	// Client enqueues the read first, then the worker queues the user message.
	enqueuePendingItemForTest(w, "", ConversationItem{
		Type: "file-content", ItemID: "FILE_1", IsNew: true,
		Data: json.RawMessage(`{"path":"foo.txt"}`),
	})
	w.enqueuePendingMessage("", UserMessageInput{Text: "look at @foo.txt"})

	if n := w.currentRun().promotePendingItems("", restDrain(time.Now())); n != 2 {
		t.Fatalf("expected 2 items promoted (read + message), got %d", n)
	}
	if w.hasPendingItems("") {
		t.Error("expected the pending queue to be empty after promotion")
	}

	items := w.doc.GetItems()
	fileIdx, userIdx := -1, -1
	for i, it := range items {
		switch {
		case it.ItemID == "FILE_1":
			fileIdx = i
		case it.Type == ItemTypeUser && it.Content == "look at @foo.txt":
			userIdx = i
		}
	}
	if fileIdx < 0 || userIdx < 0 {
		t.Fatalf("promoted items missing: fileIdx=%d userIdx=%d items=%+v", fileIdx, userIdx, items)
	}
	// The read must sit immediately before its message — grouped, not separated.
	if userIdx != fileIdx+1 {
		t.Errorf("expected the read immediately before the message, got fileIdx=%d userIdx=%d", fileIdx, userIdx)
	}
	// The context-item payload survives the promote round-trip.
	if got := items[fileIdx]; got.Type != "file-content" || !strings.Contains(string(got.Data), "foo.txt") {
		t.Errorf("read payload lost through promotion: type=%q data=%s", got.Type, string(got.Data))
	}
}

// feedEngine answers the engine's context and tools requests until stop closes,
// so each dispatched turn completes. Two independent feeders avoid any
// ctx-vs-tools ordering dependency.
func feedEngine(w *ConversationWorker, stop chan struct{}) {
	ctxResp, _ := json.Marshal(map[string]any{
		"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
	})
	toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
	go func() {
		for {
			if !w.engine.contextReply.inject(stop, ctxResp) {
				return
			}
		}
	}()
	go func() {
		for {
			if !w.engine.toolsReply.inject(stop, toolsResp) {
				return
			}
		}
	}()
}
