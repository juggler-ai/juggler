//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// Held sends in the pending queue: a send scheduled for a time, or for the end
// of the run, waits in the queue past every drain its hold has not lifted at,
// while untimed sends around it are promoted as they always are.

// queuedLabels lists the thread's pending queue in order: a user message by its
// content, anything else by its item id.
func queuedLabels(t *testing.T, w *ConversationWorker, threadItemID string) []string {
	t.Helper()
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	if arr == nil {
		return nil
	}
	var out []string
	for _, it := range w.doc.getItemsFromArrayLocked(arr) {
		out = append(out, itemLabel(it))
	}
	return out
}

func itemLabel(it ConversationItem) string {
	if it.Type == ItemTypeUser {
		return it.Content
	}
	return it.ItemID
}

func labelsOf(items []ConversationItem) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = itemLabel(it)
	}
	return out
}

// requireNoHoldKeys fails for any root item carrying a pending entry's hold or
// send stamp: those belong to the queue and never reach a transcript.
func requireNoHoldKeys(t *testing.T, w *ConversationWorker) {
	t.Helper()
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.ensureItems()
	for i := 0; i < int(arr.GetLength()); i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		for _, k := range []string{keyNotBefore, keyHold, keySendID} {
			if m.Has(k) {
				t.Errorf("promoted item %q kept %q: %v", yMapString(m, keyItemID), k, m.ToJson())
			}
		}
	}
}

// stampLastPending writes keys onto the newest entry of the thread's queue, as
// a client stamping a context item it queued would.
func stampLastPending(w *ConversationWorker, threadItemID string, keys map[string]any) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	m, _ := arr.Get(ycrdt.Number(int(arr.GetLength()) - 1)).(*ycrdt.YMap)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		for k, v := range keys {
			m.Set(k, v)
		}
	}, w.doc.txOrigin())
}

func requireLabels(t *testing.T, what string, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("%s = %q, want %q", what, got, want)
	}
}

// TestUntimedSendBehindAHeldOneIsPromoted: a held send does not block the
// queue. An untimed message queued after it is promoted, and the held one keeps
// its place.
func TestUntimedSendBehindAHeldOneIsPromoted(t *testing.T) {
	w := NewConversationWorker("conv-scheduled-behind", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	w.enqueueHeldSend("", UserMessageInput{Text: "later"}, nil, pendingHold{NotBefore: time.Now().Add(time.Hour)})
	w.enqueueHeldSend("", UserMessageInput{Text: "after the run"}, nil, pendingHold{RunEnd: true})
	w.enqueuePendingMessage("", UserMessageInput{Text: "untimed"})

	moved := w.tracker.PromotePending("", midRunDrain(time.Now()))
	requireLabels(t, "promoted", labelsOf(moved), []string{"untimed"})
	requireLabels(t, "queue", queuedLabels(t, w, ""), []string{"later", "after the run"})
	requireNoHoldKeys(t, w)
}

// TestScheduledSendIsPromotedOnceDue: the first drain at or after its time
// promotes it, a mid-run one included, without its stamps.
func TestScheduledSendIsPromotedOnceDue(t *testing.T) {
	w := NewConversationWorker("conv-scheduled-due", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	at := time.Now().Add(time.Hour).Truncate(time.Millisecond)
	w.enqueueHeldSend("", UserMessageInput{Text: "scheduled"}, nil, pendingHold{NotBefore: at})

	if moved := w.tracker.PromotePending("", restDrain(at.Add(-time.Millisecond))); len(moved) != 0 {
		t.Fatalf("promoted %q a millisecond early", labelsOf(moved))
	}
	moved := w.tracker.PromotePending("", midRunDrain(at))
	requireLabels(t, "promoted at its time", labelsOf(moved), []string{"scheduled"})
	requireLabels(t, "queue", queuedLabels(t, w, ""), nil)
	requireNoHoldKeys(t, w)
}

// TestRunEndHoldNeedsTheRunToEnd pins the hold at the drain level: a mid-run
// drain leaves it, a rest drain lifts it, and a send that also has a time needs
// both.
func TestRunEndHoldNeedsTheRunToEnd(t *testing.T) {
	w := NewConversationWorker("conv-run-end-unit", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	now := time.Now()
	at := now.Add(time.Hour)
	w.enqueueHeldSend("", UserMessageInput{Text: "after the run"}, nil, pendingHold{RunEnd: true})
	w.enqueueHeldSend("", UserMessageInput{Text: "after the run, after its time"}, nil, pendingHold{RunEnd: true, NotBefore: at})

	if moved := w.tracker.PromotePending("", midRunDrain(now)); len(moved) != 0 {
		t.Fatalf("a mid-run drain promoted %q", labelsOf(moved))
	}
	requireLabels(t, "promoted at rest", labelsOf(w.tracker.PromotePending("", restDrain(now))), []string{"after the run"})
	if moved := w.tracker.PromotePending("", midRunDrain(at)); len(moved) != 0 {
		t.Fatalf("a mid-run drain past its time promoted %q", labelsOf(moved))
	}
	requireLabels(t, "promoted at rest past its time",
		labelsOf(w.tracker.PromotePending("", restDrain(at))), []string{"after the run, after its time"})
	requireNoHoldKeys(t, w)
}

// TestHeldSendKeepsItsContextItems: the entries queued ahead of a held message
// — a context item the client queued without a send id, the send's own skill
// load — wait with it and are promoted with it, in order, while an untimed
// message behind them goes first.
func TestHeldSendKeepsItsContextItems(t *testing.T) {
	w := NewConversationWorker("conv-held-group", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	at := time.Now().Add(time.Hour)
	enqueuePendingItemForTest(w, "", ConversationItem{
		Type: "file-content", ItemID: "FILE_1", IsNew: true, Data: json.RawMessage(`{"path":"foo.txt"}`),
	})
	sendID, userID, ok := w.enqueueHeldSend("", UserMessageInput{Text: "look at @foo.txt later"}, []string{"alpha"},
		pendingHold{NotBefore: at})
	if !ok || sendID == "" || userID == "" {
		t.Fatalf("enqueueHeldSend = %q, %q, %v", sendID, userID, ok)
	}
	w.enqueuePendingMessage("", UserMessageInput{Text: "untimed"})

	queued := queuedLabels(t, w, "")
	if len(queued) != 4 {
		t.Fatalf("queue = %q, want the read, the skill load, the held message and the untimed one", queued)
	}
	skillID := queued[1]

	requireLabels(t, "promoted mid-run", labelsOf(w.tracker.PromotePending("", midRunDrain(time.Now()))), []string{"untimed"})
	requireLabels(t, "queue", queuedLabels(t, w, ""), []string{"FILE_1", skillID, "look at @foo.txt later"})

	requireLabels(t, "promoted at its time", labelsOf(w.tracker.PromotePending("", midRunDrain(at))),
		[]string{"FILE_1", skillID, "look at @foo.txt later"})
	all := labelsOf(w.doc.GetItems())
	requireLabels(t, "transcript tail", all[len(all)-4:], []string{"untimed", "FILE_1", skillID, "look at @foo.txt later"})
	requireNoHoldKeys(t, w)
}

// TestSendIDsSeparateAdjacentSends: entries stamped with different send ids
// are different sends even with no user message between them, so a context item
// sent on its own is not held by the scheduled send queued after it.
func TestSendIDsSeparateAdjacentSends(t *testing.T) {
	w := NewConversationWorker("conv-send-ids", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()

	enqueuePendingItemForTest(w, "", ConversationItem{Type: "file-content", ItemID: "FILE_A", IsNew: true})
	stampLastPending(w, "", map[string]any{keySendID: "send-a"})
	w.enqueueHeldSend("", UserMessageInput{Text: "later"}, nil, pendingHold{NotBefore: time.Now().Add(time.Hour)})

	requireLabels(t, "promoted", labelsOf(w.tracker.PromotePending("", midRunDrain(time.Now()))), []string{"FILE_A"})
	requireLabels(t, "queue", queuedLabels(t, w, ""), []string{"later"})
}

// TestGroupHoldComesFromAnyMemberUserFirst: a group's hold is the user
// message's when it carries one, and otherwise any member's.
func TestGroupHoldComesFromAnyMemberUserFirst(t *testing.T) {
	w := NewConversationWorker("conv-group-hold", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()
	now := time.Now()

	// Held by its context item: the user message carries no stamp.
	enqueuePendingItemForTest(w, "", ConversationItem{Type: "file-content", ItemID: "FILE_HELD", IsNew: true})
	stampLastPending(w, "", map[string]any{keyNotBefore: int(now.Add(time.Hour).UnixMilli())})
	w.enqueuePendingMessage("", UserMessageInput{Text: "held by its read"})

	// The user message's own (lifted) time outranks its read's run-end hold.
	enqueuePendingItemForTest(w, "", ConversationItem{Type: "file-content", ItemID: "FILE_FREE", IsNew: true})
	stampLastPending(w, "", map[string]any{keyHold: pendingHoldRunEnd})
	w.enqueuePendingMessage("", UserMessageInput{Text: "due"})
	stampLastPending(w, "", map[string]any{keyNotBefore: int(now.Add(-time.Minute).UnixMilli())})

	requireLabels(t, "promoted", labelsOf(w.tracker.PromotePending("", midRunDrain(now))), []string{"FILE_FREE", "due"})
	requireLabels(t, "queue", queuedLabels(t, w, ""), []string{"FILE_HELD", "held by its read"})
}
