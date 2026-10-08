//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

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
	w.sched.markReconcile()
	w.quiesce(t)

	// The model was NOT re-invoked: the scripted turn is still on the queue.
	if n := w.mock.remaining(); n != 1 {
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

// TestPoliteStop_IdlePauseIsNoOp pins V3: a pause that arrives while the worker
// is idle must NOT latch — otherwise it would strand the flag and suppress the
// next user-initiated turn.
func TestPoliteStop_IdlePauseIsNoOp(t *testing.T) {
	w := NewConversationWorker("test-polite-idle", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	w.handlePause("")

	if w.hasPoliteStops() {
		t.Error("handlePause marked an idle worker; an idle pause must be a no-op (V3)")
	}
}

// TestPoliteStop_HandlePauseLatchesWhenBusy verifies the complementary case: a
// pause while a turn is parked (activity=awaiting_llm) latches the polite stop.
func TestPoliteStop_HandlePauseLatchesWhenBusy(t *testing.T) {
	w := NewConversationWorker("test-polite-busy", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	w.handlePause("")

	if !w.politeStopCovers("") {
		t.Error("handlePause did not mark while the worker was busy (awaiting_llm)")
	}
}

// TestPoliteStop_SupersededByHardCancel pins D7: a hard cancel while a polite
// stop is pending drops the latch (escalation), so the turn after the cancel is
// never spuriously suppressed.
func TestPoliteStop_SupersededByHardCancel(t *testing.T) {
	w := NewConversationWorker("test-polite-escalate", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	w.markPoliteStop("")
	w.currentRun().handleCancel(cancelReasonUnspecified)

	if w.hasPoliteStops() {
		t.Error("hard cancel did not supersede the pending polite stop (D7)")
	}
}

// TestPoliteStop_ClearedByExplicitSend pins D6: an explicit send on an idle
// worker is an unambiguous "resume now" that clears any pending latch, so the
// user-initiated turn is not suppressed. (No model config is set, so the send
// short-circuits at validation without driving a turn — the latch clear runs
// before that guard.)
func TestPoliteStop_ClearedByExplicitSend(t *testing.T) {
	w := NewConversationWorker("test-polite-resume", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	w.markPoliteStop("")

	payload, _ := json.Marshal(map[string]any{"text": "resume with this"})
	w.currentRun().handleSendMessage(payload)

	if w.hasPoliteStops() {
		t.Error("explicit send did not lift the polite stop covering the thread (D6 resume)")
	}
}

// TestPoliteStop_UnpauseClearsPendingLatch verifies the Pause-button toggle-off
// path: an "unpause" while a polite stop is pending drops the latch so the turn
// continues to its next boundary instead of resting at idle. This is the inverse
// of handlePause and, unlike a hard cancel, is non-destructive.
func TestPoliteStop_UnpauseClearsPendingLatch(t *testing.T) {
	w := NewConversationWorker("test-polite-unpause", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	w.markPoliteStop("")
	w.handleUnpause("")

	if w.hasPoliteStops() {
		t.Error("handleUnpause did not lift the pending polite stop")
	}
}

// TestPoliteStop_UnpauseIsIdempotent pins that clearing an already-unset latch is
// a harmless no-op — an unpause that races past the consuming boundary must not
// wedge anything (the turn was going to continue regardless).
func TestPoliteStop_UnpauseIsIdempotent(t *testing.T) {
	w := NewConversationWorker("test-polite-unpause-noop", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	w.handleUnpause("") // nothing marked

	if w.hasPoliteStops() {
		t.Error("handleUnpause spuriously marked a polite stop")
	}
}

// TestPoliteStop_PublishesPendingToProcessingState verifies the pause-pending cue
// is server-authoritative rather than client-local: latching the polite stop
// mirrors politePending=true into the synced processingState (so a client that
// reloads mid-pause restores the "Pausing…" cue from the doc), and un-pausing
// drops it. Without this the whole feature rests on optimistic local state that a
// reload resets to false.
func TestPoliteStop_PublishesPendingToProcessingState(t *testing.T) {
	w := NewConversationWorker("test-polite-publish", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	w.handlePause("")

	if !w.politeStopCovers("") {
		t.Fatal("handlePause did not mark while the worker was busy")
	}
	if pending, _ := w.readProcessingState()["politePending"].(bool); !pending {
		t.Error("handlePause did not publish politePending=true into the synced processingState")
	}

	w.handleUnpause("")

	if w.hasPoliteStops() {
		t.Fatal("handleUnpause did not lift the mark")
	}
	if _, present := w.readProcessingState()["politePending"]; present {
		t.Error("handleUnpause left a stale politePending in processingState")
	}
}

// TestPoliteStop_PendingBecomesPausedWhenTheWorkRests verifies the two states a
// mark passes through, which is the whole of what the user is told. While the
// covered thread is still working the frame says politePending — re-emitted on
// every busy frame, since each is rebuilt from scratch. Once it rests the pending
// cue goes and the mark reports `landed`: the conversation is Paused, and that
// survives on an idle frame because a landed pause is BY DEFINITION on a resting
// conversation. Without the landed half, resting is indistinguishable from the
// pause having been forgotten — which is exactly how it read.
func TestPoliteStop_PendingBecomesPausedWhenTheWorkRests(t *testing.T) {
	w := NewConversationWorker("test-polite-publish-landed", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityCallingLLM, "threadItemId": "", "status": "streaming",
	})

	w.markPoliteStop("")
	if p, _ := w.readProcessingState()["politePending"].(bool); !p {
		t.Fatal("marking a polite stop did not publish politePending")
	}

	w.currentRun().sendStatus("streaming", "")
	state := w.readProcessingState()
	if p, _ := state["politePending"].(bool); !p {
		t.Error("busy sendStatus frame dropped politePending while the mark stood")
	}
	if landed := publishedPoliteStopLanded(state, ""); landed != false {
		t.Errorf("mark reported landed=%v while its thread was still calling the model", landed)
	}

	// The run rests: the pause has landed.
	w.currentRun().sendStatus("idle", "")
	state = w.readProcessingState()
	if _, present := state["politePending"]; present {
		t.Error("resting frame still claims a pause is pending")
	}
	if landed := publishedPoliteStopLanded(state, ""); landed != true {
		t.Errorf("mark reported landed=%v on a resting conversation; the Paused state has no other source", landed)
	}
}

// publishedPoliteStopLanded reads one mark's landed flag out of a published
// frame, or nil when the frame carries no such mark.
func publishedPoliteStopLanded(state map[string]any, threadItemID string) any {
	stops, _ := state["politeStops"].(map[string]any)
	entry, _ := stops[runKey(threadItemID)].(map[string]any)
	if entry == nil {
		return nil
	}
	return entry["landed"]
}
