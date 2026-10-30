//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// The engine's answer to a tool command reaches the worker as a message in its
// inbox, so a worker behind on its inbox cannot tell an engine that never
// answered from one whose answer it has not reached yet. Both look like no
// trace. These pin that escalation waits on the inbox rather than on the clock:
// a run loop minutes behind must not fail tools the engine answered at once.
//
// The harness worker has no run loop, so a message sent to it stays queued —
// which is exactly a saturated loop, as the engine sees it.

// queueEngineTrace has the engine answer for tool id with event, the answer
// landing in the inbox and staying there.
func queueEngineTrace(t *testing.T, h *reattachHarness, id, event string) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"event": event, "toolUseId": id})
	if err != nil {
		t.Fatal(err)
	}
	h.w.SendFromClient("engine", string(msgEngineTrace), payload)
}

// processNextMessage takes the oldest queued message and handles it, as one
// run-loop iteration would.
func processNextMessage(t *testing.T, h *reattachHarness) {
	t.Helper()
	select {
	case msg := <-h.w.inbox.messages():
		h.w.inbox.taken(msg)
		h.w.currentRun().handleMessage(msg)
	case <-time.After(flushBarrierWait):
		t.Fatal("no queued message to process")
	}
}

// TestEngineAnswerQueued_ToolIsNotEscalated is the production incident: the
// engine claimed the tool within milliseconds, but its trace sat in the inbox
// behind minutes of backlog. Re-drive after re-drive found no trace, the hold's
// wall clock ran out, and the tool was failed as "the engine never answered".
// An answer still in the queue is not silence, so neither the attempts nor the
// hold may run while one is waiting — and re-sending the command into that
// backlog only adds to it.
func TestEngineAnswerQueued_ToolIsNotEscalated(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-answer-queued")
	insertApprovedTool(h)
	h.w.tools.redriveAfter = 0

	h.w.driveToolActions() // execute-tool goes out
	queueEngineTrace(t, h, "tu-1", "execute-claim")
	if got := h.w.inbox.pendingFrom("engine"); got != 1 {
		t.Fatalf("harness precondition: the engine's answer must be waiting in the inbox, got %d pending", got)
	}
	// Every wall-clock bound on the phase has long run out.
	h.w.tools.entry("tu-1").firstDispatchedAt = time.Now().Add(-2 * engineUnreachableHold)

	driveToEscalation(h, traceNothing)
	h.flush(t)

	if it, ok := findToolItem(h.w.currentRun().getTargetItems(), "tu-1"); !ok || it.State == StateCompleted {
		t.Fatalf("a tool was failed while the engine's answer to its command sat unprocessed "+
			"in the worker's own inbox: state=%q (ok=%v). The engine answered; the worker had "+
			"not caught up", it.State, ok)
	}
	if got := h.executeCount("tu-1"); got != 1 {
		t.Fatalf("execute-tool was re-sent %d times while the engine's answer was queued; "+
			"want only the original command (re-drives feed the backlog they wait on)", got)
	}

	// Once the loop reaches the answer, it is credited like any other.
	processNextMessage(t, h)
	if !h.w.tools.answeredSincePrevDispatch("tu-1") {
		t.Fatal("the engine's answer, once processed, must count as an answer for tu-1")
	}
}

// TestViewerBacklog_DoesNotHoldAMuteEngine is the guard against over-fixing:
// only the engine's own queued messages can hold its answer. A backlog of
// viewer traffic says nothing about the engine, and must not keep a tool waiting
// on an engine that is genuinely silent past every hold.
func TestViewerBacklog_DoesNotHoldAMuteEngine(t *testing.T) {
	h := newReattachHarness(t, "conv-viewer-backlog-mute-engine")
	insertApprovedTool(h)
	h.w.tools.redriveAfter = 0

	h.w.driveToolActions()
	h.w.SendFromClient("viewer", "stop-undo-capturing", json.RawMessage(`{}`))
	h.w.tools.entry("tu-1").firstDispatchedAt = time.Now().Add(-2 * engineUnreachableHold)

	driveToEscalation(h, traceNothing)
	h.flush(t)

	if it, ok := findToolItem(h.w.currentRun().getTargetItems(), "tu-1"); !ok || it.State != StateCompleted {
		t.Fatalf("a mute engine past its hold must still have the tool failed, a viewer "+
			"backlog notwithstanding: state=%q (ok=%v)", it.State, ok)
	}
}
