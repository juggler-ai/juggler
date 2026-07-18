//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"

	ycrdt "github.com/skyterra/y-crdt"
)

// recoveryLimitErr builds the admission rejection the orchestrator consumes:
// a 4000-token window, 300 reserve, and a breakdown whose fixed envelope
// (Total - MessageTokens - ImageTokens) is 200 tokens.
func recoveryLimitErr() *provider.ContextLimitExceededError {
	return &provider.ContextLimitExceededError{
		EstimatedInputTokens: 6_200,
		OutputReserveTokens:  300,
		ContextWindowTokens:  4_000,
		Breakdown: provider.RequestTokenEstimate{
			Total: 6_200, MessageTokens: 6_000, ProviderOverheadTokens: 50,
		},
	}
}

func recoveryTestItems() []ConversationItem {
	items := make([]ConversationItem, 0, 7)
	for i := 0; i < 4; i++ {
		items = append(items, ConversationItem{
			Type: ItemTypeUser, ItemID: fmt.Sprintf("old-%d", i),
			Content: strings.Repeat("x", 2600),
		})
	}
	for i := 0; i < 3; i++ {
		items = append(items, ConversationItem{
			Type: ItemTypeUser, ItemID: fmt.Sprintf("recent-%d", i),
			Content: fmt.Sprintf("recent question %c", 'A'+i),
		})
	}
	return items
}

// newRecoveryStub records hidden calls, asserts every hidden request fits the
// full window (the orchestrator's reduced window is stricter still), pins the
// rejected request's model, and returns a fixed final summary.
func newRecoveryStub(t *testing.T, pinned *ModelConfig) (*int, func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error)) {
	t.Helper()
	calls := new(int)
	return calls, func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		*calls++
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if req.ModelConfig == nil || *req.ModelConfig != *pinned {
			t.Fatalf("hidden call %d model = %+v, want pinned %+v", *calls, req.ModelConfig, pinned)
		}
		estimate := provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total
		if estimate+300 > 4_000 {
			t.Fatalf("hidden request %d does not fit: %d + 300 > 4000", *calls, estimate)
		}
		if len(req.Tools) > 0 {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"recovered prefix summary"}`)}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}
}

func TestContextRecoveryFoldsRootPrefixPreservesSuffix(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if err := w.tryContextRecovery(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}
	if *calls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", *calls)
	}

	items := w.doc.GetItems()
	if len(items) != 5 {
		t.Fatalf("items after fold = %d, want summary plus four verbatim suffix items", len(items))
	}
	folded := items[0]
	if folded.Type != ItemTypeCompactionSummary {
		t.Fatalf("items[0].Type = %q, want %q", folded.Type, ItemTypeCompactionSummary)
	}
	if folded.Content != "recovered prefix summary" {
		t.Fatalf("folded content = %q", folded.Content)
	}
	if !strings.Contains(folded.Summary, "3 earlier items") {
		t.Fatalf("folded summary line = %q, want the folded prefix count", folded.Summary)
	}
	wantIDs := []string{"old-3", "recent-0", "recent-1", "recent-2"}
	for i, want := range wantIDs {
		if items[i+1].ItemID != want {
			t.Fatalf("items[%d].ItemID = %q, want verbatim suffix item %q", i+1, items[i+1].ItemID, want)
		}
	}
}

func TestContextRecoveryFoldsSubthreadPrefix(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	threadID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		thread := conversationItemToYMap(ConversationItem{Type: ItemTypeThread, ItemID: threadID, Goal: "Research"})
		thread.Set("items", ycrdt.NewYArray())
		w.doc.ensureItems().Push(ycrdt.ArrayAny{thread})
	}, w.doc.authorID)
	arr := w.doc.GetThreadItemsArray(threadID)
	w.doc.InsertMessageIntoArray(arr, 0, recoveryTestItems()...)
	w.thread.itemID = threadID
	w.thread.itemsArray = arr

	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if err := w.tryContextRecovery(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}
	if *calls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", *calls)
	}

	root := w.doc.GetItems()
	if len(root) != 1 || root[0].ItemID != threadID {
		t.Fatalf("root items = %+v, want only the untouched thread item", root)
	}
	items := w.doc.GetItemsFromArray(arr)
	if len(items) != 5 || items[0].Type != ItemTypeCompactionSummary {
		t.Fatalf("nested items after fold = %d (first %q), want summary plus four suffix items", len(items), items[0].Type)
	}
	wantIDs := []string{"old-3", "recent-0", "recent-1", "recent-2"}
	for i, want := range wantIDs {
		if items[i+1].ItemID != want {
			t.Fatalf("nested items[%d].ItemID = %q, want %q", i+1, items[i+1].ItemID, want)
		}
	}
}

func recoveryToolBatch(txnID string, resultRunes int) []ConversationItem {
	batch := make([]ConversationItem, 2)
	for i := range batch {
		result, _ := json.Marshal(map[string]any{"content": strings.Repeat("r", resultRunes), "isError": false})
		batch[i] = ConversationItem{
			Type: ItemTypeToolAction, ItemID: fmt.Sprintf("%s-%d", txnID, i),
			ToolUseID: fmt.Sprintf("toolu_%s_%d", txnID, i), ToolName: "read_file",
			State: StateCompleted, Result: result, TransactionID: txnID,
		}
	}
	return batch
}

func TestContextRecoveryKeepsToolBatchAtomic(t *testing.T) {
	pinned := &ModelConfig{Provider: "test", Model: "test"}

	t.Run("batch too large for suffix folds whole", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.storeState(StateProcessing)
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

		items := recoveryTestItems()[:4] // four big old items
		items = append(items, recoveryToolBatch("txn-big", 2600)...)
		items = append(items, ConversationItem{Type: ItemTypeUser, ItemID: "latest", Content: "latest question"})
		w.doc.InsertMessage(0, items...)
		calls, stub := newRecoveryStub(t, pinned)
		w.llmCallFunc = stub

		if err := w.tryContextRecovery(recoveryLimitErr(), pinned); err != nil {
			t.Fatal(err)
		}
		if *calls < 2 {
			t.Fatalf("hidden calls = %d, want map(s) plus final", *calls)
		}
		got := w.doc.GetItems()
		if len(got) != 2 || got[0].Type != ItemTypeCompactionSummary || got[1].ItemID != "latest" {
			t.Fatalf("items = %d (%v ...), want whole batch folded and only the latest message kept", len(got), got[0].Type)
		}
	})

	t.Run("batch fitting suffix stays whole and verbatim", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.storeState(StateProcessing)
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

		items := recoveryTestItems()[:4]
		items = append(items, recoveryToolBatch("txn-small", 200)...)
		items = append(items, ConversationItem{Type: ItemTypeUser, ItemID: "latest", Content: "latest question"})
		w.doc.InsertMessage(0, items...)
		calls, stub := newRecoveryStub(t, pinned)
		w.llmCallFunc = stub

		if err := w.tryContextRecovery(recoveryLimitErr(), pinned); err != nil {
			t.Fatal(err)
		}
		if *calls < 2 {
			t.Fatalf("hidden calls = %d, want map(s) plus final", *calls)
		}
		got := w.doc.GetItems()
		if len(got) != 4 || got[0].Type != ItemTypeCompactionSummary {
			t.Fatalf("items = %d, want summary plus whole batch plus latest message", len(got))
		}
		wantIDs := []string{"txn-small-0", "txn-small-1", "latest"}
		for i, want := range wantIDs {
			if got[i+1].ItemID != want {
				t.Fatalf("items[%d].ItemID = %q, want %q", i+1, got[i+1].ItemID, want)
			}
		}
	})
}

func TestContextRecoveryAbortsWhenSourceChanges(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}

	edited := false
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if len(req.Tools) == 0 && !edited {
			edited = true
			// A concurrent edit lands mid-reduce: the fold must not commit.
			w.doc.InsertMessage(w.doc.GetItemsLength(), ConversationItem{Type: ItemTypeUser, ItemID: "concurrent-edit", Content: "edited while summarizing"})
		}
		if len(req.Tools) > 0 {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"stale summary"}`)}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}

	err := w.tryContextRecovery(recoveryLimitErr(), pinned)
	var bounded *BoundedCompactionError
	if !errors.As(err, &bounded) || bounded.Reason != BoundedCompactionSourceChanged {
		t.Fatalf("error = %#v, want source_changed", err)
	}
	items := w.doc.GetItems()
	if len(items) != 8 {
		t.Fatalf("items = %d, want original seven plus the concurrent edit (no fold)", len(items))
	}
	for _, item := range items {
		if item.Type == ItemTypeCompactionSummary {
			t.Fatal("a compaction summary was committed despite the source change")
		}
	}
}

func TestContextRecoveryTerminalWhenNewestItemAloneExceeds(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0,
		ConversationItem{Type: ItemTypeUser, ItemID: "old-0", Content: "small old question"},
		ConversationItem{Type: ItemTypeUser, ItemID: "giant", Content: strings.Repeat("x", 25_000)},
	)
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	err := w.tryContextRecovery(recoveryLimitErr(), pinned)
	var bounded *BoundedCompactionError
	if !errors.As(err, &bounded) || bounded.Reason != BoundedCompactionContextBound {
		t.Fatalf("error = %#v, want context_bound", err)
	}
	if *calls != 0 {
		t.Fatalf("hidden calls = %d, want none for an unrecoverable suffix", *calls)
	}
	if items := w.doc.GetItems(); len(items) != 2 {
		t.Fatalf("items = %d, want the untouched original two", len(items))
	}
}

func TestContextRecoveryCancelledMidReduce(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}

	calls := 0
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		w.storeState(StateCancelling)
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}

	err := w.tryContextRecovery(recoveryLimitErr(), pinned)
	if !errors.Is(err, errBoundedCompactionCancelled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	var cancelled *BoundedCompactionCancelledError
	if !errors.As(err, &cancelled) || cancelled.Result.Calls == 0 {
		t.Fatalf("error = %#v, want partial accounting on the cancellation", err)
	}
	if items := w.doc.GetItems(); len(items) != 7 {
		t.Fatalf("items = %d, want the untouched original seven after cancellation", len(items))
	}
}

func TestContextRecoveryPinsLeadingContextItems(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	items := []ConversationItem{{Type: "rule", ItemID: "rule-0", Content: "always answer tersely"}}
	items = append(items, recoveryTestItems()...)
	w.doc.InsertMessage(0, items...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if err := w.tryContextRecovery(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}
	if *calls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", *calls)
	}
	got := w.doc.GetItems()
	if len(got) != 6 {
		t.Fatalf("items = %d, want pinned rule plus summary plus four suffix items", len(got))
	}
	if got[0].ItemID != "rule-0" {
		t.Fatalf("items[0] = %q, want the pinned rule item untouched", got[0].ItemID)
	}
	if got[1].Type != ItemTypeCompactionSummary {
		t.Fatalf("items[1].Type = %q, want the summary inserted after the pinned run", got[1].Type)
	}
	if !strings.Contains(got[1].Summary, "3 earlier items") {
		t.Fatalf("folded summary line = %q, want only the three foldable old items counted", got[1].Summary)
	}
}

// TestContextRecoveryRetriesRejectedTurnOnce drives the full strategy loop:
// the first real request is rejected admission-style, recovery folds the old
// history into the doc, and the loop retries the same turn — which now fits
// and completes, exactly once.
func TestContextRecoveryRetriesRejectedTurnOnce(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Four oversized old items; the turn's own user message lands after them.
	w.doc.InsertMessage(0, recoveryTestItems()[:4]...)

	// Feed context/tools for the initial and retried turns (hidden recovery
	// calls do not consume these).
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			select {
			case <-w.done:
				return
			case w.contextResultChan <- ctxResp:
			}
			select {
			case <-w.done:
				return
			case w.toolsResultChan <- toolsResp:
			}
		}
	}()

	realCalls, hiddenCalls := 0, 0
	firstTurnMessages, retriedTurnMessages := -1, -1
	retriedFit := false
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			hiddenCalls++
			if len(req.Tools) > 0 {
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"recovered prefix summary"}`)}}}, nil
			}
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
		}
		realCalls++
		if realCalls == 1 {
			firstTurnMessages = len(req.Messages)
			return nil, recoveryLimitErr()
		}
		retriedTurnMessages = len(req.Messages)
		estimate := provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total
		retriedFit = estimate+300 <= 4_000
		// Visible turns assemble the assistant message from streamed chunks;
		// mirror the provider's stream before delivering the final response.
		sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: "recovered answer"})
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "recovered answer"}},
			StopReason: "end_turn",
		}, nil
	}

	w.runStrategyLoop("Hello", false)

	if realCalls != 2 {
		t.Fatalf("real calls = %d, want the rejected attempt plus exactly one retry", realCalls)
	}
	if hiddenCalls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", hiddenCalls)
	}
	if firstTurnMessages != 5 || retriedTurnMessages != 3 {
		t.Fatalf("turn messages %d -> %d, want 5 rejected, 3 after the fold", firstTurnMessages, retriedTurnMessages)
	}
	if !retriedFit {
		t.Fatal("retried request still exceeds the model context window after the fold")
	}

	items := w.doc.GetItems()
	var summaries, assistants int
	for _, item := range items {
		switch item.Type {
		case ItemTypeCompactionSummary:
			summaries++
			if item.Content != "recovered prefix summary" {
				t.Fatalf("summary content = %q", item.Content)
			}
		case ItemTypeAssistant:
			assistants++
			if item.Content != "recovered answer" {
				t.Fatalf("assistant content = %q", item.Content)
			}
		case ItemTypeError:
			t.Fatalf("unexpected error item after recovery: %q", item.Content)
		}
	}
	if summaries != 1 || assistants != 1 {
		t.Fatalf("items have %d summaries and %d assistants, want exactly one of each", summaries, assistants)
	}
}
