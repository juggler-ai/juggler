//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside worker_queued_actions_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"testing"
	"time"
)

// TestReleaseQueuedOnAnIdleThreadIsAnswered: Send now on a send scheduled for
// an hour away, on a thread with no run, fires it as its time coming would.
func TestReleaseQueuedOnAnIdleThreadIsAnswered(t *testing.T) {
	fc := newFakeClock()
	w := heldSendWorker(t, "conv-release-idle", fc, "answered now")
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "later", NotBefore: fakeEpoch.Add(time.Hour).UnixMilli()})
	w.quiesce(t)
	requireLabels(t, "queue before Send now", queuedLabels(t, w, ""), []string{"later"})

	w.heldTimer.stale.Store(false)
	deliverQueuedAction(t, w, msgReleaseQueued, "", queuedUserID(t, w, "", "later"))
	w.quiesce(t)

	requireLabels(t, "transcript", transcript(w), []string{ItemTypeUser + ":later", ItemTypeAssistant + ":answered now"})
	requireLabels(t, "queue", queuedLabels(t, w, ""), nil)
	requireNoHoldKeys(t, w)
	if !w.heldTimer.stale.Load() {
		t.Error("Send now left the held-send timer's moment standing")
	}
}

// TestReleaseQueuedOnABusyThreadJoinsTheNextDrain: on a thread mid-run, Send now
// promotes nothing itself. The held send waits for the run's next drain, which
// takes it in like any untimed queued message — here the top of the turn that
// answers a tool batch.
func TestReleaseQueuedOnABusyThreadJoinsTheNextDrain(t *testing.T) {
	fc := newFakeClock()
	w := heldSendWorker(t, "conv-release-busy", fc, "reply to tools and message")
	seedCompletedToolBatch(w)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "later", NotBefore: fakeEpoch.Add(time.Hour).UnixMilli()})

	deliverQueuedAction(t, w, msgReleaseQueued, "", queuedUserID(t, w, "", "later"))
	requireLabels(t, "queue right after Send now", queuedLabels(t, w, ""), []string{"later"})

	w.sched.markReconcile(reconcileTestDriven)
	w.quiesce(t)
	requireLabels(t, "transcript", transcript(w), []string{
		ItemTypeUser + ":run bash",
		ItemTypeAssistant + ":I'll run that.",
		ItemTypeToolAction + ":",
		ItemTypeUser + ":later",
		ItemTypeAssistant + ":reply to tools and message",
	})
	requireLabels(t, "queue", queuedLabels(t, w, ""), nil)
	requireNoHoldKeys(t, w)
}

// TestQueuedActionsIgnoreWhatTheyCannotFind: an item id naming no queued user
// message — gone already, or a context item — changes nothing.
func TestQueuedActionsIgnoreWhatTheyCannotFind(t *testing.T) {
	fc := newFakeClock()
	w := heldSendWorker(t, "conv-queued-unknown", fc)
	enqueuePendingItemForTest(w, "", ConversationItem{Type: "file-content", ItemID: "FILE_1", IsNew: true})
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "later", NotBefore: fakeEpoch.Add(time.Hour).UnixMilli()})
	w.quiesce(t)

	for _, typ := range []wireMsgType{msgReleaseQueued, msgRemoveQueued} {
		for _, id := range []string{"no-such-item", "FILE_1"} {
			deliverQueuedAction(t, w, typ, "", id)
			deliverQueuedAction(t, w, typ, "no-such-thread", id)
		}
	}
	w.quiesce(t)
	requireLabels(t, "queue", queuedLabels(t, w, ""), []string{"FILE_1", "later"})
	requireLabels(t, "transcript", transcript(w), nil)
}
