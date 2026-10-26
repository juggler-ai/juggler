//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// The queued zone's actions on one queued message: Send now (release-queued)
// drops its send's hold, Remove (remove-queued) takes its whole send off the
// queue. Both name the message by its item id and act on its group.

// deliverQueuedAction sends a release-queued or remove-queued frame through the
// worker's inbound table, as a client would.
func deliverQueuedAction(t *testing.T, w *ConversationWorker, typ wireMsgType, threadItemID, itemID string) {
	t.Helper()
	payload, err := json.Marshal(QueuedEntryMessage{Type: typ, ThreadItemID: threadItemID, ItemID: itemID})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	workerInbound[typ](w.currentRun(), workerMessage{Type: string(typ), Payload: payload})
}

// queuedUserID is the item id of the queued user message reading text.
func queuedUserID(t *testing.T, w *ConversationWorker, threadItemID, text string) string {
	t.Helper()
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	for _, it := range w.doc.getItemsFromArrayLocked(w.doc.getPendingArrayLocked(threadItemID)) {
		if it.Type == ItemTypeUser && it.Content == text {
			return it.ItemID
		}
	}
	t.Fatalf("no queued user message %q", text)
	return ""
}

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

	w.sched.markReconcile()
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

// TestRemoveQueuedTakesItsWholeSend: Remove deletes the message with the
// entries queued ahead of it for it — a context item, a skill load — held or
// not, and leaves the other sends queued.
func TestRemoveQueuedTakesItsWholeSend(t *testing.T) {
	w := NewConversationWorker("conv-remove-queued", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	enqueuePendingItemForTest(w, "", ConversationItem{Type: "file-content", ItemID: "FILE_1", IsNew: true})
	w.enqueueHeldSend("", UserMessageInput{Text: "held"}, []string{"alpha"}, pendingHold{NotBefore: time.Now().Add(time.Hour)})
	enqueuePendingItemForTest(w, "", ConversationItem{Type: "file-content", ItemID: "FILE_2", IsNew: true})
	w.enqueuePendingMessage("", UserMessageInput{Text: "plain"})
	w.enqueuePendingMessage("", UserMessageInput{Text: "kept"})

	w.heldTimer.stale.Store(false)
	deliverQueuedAction(t, w, msgRemoveQueued, "", queuedUserID(t, w, "", "held"))
	requireLabels(t, "queue after removing the held send", queuedLabels(t, w, ""), []string{"FILE_2", "plain", "kept"})
	if !w.heldTimer.stale.Load() {
		t.Error("Remove left the held-send timer's moment standing")
	}

	deliverQueuedAction(t, w, msgRemoveQueued, "", queuedUserID(t, w, "", "plain"))
	requireLabels(t, "queue after removing the untimed send", queuedLabels(t, w, ""), []string{"kept"})
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
