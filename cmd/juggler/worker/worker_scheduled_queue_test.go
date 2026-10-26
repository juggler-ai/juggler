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
