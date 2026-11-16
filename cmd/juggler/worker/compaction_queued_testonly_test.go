//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

import (
	"context"
	"encoding/json"
	"testing"

	"juggler/cmd/juggler/providers/provider"

	ycrdt "github.com/skyterra/y-crdt"
)

// newBusyCompactWorker is a conversation with history whose root turn is live
// and has a bash call running: what /compact meets when typed mid-turn. The
// summarizer answers summary.
func newBusyCompactWorker(t *testing.T, summary string) (*ConversationWorker, *run) {
	t.Helper()
	w := NewConversationWorker("conv-compact-queued", "user:test")
	t.Cleanup(w.doc.Destroy)
	r := w.currentRun()
	r.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: summary}}}, nil
	})
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "run the tests"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "running them"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{
			Type: ItemTypeToolAction, ItemID: generateItemID(), ToolUseID: "tu-tests", ToolName: "bash", State: StateRunning,
		})})
	}, w.doc.authorID)
	if !r.claimLLM("") {
		t.Fatal("could not claim the root")
	}
	tr := r.beginTurn("")
	tr.storeState(StateProcessing)
	return w, tr
}

// queuedCompact sends /compact as the command does (keepRecent: plain /compact;
// otherwise /compact all) and returns its ack result.
func queuedCompact(t *testing.T, w *ConversationWorker, ackID string, keepRecent bool) map[string]any {
	t.Helper()
	waitAck := captureAck(t, w, "client-1", ackID)
	payload, _ := json.Marshal(CompactMessage{Type: msgCompact, AckID: ackID, KeepRecent: keepRecent, QueueIfBusy: true})
	w.currentRun().handleCompact(payload)
	result, _ := waitAck()["result"].(map[string]any)
	return result
}

// queuedCompactions lists the content of every queued /compact in the root queue.
func queuedCompactions(w *ConversationWorker) []string {
	var out []string
	withYDoc(func() {
		queue := w.doc.getPendingArrayLocked("")
		if queue == nil {
			return
		}
		for i, e := range readPendingEntriesLocked(queue) {
			if e.compaction {
				out = append(out, yMapString(queue.Get(ycrdt.Number(i)).(*ycrdt.YMap), keyContent))
			}
		}
	})
	return out
}

// rootThreads counts the thread items at the root: a fold leaves one.
func rootThreads(w *ConversationWorker) int {
	n := 0
	for _, it := range w.doc.GetItems() {
		if it.Type == ItemTypeThread {
			n++
		}
	}
	return n
}

// TestCompactWhileBusyWaitsForTheTurn pins /compact typed during a running turn:
// it is queued — neither refused nor folded over the running bash call — a second
// one replaces its mode rather than folding twice, the turn finishes untouched,
// and then the fold happens and its summary lands.
func TestCompactWhileBusyWaitsForTheTurn(t *testing.T) {
	w, tr := newBusyCompactWorker(t, "queued compact summary")

	for i, ackID := range []string{"q1", "q2"} {
		result := queuedCompact(t, w, ackID, i == 0)
		if result["queued"] != true || result["folded"] == true || result["error"] != nil {
			t.Fatalf("ack %s = %v, want {queued:true} with no fold and no error", ackID, result)
		}
	}
	if n := rootThreads(w); n != 0 {
		t.Fatalf("/compact folded under a running tool: %d thread(s) at the root", n)
	}
	requireLabels(t, "queued /compacts", queuedCompactions(w), []string{"/compact all"})

	w.currentRun().runTurn(tr, func(tr *run) {
		w.doc.UpdateToolActionFieldsRecursive("tu-tests", map[string]any{
			"state": StateCompleted, "result": map[string]any{"content": "ok", "isError": false},
		})
		w.doc.InsertMessage(w.doc.GetItemsLength(), ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "tests pass"})
		tr.finishStrategyRun()
	})
	w.quiesce(t)

	if w.hasPendingItems("") {
		t.Fatal("the queued /compact is still queued under an idle conversation")
	}
	items := w.doc.GetItems()
	if len(items) != 1 || items[0].Type != ItemTypeThread {
		t.Fatalf("root = %+v, want one fold thread (one fold, not two)", items)
	}
	thread := w.doc.GetThreadYMap(items[0].ItemID)
	if got, _ := thread.Get("result").(string); got != "queued compact summary" {
		t.Fatalf("fold thread result = %q, want the summarizer output", got)
	}
	for _, it := range w.doc.GetThreadItems(items[0].ItemID) {
		if it.Type == ItemTypeToolAction && !isToolTerminal(it) {
			t.Fatalf("the fold took a tool call in state %q", it.State)
		}
	}
	if a := w.currentRun().threadActivity(""); a != ActivityNone {
		t.Fatalf("the conversation was left %q after the summary", a)
	}
}

// TestQueuedCompactIsWithdrawnWhenTheTurnDoesNotFinish: /compact waits for the
// turn to finish, so whatever ends it otherwise — Stop, Pause, undo — withdraws
// it, and the conversation is not folded once it comes to rest. Undo stops the
// turn by a path of its own (cancelAndWaitForIdle), and a fold after it would
// land on the history it just restored.
func TestQueuedCompactIsWithdrawnWhenTheTurnDoesNotFinish(t *testing.T) {
	for name, end := range map[string]func(w *ConversationWorker, tr *run){
		"stop": func(w *ConversationWorker, tr *run) {
			w.currentRun().handleCancel(cancelReasonUnspecified)
			w.currentRun().runTurn(tr, func(tr *run) { tr.finishStrategyRun() })
		},
		"pause": func(w *ConversationWorker, tr *run) {
			w.handlePause("")
			w.currentRun().runTurn(tr, func(tr *run) { tr.finishStrategyRun() })
		},
		"undo": func(w *ConversationWorker, tr *run) {
			w.currentRun().runTurn(tr, func(tr *run) { tr.finishStrategyRun() })
			if !w.currentRun().cancelAndWaitForIdle() {
				t.Fatal("the turn did not stop for the undo")
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			w, tr := newBusyCompactWorker(t, "unwanted summary")
			if result := queuedCompact(t, w, "s1", false); result["queued"] != true {
				t.Fatalf("ack = %v, want {queued:true}", result)
			}
			end(w, tr)
			w.quiesce(t)

			if q := queuedCompactions(w); len(q) != 0 {
				t.Fatalf("%s left the /compact queued: %q", name, q)
			}
			if n := rootThreads(w); n != 0 {
				t.Fatalf("the conversation was folded after %s: %d thread(s) at the root", name, n)
			}
		})
	}
}

// TestQueuedCompactDoesNotOutliveItsTurn: a /compact queued behind a turn is
// not carried past it by a restart of the server, which ended that turn, nor
// into a duplicate of the conversation, which never had it.
func TestQueuedCompactDoesNotOutliveItsTurn(t *testing.T) {
	queued := func(t *testing.T) *ConversationWorker {
		w := NewConversationWorker("conv-compact-outlive", "user:test")
		t.Cleanup(w.doc.Destroy)
		if !w.currentRun().queueCompaction("", true) {
			t.Fatal("could not queue a /compact")
		}
		return w
	}
	t.Run("restart", func(t *testing.T) {
		w := queued(t)
		w.currentRun().reconcileProcessingStateOnLoad()
		if q := queuedCompactions(w); len(q) != 0 {
			t.Fatalf("a load kept the /compact queued: %q", q)
		}
	})
	t.Run("duplicate", func(t *testing.T) {
		w := queued(t)
		if !w.doc.dropHeldSends() || len(queuedCompactions(w)) != 0 {
			t.Fatalf("the copy kept the /compact queued: %q", queuedCompactions(w))
		}
	})
}

// TestQueuedCompactInAnArchivedThreadIsDropped: a /compact queued in a thread
// that a later fold archived could only fold history nothing reads, into a fold
// the pickup never summarizes. It is dropped as found, and the root is not
// folded on its account.
func TestQueuedCompactInAnArchivedThreadIsDropped(t *testing.T) {
	w := NewConversationWorker("conv-compact-archived", "user:test")
	t.Cleanup(w.doc.Destroy)
	r := w.currentRun()
	r.storeState(StateIdle)
	inner := ConversationItem{Type: ItemTypeThread, ItemID: "th-inner", Goal: "inner", Items: json.RawMessage(mustJSON(t, []ConversationItem{
		{Type: ItemTypeUser, ItemID: generateItemID(), Content: "inner question"},
		{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "inner answer"},
	}))}
	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "hello"})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeThread, ItemID: "th-archive", Goal: "Compacted conversation history", BoundedCompaction: true, Result: json.RawMessage(mustJSON(t, "old summary")),
		Items: json.RawMessage(mustJSON(t, []ConversationItem{inner})),
	})
	if !r.queueCompaction("th-inner", false) {
		t.Fatal("could not queue a /compact in the archived thread")
	}
	before := len(w.doc.GetItems())

	r.drainReconcile()

	left := 0
	withYDoc(func() {
		walkQueuesLocked(w.doc, func(_ string, queue *ycrdt.YArray, _ bool) {
			for _, e := range readPendingEntriesLocked(queue) {
				if e.compaction {
					left++
				}
			}
		})
	})
	if left != 0 {
		t.Fatal("the /compact queued inside an archive was left queued")
	}
	inside := w.doc.GetThreadItems("th-inner")
	if got := len(w.doc.GetItems()); got != before || len(inside) != 2 || inside[0].Type != ItemTypeUser {
		t.Fatalf("a /compact queued inside an archive folded something: root %d → %d items, archived thread %+v", before, got, inside)
	}
}
