//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	provider "juggler/cmd/juggler/providers/registry"

	ycrdt "github.com/skyterra/y-crdt"
)

func insertBoundedCompactionThread(t *testing.T, w *ConversationWorker, content string) string {
	t.Helper()
	threadID := generateItemID()
	promptID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		thread := conversationItemToYMap(ConversationItem{
			Type: ItemTypeThread, ItemID: threadID, Goal: "Compact",
			BoundedCompaction: true, CompactionPromptItemID: promptID,
		})
		thread.Set("noAutoSelect", true)
		thread.Set("forceTool", "return_result")
		items := ycrdt.NewYArray()
		items.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: content})})
		items.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: promptID, Content: "orchestration prompt"})})
		thread.Set("items", items)
		w.doc.ensureItems().Push(ycrdt.ArrayAny{thread})
	}, w.doc.authorID)
	w.thread.itemID = threadID
	w.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	return threadID
}

func TestBoundedCompactionMapsReducesAndPublishesOnlyFinalResult(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	threadID := insertBoundedCompactionThread(t, w, strings.Repeat("large history λ🙂 ", 500))

	const window int64 = 2400
	const reserve int64 = 300
	calls := 0
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		estimate := provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total
		if estimate+reserve > window {
			t.Fatalf("hidden request %d does not fit: %d + %d > %d", calls, estimate, reserve, window)
		}
		if len(req.Tools) > 0 {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"final compact summary"}`)}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}

	handled, err := w.tryBoundedCompaction(&provider.ContextLimitExceededError{
		EstimatedInputTokens: 5_000, OutputReserveTokens: reserve, ContextWindowTokens: window,
	}, &ModelConfig{Provider: "test", Model: "test"})
	if err != nil || !handled {
		t.Fatalf("tryBoundedCompaction = (%v, %v), want handled success", handled, err)
	}
	if calls < 2 || calls >= boundedCompactionMaxCalls {
		t.Fatalf("hidden calls = %d, want map(s) plus final within bound", calls)
	}
	thread := w.doc.GetThreadYMap(threadID)
	result, _ := thread.Get("result").(string)
	if result != "final compact summary" {
		t.Fatalf("thread result = %q", result)
	}
	items := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))
	if len(items) != 2 {
		t.Fatalf("visible nested items = %d, want original two only", len(items))
	}
}

func TestBoundedCompactionEighthPassFinalizationBoundary(t *testing.T) {
	for completed := 0; completed < boundedCompactionMaxPasses; completed++ {
		if !boundedCompactionCanReduce(completed) {
			t.Fatalf("reduction %d was rejected before the eighth pass", completed+1)
		}
	}
	if boundedCompactionCanReduce(boundedCompactionMaxPasses) {
		t.Fatal("ninth reduction was permitted; pass 8 must proceed only to final-fit check")
	}
}

func TestCanonicalCompactionSplitsUnicodeThroughPackPath(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	model := &ModelConfig{Provider: "test", Model: "test"}
	text := strings.Repeat("🙂界λ", 3000)
	budget := boundedCompactionBudget{window: 900, reserve: 100, maxSpend: 1 << 60}
	chunks, err := w.packCompactionChunks("thread", model, 0, []string{text}, &budget)
	if err != nil {
		t.Fatalf("packCompactionChunks: %v", err)
	}
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want giant Unicode input split", len(chunks))
	}
	for i, chunk := range chunks {
		if !utf8.ValidString(chunk) {
			t.Fatalf("chunk %d is invalid UTF-8", i)
		}
		if !budget.fits(w.hiddenCompactionRequest("thread", model, 0, i, chunk, false)) {
			t.Fatalf("chunk %d does not fit", i)
		}
	}
	if strings.Join(chunks, "") != text {
		t.Fatal("pack path did not preserve source text")
	}
}

func TestBoundedCompactionBudgetAllowsExactly64TotalAttempts(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	req := w.hiddenCompactionRequest("thread", &ModelConfig{Provider: "test", Model: "test"}, 0, 0, "x", false)
	budget := boundedCompactionBudget{window: 10_000, reserve: 7, maxSpend: 1 << 60, calls: 1, spend: 11}
	for attempt := 2; attempt <= boundedCompactionMaxCalls; attempt++ {
		if err := budget.plan(req, 1); err != nil {
			t.Fatalf("attempt %d rejected: %v", attempt, err)
		}
	}
	if budget.calls != 64 {
		t.Fatalf("calls = %d, want exactly 64 admitted attempts", budget.calls)
	}
	err := budget.plan(req, 1)
	var bounded *BoundedCompactionError
	if !errors.As(err, &bounded) || bounded.Reason != BoundedCompactionCallBound || bounded.Calls != 64 {
		t.Fatalf("65th attempt error = %#v, want call bound at 64", err)
	}
}

func TestBoundedCompactionSpendIncludesReserveBeforeDispatch(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	req := w.hiddenCompactionRequest("thread", &ModelConfig{Provider: "test", Model: "test"}, 0, 0, "payload", false)
	budget := boundedCompactionBudget{window: 10_000, reserve: 23, maxSpend: 1 << 60, calls: 1, spend: 101}
	want := saturatingAdd64(budget.spend, saturatingAdd64(budget.estimate(req), budget.reserve))
	if err := budget.plan(req, 1); err != nil {
		t.Fatal(err)
	}
	if budget.spend != want {
		t.Fatalf("spend = %d, want input plus reserve = %d", budget.spend, want)
	}
	budget.maxSpend = budget.spend
	beforeCalls, beforeSpend := budget.calls, budget.spend
	if err := budget.plan(req, 1); err == nil {
		t.Fatal("request exceeding spend bound was admitted")
	}
	if budget.calls != beforeCalls || budget.spend != beforeSpend {
		t.Fatalf("rejected request mutated budget to calls=%d spend=%d", budget.calls, budget.spend)
	}
}

func TestBoundedCompactionPinsRejectedRequestModel(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "changed", "model": "later"})
	insertBoundedCompactionThread(t, w, strings.Repeat("history ", 1000))
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls := 0
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if req.ModelConfig == nil || *req.ModelConfig != *pinned {
			t.Fatalf("hidden call %d model = %+v, want pinned %+v", calls, req.ModelConfig, pinned)
		}
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "changed-again", "model": "new-default"})
		if len(req.Tools) > 0 {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"done"}`)}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "short"}}}, nil
	}
	_, err := w.tryBoundedCompaction(&provider.ContextLimitExceededError{EstimatedInputTokens: 3_000, OutputReserveTokens: 300, ContextWindowTokens: 3000}, pinned)
	if err != nil {
		t.Fatal(err)
	}
	if calls < 2 {
		t.Fatalf("calls = %d, want map and final", calls)
	}
}

func TestCanonicalCompactionRecordsPreserveCompleteItemShape(t *testing.T) {
	prompt := ConversationItem{Type: ItemTypeUser, ItemID: "prompt", Content: "exclude me"}
	source := ConversationItem{
		Type: ItemTypeToolAction, ItemID: "item", Content: "content", Source: "source",
		Summary: "summary", Timestamp: "timestamp", ToolUseID: "tool-use", ToolName: "tool",
		ToolInput: json.RawMessage(`{"input":true}`), State: "complete",
		ApprovalOptions: json.RawMessage(`[{"option":"allow"}]`), DisplayData: json.RawMessage(`{"display":"value"}`),
		IsError: true, Data: json.RawMessage(`{"data":"value"}`), Cancelled: true,
		Result: json.RawMessage(`{"result":"value"}`), Goal: "goal", Items: json.RawMessage(`[{"type":"user","content":"nested"}]`),
		BoundedCompaction: true, CompactionPromptItemID: "nested-prompt", PreventUserDeletion: true,
		IsNew: true, Error: "error", TransactionID: "transaction",
		ProviderData: map[string]any{"opaque": "provider", "count": float64(2)},
		Attachments:  []AssetRef{{ID: "sha256", Mime: "image/webp", Filename: "original.webp", Bytes: 42, Width: 7, Height: 6}},
		TaskSource:   &TaskSourceRef{TaskID: "task", Label: "monitor"},
	}
	records, err := canonicalCompactionRecords([]ConversationItem{prompt, source}, prompt.ItemID)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("records = %d, want 1", len(records))
	}
	encoded := strings.TrimSuffix(strings.TrimPrefix(records[0], "<record>"), "</record>")
	var decoded canonicalCompactionRecord
	if err := json.Unmarshal([]byte(encoded), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Index != 1 {
		t.Fatalf("stable index = %d, want 1", decoded.Index)
	}
	if !reflect.DeepEqual(decoded.Item, source) {
		t.Fatalf("decoded item lost source fields:\n got: %#v\nwant: %#v", decoded.Item, source)
	}
}

func TestCanonicalCompactionRecordsFailClosedOnMarshalError(t *testing.T) {
	items := []ConversationItem{{
		Type: ItemTypeAssistant, ItemID: "bad", ProviderData: map[string]any{"invalid": math.NaN()},
	}}
	records, err := canonicalCompactionRecords(items, "prompt")
	if err == nil {
		t.Fatal("marshal failure was silently accepted")
	}
	if records != nil {
		t.Fatalf("records = %#v, want nil on marshal failure", records)
	}
	if !strings.Contains(err.Error(), `item 0 ("bad")`) {
		t.Fatalf("error = %q, want item identity", err)
	}
}

func TestLegacyCompactionPromptDoesNotDropLaterUserItem(t *testing.T) {
	items := []ConversationItem{
		{Type: ItemTypeUser, ItemID: "source", Content: "original request"},
		{Type: ItemTypeUser, ItemID: "prompt", Content: defaultSummarizationPromptMarker + " rest of known prompt"},
		{Type: ItemTypeUser, ItemID: "later", Content: "real later user request"},
	}
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	id, safe := w.resolveCompactionPromptItemID("missing", items)
	if !safe || id != "prompt" {
		t.Fatalf("legacy prompt = (%q, %v), want provable prompt", id, safe)
	}
	recordSlice, err := canonicalCompactionRecords(items, id)
	if err != nil {
		t.Fatal(err)
	}
	records := strings.Join(recordSlice, "\n")
	if strings.Contains(records, "known prompt") || !strings.Contains(records, "real later user request") {
		t.Fatalf("canonical records omitted wrong item: %s", records)
	}
	items[1].Content = "summarize this maybe"
	if _, safe := w.resolveCompactionPromptItemID("missing", items); safe {
		t.Fatal("unprovable legacy prompt was accepted")
	}
}

func TestBoundedCompactionRejectsNonConvergence(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	insertBoundedCompactionThread(t, w, strings.Repeat("source ", 2000))
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		_ = json.Unmarshal(raw, &req)
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: strings.Repeat("expanded ", 3000)}}}, nil
	}
	_, err := w.tryBoundedCompaction(&provider.ContextLimitExceededError{OutputReserveTokens: 200, ContextWindowTokens: 1800}, &ModelConfig{Provider: "test", Model: "test"})
	if err == nil || !strings.Contains(err.Error(), "no progress") {
		t.Fatalf("error = %v, want no progress", err)
	}
}

func TestBoundedCompactionCancellationPublishesNothing(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	threadID := insertBoundedCompactionThread(t, w, strings.Repeat("source ", 2000))
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		w.storeState(StateCancelling)
		return nil, context.Canceled
	}
	_, err := w.tryBoundedCompaction(&provider.ContextLimitExceededError{OutputReserveTokens: 200, ContextWindowTokens: 1800}, &ModelConfig{Provider: "test", Model: "test"})
	if !errors.Is(err, errBoundedCompactionCancelled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	result, _ := w.doc.GetThreadYMap(threadID).Get("result").(string)
	if result != "" {
		t.Fatalf("partial result was published: %q", result)
	}
}

func TestBoundedCompactionDoesNotHandleRoot(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	handled, err := w.tryBoundedCompaction(&provider.ContextLimitExceededError{ContextWindowTokens: 100}, &ModelConfig{Provider: "test", Model: "test"})
	if handled || err != nil {
		t.Fatalf("root fallback = (%v, %v), want (false, nil)", handled, err)
	}
}

type compactionAdmissionProvider struct {
	name         string
	conversation *compactionAdmissionConversation
}

func (p *compactionAdmissionProvider) Name() string { return p.name }
func (p *compactionAdmissionProvider) ListModelsWithInfo(context.Context) ([]provider.ModelInfo, error) {
	return nil, nil
}
func (p *compactionAdmissionProvider) OpenConversation(context.Context, string) (provider.Conversation, error) {
	return p.conversation, nil
}

type compactionAdmissionConversation struct {
	submits   int
	threadIDs []string
}

func (cv *compactionAdmissionConversation) Submit(_ context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	cv.submits++
	cv.threadIDs = append(cv.threadIDs, req.ThreadID)
	chunks := []provider.StreamChunk{
		{Type: provider.ContentBlockTypeText, Content: "hidden text"},
		{Type: provider.ContentBlockTypeThinking, Content: "hidden thinking"},
		{Type: provider.ContentBlockTypeStatus, Content: "hidden status"},
		{Type: provider.ContentBlockTypeToolUse, ToolUseID: "hidden-tool", ToolName: "must-not-execute", ToolInput: map[string]any{"value": true}},
	}
	for _, chunk := range chunks {
		result, err := callback(chunk)
		if err != nil {
			return nil, err
		}
		if result != nil {
			return nil, errors.New("hidden stream callback executed a tool")
		}
	}
	return &provider.StreamResult{StopReason: "end_turn"}, nil
}
func (cv *compactionAdmissionConversation) Subscribe(provider.TurnSink) {}
func (cv *compactionAdmissionConversation) CacheTTL() time.Duration     { return 0 }
func (cv *compactionAdmissionConversation) Cancel()                     {}
func (cv *compactionAdmissionConversation) Close() error                { return nil }

func openCompactionAdmissionConversation(t *testing.T, window, reserve int64) (*compactionAdmissionConversation, provider.Conversation) {
	t.Helper()
	underlying := &compactionAdmissionConversation{}
	name := "compaction-admission-" + generateRequestID()
	provider.RegisterProvider(provider.ProviderInfo{Name: name}, func(provider.Config) (provider.Provider, error) {
		return &compactionAdmissionProvider{name: name, conversation: underlying}, nil
	})
	initialized, err := provider.InitializeProvider(name, provider.Config{
		ModelCapabilities: provider.ModelCapabilities{ContextWindowTokens: window},
		BudgetContract:    provider.BudgetContract{OutputReserveTokens: reserve},
	})
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := initialized.OpenConversation(context.Background(), "test-conv")
	if err != nil {
		t.Fatal(err)
	}
	return underlying, conversation
}

func TestHiddenCompactionUsesRegistryAdmissionAndDiscardsAllStreamChunks(t *testing.T) {
	const window int64 = 2400
	const reserve int64 = 300
	underlying, conversation := openCompactionAdmissionConversation(t, window, reserve)
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	threadID := insertBoundedCompactionThread(t, w, strings.Repeat("large history λ🙂 ", 500))
	originalItems := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))
	w.llmCallFunc = func(ctx context.Context, raw json.RawMessage, callback func(StreamChunk)) (*LLMResponse, error) {
		var hidden hiddenLLMRequest
		if err := json.Unmarshal(raw, &hidden); err != nil {
			return nil, err
		}
		_, err := conversation.Submit(ctx, providerRequest(hidden), func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
			callback(StreamChunk{Type: chunk.Type, Content: chunk.Content})
			return nil, nil
		})
		if err != nil {
			return nil, err
		}
		if len(hidden.Tools) > 0 {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"admitted final"}`)}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "short"}}}, nil
	}

	handled, err := w.tryBoundedCompaction(&provider.ContextLimitExceededError{
		EstimatedInputTokens: 5_000, OutputReserveTokens: reserve, ContextWindowTokens: window,
	}, &ModelConfig{Provider: "test", Model: "test"})
	if err != nil || !handled {
		t.Fatalf("tryBoundedCompaction = (%v, %v), want handled success", handled, err)
	}
	if underlying.submits < 2 {
		t.Fatalf("underlying submits = %d, want every map and final dispatch admitted", underlying.submits)
	}
	seen := make(map[string]bool, len(underlying.threadIDs))
	for _, hiddenThreadID := range underlying.threadIDs {
		if hiddenThreadID == threadID || seen[hiddenThreadID] {
			t.Fatalf("hidden thread ID %q reused visible or prior hidden ID", hiddenThreadID)
		}
		seen[hiddenThreadID] = true
	}
	items := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))
	if len(items) != len(originalItems) {
		t.Fatalf("streaming callbacks created visible items: got %d, want %d", len(items), len(originalItems))
	}

	rejectedUnderlying, rejected := openCompactionAdmissionConversation(t, 100, 20)
	oversized := provider.MessageRequest{Messages: []provider.Message{{Type: "user", Content: strings.Repeat("oversized ", 1000)}}}
	_, err = rejected.Submit(context.Background(), oversized, func(provider.StreamChunk) (*provider.ToolResult, error) {
		t.Fatal("rejected request invoked callback")
		return nil, nil
	})
	var exceeded *provider.ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("oversized error = %T %v, want ContextLimitExceededError", err, err)
	}
	if rejectedUnderlying.submits != 0 {
		t.Fatalf("oversized probe reached underlying Submit %d times", rejectedUnderlying.submits)
	}
}

func TestCompactionResponseTextReturnResultPrecedenceAndFallback(t *testing.T) {
	tests := []struct {
		name   string
		blocks []LLMResponseBlock
		want   string
	}{
		{name: "valid result wins over text", blocks: []LLMResponseBlock{
			{Type: provider.ContentBlockTypeText, Content: "fallback"},
			{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"tool result"}`)},
		}, want: "tool result"},
		{name: "malformed result falls back", blocks: []LLMResponseBlock{
			{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":`)},
			{Type: provider.ContentBlockTypeText, Content: "fallback"},
		}, want: "fallback"},
		{name: "empty result falls back", blocks: []LLMResponseBlock{
			{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"  "}`)},
			{Type: provider.ContentBlockTypeText, Content: "first "},
			{Type: provider.ContentBlockTypeThinking, Content: "ignored"},
			{Type: provider.ContentBlockTypeText, Content: "second"},
		}, want: "first second"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := compactionResponseText(&LLMResponse{Blocks: test.blocks}); got != test.want {
				t.Fatalf("compactionResponseText = %q, want %q", got, test.want)
			}
		})
	}
}

func TestBoundedCompactionFinalWriteMergesWithFoldUndoGroup(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()
	w.tracker.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "history", Content: "keep me"})
	w.tracker.StopCapturing()
	threadID := insertBoundedCompactionThread(t, w, "source")
	mergeFrom := w.tracker.UndoStackLen() - 1
	if mergeFrom < 1 {
		t.Fatalf("fold undo index = %d, want group after history", mergeFrom)
	}
	w.tracker.StopCapturing()
	if !w.writeBoundedCompactionResult(threadID, "final result") {
		t.Fatal("final result was not written")
	}
	if got, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); got != "final result" {
		t.Fatalf("thread result = %q", got)
	}
	if w.tracker.UndoStackLen() <= mergeFrom+1 {
		t.Fatal("final result write was not tracked as a compaction merge entry")
	}
	w.tracker.MergeFromIndex(mergeFrom)
	if !w.tracker.Undo() {
		t.Fatal("merged compaction group was not undoable")
	}
	items := w.doc.GetItems()
	if len(items) != 1 || items[0].ItemID != "history" {
		t.Fatalf("single undo items = %+v, want pre-fold history only", items)
	}
}
