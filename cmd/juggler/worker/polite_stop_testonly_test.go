//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside polite_stop_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"testing"
	"time"
)

// TestPoliteStop_ReducerRestsBeforeNextTurn is the core polite-stop (Pause)
// guarantee: with the latch set, a completed tool batch that would normally
// re-drive the model instead rests at idle before the next LLM turn. Nothing is
// cancelled — the tool keeps its real result — and any queued message is
// promoted into the conversation as an ordinary user item (D1, D3, D4). The
// scripted turn must NOT be consumed: the model is not re-invoked.
func TestPoliteStop_ReducerRestsBeforeNextTurn(t *testing.T) {
	w := NewConversationWorker("test-polite-rest", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Seed a completed tool batch awaiting the model's reaction: user asked,
	// assistant called a tool, the tool has completed with a real result.
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

	// User typed a follow-up while the tool ran — parked in the pending queue.
	w.enqueuePendingMessage("", UserMessageInput{Text: "queued follow-up"})

	// The user pressed Pause: the mark is set before the reducer would re-drive.
	w.markPoliteStop("")

	// One scripted turn. If polite stop fails to suppress the re-dispatch this
	// turn is consumed and an assistant reply lands — the regression signal.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN"}}, StopReason: "end_turn"},
	})

	// Feed context/tools on demand so that IF a turn wrongly dispatches it
	// COMPLETES (leaving evidence) instead of hanging the test on the channel.
	stop := make(chan struct{})
	defer close(stop)
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

	// Drive the reducer exactly as the event loop would after the tool completes.
	w.sched.markReconcile(reconcileTestDriven)
	w.quiesce(t)

	// The model was NOT re-invoked: the scripted turn is still on the queue.
	if n := w.mock().remaining(); n != 1 {
		t.Fatalf("polite stop failed to suppress the next turn: %d scripted responses left, want 1", n)
	}

	// The mark still stands. A pause outlives the rest it caused — nothing may
	// re-drive this thread until a human lifts it (D6: an explicit send does).
	if !w.politeStopCovers("") {
		t.Error("the pause mark was consumed by the boundary; a mark must stand until it is lifted")
	}

	// The worker rested at ordinary idle.
	if st, _ := w.readProcessingState()["status"].(string); st != "idle" {
		t.Errorf("worker status = %q, want idle after polite stop", st)
	}

	// Nothing was cancelled: the tool keeps its completed result.
	items := w.doc.GetItems()
	if items[2].State != StateCompleted {
		t.Errorf("tool-action state = %q, want %q (polite stop must not cancel/interrupt)", items[2].State, StateCompleted)
	}

	// The queued message was promoted to an ordinary trailing user item, and no
	// assistant reply was appended after it (the model never reacted).
	last := items[len(items)-1]
	if last.Type != ItemTypeUser || last.Content != "queued follow-up" {
		t.Fatalf("trailing item = {%q,%q}, want a promoted user item %q", last.Type, last.Content, "queued follow-up")
	}
	if w.hasPendingItems("") {
		t.Error("pending queue should be drained (promoted) after polite stop settled to idle")
	}
}
