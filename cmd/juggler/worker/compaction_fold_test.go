//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// echoableTurn is a user turn long enough for an echo of it to be recognisable
// as one: the reducer only calls a reply a copy when it reproduces a run of the
// source longer than compactionEchoWindow.
func echoableTurn(topic string) string {
	return topic + ": " + strings.Repeat("the user asked for a change and the agent made it. ", 4)
}

// TestFoldConversationForCompactionBuildsUnsummarizedThread verifies the Go port
// of the browser /compact fold: the leading standing-context run stays at the
// parent, the conversational history is relocated into one unsummarized
// bounded-compaction thread carrying the /compact control flags, and the thread's
// nested items are the folded items plus the summarization prompt.
func TestFoldConversationForCompactionBuildsUnsummarizedThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	ruleID := generateItemID()
	uID := generateItemID()
	aID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		// Leading standing context: non-conversational, has an itemId, no toolUseId.
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "rule", ItemID: ruleID, Content: "a standing rule"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: uID, Content: "do the thing"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: aID, Content: "did the thing"})})
	}, w.doc.authorID)

	threadID, folded, err := w.currentRun().foldConversationForCompaction(false)
	if err != nil || !folded {
		t.Fatalf("foldConversationForCompaction = (%q, %v, %v), want folded success", threadID, folded, err)
	}

	items := w.doc.GetItems()
	if len(items) != 2 {
		t.Fatalf("root item count = %d, want 2 (leading rule + fold thread)", len(items))
	}
	if items[0].Type != "rule" || items[0].ItemID != ruleID {
		t.Fatalf("root[0] = %+v, want the preserved leading rule", items[0])
	}
	thread := items[1]
	if thread.Type != ItemTypeThread || thread.ItemID != threadID {
		t.Fatalf("root[1] = %+v, want the fold thread", thread)
	}
	if !thread.BoundedCompaction || thread.CompactionPromptItemID == "" {
		t.Fatalf("fold thread missing bounded-compaction markers: %+v", thread)
	}

	// The Y.Map must carry the unsummarized-pickup control keys so
	// checkForNewThreads runs it (they are read off the Y.Map directly).
	ymap := w.doc.GetThreadYMap(threadID)
	if ymap == nil {
		t.Fatal("fold thread Y.Map not found")
	}
	ycrdtMu.Lock()
	needsRun, _ := ymap.Get("needsStrategyRun").(bool)
	noAutoSelect, _ := ymap.Get("noAutoSelect").(bool)
	noContextSeed, _ := ymap.Get("noContextSeed").(bool)
	bounded, _ := ymap.Get("boundedCompaction").(bool)
	result, _ := ymap.Get("result").(string)
	ycrdtMu.Unlock()
	// boundedCompaction is the sole signal isBoundedCompactionThread reads, so
	// it is asserted on the Y.Map and not just on the serialised item.
	if !needsRun || !noAutoSelect || !noContextSeed || !bounded {
		t.Fatalf("fold thread control flags wrong: needsRun=%v noAutoSelect=%v noContextSeed=%v boundedCompaction=%v",
			needsRun, noAutoSelect, noContextSeed, bounded)
	}
	if result != "" {
		t.Fatalf("fold thread should be UNSUMMARIZED (no result), got %q", result)
	}

	// Nested items: the two folded conversational items + the prompt item, whose
	// content is the rich DefaultSummarizationPrompt and whose id is the excluded
	// CompactionPromptItemID.
	nested := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))
	if len(nested) != 3 {
		t.Fatalf("nested item count = %d, want 3 (user + assistant + prompt)", len(nested))
	}
	if nested[0].ItemID != uID || nested[1].ItemID != aID {
		t.Fatalf("nested folded items = %q,%q, want %q,%q", nested[0].ItemID, nested[1].ItemID, uID, aID)
	}
	prompt := nested[2]
	if prompt.ItemID != thread.CompactionPromptItemID {
		t.Fatalf("prompt item id = %q, want CompactionPromptItemID %q", prompt.ItemID, thread.CompactionPromptItemID)
	}
	if prompt.Content != DefaultSummarizationPrompt {
		t.Fatalf("prompt content = %q, want DefaultSummarizationPrompt", prompt.Content)
	}
}

// captureAck registers a client callback and returns a function that waits for
// the worker's ack for the given ackId (scanning past any interleaved sync/status
// broadcasts the pickup emits to the same client).
func captureAck(t *testing.T, w *ConversationWorker, clientID, ackID string) func() map[string]any {
	t.Helper()
	msgs := make(chan []byte, 64)
	w.SetCallback(clientID, func(b []byte) {
		bb := make([]byte, len(b))
		copy(bb, b)
		select {
		case msgs <- bb:
		default:
		}
	})
	w.inbox.beginReply(clientID)
	return func() map[string]any {
		deadline := time.After(2 * time.Second)
		for {
			select {
			case b := <-msgs:
				var m map[string]any
				if json.Unmarshal(b, &m) != nil {
					continue
				}
				if m["type"] == "ack" && m["ackId"] == ackID {
					return m
				}
			case <-deadline:
				t.Fatalf("no ack for %q", ackID)
				return nil
			}
		}
	}
}

// TestHandleCompactBusyDeclines verifies the idle guard: a compact request while
// the worker is processing acks {folded:false} with a busy error and folds
// nothing.
func TestHandleCompactBusyDeclines(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "hello"})})
	}, w.doc.authorID)

	waitAck := captureAck(t, w, "client-1", "a2")
	w.currentRun().handleCompact(json.RawMessage(`{"type":"compact","ackId":"a2"}`))
	w.quiesce(t)

	ack := waitAck()
	result, _ := ack["result"].(map[string]any)
	if folded, _ := result["folded"].(bool); folded {
		t.Fatalf("ack result = %v, want {folded:false} while busy", result)
	}
	if result["error"] == nil {
		t.Fatalf("ack result = %v, want a busy error", result)
	}
	if len(w.doc.GetItems()) != 1 {
		t.Fatalf("root = %d items, want unchanged (no fold while busy)", len(w.doc.GetItems()))
	}
}

// TestFoldConversationForCompactionSweepsMidConversationContext pins the
// positional /compact rule: a non-conversational context/file item that appears
// AFTER conversation started is swept into the thread (it is standing context
// only while leading), while a LEADING context item of the same shape stays at
// the parent.
func TestFoldConversationForCompactionSweepsMidConversationContext(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	leadingFileID := generateItemID()
	uID := generateItemID()
	midFileID := generateItemID()
	aID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		// Leading standing-context file (itemId, no toolUseId) — kept at parent.
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "read-file", ItemID: leadingFileID, Content: "leading file"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: uID, Content: "look at this"})})
		// Mid-conversation file — must be swept.
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "read-file", ItemID: midFileID, Content: "mid file"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: aID, Content: "looked"})})
	}, w.doc.authorID)

	threadID, folded, err := w.currentRun().foldConversationForCompaction(false)
	if err != nil || !folded {
		t.Fatalf("fold = (%q, %v, %v), want folded success", threadID, folded, err)
	}
	items := w.doc.GetItems()
	if len(items) != 2 || items[0].ItemID != leadingFileID {
		t.Fatalf("root = %+v, want [leading file, foldThread]", items)
	}
	nested := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))
	// user + mid-file + assistant + prompt
	if len(nested) != 4 {
		t.Fatalf("nested = %d items, want 4 (user + mid-file + assistant + prompt)", len(nested))
	}
	sweptMid := false
	for _, it := range nested {
		if it.ItemID == midFileID {
			sweptMid = true
		}
		if it.ItemID == leadingFileID {
			t.Fatal("leading standing-context file was wrongly swept into the thread")
		}
	}
	if !sweptMid {
		t.Fatal("mid-conversation file was not swept into the thread")
	}
}

// TestFoldConversationForCompactionNothingFoldable verifies a conversation with
// only standing context (no conversational history) folds nothing.
func TestFoldConversationForCompactionNothingFoldable(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "rule", ItemID: generateItemID(), Content: "only a rule"})})
	}, w.doc.authorID)

	threadID, folded, err := w.currentRun().foldConversationForCompaction(false)
	if folded || err != nil || threadID != "" {
		t.Fatalf("fold = (%q, %v, %v), want no-op (nothing foldable)", threadID, folded, err)
	}
	if len(w.doc.GetItems()) != 1 {
		t.Fatalf("root item count = %d, want 1 (unchanged)", len(w.doc.GetItems()))
	}
}

// TestFoldConversationForCompactionSwallowsPriorSummary verifies the
// convergence invariant: a fold swallows an existing summarized compaction
// thread, so the root converges to a single fold thread instead of
// accumulating one summary per fold. The swallowed summary nests with its
// run-control flags dropped and its folded transcript kept, so earlier history
// stays browsable inside it.
func TestFoldConversationForCompactionSwallowsPriorSummary(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	priorSummaryID := generateItemID()
	freshUID := generateItemID()
	oldNested, err := json.Marshal([]ConversationItem{{Type: ItemTypeUser, ItemID: generateItemID(), Content: "ancient history"}})
	if err != nil {
		t.Fatal(err)
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{
			Type: ItemTypeThread, ItemID: priorSummaryID, Goal: "Compacted conversation history",
			BoundedCompaction: true, Result: json.RawMessage(`"earlier summary"`), Items: oldNested,
		})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: freshUID, Content: "new work"})})
	}, w.doc.authorID)

	threadID, folded, err := w.currentRun().foldConversationForCompaction(false)
	if err != nil || !folded {
		t.Fatalf("fold = (%q, %v, %v), want folded success", threadID, folded, err)
	}
	items := w.doc.GetItems()
	if len(items) != 1 || items[0].ItemID != threadID {
		t.Fatalf("root = %d items (%+v), want the single new fold thread", len(items), items)
	}
	nested := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))
	if len(nested) != 3 {
		t.Fatalf("nested item count = %d, want 3 (condensed prior summary + fresh user + prompt)", len(nested))
	}
	condensed := nested[0]
	if condensed.ItemID != priorSummaryID || !condensed.BoundedCompaction {
		t.Fatalf("nested[0] = %+v, want the condensed prior summary", condensed)
	}
	if got := threadResultString(condensed); got != "earlier summary" {
		t.Fatalf("condensed summary result = %q, want the prior summary text", got)
	}
	if !strings.Contains(string(condensed.Items), "ancient history") {
		t.Fatalf("condensed summary lost its folded transcript: %s", condensed.Items)
	}
	if condensed.NeedsStrategyRun || condensed.ForceTool != "" || condensed.CompactionPromptItemID != "" {
		t.Fatalf("condensed summary kept run-control flags: %+v", condensed)
	}
	if nested[1].ItemID != freshUID {
		t.Fatalf("nested[1] = %q, want the fresh user turn %q", nested[1].ItemID, freshUID)
	}
}

// TestFoldConversationForCompactionPinsPendingFold verifies that an in-flight
// unsummarized fold thread (no result yet) is pinned: the fold covers only the
// fresh history after it and never nests the pending fold.
func TestFoldConversationForCompactionPinsPendingFold(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	pendingID := generateItemID()
	freshUID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{
			Type: ItemTypeThread, ItemID: pendingID, Goal: "Compacted conversation history",
			BoundedCompaction: true, NeedsStrategyRun: true,
		})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: freshUID, Content: "new work"})})
	}, w.doc.authorID)

	threadID, folded, err := w.currentRun().foldConversationForCompaction(false)
	if err != nil || !folded {
		t.Fatalf("fold = (%q, %v, %v), want folded success", threadID, folded, err)
	}
	items := w.doc.GetItems()
	if len(items) != 2 || items[0].ItemID != pendingID || items[1].ItemID != threadID {
		t.Fatalf("root = %+v, want [untouched pending fold, new fold thread]", items)
	}
}

// TestFoldConversationForCompactionDeclinesSummaryOnly verifies a root whose
// only conversational content is an existing summarized compaction thread
// folds nothing — re-summarizing a lone summary gains no context.
func TestFoldConversationForCompactionDeclinesSummaryOnly(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)

	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "rule", ItemID: generateItemID(), Content: "a standing rule"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{
			Type: ItemTypeThread, ItemID: generateItemID(), Goal: "Compacted conversation history",
			BoundedCompaction: true, Result: json.RawMessage(`"earlier summary"`),
		})})
	}, w.doc.authorID)

	threadID, folded, err := w.currentRun().foldConversationForCompaction(false)
	if folded || err != nil || threadID != "" {
		t.Fatalf("fold = (%q, %v, %v), want no-op (nothing fresh to compact)", threadID, folded, err)
	}
	if len(w.doc.GetItems()) != 2 {
		t.Fatalf("root item count = %d, want unchanged", len(w.doc.GetItems()))
	}
}

// threadFlag reads a boolean field off a thread's Y.Map. GetThreadYMap takes
// ycrdtMu itself, so resolve the map first and hold the lock only across the
// field read.
func threadFlag(w *ConversationWorker, threadID, field string) bool {
	m := w.doc.GetThreadYMap(threadID)
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	v, _ := m.Get(field).(bool)
	return v
}

// threadResult reads a thread's committed summary, same locking rule.
func threadResult(w *ConversationWorker, threadID string) string {
	m := w.doc.GetThreadYMap(threadID)
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	v, _ := m.Get("result").(string)
	return v
}
