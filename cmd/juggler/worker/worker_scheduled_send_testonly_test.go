//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside worker_scheduled_send_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"
)

// startHeadlessCapable starts a worker on fc with replies scripted and the
// engine answered, attaches one client and returns it.
func startHeadlessCapable(t *testing.T, convID string, fc *fakeClock, replies ...string) (*ConversationWorker, *msgChan) {
	t.Helper()
	w := NewConversationWorker(convID, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	fc.install(w)

	initPayload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: convID},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("marshalling init: %v", err)
	}
	w.currentRun().handleInit(initPayload)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	script := make([]MockResponse, len(replies))
	for i, r := range replies {
		script[i] = MockResponse{Blocks: []LLMResponseBlock{{Type: "text", Content: r}}, StopReason: "end_turn"}
	}
	w.setMockResponses(script)
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	feedEngine(w, stop)

	mc := newMsgChan()
	w.SetCallback("client-A", mc.callback)
	w.currentRun().Start(context.Background())
	t.Cleanup(w.currentRun().Stop)
	return w, mc
}

func scriptReplies(w *ConversationWorker, replies ...string) {
	script := make([]MockResponse, len(replies))
	for i, r := range replies {
		script[i] = MockResponse{Blocks: []LLMResponseBlock{{Type: "text", Content: r}}, StopReason: "end_turn"}
	}
	w.setMockResponses(script)
}

// TestScheduledSendFiresWithNoClientAttached: a timed send queued on an idle
// worker waits in the queue, and at its time the worker answers it on its own —
// after the only client has gone, as Manager.ClientDisconnected leaves a worker
// (its callbacks removed, the worker running).
func TestScheduledSendFiresWithNoClientAttached(t *testing.T) {
	fc := newFakeClock()
	w, _ := startHeadlessCapable(t, "conv-held-headless", fc, "good morning to you")

	at := fakeEpoch.Add(time.Hour)
	sendFromClient(t, w, SendMessageMessage{Text: "good morning", NotBefore: at.UnixMilli()})
	timer := fc.awaitArm(t, at)

	requireLabels(t, "queue before its time", queuedLabels(t, w, ""), []string{"good morning"})
	if got := transcript(w); len(got) != 0 {
		t.Fatalf("transcript before its time = %q, want it empty", got)
	}

	w.RemoveCallback("client-A")
	fc.fire(timer)
	awaitTranscript(t, w, []string{ItemTypeUser + ":good morning", ItemTypeAssistant + ":good morning to you"})
	requireLabels(t, "queue after firing", queuedLabels(t, w, ""), nil)
	requireNoHoldKeys(t, w)
}

// TestScheduledSendDueMidRunJoinsThatRun: a timed send that comes due while
// the thread is between tool rounds is left alone by the timer — the thread is
// busy — and the run's next round takes it in, so one turn answers the tools
// and the send. A send not yet due at that round stays queued.
func TestScheduledSendDueMidRunJoinsThatRun(t *testing.T) {
	fc := newFakeClock()
	w := idleWorkerOn(t, "conv-held-mid-run", fc)
	seedCompletedToolBatch(w)
	scriptReplies(w, "reply to tools and the send", "spare")
	stop := make(chan struct{})
	defer close(stop)
	feedEngine(w, stop)

	at := fakeEpoch.Add(time.Minute)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "scheduled", NotBefore: at.UnixMilli()})
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "not yet", NotBefore: at.Add(time.Hour).UnixMilli()})
	requireLabels(t, "queue", queuedLabels(t, w, ""), []string{"scheduled", "not yet"})

	fc.set(at)
	w.currentRun().fireHeldSends()
	requireLabels(t, "queue after the timer fired on a busy thread", queuedLabels(t, w, ""), []string{"scheduled", "not yet"})

	w.sched.markReconcile()
	w.quiesce(t)
	requireLabels(t, "transcript", transcript(w), []string{
		ItemTypeUser + ":run bash",
		ItemTypeAssistant + ":I'll run that.",
		ItemTypeToolAction + ":",
		ItemTypeUser + ":scheduled",
		ItemTypeAssistant + ":reply to tools and the send",
	})
	if n := w.mock().remaining(); n != 1 {
		t.Errorf("%d scripted replies left, want 1: the run made %d LLM request(s), want 1", n, 2-n)
	}
	requireLabels(t, "queue after the run", queuedLabels(t, w, ""), []string{"not yet"})
	requireNoHoldKeys(t, w)
}

// TestRunEndSendOverTheWire: a send held for the end of the run, sent while the
// run is between tool rounds, is queued at intake and answered by a turn of its
// own once the run ends. Sent to an idle thread, whose run has already ended,
// it is answered at once.
func TestRunEndSendOverTheWire(t *testing.T) {
	fc := newFakeClock()
	w := idleWorkerOn(t, "conv-held-run-end", fc)
	seedCompletedToolBatch(w)
	scriptReplies(w, "reply to tools", "reply to the held send", "reply to the idle one")
	stop := make(chan struct{})
	defer close(stop)
	feedEngine(w, stop)

	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "after the run", Hold: pendingHoldRunEnd})
	requireLabels(t, "queue", queuedLabels(t, w, ""), []string{"after the run"})

	w.sched.markReconcile()
	w.quiesce(t)
	base := []string{
		ItemTypeUser + ":run bash",
		ItemTypeAssistant + ":I'll run that.",
		ItemTypeToolAction + ":",
		ItemTypeAssistant + ":reply to tools",
		ItemTypeUser + ":after the run",
		ItemTypeAssistant + ":reply to the held send",
	}
	requireLabels(t, "transcript", transcript(w), base)

	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "idle one", Hold: pendingHoldRunEnd})
	w.quiesce(t)
	requireLabels(t, "transcript after an idle run-end send", transcript(w),
		append(slices.Clone(base), ItemTypeUser+":idle one", ItemTypeAssistant+":reply to the idle one"))
	requireLabels(t, "queue", queuedLabels(t, w, ""), nil)
	requireNoHoldKeys(t, w)
}

// TestPastNotBeforeIsAnOrdinarySend: a time already passed holds nothing. The
// message lands in the thread at once, unstamped, and is answered.
func TestPastNotBeforeIsAnOrdinarySend(t *testing.T) {
	fc := newFakeClock()
	w := idleWorkerOn(t, "conv-held-past", fc)
	scriptReplies(w, "answer")
	stop := make(chan struct{})
	defer close(stop)
	feedEngine(w, stop)

	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "overdue", NotBefore: fakeEpoch.Add(-time.Minute).UnixMilli()})
	requireLabels(t, "queue", queuedLabels(t, w, ""), nil)
	requireLabels(t, "transcript at intake", transcript(w), []string{ItemTypeUser + ":overdue"})
	w.quiesce(t)
	requireLabels(t, "transcript", transcript(w), []string{ItemTypeUser + ":overdue", ItemTypeAssistant + ":answer"})
	requireNoHoldKeys(t, w)
}

// TestScheduledSendsFireInOrder: two timed sends fire one after the other. The
// timer is armed for the earlier one, and once it has fired, re-armed for the
// later.
func TestScheduledSendsFireInOrder(t *testing.T) {
	fc := newFakeClock()
	w, _ := startHeadlessCapable(t, "conv-held-order", fc, "first answer", "second answer")

	first, second := fakeEpoch.Add(time.Minute), fakeEpoch.Add(2*time.Minute)
	// Queued latest first: the timer must follow the earliest, not the newest.
	sendFromClient(t, w, SendMessageMessage{Text: "second", NotBefore: second.UnixMilli()})
	fc.awaitArm(t, second)
	sendFromClient(t, w, SendMessageMessage{Text: "first", NotBefore: first.UnixMilli()})
	fc.fire(fc.awaitArm(t, first))
	awaitTranscript(t, w, []string{ItemTypeUser + ":first", ItemTypeAssistant + ":first answer"})
	requireLabels(t, "queue between them", queuedLabels(t, w, ""), []string{"second"})

	fc.fire(fc.awaitArm(t, second))
	awaitTranscript(t, w, []string{
		ItemTypeUser + ":first", ItemTypeAssistant + ":first answer",
		ItemTypeUser + ":second", ItemTypeAssistant + ":second answer",
	})
	requireNoHoldKeys(t, w)
	if !fc.noArmFor(second) {
		t.Error("the timer was re-armed for a send already answered")
	}
}
