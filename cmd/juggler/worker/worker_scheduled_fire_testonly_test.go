//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside worker_scheduled_fire_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"testing"
	"time"
)

// heldSendWorker is idleWorkerOn with the engine answered and replies scripted.
func heldSendWorker(t *testing.T, convID string, fc *fakeClock, replies ...string) *ConversationWorker {
	t.Helper()
	w := idleWorkerOn(t, convID, fc)
	scriptReplies(w, replies...)
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	feedEngine(w, stop)
	return w
}

// TestScheduledSendLiftsTheUsageCap is the feature's reason to exist: the user
// meets a usage cap and schedules the next prompt for when it resets. When it
// fires it is the "try anyway" a typed send is, so the cap goes and the message
// is answered.
func TestScheduledSendLiftsTheUsageCap(t *testing.T) {
	fc := newFakeClock()
	w := heldSendWorker(t, "conv-held-cap", fc, "the limit has reset")
	w.latchRateLimit("test", time.Now().Add(4*time.Hour))

	at := fakeEpoch.Add(4 * time.Hour)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "carry on", NotBefore: at.UnixMilli()})
	if w.rateLimitedUntil("test").IsZero() {
		t.Fatal("queueing a held send lifted the cap; it lifts nothing until it fires")
	}

	fireAt(t, w, fc, at)
	requireLabels(t, "transcript", transcript(w), []string{ItemTypeUser + ":carry on", ItemTypeAssistant + ":the limit has reset"})
	if until := w.rateLimitedUntil("test"); !until.IsZero() {
		t.Errorf("the cap still stands until %v after the scheduled send fired", until)
	}
}

// TestScheduledSendLiftsAStandingPause: an explicit send into a paused, idle
// thread lifts the pause (TestPoliteStop_ClearedByExplicitSend). A scheduled
// one does the same when it fires, and is answered.
func TestScheduledSendLiftsAStandingPause(t *testing.T) {
	fc := newFakeClock()
	w := heldSendWorker(t, "conv-held-pause", fc, "resumed")
	w.markPoliteStop("")

	at := fakeEpoch.Add(time.Hour)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "resume later", NotBefore: at.UnixMilli()})
	if !w.politeStopCovers("") {
		t.Fatal("queueing a held send lifted the pause; it lifts nothing until it fires")
	}

	fireAt(t, w, fc, at)
	requireLabels(t, "transcript", transcript(w), []string{ItemTypeUser + ":resume later", ItemTypeAssistant + ":resumed"})
	if w.hasPoliteStops() {
		t.Error("the pause still stands after the scheduled send fired")
	}
}

// TestRunEndSendToAPausedIdleThread: a run-end send into a thread with no run
// fires at intake, and lifts the pause as it does.
func TestRunEndSendToAPausedIdleThread(t *testing.T) {
	fc := newFakeClock()
	w := heldSendWorker(t, "conv-held-run-end-pause", fc, "answered")
	w.markPoliteStop("")

	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "after the run", Hold: pendingHoldRunEnd})
	w.quiesce(t)
	requireLabels(t, "transcript", transcript(w), []string{ItemTypeUser + ":after the run", ItemTypeAssistant + ":answered"})
	if w.hasPoliteStops() {
		t.Error("the pause still stands after the run-end send fired")
	}
}

// TestScheduledSendLiftsTheCapOverAParkedParent: a child rested on the cap, so
// its parent is parked on it — busy, with nothing running. A send scheduled
// into the parent queues there, and when it fires it lifts the cap as a typed
// send into the parked parent does
// (TestRateLimitLatch_UserSendLiftsItForAParkedParent): the child is
// re-offered, settles, and the parent's turn takes the send in.
func TestScheduledSendLiftsTheCapOverAParkedParent(t *testing.T) {
	fc := newFakeClock()
	w := idleWorkerOn(t, "conv-held-parked-parent", fc)
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "look at a", TransactionID: "txn-0", Timestamp: fakeEpoch.Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send an agent.", TransactionID: "txn-0", Timestamp: fakeEpoch.Format(time.RFC3339),
	})
	child := insertThreadWithOpts(w, threadOpts{goal: "read a", userMessage: "look at a", llmCreated: true, delegated: true})
	appendToThread(w, child,
		ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "I'll grep for it."},
		ConversationItem{Type: ItemTypeToolAction, ItemID: generateItemID(), ToolUseID: "tu-a", ToolName: "grep", State: StateCompleted, Result: resultJSON("ok")},
	)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})
	w.latchRateLimit("test", time.Now().Add(4*time.Hour))
	scriptReplies(w, "a is fine", "so it is")
	stop := make(chan struct{})
	defer close(stop)
	feedEngine(w, stop)

	at := fakeEpoch.Add(4 * time.Hour)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "try again then", NotBefore: at.UnixMilli()})
	w.sched.markReconcile(reconcileTestDriven)
	w.quiesce(t)
	if left := w.mock().remaining(); left != 2 {
		t.Fatalf("%d of 2 scripted turns ran before the scheduled send fired; the cap should still hold", 2-left)
	}

	fireAt(t, w, fc, at)
	if until := w.rateLimitedUntil("test"); !until.IsZero() {
		t.Fatalf("the cap still stands until %v after a send scheduled into the parked parent fired", until)
	}
	if left := w.mock().remaining(); left != 0 {
		t.Fatalf("%d of 2 scripted turns went unused: the child was never re-offered after the cap lifted", left)
	}
	requireLabels(t, "queue", queuedLabels(t, w, ""), nil)
}

// TestScheduledFirstMessageNamesTheConversation: a conversation whose first
// message was scheduled is auto-named from it when it fires, exactly once.
func TestScheduledFirstMessageNamesTheConversation(t *testing.T) {
	fc := newFakeClock()
	var calls []autoNameCall
	w := heldSendWorker(t, "conv-held-name", fc, "sure")
	w.SetAutoNamer(func(convID, firstMessage, provider, model, thinking string, force bool) {
		calls = append(calls, autoNameCall{convID, firstMessage, provider, model, thinking, force})
	})

	at := fakeEpoch.Add(time.Hour)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "Add a dark mode toggle", NotBefore: at.UnixMilli()})
	if len(calls) != 0 {
		t.Fatalf("queueing a held send fired the auto-namer %d time(s); it is not a message until it fires", len(calls))
	}
	fireAt(t, w, fc, at)
	want := []autoNameCall{{"conv-held-name", "Add a dark mode toggle", "test", "test", "", false}}
	if len(calls) != 1 || calls[0] != want[0] {
		t.Fatalf("auto-name calls = %+v, want %+v", calls, want)
	}
}

// TestScheduledSendWithNoModelLandsAndWarns: a send that fires into a thread
// with no model has nothing to run on. Left queued it would be due again at
// once, forever; so it lands in the transcript, unanswered, and the timer is
// not re-armed for it.
func TestScheduledSendWithNoModelLandsAndWarns(t *testing.T) {
	fc := newFakeClock()
	w := heldSendWorker(t, "conv-held-no-model", fc, "SHOULD NOT RUN")
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "", "model": ""})

	at := fakeEpoch.Add(time.Hour)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "orphan", NotBefore: at.UnixMilli()})
	fireAt(t, w, fc, at)
	requireLabels(t, "transcript", transcript(w), []string{ItemTypeUser + ":orphan"})
	requireLabels(t, "queue", queuedLabels(t, w, ""), nil)
	if left := w.mock().remaining(); left != 1 {
		t.Errorf("a turn ran with no model configured")
	}
	if got := w.readProcessingState()["status"]; got != string(statusValidationError) {
		t.Errorf("status = %v, want %s: the user is told why the send went unanswered", got, statusValidationError)
	}
}
