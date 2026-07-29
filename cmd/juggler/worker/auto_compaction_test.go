//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"

	ycrdt "github.com/skyterra/y-crdt"
)

// seedRootTurnWithAnchor pushes a leading rule plus a user/assistant turn stamped
// with txnID onto the root, and saves a transaction blob carrying inputTokens so
// the proactive trigger can read the anchored usage. Returns nothing; the caller
// drives maybeAutoCompactAtSettle.
func seedRootTurnWithAnchor(t *testing.T, w *ConversationWorker, txnID string, inputTokens int) {
	t.Helper()
	dir := t.TempDir()
	w.txnStore = NewTransactionStore(func(string) (string, bool) { return dir, true })
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "rule", ItemID: generateItemID(), Content: "a standing rule"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "do the thing", TransactionID: txnID})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "did the thing", TransactionID: txnID})})
	}, w.doc.authorID)
	if err := w.txnStore.SaveBlob(TransactionBlobInput{
		ConversationID: w.conversationID, TxnID: txnID,
		Response:  &LLMResponse{InputTokens: inputTokens},
		StartTime: time.Now(),
	}); err != nil {
		t.Fatalf("SaveBlob: %v", err)
	}
}

// TestMaybeAutoCompactAtSettleFoldsAndSummarizes drives the whole worker trigger:
// a 90%-of-window anchor folds the root and the existing pickup path summarizes
// the fold thread. It also pins self-termination — a second settle after the fold
// finds no root anchor and declines.
func TestMaybeAutoCompactAtSettleFoldsAndSummarizes(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.windowResolver = func(ModelConfig) (int, int) { return 10000, 1000 }
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"auto compact summary"}`)}}}, nil
	}
	seedRootTurnWithAnchor(t, w, "txnA", 9000)

	if !w.maybeAutoCompactAtSettle() {
		t.Fatal("maybeAutoCompactAtSettle = false, want a fold at 90% of window")
	}
	if w.autoCompactAnchorTxnID != "txnA" {
		t.Fatalf("debounce anchor = %q, want txnA", w.autoCompactAnchorTxnID)
	}
	items := w.doc.GetItems()
	if len(items) != 2 || items[1].Type != ItemTypeThread {
		t.Fatalf("root = %d items, want [rule, foldThread]", len(items))
	}
	// The pickup ran the fold thread through the summarizer.
	thread := w.doc.GetThreadYMap(items[1].ItemID)
	if got, _ := thread.Get("result").(string); got != "auto compact summary" {
		t.Fatalf("fold thread result = %q, want the summarizer output", got)
	}
	// Self-termination: the anchor moved into the thread, so a second settle finds
	// no root anchor and declines — the trigger cannot loop.
	if w.maybeAutoCompactAtSettle() {
		t.Fatal("second settle folded again; trigger must be self-terminating")
	}
}

// TestMaybeAutoCompactBelowThresholdDoesNotFold pins the negative case and the
// debounce: under-threshold usage records the anchor without folding.
func TestMaybeAutoCompactBelowThresholdDoesNotFold(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.windowResolver = func(ModelConfig) (int, int) { return 10000, 1000 }
	seedRootTurnWithAnchor(t, w, "txnB", 5000) // 50% — below threshold

	if w.maybeAutoCompactAtSettle() {
		t.Fatal("folded at 50% of window; expected no fold")
	}
	if w.autoCompactAnchorTxnID != "txnB" {
		t.Fatalf("debounce anchor = %q, want txnB recorded", w.autoCompactAnchorTxnID)
	}
	if len(w.doc.GetItems()) != 3 {
		t.Fatalf("root = %d items, want unchanged (rule + user + assistant)", len(w.doc.GetItems()))
	}
}

// TestMaybeAutoCompactDormantWithoutResolver pins that the trigger stays inert
// when no window resolver is wired (tests, or a model with no known window),
// even well above the threshold.
func TestMaybeAutoCompactDormantWithoutResolver(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	// No windowResolver set.
	seedRootTurnWithAnchor(t, w, "txnC", 9_000_000)

	if w.maybeAutoCompactAtSettle() {
		t.Fatal("folded without a window resolver; trigger must stay dormant")
	}
	if len(w.doc.GetItems()) != 3 {
		t.Fatalf("root = %d items, want unchanged", len(w.doc.GetItems()))
	}
}

// TestAutoCompactThresholdCrossed pins the proactive-fold decision (worker
// counterpart of the browser shouldAutoCompactInputUsage): fold at/above 85% of
// a known window, never with a non-positive numerator or denominator.
func TestAutoCompactThresholdCrossed(t *testing.T) {
	cases := []struct {
		anchored, window int
		want             bool
	}{
		{8500, 10000, true},  // exactly at threshold
		{9000, 10000, true},  // above
		{8400, 10000, false}, // below
		{9000, 0, false},     // unknown window
		{0, 10000, false},    // no anchor
		{-5, 10000, false},   // garbage anchor
	}
	for _, c := range cases {
		if got := autoCompactThresholdCrossed(c.anchored, c.window); got != c.want {
			t.Errorf("autoCompactThresholdCrossed(%d, %d) = %v, want %v", c.anchored, c.window, got, c.want)
		}
	}
}

// TestFoldConversationForCompactionBuildsUnsummarizedThread verifies the Go port
// of the browser /compact fold: the leading standing-context run stays at the
// parent, the conversational history is relocated into one unsummarized
// bounded-compaction thread carrying the /compact control flags, and the thread's
// nested items are the folded items plus the summarization prompt.
func TestFoldConversationForCompactionBuildsUnsummarizedThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)

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

	threadID, folded, err := w.foldConversationForCompaction(false)
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
	forceTool, _ := ymap.Get("forceTool").(string)
	result, _ := ymap.Get("result").(string)
	ycrdtMu.Unlock()
	if !needsRun || !noAutoSelect || !noContextSeed || forceTool != "return_result" {
		t.Fatalf("fold thread control flags wrong: needsRun=%v noAutoSelect=%v noContextSeed=%v forceTool=%q",
			needsRun, noAutoSelect, noContextSeed, forceTool)
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
	w.replyTo = clientID
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

// TestHandleCompactFoldsSummarizesAndAcks drives the /compact + /handoff worker
// op end-to-end: an idle worker folds on request, summarizes via the pickup, and
// acks {folded:true}.
func TestHandleCompactFoldsSummarizesAndAcks(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"command compact summary"}`)}}}, nil
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "rule", ItemID: generateItemID(), Content: "rule"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "hello"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "hi"})})
	}, w.doc.authorID)

	waitAck := captureAck(t, w, "client-1", "a1")
	w.handleCompact(json.RawMessage(`{"type":"compact","ackId":"a1"}`))

	ack := waitAck()
	result, _ := ack["result"].(map[string]any)
	if folded, _ := result["folded"].(bool); !folded {
		t.Fatalf("ack result = %v, want {folded:true}", result)
	}
	items := w.doc.GetItems()
	if len(items) != 2 || items[1].Type != ItemTypeThread {
		t.Fatalf("root = %d items, want [rule, foldThread]", len(items))
	}
	thread := w.doc.GetThreadYMap(items[1].ItemID)
	if got, _ := thread.Get("result").(string); got != "command compact summary" {
		t.Fatalf("fold thread result = %q, want the summarizer output", got)
	}
}

// TestHandleCompactBusyDeclines verifies the idle guard: a compact request while
// the worker is processing acks {folded:false} with a busy error and folds
// nothing.
func TestHandleCompactBusyDeclines(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "hello"})})
	}, w.doc.authorID)

	waitAck := captureAck(t, w, "client-1", "a2")
	w.handleCompact(json.RawMessage(`{"type":"compact","ackId":"a2"}`))

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
	w.storeState(StateIdle)

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

	threadID, folded, err := w.foldConversationForCompaction(false)
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
	w.storeState(StateIdle)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "rule", ItemID: generateItemID(), Content: "only a rule"})})
	}, w.doc.authorID)

	threadID, folded, err := w.foldConversationForCompaction(false)
	if folded || err != nil || threadID != "" {
		t.Fatalf("fold = (%q, %v, %v), want no-op (nothing foldable)", threadID, folded, err)
	}
	if len(w.doc.GetItems()) != 1 {
		t.Fatalf("root item count = %d, want 1 (unchanged)", len(w.doc.GetItems()))
	}
}

// TestFoldConversationForCompactionSkipsPriorSummary verifies the interior-pin
// clamp: an existing bounded-compaction summary is never re-swallowed, so a fold
// covers only the fresh history before it.
func TestFoldConversationForCompactionSkipsPriorSummary(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)

	priorSummaryID := generateItemID()
	freshUID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		// A prior completed compaction summary (non-foldable pin).
		summary := conversationItemToYMap(ConversationItem{
			Type: ItemTypeThread, ItemID: priorSummaryID, Goal: "Compacted conversation history",
			BoundedCompaction: true, Result: json.RawMessage(`"earlier summary"`),
		})
		arr.Push(ycrdt.ArrayAny{summary})
		// Fresh history after it.
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: freshUID, Content: "new work"})})
	}, w.doc.authorID)

	// The leading unit is the pinned prior summary, so skip advances past it and
	// the fold covers the fresh trailing user turn only.
	threadID, folded, err := w.foldConversationForCompaction(false)
	if err != nil || !folded {
		t.Fatalf("fold = (%q, %v, %v), want folded success", threadID, folded, err)
	}
	items := w.doc.GetItems()
	if len(items) != 2 {
		t.Fatalf("root item count = %d, want 2 (prior summary + new fold thread)", len(items))
	}
	if items[0].ItemID != priorSummaryID || !items[0].BoundedCompaction {
		t.Fatalf("root[0] = %+v, want the untouched prior summary", items[0])
	}
	if items[1].ItemID != threadID {
		t.Fatalf("root[1] id = %q, want new fold thread %q", items[1].ItemID, threadID)
	}
}
