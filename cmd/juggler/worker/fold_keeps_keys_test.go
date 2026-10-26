//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestCompactionFoldKeepsEveryKeyOfWhatItFolds pins what a compaction fold
// moves. A fold relocates history into a summary thread; it must not edit it.
// Items carry keys ConversationItem does not declare — a tool action's running
// epoch, whatever a plugin wrote — and keys it declares whose Y type the struct
// would not keep, such as a thread's unsent draft (a Y.Map), beside its
// llmCreated, delegated and readOnly stamps, a tool action's executor and a
// notice's source. Every one of them, and the Y type each value had, must come
// through the fold at every depth. The one deliberate
// exception is a prior summarized fold, which sheds its run-control fields
// (condenseForRefold).
func TestCompactionFoldKeepsEveryKeyOfWhatItFolds(t *testing.T) {
	w := NewConversationWorker("test-fold-keys", "user:test")
	defer w.doc.Destroy()

	ycrdtMu.Lock()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Insert(0, ycrdt.ArrayAny{ycrdt.NewYMap(map[string]any{
			"type": ItemTypeThread, "itemId": "prior", "goal": "Compacted conversation history",
			"result": "earlier summary", "boundedCompaction": true, "needsStrategyRun": true,
			"compactionPromptItemId": "prior-prompt",
		})})
		arr.Insert(1, ycrdt.ArrayAny{ycrdt.NewYMap(map[string]any{"type": ItemTypeUser, "itemId": "u1", "content": "hello"})})
		thread := ycrdt.NewYMap(map[string]any{
			"type": ItemTypeThread, "itemId": "t1", "goal": "look", "result": "done",
			"llmCreated": true, "delegated": true, "readOnly": true, "resultSpec": "a list",
			"contextTokens": 12, "pluginKey": "kept",
		})
		arr.Insert(2, ycrdt.ArrayAny{thread})
		thread.Set("draft", ycrdt.NewYMap(map[string]any{"text": "unsent"}))
		nested := ycrdt.NewYArray()
		thread.Set("items", nested)
		nested.Insert(0, ycrdt.ArrayAny{ycrdt.NewYMap(map[string]any{
			"type": ItemTypeToolAction, "itemId": "a1", "toolUseId": "tu1", "toolName": "bash",
			"state": "completed", "executor": "engine", "runningEpoch": 3,
		})})
		arr.Insert(3, ycrdt.ArrayAny{ycrdt.NewYMap(map[string]any{
			"type": ItemTypeNotice, "itemId": "n1", "content": "note", "source": "compaction",
		})})
		arr.Insert(4, ycrdt.ArrayAny{ycrdt.NewYMap(map[string]any{"type": ItemTypeUser, "itemId": "tail", "content": "recent"})})
	}, w.doc.txOrigin())
	ycrdtMu.Unlock()

	const promptID = "fold-prompt"
	items := w.doc.GetItems()
	records, err := canonicalCompactionRecords(items, promptID)
	if err != nil {
		t.Fatal(err)
	}
	// The summary the way the fold's callers build it: the range as read, then
	// the prompt.
	nestedItems := []ConversationItem{}
	for _, it := range items[0:4] {
		nestedItems = append(nestedItems, condenseForRefold(it))
	}
	nestedItems = append(nestedItems, ConversationItem{Type: ItemTypeUser, ItemID: promptID, Content: "summarize"})
	nestedJSON, err := json.Marshal(nestedItems)
	if err != nil {
		t.Fatal(err)
	}
	summary := ConversationItem{
		Type: ItemTypeThread, ItemID: "sum", BoundedCompaction: true,
		CompactionPromptItemID: promptID, Items: nestedJSON,
	}
	if !w.doc.FoldPrefixIntoSummaryIfUnchanged(w.doc.ensureItems(), 0, 4, summary, promptID, compactionSourceFingerprint(records)) {
		t.Fatal("the fold did not commit")
	}

	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.ensureItems()
	sum, _ := arr.Get(0).(*ycrdt.YMap)
	if sum == nil || yMapString(sum, "itemId") != "sum" {
		t.Fatalf("the fold's summary is not first: %v", arr.ToJson())
	}
	folded, _ := sum.Get("items").(*ycrdt.YArray)
	if folded == nil || folded.GetLength() != 5 {
		t.Fatalf("the summary must hold the four folded items and its prompt, in order; got %v", sum.ToJson())
	}
	at := func(i int) *ycrdt.YMap { m, _ := folded.Get(ycrdt.Number(i)).(*ycrdt.YMap); return m }
	for i, want := range []string{"prior", "u1", "t1", "n1", promptID} {
		if got := yMapString(at(i), "itemId"); got != want {
			t.Fatalf("folded item %d is %q, want %q", i, got, want)
		}
	}

	prior := at(0)
	if prior.Has("needsStrategyRun") || prior.Has("compactionPromptItemId") {
		t.Errorf("a prior summarized fold must shed its run-control fields: %v", prior.ToJson())
	}
	if yMapString(prior, "goal") == "" || !yMapBool(prior, "boundedCompaction") {
		t.Errorf("a prior summarized fold must keep what identifies it: %v", prior.ToJson())
	}

	thread := at(2)
	for _, key := range []string{"llmCreated", "delegated", "readOnly"} {
		if !yMapBool(thread, key) {
			t.Errorf("the folded thread lost %s: %v", key, thread.ToJson())
		}
	}
	if yMapString(thread, "resultSpec") != "a list" || yMapString(thread, "pluginKey") != "kept" || docInt64(thread.Get("contextTokens")) != 12 {
		t.Errorf("the folded thread lost a key it does not declare: %v", thread.ToJson())
	}
	draft, ok := thread.Get("draft").(*ycrdt.YMap)
	if !ok || yMapString(draft, "text") != "unsent" {
		t.Errorf("the folded thread's draft must stay a Y.Map holding its text, got %T %v", thread.Get("draft"), thread.Get("draft"))
	}
	inner, _ := thread.Get("items").(*ycrdt.YArray)
	if inner == nil || inner.GetLength() != 1 {
		t.Fatalf("the folded thread's own transcript must come with it: %v", thread.ToJson())
	}
	tool, _ := inner.Get(0).(*ycrdt.YMap)
	if yMapString(tool, "executor") != "engine" || docInt64(tool.Get("runningEpoch")) != 3 {
		t.Errorf("the nested tool action lost its run-time keys: %v", tool.ToJson())
	}

	if yMapString(at(3), "source") != "compaction" {
		t.Errorf("the folded notice lost its source: %v", at(3).ToJson())
	}
}

// TestPromotePendingKeepsEveryKeyOfWhatItMoves pins the same rule for a queued
// message entering the transcript: it moves as it was queued, every key
// included, losing only the transaction stamp it must not carry into the next
// turn. Queued context items come from the browser and from plugins, with keys
// ConversationItem does not declare.
func TestPromotePendingKeepsEveryKeyOfWhatItMoves(t *testing.T) {
	w := NewConversationWorker("test-promote-keys", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()
	w.enqueuePendingMessage("", UserMessageInput{Text: "queued"})

	ycrdtMu.Lock()
	queue := w.doc.getPendingArrayLocked("")
	queued, _ := queue.Get(0).(*ycrdt.YMap)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		queued.Set("pluginKey", "kept")
		queued.Set("source", "plugin")
		queued.Set("transactionId", "txn-earlier")
		queued.Set("payload", ycrdt.NewYMap(map[string]any{"x": 1}))
	}, w.doc.txOrigin())
	ycrdtMu.Unlock()

	if moved := w.tracker.PromotePending("", restDrain(time.Now())); len(moved) != 1 || moved[0].Content != "queued" {
		t.Fatalf("PromotePending returned %+v, want the one queued message", moved)
	}

	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.ensureItems()
	last, _ := arr.Get(arr.GetLength() - 1).(*ycrdt.YMap)
	if last == nil || yMapString(last, "content") != "queued" {
		t.Fatalf("the queued message is not at the end of the transcript: %v", arr.ToJson())
	}
	if yMapString(last, "pluginKey") != "kept" || yMapString(last, "source") != "plugin" {
		t.Errorf("the promoted message lost keys it was queued with: %v", last.ToJson())
	}
	if payload, ok := last.Get("payload").(*ycrdt.YMap); !ok || docInt64(payload.Get("x")) != 1 {
		t.Errorf("a Y.Map value must arrive as a Y.Map, got %T", last.Get("payload"))
	}
	if last.Has("transactionId") {
		t.Errorf("the promoted message kept the transaction stamp it was queued under: %v", last.ToJson())
	}
	if queue.GetLength() != 0 {
		t.Errorf("the queue still holds %d item(s)", queue.GetLength())
	}
}
