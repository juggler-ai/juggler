//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside compaction_observe_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

func feedStrategyContextAndTools(w *ConversationWorker) {
	ctxResp, _ := json.Marshal(map[string]any{
		"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
	})
	toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
	for {
		if !w.engine.contextReply.inject(w.done, ctxResp) {
			return
		}
		if !w.engine.toolsReply.inject(w.done, toolsResp) {
			return
		}
	}
}

// TestContextGuardRecoveryRetryDispatchesBypassed pins the post-fold contract:
// a fold invalidates the measured-prefix anchor, so re-entering guarded
// admission would judge the compacted history with the raw character estimator
// — the same overcounting that fires spurious triggers, and the engine of the
// old fold/advise/fold loop. The retry after structural progress therefore
// dispatches with the guard bypassed and the provider is the judge: its billed
// count re-anchors admission, or its rejection re-enters recovery.
func TestContextGuardRecoveryRetryDispatchesBypassed(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	go feedStrategyContextAndTools(w)

	visibleCalls, hiddenCalls := 0, 0
	retryBypassed := false
	w.SetLLMCaller(func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			hiddenCalls++
			if !req.BypassContextGuard {
				t.Fatal("hidden recovery request did not bypass guard")
			}
			if isCompactionFinalRequest(req) {
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "guard recovery summary"}}}, nil
			}
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "short"}}}, nil
		}
		visibleCalls++
		if visibleCalls == 1 {
			if req.BypassContextGuard {
				t.Fatal("initial guarded request bypassed")
			}
			limit := recoveryLimitErr()
			return nil, &provider.ContextCompactionAdvisory{
				EstimatedInputTokens: limit.EstimatedInputTokens, OutputReserveTokens: limit.OutputReserveTokens,
				ContextWindowTokens: limit.ContextWindowTokens, Breakdown: limit.Breakdown,
			}
		}
		retryBypassed = req.BypassContextGuard
		// Bypassed, but still this thread's real transcript: marking it synthetic
		// would silence the measurement recovery dispatched it to obtain.
		if req.SyntheticTranscript {
			t.Fatal("the bypassed retry was marked synthetic, so the dispatch recovery relies on can no longer re-anchor admission")
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered"}}, StopReason: "end_turn"}, nil
	})

	w.driveStrategyLoop(t, "latest question", false)
	if visibleCalls != 2 || hiddenCalls == 0 {
		t.Fatalf("visible/hidden calls = %d/%d, want 2 and at least 1", visibleCalls, hiddenCalls)
	}
	if !retryBypassed {
		t.Fatal("post-fold retry re-entered guarded admission; it must dispatch bypassed for a measured verdict")
	}
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeError {
			t.Fatalf("advisory escaped as terminal error: %q", item.Content)
		}
	}
}

// The contract handleContextOverflow states in prose twice — "an accepted
// dispatch re-anchors admission with its billed count" — driven through real
// admission rather than a stubbed advisory.
//
// Without it a conversation that has no anchor can never get one: the character
// estimator overcounts a real transcript by half again or more, so every
// dispatch is advised, so every dispatch is bypassed, so none of them is
// allowed to measure anything. The silent-truncation guard switches itself off
// and stays off for the rest of the session.
func TestContextGuardBypassedRetryReanchorsAdmission(t *testing.T) {
	const window, reserve, billed = int64(20_000), int64(2_000), 3_000
	underlying, conversation := openCompactionAdmissionConversation(t, window, reserve)
	underlying.scripted = func(_ provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
		if _, err := callback(provider.StreamChunk{Type: provider.ContentBlockTypeText, Content: "answer"}); err != nil {
			return nil, err
		}
		// What the provider really bills: a small fraction of what the estimator
		// claimed for the same messages.
		return &provider.StreamResult{StopReason: "end_turn", InputTokens: billed}, nil
	}

	// Size the opening turn by measuring rather than guessing: over the soft
	// ceiling, so admission advises, but inside the window, so the ladder's
	// verdict is one bypassed dispatch for a measured verdict rather than a fold.
	// The margin is deliberate — the second turn appends a reply and a short
	// question to this transcript, and unanchored it has to stay clearly over the
	// ceiling, or it would fit by accident and prove nothing.
	budget := provider.ContextCeiling(window, 0) - reserve
	var prompt strings.Builder
	for provider.EstimateMessageRequestTokens(provider.MessageRequest{
		SystemPrompt: "sys",
		Messages:     []provider.Message{{Type: ItemTypeUser, Content: prompt.String()}},
	}) <= budget+budget/10 {
		prompt.WriteString(strings.Repeat("the quick brown fox jumps over the lazy dog. ", 25))
	}

	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	go feedStrategyContextAndTools(w)

	advisories := 0
	var admitted []*provider.StreamResult
	var wholeRequestEstimates []int64
	w.SetLLMCaller(func(ctx context.Context, raw json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		result, err := conversation.Submit(ctx, providerRequest(req), func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
			sink(StreamChunk{Type: chunk.Type, Content: chunk.Content})
			return nil, nil
		})
		if err != nil {
			var advisory *provider.ContextCompactionAdvisory
			if errors.As(err, &advisory) {
				advisories++
			}
			return nil, err
		}
		admitted = append(admitted, result)
		// What the same request would have been judged at with no anchor to
		// project from — the number that decides whether this test has teeth.
		wholeRequestEstimates = append(wholeRequestEstimates, provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total)
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "answer"}}, StopReason: "end_turn"}, nil
	})

	w.driveStrategyLoop(t, prompt.String(), false)
	if advisories != 1 || len(admitted) != 1 {
		t.Fatalf("first turn = %d advisories, %d admitted dispatches, want one of each", advisories, len(admitted))
	}

	w.currentRun().storeState(StateProcessing)
	w.driveStrategyLoop(t, "and again", false)
	if advisories != 1 {
		t.Fatalf("advisories = %d: the turn after the bypassed dispatch was advised again, so admission never learned what the provider billed", advisories)
	}
	if len(admitted) != 2 || !admitted[1].AdmissionAnchored {
		t.Fatalf("second turn = %d admitted dispatches, anchored=%v, want one dispatch projected from the measurement", len(admitted)-1, len(admitted) == 2 && admitted[1].AdmissionAnchored)
	}
	if int64(admitted[1].AdmissionEstimateTokens) > billed*2 {
		t.Fatalf("projection %d is still the estimator's view of the whole transcript, not the provider's %d-token count", admitted[1].AdmissionEstimateTokens, billed)
	}
	// The second turn cleared the ceiling only because it was projected from the
	// measurement. Estimated whole, as an unanchored conversation must be, it is
	// over — which is what makes the assertions above worth making.
	if wholeRequestEstimates[1] <= budget {
		t.Fatalf("the second turn estimates %d against a %d budget, so it would have been admitted with or without an anchor", wholeRequestEstimates[1], budget)
	}
}

func TestContextGuardIrreducibleFallbackIsSingleDispatchAndResets(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	go feedStrategyContextAndTools(w)

	calls := 0
	w.SetLLMCaller(func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		if calls == 1 {
			if req.BypassContextGuard {
				t.Fatal("initial guarded request bypassed")
			}
			limit := recoveryLimitErr()
			return nil, &provider.ContextCompactionAdvisory{
				EstimatedInputTokens: limit.EstimatedInputTokens, OutputReserveTokens: limit.OutputReserveTokens,
				ContextWindowTokens: limit.ContextWindowTokens, Breakdown: limit.Breakdown,
			}
		}
		if calls == 2 {
			if !req.BypassContextGuard {
				t.Fatal("irreducible fallback was not marked")
			}
			// A successful but barren fallback drives another strategy iteration;
			// that next visible request must return to normal guarded admission.
			return &LLMResponse{StopReason: "end_turn"}, nil
		}
		if req.BypassContextGuard {
			t.Fatal("fallback bypass was not reset after successful dispatch")
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "next turn success"}}, StopReason: "end_turn"}, nil
	})

	w.driveStrategyLoop(t, strings.Repeat("x", 25_000), false)
	if calls != 3 {
		t.Fatalf("visible calls = %d, want advisory, one fallback, and one normally guarded next turn", calls)
	}
	request := w.currentRun().buildLLMRequest(&ContextResult{}, nil, "after-success", false)
	var rebuilt hiddenLLMRequest
	if err := json.Unmarshal(request, &rebuilt); err != nil {
		t.Fatal(err)
	}
	if rebuilt.BypassContextGuard {
		t.Fatal("context guard fallback leaked after successful visible dispatch")
	}
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeError {
			t.Fatalf("advisory created error item: %q", item.Content)
		}
	}
}

func TestContextGuardRepeatedAdvisoryAfterBypassStopsWithoutErrorItem(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	go feedStrategyContextAndTools(w)

	calls := 0
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		limit := recoveryLimitErr()
		return nil, &provider.ContextCompactionAdvisory{
			EstimatedInputTokens: limit.EstimatedInputTokens, OutputReserveTokens: limit.OutputReserveTokens,
			ContextWindowTokens: limit.ContextWindowTokens, Breakdown: limit.Breakdown,
		}
	})
	w.driveStrategyLoop(t, strings.Repeat("x", 25_000), false)
	if calls != 2 {
		t.Fatalf("calls = %d, want initial advisory plus one bounded fallback", calls)
	}
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeError {
			t.Fatalf("repeated advisory reached terminal error item: %q", item.Content)
		}
	}
}

func TestContextGuardFallbackRealOverflowPreservesProviderCause(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	go feedStrategyContextAndTools(w)

	providerCause := errors.New("provider fallback says context window exceeded")
	calls := 0
	w.SetLLMCaller(func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		limit := recoveryLimitErr()
		if calls == 1 {
			return nil, &provider.ContextCompactionAdvisory{
				EstimatedInputTokens: limit.EstimatedInputTokens, OutputReserveTokens: limit.OutputReserveTokens,
				ContextWindowTokens: limit.ContextWindowTokens, Breakdown: limit.Breakdown,
			}
		}
		if !req.BypassContextGuard {
			t.Fatal("fallback provider call was not bypassed")
		}
		limit.Cause = providerCause
		return nil, limit
	})

	w.driveStrategyLoop(t, strings.Repeat("x", 25_000), false)
	if calls != 2 {
		t.Fatalf("visible calls = %d, want bounded advisory plus fallback", calls)
	}
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeError {
			if !strings.Contains(item.Content, providerCause.Error()) {
				t.Fatalf("error item = %q, want provider cause", item.Content)
			}
			return
		}
	}
	t.Fatal("real fallback overflow did not create a terminal provider error item")
}

// TestContextGuardRecoveryFailureSurfacesErrorItem proves a concrete recovery
// failure under the silent-truncation guard is surfaced as a terminal error
// item (a silent stop would look like a dead conversation), while the advisory
// estimate itself still never appears as the terminal message.
func TestContextGuardRecoveryFailureSurfacesErrorItem(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	go feedStrategyContextAndTools(w)

	reducerFailure := errors.New("hidden reducer transport failed")
	w.SetLLMCaller(func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			return nil, reducerFailure
		}
		limit := recoveryLimitErr()
		return nil, &provider.ContextCompactionAdvisory{
			EstimatedInputTokens: limit.EstimatedInputTokens, OutputReserveTokens: limit.OutputReserveTokens,
			ContextWindowTokens: limit.ContextWindowTokens, Breakdown: limit.Breakdown,
		}
	})

	w.driveStrategyLoop(t, "latest question", false)
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeError {
			if !strings.Contains(item.Content, "context recovery failed") || !strings.Contains(item.Content, reducerFailure.Error()) {
				t.Fatalf("error item = %q, want the surfaced recovery failure", item.Content)
			}
			if strings.Contains(item.Content, "compaction is advised") {
				t.Fatalf("error item leaked advisory text: %q", item.Content)
			}
			return
		}
	}
	t.Fatal("guard recovery failure did not surface an error item")
}

// TestContextRecoveryBudgetResetsAfterSuccessfulDispatch proves the bounded
// recovery budget is per context-pressure incident, not per strategy run: after
// the attempt bound is consumed and a dispatch succeeds, a later overflow in
// the same run recovers again instead of dying on an exhausted budget.
func TestContextRecoveryBudgetResetsAfterSuccessfulDispatch(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	go feedStrategyContextAndTools(w)

	providerCause := errors.New("provider says context window exceeded")
	overflowRounds := 0
	visibleCalls := 0
	overflow := func() error {
		// Stage fresh foldable history before each overflow so every recovery
		// can make objective progress (the worker is blocked in
		// waitForLLMResponse while this runs; InsertMessage locks the doc).
		overflowRounds++
		items := make([]ConversationItem, 3)
		for i := range items {
			items[i] = ConversationItem{
				Type: ItemTypeUser, ItemID: fmt.Sprintf("stage-%d-%d", overflowRounds, i),
				Content: strings.Repeat("x", 2300),
			}
		}
		w.doc.InsertMessage(0, items...)
		limit := recoveryLimitErr()
		limit.Cause = providerCause
		return limit
	}
	w.SetLLMCaller(func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			if isCompactionFinalRequest(req) {
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "staged history summary"}}}, nil
			}
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "short"}}}, nil
		}
		visibleCalls++
		switch {
		case visibleCalls <= maxContextRecoveryAttempts:
			// Consume the entire bounded recovery budget on real overflows.
			return nil, overflow()
		case visibleCalls == maxContextRecoveryAttempts+1:
			// Successful but barren dispatch: closes the incident and drives
			// one more strategy iteration.
			return &LLMResponse{StopReason: "end_turn"}, nil
		case visibleCalls == maxContextRecoveryAttempts+2:
			// A fresh incident after success: must recover, not die on an
			// exhausted per-run budget.
			return nil, overflow()
		default:
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered"}}, StopReason: "end_turn"}, nil
		}
	})

	w.driveStrategyLoop(t, "latest question", false)
	if want := maxContextRecoveryAttempts + 3; visibleCalls != want {
		t.Fatalf("visible calls = %d, want %d (budget-consuming overflows, barren success, post-reset overflow, final success)", visibleCalls, want)
	}
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeError {
			t.Fatalf("post-success overflow hit an exhausted recovery budget: %q", item.Content)
		}
	}
}

// TestContextRecoveryNoProgressErrorItemPreservesProviderCause drives the
// strategy loop into the no-progress case and asserts the terminal item reports
// the latest provider-authored overflow rather than a local compaction error.
func TestContextRecoveryNoProgressErrorItemPreservesProviderCause(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "old-0", Content: "small old question"})

	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			if !w.engine.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()

	providerCause := errors.New("provider says context is too long")
	realCalls, hiddenCalls := 0, 0
	w.SetLLMCaller(func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			hiddenCalls++
			return nil, errors.New("unexpected hidden call for an unrecoverable request")
		}
		realCalls++
		overflow := recoveryLimitErr()
		overflow.Cause = providerCause
		return nil, overflow
	})

	// The user's own message is the newest unit and alone exceeds the window:
	// recovery cannot fold anything, so the turn fails terminally.
	w.driveStrategyLoop(t, strings.Repeat("x", 25_000), false)

	if realCalls != 1 {
		t.Fatalf("real calls = %d, want the single rejected attempt", realCalls)
	}
	if hiddenCalls != 0 {
		t.Fatalf("hidden calls = %d, want none — the reducer never starts", hiddenCalls)
	}

	var errorItem *ConversationItem
	items := w.doc.GetItems()
	for i := range items {
		switch items[i].Type {
		case ItemTypeError:
			if errorItem != nil {
				t.Fatal("more than one error item for a single terminal failure")
			}
			errorItem = &items[i]
		case ItemTypeThread:
			if items[i].BoundedCompaction {
				t.Fatal("a compaction summary was committed for an unrecoverable request")
			}
		}
	}
	if errorItem == nil {
		t.Fatal("no error item after a terminal recovery failure")
	}
	var data map[string]any
	if err := json.Unmarshal(errorItem.Data, &data); err != nil {
		t.Fatalf("error item data does not unmarshal: %v (raw %q)", err, errorItem.Data)
	}
	if data["compactionReason"] != nil {
		t.Fatalf("error item compactionReason = %v, want none for provider-authored overflow", data["compactionReason"])
	}
	if !strings.Contains(errorItem.Content, providerCause.Error()) {
		t.Fatalf("error item content = %q, want provider cause %q", errorItem.Content, providerCause)
	}
	if data["provider"] != "test" || data["model"] != "test" {
		t.Fatalf("error item provider/model = %v/%v, want test/test", data["provider"], data["model"])
	}
}
