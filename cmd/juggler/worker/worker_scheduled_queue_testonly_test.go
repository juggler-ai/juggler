//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside worker_scheduled_queue_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"testing"
	"time"
)

// TestScheduledSendIsNotPromotedBeforeItsTime: a send scheduled for later
// rides through a whole run without being promoted — not at the turn's top,
// not where the run ends — and the run rests instead of spinning on it.
func TestScheduledSendIsNotPromotedBeforeItsTime(t *testing.T) {
	w := NewConversationWorker("conv-scheduled-future", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "now", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing",
	})
	if _, _, ok := w.enqueueHeldSend("", UserMessageInput{Text: "later"}, nil,
		pendingHold{NotBefore: time.Now().Add(time.Hour)}); !ok {
		t.Fatal("the scheduled send was not queued")
	}

	// Two scripted replies: a worker that spun on the held send would spend the
	// second one.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "answer to now"}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "spun"}}, StopReason: "end_turn"},
	})
	stop := make(chan struct{})
	defer close(stop)
	feedEngine(w, stop)

	w.sched.markReconcile()
	w.quiesce(t)

	if n := w.mock().remaining(); n != 1 {
		t.Fatalf("%d scripted replies left, want 1: the run made %d LLM request(s), want exactly 1", n, 2-n)
	}
	var transcript []string
	for _, it := range w.doc.GetItems() {
		transcript = append(transcript, it.Type+":"+it.Content)
	}
	requireLabels(t, "transcript", transcript, []string{ItemTypeUser + ":now", ItemTypeAssistant + ":answer to now"})
	requireLabels(t, "queue after the run", queuedLabels(t, w, ""), []string{"later"})
	if a := w.threadActivity(""); a != ActivityNone {
		t.Errorf("thread activity = %q, want it resting", a)
	}

	now := time.Now()
	for name, pc := range map[string]promoteCtx{"mid-run": midRunDrain(now), "rest": restDrain(now)} {
		if moved := w.tracker.PromotePending("", pc); len(moved) != 0 {
			t.Errorf("a %s drain promoted %q before its time", name, labelsOf(moved))
		}
	}
}

// TestRunEndSendWaitsOutToolRounds: a send held for the end of the run is not
// spliced into the tool-result continuation a plain queued message joins
// (TestQueuedMessageJoinsToolResultContinuation). The run answers its tools
// first; where it would end, the held send is promoted and a turn answers it.
func TestRunEndSendWaitsOutToolRounds(t *testing.T) {
	w := NewConversationWorker("conv-run-end", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

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
	w.enqueueHeldSend("", UserMessageInput{Text: "after the run"}, nil, pendingHold{RunEnd: true})

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "reply to tools"}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "reply to the held send"}}, StopReason: "end_turn"},
	})
	stop := make(chan struct{})
	defer close(stop)
	feedEngine(w, stop)

	w.sched.markReconcile()
	w.quiesce(t)

	items := w.doc.GetItems()
	var got []string
	for _, it := range items {
		got = append(got, it.Type+":"+it.Content)
	}
	requireLabels(t, "transcript", got, []string{
		ItemTypeUser + ":run bash",
		ItemTypeAssistant + ":I'll run that.",
		ItemTypeToolAction + ":",
		ItemTypeAssistant + ":reply to tools",
		ItemTypeUser + ":after the run",
		ItemTypeAssistant + ":reply to the held send",
	})
	if n := w.mock().remaining(); n != 0 {
		t.Errorf("%d scripted replies left; the held send was never answered", n)
	}
	requireLabels(t, "queue", queuedLabels(t, w, ""), nil)
	requireNoHoldKeys(t, w)
}
