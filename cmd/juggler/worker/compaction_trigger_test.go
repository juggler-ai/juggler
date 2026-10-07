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

	"juggler/cmd/juggler/providers/provider"

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

// testOverflow hands the ladder limit as an overflow of the given kind, with
// limit itself as the original error, the way a provider rejection arrives.
func testOverflow(limit *provider.ContextLimitExceededError, advisory bool) contextOverflow {
	return contextOverflow{limit: limit, advisory: advisory, err: limit}
}

// TestAsContextOverflowClassifiesBothKinds pins the one place a context-limit
// failure becomes the ladder's shape: an admission estimate is advisory and
// normalized to the limit shape, a provider rejection is not advisory and is
// its own limit, either may arrive wrapped, the original error is kept for the
// provider-authored cause, and anything else is not an overflow.
func TestAsContextOverflowClassifiesBothKinds(t *testing.T) {
	advisory := &provider.ContextCompactionAdvisory{EstimatedInputTokens: 3_500, OutputReserveTokens: 300, ContextWindowTokens: 4_000, MeasuredPrefix: true}
	wrapped := fmt.Errorf("dispatch: %w", advisory)
	o, ok := asContextOverflow(wrapped)
	if !ok || !o.advisory {
		t.Fatalf("wrapped advisory: ok=%v advisory=%v, want an advisory overflow", ok, o.advisory)
	}
	if o.limit == nil || o.limit.EstimatedInputTokens != 3_500 || !o.limit.MeasuredPrefix {
		t.Fatalf("advisory was not normalized to its limit: %+v", o.limit)
	}
	if o.err != wrapped {
		t.Fatalf("original error not kept: %v", o.err)
	}

	rejection := recoveryLimitErr()
	o, ok = asContextOverflow(fmt.Errorf("call: %w", rejection))
	if !ok || o.advisory || o.limit != rejection {
		t.Fatalf("wrapped rejection: ok=%v advisory=%v limit=%p, want the rejection itself as a non-advisory overflow", ok, o.advisory, o.limit)
	}

	if _, ok := asContextOverflow(errors.New("connection reset")); ok {
		t.Fatal("an ordinary error was classified as an overflow")
	}
}

// TestRepeatedAdvisoryAfterBypassStopsQuietly pins the single-shot rule
// resolveContextOverflow holds for the ladder: an advisory on a request that
// already bypassed the guard settles the turn without a terminal error and
// without starting recovery, where a provider rejection on the same request
// still goes to the ladder.
func TestRepeatedAdvisoryAfterBypassStopsQuietly(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		t.Fatal("recovery ran for an advisory on a request that had already bypassed the guard")
		return nil, nil
	}
	before := len(w.doc.GetItems())
	st := &strategyRunState{bypassContextGuard: true}
	advisory := &provider.ContextCompactionAdvisory{EstimatedInputTokens: 6_200, OutputReserveTokens: 300, ContextWindowTokens: 4_000, MeasuredPrefix: true}

	verdict, settled, reportErr := w.ownedRun(t).resolveContextOverflow(st, advisory, nil)
	if verdict != turnDone || !settled {
		t.Fatalf("verdict=%v settled=%v, want a settled stop", verdict, settled)
	}
	if reportErr != advisory {
		t.Fatalf("reported %v, want the advisory itself (settled, so never shown)", reportErr)
	}
	if st.compaction.attempts != 0 {
		t.Fatalf("recovery budget advanced to %d", st.compaction.attempts)
	}
	if got := len(w.doc.GetItems()); got != before {
		t.Fatalf("durable items changed %d -> %d", before, got)
	}
}

func recoveryTestItems() []ConversationItem {
	items := make([]ConversationItem, 0, 7)
	for i := 0; i < 4; i++ {
		items = append(items, ConversationItem{
			Type: ItemTypeUser, ItemID: fmt.Sprintf("old-%d", i),
			// Sized through the estimator (~2300 tokens each): each old item
			// alone busts the halved suffix budget, so the walk keeps only the
			// recents and folds old-0..3.
			Content: strings.Repeat("x", 2300),
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
		if isCompactionFinalRequest(req) {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered prefix summary"}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}
}

// TestHandleContextOverflowGateOffProviderRejectionTerminal pins the reactive
// gate: with automatic compaction disabled, a real provider rejection is
// surfaced terminally without running the recovery ladder — the durable history
// is left untouched and the reducer is never called.
func TestHandleContextOverflowGateOffProviderRejectionTerminal(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	w.autoCompactGate = func() bool { return false }
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		t.Fatal("recovery reducer ran while auto-compaction was disabled")
		return nil, nil
	}
	pinned := &ModelConfig{Provider: "test", Model: "test"}

	before := len(w.doc.GetItems())
	recovery := &compactionAttempts{}
	retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(recoveryLimitErr(), false), recovery, pinned)

	if retry || err == nil {
		t.Fatalf("retry = %v, err = %v; want a terminal error", retry, err)
	}
	var limit *provider.ContextLimitExceededError
	if !errors.As(err, &limit) {
		t.Fatalf("terminal error does not wrap the provider context limit: %v", err)
	}
	if !strings.Contains(err.Error(), "/compact") {
		t.Fatalf("terminal error lacks the compact-now hint: %q", err.Error())
	}
	if got := len(w.doc.GetItems()); got != before {
		t.Fatalf("durable items changed %d -> %d; recovery must not run when gated off", before, got)
	}
}

// TestHandleContextOverflowGateOffAdvisoryBypasses pins that an advisory
// (silent-truncation estimate) is never terminal when auto-compaction is
// disabled: it dispatches one guard-bypassed retry instead of rewriting the
// transcript.
func TestHandleContextOverflowGateOffAdvisoryBypasses(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	w.autoCompactGate = func() bool { return false }
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		t.Fatal("recovery reducer ran for an advisory while auto-compaction was disabled")
		return nil, nil
	}
	pinned := &ModelConfig{Provider: "test", Model: "test"}

	recovery := &compactionAttempts{}
	retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(recoveryLimitErr(), true), recovery, pinned)

	if !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a guard-bypassed retry", retry, err)
	}
	if err != nil {
		t.Fatalf("advisory bypass carried an error: %v", err)
	}
}

// advisoryLimitErr builds a soft-ceiling advisory overflow: the 3,500-token
// estimate plus the 300 reserve fits the 4,000-token hard window, so only the
// 0.85 ceiling was crossed. measured says whether the estimate was projected
// from a provider-billed prefix or from the character heuristic alone.
func advisoryLimitErr(measured bool) *provider.ContextLimitExceededError {
	return &provider.ContextLimitExceededError{
		EstimatedInputTokens: 3_500,
		OutputReserveTokens:  300,
		ContextWindowTokens:  4_000,
		MeasuredPrefix:       measured,
		Breakdown: provider.RequestTokenEstimate{
			Total: 3_500, MessageTokens: 3_300, ProviderOverheadTokens: 50,
		},
	}
}

// TestHandleContextOverflowUnanchoredAdvisoryBypasses pins the trigger
// discipline: a soft-ceiling advisory whose basis is the character estimator
// alone (no measured prefix) never starts a fold. The estimator overcounts
// real transcripts by 2x or more, so an unanchored advisory routinely fires at
// half the real ceiling; the answer is one guard-bypassed dispatch, whose
// provider-billed count re-anchors admission — or whose rejection re-enters
// recovery as an authoritative overflow.
func TestHandleContextOverflowUnanchoredAdvisoryBypasses(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	hiddenCalls := 0
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		hiddenCalls++
		return nil, errors.New("reducer must not run for an unanchored soft-ceiling advisory")
	}
	pinned := &ModelConfig{Provider: "test", Model: "test"}

	before := len(w.doc.GetItems())
	recovery := &compactionAttempts{}
	retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(advisoryLimitErr(false), true), recovery, pinned)

	if hiddenCalls != 0 {
		t.Fatalf("hidden reducer calls = %d, want 0 for an unanchored soft-ceiling advisory", hiddenCalls)
	}
	if !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a guard-bypassed retry", retry, err)
	}
	if err != nil {
		t.Fatalf("bypass carried an error: %v", err)
	}
	if got := len(w.doc.GetItems()); got != before {
		t.Fatalf("durable items changed %d -> %d; an unanchored estimate must not rewrite history", before, got)
	}
}

// TestHandleContextOverflowAnchoredAdvisoryFolds is the counterpart: the same
// soft-ceiling advisory, projected from a measured prefix, does fold — the
// provider's own billed count crossing the ceiling is the one estimate-side
// trigger automatic compaction trusts.
func TestHandleContextOverflowAnchoredAdvisoryFolds(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	recovery := &compactionAttempts{}
	retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(advisoryLimitErr(true), true), recovery, pinned)

	if !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a guard-bypassed retry after a measured-ceiling fold", retry, err)
	}
	if *calls == 0 {
		t.Fatal("no hidden calls — the fold reducer never ran")
	}
	items := w.doc.GetItems()
	if len(items) == 0 || items[0].Type != ItemTypeThread || !items[0].BoundedCompaction {
		t.Fatalf("items[0] = %+v, want a bounded-compaction summary thread", items[0])
	}
}

// TestHandleContextOverflowFoldLeavesTailNotice pins the fold's visible trace:
// the summary thread is spliced where the folded history began — usually far
// above the reader — so the incident also leaves a durable notice at the TAIL,
// at the point in the conversation where it happened. The notice is a normal
// ItemTypeNotice, so it never reaches the wire.
func TestHandleContextOverflowFoldLeavesTailNotice(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	recovery := &compactionAttempts{}
	retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(advisoryLimitErr(true), true), recovery, pinned)
	if !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a guard-bypassed retry", retry, err)
	}

	items := w.doc.GetItems()
	last := items[len(items)-1]
	if last.Type != ItemTypeNotice {
		t.Fatalf("last item = %q, want a compaction notice at the tail: %s", last.Type, itemIDs(items))
	}
	if !strings.Contains(last.Summary, "4 earlier items") {
		t.Fatalf("notice summary = %q, want the folded item count", last.Summary)
	}
	if last.Content == "" {
		t.Fatal("notice carries no detail content")
	}
}

// assumedWindowNotices returns the notices that point at a model's Context
// window setting, in document order.
func assumedWindowNotices(t *testing.T, items []ConversationItem) []ConversationItem {
	t.Helper()
	var out []ConversationItem
	for _, item := range items {
		if item.Type != ItemTypeNotice || len(item.Data) == 0 {
			continue
		}
		var data assumedWindowNoticeData
		if err := json.Unmarshal(item.Data, &data); err != nil {
			t.Fatalf("notice data %s: %v", item.Data, err)
		}
		if data.Settings.Field == "contextWindow" {
			out = append(out, item)
		}
	}
	return out
}

// assumedResolver answers every model with an 8192-token window that the
// provider did not report, or did, per assumed.
func assumedResolver(assumed bool) WindowResolverFunc {
	return func(ModelConfig) ContextWindowInfo {
		return ContextWindowInfo{WindowTokens: 8192, ReserveTokens: 1638, Assumed: assumed}
	}
}

// TestAssumedWindowNoticeBeforeAutoCompaction is the report that motivated the
// notice: a model loaded with a large window, served by a server that reported
// none, compacted at a fraction of it and the compaction then failed — and
// nothing on screen said the 8192 it compacted against was a guess. The notice
// lands before recovery runs, so it is there even when recovery fails, and it
// names the model that overflowed and where its window is set.
func TestAssumedWindowNoticeBeforeAutoCompaction(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	w.windowResolver = assumedResolver(true)
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return nil, errors.New("server dropped the connection")
	}
	pinned := &ModelConfig{Provider: "local", Model: "qwen3.6-35b"}

	recovery := &compactionAttempts{}
	retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(recoveryLimitErr(), false), recovery, pinned)
	if retry || err == nil {
		t.Fatalf("retry = %v, err = %v; want a terminal error (the reducer call fails)", retry, err)
	}

	notices := assumedWindowNotices(t, w.doc.GetItems())
	if len(notices) != 1 {
		t.Fatalf("got %d assumed-window notices, want 1: %s", len(notices), itemIDs(w.doc.GetItems()))
	}
	notice := notices[0]
	for _, want := range []string{"8192", "qwen3.6-35b", "assumed"} {
		if !strings.Contains(notice.Summary, want) {
			t.Errorf("notice summary = %q, want it to mention %q", notice.Summary, want)
		}
	}
	var data assumedWindowNoticeData
	_ = json.Unmarshal(notice.Data, &data)
	if data.Settings.Tab != "providers" || data.Settings.Provider != "local" || data.Settings.Model != "qwen3.6-35b" {
		t.Errorf("notice link = %+v, want the providers tab at local/qwen3.6-35b", data.Settings)
	}
}

// A window the provider reported is not a guess, and compacting against it is
// the system working: no notice.
func TestNoAssumedWindowNoticeForReportedWindow(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	w.windowResolver = assumedResolver(false)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	recovery := &compactionAttempts{}
	if retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(advisoryLimitErr(true), true), recovery, pinned); !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a guard-bypassed retry", retry, err)
	}
	if n := len(assumedWindowNotices(t, w.doc.GetItems())); n != 0 {
		t.Fatalf("got %d assumed-window notices for a reported window, want 0", n)
	}
}

// One notice per model and window: a conversation that compacts again and
// again against the same guess is told once, not at every fold.
func TestAssumedWindowNoticeOncePerModelWindow(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.windowResolver = assumedResolver(true)
	r := w.currentRun()
	mc := &ModelConfig{Provider: "local", Model: "qwen"}

	for range 3 {
		if item, ok := r.assumedWindowNotice(mc); ok {
			r.appendTargetMessage(item)
		}
	}
	if n := len(assumedWindowNotices(t, w.doc.GetItems())); n != 1 {
		t.Fatalf("three compactions against one guess left %d notices, want 1", n)
	}

	// A different model's guess is news.
	if _, ok := r.assumedWindowNotice(&ModelConfig{Provider: "local", Model: "other"}); !ok {
		t.Fatal("a second model's assumed window was suppressed as a duplicate")
	}
}

// TestHandleContextOverflowFoldReceiptSaysWhatSurvived covers the reassurance
// half of the receipt. A reader who watches their context fill assumes the
// oldest thing to go is the brief, so a notice that reports only how much was
// folded confirms the fear it should answer: what the fold kept is the fact
// worth stating, and the folded items themselves are kept for undo.
func TestHandleContextOverflowFoldReceiptSaysWhatSurvived(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	recovery := &compactionAttempts{}
	if retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(advisoryLimitErr(true), true), recovery, pinned); !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a guard-bypassed retry", retry, err)
	}

	items := w.doc.GetItems()
	notice := items[len(items)-1]
	if notice.Type != ItemTypeNotice {
		t.Fatalf("last item = %q, want the tail notice: %s", notice.Type, itemIDs(items))
	}
	if !strings.Contains(notice.Summary, "4 earlier items") {
		t.Fatalf("notice summary = %q, want the folded item count", notice.Summary)
	}
	if !strings.Contains(notice.Summary, "Nothing was discarded") {
		t.Fatalf("notice summary = %q, want the row itself to say nothing was lost", notice.Summary)
	}
	for _, kept := range []string{"standing context", "memory", "undo"} {
		if !strings.Contains(notice.Content, kept) {
			t.Fatalf("notice content = %q, want it to name what survived the fold (%q)", notice.Content, kept)
		}
	}
}

// TestHandleContextOverflowFoldDoesNotStealSelection pins the receipt's manners.
// The summary thread is spliced where the folded history BEGAN, far above a
// reader parked at the tail, and it is a thread item — the auto-select
// fallback. Without the opt-out the browser /compact fold already sets, an
// automatic fold yanks the reader into the folded column mid-turn.
func TestHandleContextOverflowFoldDoesNotStealSelection(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	recovery := &compactionAttempts{}
	if _, err := w.ownedRun(t).handleContextOverflow(testOverflow(advisoryLimitErr(true), true), recovery, pinned); err != nil {
		t.Fatalf("fold failed: %v", err)
	}

	items := w.doc.GetItems()
	if items[0].Type != ItemTypeThread || !items[0].BoundedCompaction {
		t.Fatalf("items[0] = %+v, want the summary thread", items[0])
	}
	// Read off the Y.Map, which is what the browser reads: the flag is a control
	// key rather than a serialized ConversationItem field.
	ymap := w.doc.GetThreadYMap(items[0].ItemID)
	if ymap == nil {
		t.Fatal("summary thread Y.Map not found")
	}
	ycrdtMu.Lock()
	noAutoSelect, _ := ymap.Get("noAutoSelect").(bool)
	ycrdtMu.Unlock()
	if !noAutoSelect {
		t.Fatal("the summary thread must not be an auto-select candidate")
	}
}

// TestHandleContextOverflowUnanchoredOverHardWindowStillFolds keeps the
// silent-truncation guard: an unanchored estimate that exceeds the hard window
// itself (not just the soft ceiling) may still fold — it is the only protection
// a provider that truncates instead of rejecting ever gets.
func TestHandleContextOverflowUnanchoredOverHardWindowStillFolds(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	recovery := &compactionAttempts{}
	retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(recoveryLimitErr(), true), recovery, pinned)

	if !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a guard-bypassed retry — over-window estimates still fold, then the provider judges the retry", retry, err)
	}
	if *calls == 0 {
		t.Fatal("no hidden calls — the fold reducer never ran")
	}
}

func TestContextRecoveryFoldsRootPrefixPreservesSuffix(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}
	if *calls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", *calls)
	}

	items := w.doc.GetItems()
	if len(items) != 4 {
		t.Fatalf("items after fold = %d, want summary plus three verbatim suffix items", len(items))
	}
	folded := items[0]
	if folded.Type != ItemTypeThread || !folded.BoundedCompaction {
		t.Fatalf("items[0] = %q (bounded=%v), want a bounded-compaction thread", folded.Type, folded.BoundedCompaction)
	}
	if got := threadResultString(folded); got != "recovered prefix summary" {
		t.Fatalf("folded thread result = %q", got)
	}
	if !strings.Contains(folded.Summary, "4 earlier items") {
		t.Fatalf("folded summary line = %q, want the folded prefix count", folded.Summary)
	}
	wantIDs := []string{"recent-0", "recent-1", "recent-2"}
	for i, want := range wantIDs {
		if items[i+1].ItemID != want {
			t.Fatalf("items[%d].ItemID = %q, want verbatim suffix item %q", i+1, items[i+1].ItemID, want)
		}
	}
}

func TestContextRecoveryFoldsSubthreadPrefix(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	threadID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		thread := conversationItemToYMap(ConversationItem{Type: ItemTypeThread, ItemID: threadID, Goal: "Research"})
		thread.Set("items", ycrdt.NewYArray())
		w.doc.ensureItems().Push(ycrdt.ArrayAny{thread})
	}, w.doc.authorID)
	arr := w.doc.GetThreadItemsArray(threadID)
	w.doc.InsertMessageIntoArray(arr, 0, recoveryTestItems()...)
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = arr

	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
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
	if len(items) != 4 || items[0].Type != ItemTypeThread {
		t.Fatalf("nested items after fold = %d (first %q), want summary thread plus three suffix items", len(items), items[0].Type)
	}
	wantIDs := []string{"recent-0", "recent-1", "recent-2"}
	for i, want := range wantIDs {
		if items[i+1].ItemID != want {
			t.Fatalf("nested items[%d].ItemID = %q, want %q", i+1, items[i+1].ItemID, want)
		}
	}
}

// TestContextRecoveryKeepsDelegatedRunRecords covers the case a resumable
// session makes routine: a delegated child folds its OWN history to stay inside
// the window, and must come out of it with every call it has taken still
// answerable. The fold swallows the earlier invocation messages along with the
// run bodies around them and carries their records instead, so the three things
// that read a run record all still find one — the caller's wire keeps a
// tool_result per call, the session keeps the tool that owns it, and the fold
// reads as the settled container it is rather than as a child still running.
func TestContextRecoveryKeepsDelegatedRunRecords(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	threadID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		thread := conversationItemToYMap(ConversationItem{
			Type: ItemTypeThread, ItemID: threadID, Goal: "Research", SessionName: "explore-1",
		})
		thread.Set("items", ycrdt.NewYArray())
		w.doc.ensureItems().Push(ycrdt.ArrayAny{thread})
	}, w.doc.authorID)
	arr := w.doc.GetThreadItemsArray(threadID)

	// Two calls against one session: [invoc-1][run 1 body][invoc-2][run 2 body].
	nested := []ConversationItem{invocationItemForTest("invoc-1", "tu-1", "first answer")}
	for i := 0; i < 3; i++ {
		nested = append(nested, ConversationItem{
			Type: ItemTypeAssistant, ItemID: fmt.Sprintf("old-%d", i), Content: strings.Repeat("x", 2300),
		})
	}
	nested = append(nested, invocationItemForTest("invoc-2", "tu-2", "second answer"))
	for i := 0; i < 3; i++ {
		nested = append(nested, ConversationItem{
			Type: ItemTypeAssistant, ItemID: fmt.Sprintf("recent-%d", i), Content: fmt.Sprintf("recent reply %c", 'A'+i),
		})
	}
	w.doc.InsertMessageIntoArray(arr, 0, nested...)
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = arr

	wireBefore, err := json.Marshal(appendThreadMessages(nil, w.doc.GetItems()[0], w.doc.GetItems()))
	if err != nil {
		t.Fatal(err)
	}

	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}

	items := w.doc.GetItemsFromArray(arr)
	// [summary(invoc-1, old-0..2), invoc-2, recent-0..2]
	if len(items) != 5 {
		t.Fatalf("nested items after fold = %s, want the summary, the open run's invocation message and the verbatim tail", itemIDs(items))
	}
	fold := items[0]
	if fold.Type != ItemTypeThread || !fold.BoundedCompaction {
		t.Fatalf("items[0] = %q (bounded=%v), want the compaction summary", fold.Type, fold.BoundedCompaction)
	}
	if !threadRunSettled(fold) {
		t.Error("a summarized fold must read as settled, or the thread parks on it and re-summarizes it")
	}
	if len(fold.FoldedRuns) != 1 || fold.FoldedRuns[0].ToolUseID != "tu-1" || fold.FoldedRuns[0].Result != "first answer" {
		t.Fatalf("the fold dropped the record of the call it swallowed: %+v", fold.FoldedRuns)
	}
	// The thread's most recent invocation message stays put: it is where the next
	// run's outcome is stamped and where the thread's liveness is read from.
	if items[1].ItemID != "invoc-2" || items[1].RunToolUseID != "tu-2" {
		t.Fatalf("the open run's invocation message was folded away: %s", itemIDs(items))
	}

	// The caller's wire: one tool_use/tool_result pair per call, in call order,
	// and the pair for the call that already returned comes back byte for byte.
	child := w.doc.GetItems()[0]
	runs := threadRunRecords(child)
	if len(runs) != 2 || runs[0].call.ToolUseID != "tu-1" || runs[1].call.ToolUseID != "tu-2" {
		t.Fatalf("run records after the child folded itself = %+v, want tu-1 then tu-2", runs)
	}
	msgs := appendThreadMessages(nil, child, nil)
	if len(msgs) != 4 {
		t.Fatalf("wire messages = %d, want a use/result pair per call", len(msgs))
	}
	wireAfter, err := json.Marshal(msgs)
	if err != nil {
		t.Fatal(err)
	}
	if string(wireAfter) != string(wireBefore) {
		t.Errorf("the fold rewrote the caller's transcript:\n before %s\n after  %s", wireBefore, wireAfter)
	}
	if tool := sessionToolOf(child); tool != "Explore" {
		t.Errorf("session tool after the fold = %q, want Explore — a resume would create instead", tool)
	}
	if !threadRunSettled(child) {
		t.Error("the child's own latest run still reads as running after it folded its history")
	}
}

// invocationItemForTest builds the message that starts one delegated run, as
// spawnThread and resumeSession stamp it: the call's prompt plus the tool-use
// coordinates its result is paired back from.
func invocationItemForTest(id, toolUseID, result string) ConversationItem {
	return ConversationItem{
		Type: ItemTypeUser, ItemID: id, Content: "find the auth flow",
		RunToolUseID: toolUseID, RunToolName: "Explore",
		RunToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`),
		RunStatus:    runStatusRest, RunResult: result,
	}
}

// boundedSummaryItem builds a prior compaction summary thread as a recovery or
// browser /compact fold would leave one: a BoundedCompaction thread whose
// Result carries the summary text. It renders on the wire as its result, so
// `summary`'s length is the unit's footprint — small enough to sit in the
// pinned leading run, or large enough that a naive suffix walk could not keep
// it verbatim.
func boundedSummaryItem(t *testing.T, id, summary string) ConversationItem {
	t.Helper()
	res, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	return ConversationItem{
		Type: ItemTypeThread, ItemID: id, Goal: "Compacted conversation history",
		BoundedCompaction: true, Result: res,
	}
}

// TestContextRecoveryRefoldSwallowsPriorSummary pins the anti-stacking
// contract, matching the browser /compact fold's convergence invariant: a
// recovery fold SWALLOWS a prior summarized compaction thread — nested in its
// condensed form (condenseForRefold), its folded transcript kept nested inside
// it — so consecutive incidents leave exactly ONE summary thread
// instead of a growing stack. The stack was the runaway mode this replaces:
// each pinned prior summary fragmented the next fold's contiguous range into
// slivers ("records 5–6 only" summaries), while summaries accumulated at the
// top of the conversation, each pass slower and less effective than the last.
func TestContextRecoveryRefoldSwallowsPriorSummary(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	prior := boundedSummaryItem(t, "prior-summary", "prior summary")
	// A raw folded transcript on the prior summary: the re-fold keeps it nested
	// inside the prior summary, where it stays browsable.
	prior.Items = json.RawMessage(`[{"type":"user","itemId":"ancient-0","content":"ancient history"}]`)
	w.doc.InsertMessage(0, append([]ConversationItem{prior}, recoveryTestItems()...)...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	result, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed {
		t.Fatal("folding fresh history is real progress, but result.Changed = false")
	}

	got := w.doc.GetItems()
	var summaries []ConversationItem
	for _, it := range got {
		if it.Type == ItemTypeThread && it.BoundedCompaction {
			summaries = append(summaries, it)
		}
	}
	if len(summaries) != 1 {
		t.Fatalf("summary threads after re-fold = %d (%s), want exactly one — summaries must never stack", len(summaries), itemIDs(got))
	}
	fresh := summaries[0]
	if fresh.ItemID == "prior-summary" {
		t.Fatal("the fold kept the prior summary as the boundary instead of creating a new one")
	}
	if got[0].ItemID != fresh.ItemID {
		t.Fatalf("items[0] = %q, want the single summary thread leading: %s", got[0].ItemID, itemIDs(got))
	}

	var nested []ConversationItem
	if err := json.Unmarshal(fresh.Items, &nested); err != nil {
		t.Fatalf("new summary nested items do not decode: %v", err)
	}
	var condensed *ConversationItem
	for i := range nested {
		if nested[i].ItemID == "prior-summary" {
			condensed = &nested[i]
		}
	}
	if condensed == nil {
		t.Fatalf("the prior summary was dropped instead of nested condensed: %s", itemIDs(nested))
	}
	if threadResultString(*condensed) != "prior summary" {
		t.Fatalf("condensed prior summary result = %q, want its summary text carried forward", threadResultString(*condensed))
	}
	if !strings.Contains(string(condensed.Items), "ancient history") {
		t.Fatalf("condensed prior summary lost its folded transcript: %s", condensed.Items)
	}
}

// TestContextRecoveryReportsNoProgressWhenOnlyPriorSummaryFoldable pins the
// termination half of the fix. When the only non-suffix content is an existing
// compaction summary, recovery has nothing fresh to fold: it must report no
// progress (so the turn surfaces an honest overflow error) rather than
// re-wrapping the summary and reporting false progress that drives another pass.
func TestContextRecoveryReportsNoProgressWhenOnlyPriorSummaryFoldable(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Large enough that the suffix walk cannot keep it verbatim — before the fix
	// that forced the summary into the prefix and re-folded it.
	prior := boundedSummaryItem(t, "prior-summary", strings.Repeat("x", 12_000))
	recents := recoveryTestItems()[4:] // recent-0..2, small
	w.doc.InsertMessage(0, append([]ConversationItem{prior}, recents...)...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	result, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned)
	if err != nil {
		t.Fatal(err)
	}
	if result.Changed {
		t.Fatal("no fresh history to fold, yet recovery reported progress (re-folded the prior summary?)")
	}
	if *calls != 0 {
		t.Fatalf("hidden calls = %d, want 0 — nothing should have been summarized", *calls)
	}
	got := w.doc.GetItems()
	if len(got) != 4 || got[0].ItemID != "prior-summary" || !got[0].BoundedCompaction {
		t.Fatalf("items = %s, want the prior summary plus three untouched recents", itemIDs(got))
	}
	for _, it := range got[1:] {
		if it.Type == ItemTypeThread {
			t.Fatalf("a new summary thread appeared among the suffix items: %s", itemIDs(got))
		}
	}
}

// TestContextRecoveryPreservesFoldedThreadItemOrder pins the nested-item order
// inside a recovery-folded summary thread. The fold must preserve the source
// order — the summarized prefix verbatim, then the synthesized summarization
// prompt LAST — exactly as the browser /compact fold seeds it
// ([...snapshots, prompt]). The regression it guards: building the folded
// thread's Y.Map with a fully-populated *prelim* nested Y.Array integrates in
// reverse (YArray.Integrate's PrelimContent reversal), so the thread rendered
// as [prompt, ...tools, oldest] — summarization prompt first, original user
// message last — which corrupts every hidden reduce that reads the nested items.
func TestContextRecoveryPreservesFoldedThreadItemOrder(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}

	folded := w.doc.GetItems()[0]
	if folded.Type != ItemTypeThread || !folded.BoundedCompaction {
		t.Fatalf("items[0] = %q (bounded=%v), want a bounded-compaction thread", folded.Type, folded.BoundedCompaction)
	}
	var nested []ConversationItem
	if err := json.Unmarshal(folded.Items, &nested); err != nil {
		t.Fatalf("folded thread nested items do not decode: %v", err)
	}
	// Four verbatim prefix items (old-0..3) in source order, then the prompt.
	if len(nested) != 5 {
		t.Fatalf("nested items = %d, want the four folded items plus the prompt", len(nested))
	}
	for i, want := range []string{"old-0", "old-1", "old-2", "old-3"} {
		if nested[i].ItemID != want {
			t.Fatalf("nested[%d].ItemID = %q, want %q (nested order reversed?)", i, nested[i].ItemID, want)
		}
	}
	prompt := nested[4]
	if prompt.ItemID != folded.CompactionPromptItemID || prompt.Content != defaultSummarizationPromptMarker {
		t.Fatalf("nested[4] = {id:%q content:%.20q}, want the summarization prompt (%q) last",
			prompt.ItemID, prompt.Content, folded.CompactionPromptItemID)
	}
}

// TestContextRecoveryFoldIsAtomicallyUndoable pins that a recovery fold is a
// single undoable operation, exactly like the browser /compact fold. Before the
// fix the fold committed under the internal (untracked) origin, so the summary
// thread lingered as an un-undoable "zombie" while the rest of the conversation
// undid/redid around it. One undo must reverse the whole fold — restoring the
// pre-fold history verbatim and removing the summary thread — and redo re-applies
// it as one unit.
func TestContextRecoveryFoldIsAtomicallyUndoable(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.tracker.EnsureInitialized()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	// Insert the pre-fold history as separate tracked undo groups (one per turn,
	// as real usage produces) sitting below the fold on the undo stack.
	for _, it := range recoveryTestItems() {
		w.tracker.InsertMessage(w.doc.GetItemsLength(), it)
		w.tracker.StopCapturing()
	}

	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}
	if got := w.doc.GetItems(); len(got) != 4 || !got[0].BoundedCompaction {
		t.Fatalf("post-fold items = %s, want a summary thread plus three suffix items", itemIDs(got))
	}

	// The fold is the top undo group: one undo restores every pre-fold item in
	// order and removes the summary thread. A lingering thread here is the zombie.
	if !w.tracker.Undo() {
		t.Fatal("recovery fold left nothing to undo — it committed untracked")
	}
	got := w.doc.GetItems()
	wantIDs := []string{"old-0", "old-1", "old-2", "old-3", "recent-0", "recent-1", "recent-2"}
	if len(got) != len(wantIDs) {
		t.Fatalf("after undoing the fold: %s, want the seven pre-fold items restored", itemIDs(got))
	}
	for i, want := range wantIDs {
		if got[i].ItemID != want {
			t.Fatalf("restored[%d] = %q, want %q", i, got[i].ItemID, want)
		}
		if got[i].BoundedCompaction {
			t.Fatalf("summary thread survived the undo (zombie): %s", itemIDs(got))
		}
	}

	// Redo re-applies the fold atomically.
	if !w.tracker.Redo() {
		t.Fatal("recovery fold was not redoable")
	}
	if re := w.doc.GetItems(); len(re) != 4 || !re[0].BoundedCompaction {
		t.Fatalf("after redo: %s, want the fold re-applied as one unit", itemIDs(re))
	}
}

func itemIDs(items []ConversationItem) string {
	ids := make([]string, len(items))
	for i, it := range items {
		ids[i] = fmt.Sprintf("%s(%s)", it.ItemID, it.Type)
	}
	return strings.Join(ids, ", ")
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
		w.currentRun().storeState(StateProcessing)
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

		items := recoveryTestItems()[:4] // four big old items
		items = append(items, recoveryToolBatch("txn-big", 2600)...)
		items = append(items, ConversationItem{Type: ItemTypeUser, ItemID: "latest", Content: "latest question"})
		w.doc.InsertMessage(0, items...)
		calls, stub := newRecoveryStub(t, pinned)
		w.llmCallFunc = stub

		if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
			t.Fatal(err)
		}
		if *calls < 2 {
			t.Fatalf("hidden calls = %d, want map(s) plus final", *calls)
		}
		got := w.doc.GetItems()
		if len(got) != 2 || got[0].Type != ItemTypeThread || got[1].ItemID != "latest" {
			t.Fatalf("items = %d (%v ...), want whole batch folded and only the latest message kept", len(got), got[0].Type)
		}
	})

	t.Run("batch fitting suffix stays whole and verbatim", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.currentRun().storeState(StateProcessing)
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

		items := recoveryTestItems()[:4]
		items = append(items, recoveryToolBatch("txn-small", 200)...)
		items = append(items, ConversationItem{Type: ItemTypeUser, ItemID: "latest", Content: "latest question"})
		w.doc.InsertMessage(0, items...)
		calls, stub := newRecoveryStub(t, pinned)
		w.llmCallFunc = stub

		if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
			t.Fatal(err)
		}
		if *calls < 2 {
			t.Fatalf("hidden calls = %d, want map(s) plus final", *calls)
		}
		got := w.doc.GetItems()
		if len(got) != 4 || got[0].Type != ItemTypeThread {
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
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}

	edited := false
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if !isCompactionFinalRequest(req) && !edited {
			edited = true
			// A concurrent edit lands mid-reduce: the fold must not commit.
			w.doc.InsertMessage(w.doc.GetItemsLength(), ConversationItem{Type: ItemTypeUser, ItemID: "concurrent-edit", Content: "edited while summarizing"})
		}
		if isCompactionFinalRequest(req) {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "stale summary"}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}

	_, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned)
	var bounded *BoundedCompactionError
	if !errors.As(err, &bounded) || bounded.Reason != BoundedCompactionSourceChanged {
		t.Fatalf("error = %#v, want source_changed", err)
	}
	items := w.doc.GetItems()
	if len(items) != 8 {
		t.Fatalf("items = %d, want original seven plus the concurrent edit (no fold)", len(items))
	}
	for _, item := range items {
		if item.BoundedCompaction {
			t.Fatal("a compaction summary was committed despite the source change")
		}
	}
}

func TestContextRecoveryTerminalWhenNewestItemAloneExceeds(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0,
		ConversationItem{Type: ItemTypeUser, ItemID: "old-0", Content: "small old question"},
		ConversationItem{Type: ItemTypeUser, ItemID: "giant", Content: strings.Repeat("x", 25_000)},
	)
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	result, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned)
	if err != nil {
		t.Fatal(err)
	}
	if result.Changed {
		t.Fatalf("result = %+v, want no structural progress", result)
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
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}

	calls := 0
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		w.ownedRun(t).storeState(StateCancelling)
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}

	_, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned)
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
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	items := []ConversationItem{{Type: "rule", ItemID: "rule-0", Content: "always answer tersely"}}
	items = append(items, recoveryTestItems()...)
	w.doc.InsertMessage(0, items...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}
	if *calls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", *calls)
	}
	got := w.doc.GetItems()
	if len(got) != 5 {
		t.Fatalf("items = %d, want pinned rule plus summary plus three suffix items", len(got))
	}
	if got[0].ItemID != "rule-0" {
		t.Fatalf("items[0] = %q, want the pinned rule item untouched", got[0].ItemID)
	}
	if got[1].Type != ItemTypeThread || !got[1].BoundedCompaction {
		t.Fatalf("items[1] = %q (bounded=%v), want the summary thread inserted after the pinned run", got[1].Type, got[1].BoundedCompaction)
	}
	if !strings.Contains(got[1].Summary, "4 earlier items") {
		t.Fatalf("folded summary line = %q, want only the four foldable old items counted", got[1].Summary)
	}
}

func TestContextRecoveryStatePreservesLatestProviderCause(t *testing.T) {
	state := compactionAttempts{}
	firstCause := errors.New("provider overflow one")
	first := &provider.ContextLimitExceededError{Cause: firstCause}
	result := contextRecoveryResult{Changed: true, Signature: recoverySignature{retainedItems: 4, foldBoundary: "fold-1", wireSize: 400}}
	if retry, err := state.advance(result, first); !retry || err != nil {
		t.Fatalf("first advance = retry %v, err %v", retry, err)
	}

	latestCause := errors.New("provider overflow two")
	latest := &provider.ContextLimitExceededError{Cause: latestCause}
	if retry, err := state.advance(contextRecoveryResult{Signature: result.Signature}, latest); retry || !errors.Is(err, latestCause) {
		t.Fatalf("no-progress advance = retry %v, err %v; want latest provider cause", retry, err)
	}
}

func TestContextRecoveryStateAllowsTwoProgressiveRecoveriesThenThirdDispatch(t *testing.T) {
	state := compactionAttempts{}
	providerCalls := 0
	for {
		providerCalls++
		if providerCalls == 3 {
			break
		}
		result := contextRecoveryResult{Changed: true, Signature: recoverySignature{
			retainedItems: 6 - providerCalls, foldBoundary: fmt.Sprintf("fold-%d", providerCalls), wireSize: 600 - providerCalls*100,
		}}
		if retry, err := state.advance(result, recoveryLimitErr()); !retry || err != nil {
			t.Fatalf("advance %d = retry %v, err %v", providerCalls, retry, err)
		}
	}
	if state.attempts != 2 || providerCalls != 3 {
		t.Fatalf("attempts = %d, provider calls = %d; want two recoveries then third dispatch", state.attempts, providerCalls)
	}
}

func TestContextRecoveryStateBoundPreservesLatestProviderCause(t *testing.T) {
	state := compactionAttempts{}
	for i := 0; i < maxContextRecoveryAttempts; i++ {
		result := contextRecoveryResult{Changed: true, Signature: recoverySignature{
			retainedItems: maxContextRecoveryAttempts - i, foldBoundary: fmt.Sprintf("fold-%d", i), wireSize: 1000 - i,
		}}
		if retry, err := state.advance(result, recoveryLimitErr()); !retry || err != nil {
			t.Fatalf("advance %d = retry %v, err %v", i, retry, err)
		}
	}
	latestCause := errors.New("last provider overflow")
	latest := &provider.ContextLimitExceededError{Cause: latestCause}
	if retry, err := state.advance(contextRecoveryResult{Changed: true}, latest); retry || !errors.Is(err, latestCause) {
		t.Fatalf("bounded advance = retry %v, err %v; want latest provider cause", retry, err)
	}
}

func TestContextRecoveryTrailingToolShrinkCountsAsProgress(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	giantResult, _ := json.Marshal(map[string]any{"content": strings.Repeat("r", 15_000), "isError": false})
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-giant", ToolUseID: "tu-giant", ToolName: "read_file",
		ToolInput: json.RawMessage(`{"path":"/tmp/big.txt"}`), State: StateCompleted,
		Result: giantResult, TransactionID: "txn-giant",
	})
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	result, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Signature.wireSize >= 15_000 {
		t.Fatalf("result = %+v, want objective shrink progress", result)
	}
}

// TestContextRecoveryRetriesRejectedTurnAboveAdvisoryLimit drives the full strategy loop:
// the first real request is rejected by the provider, recovery folds the old
// history into the doc, and the loop retries with the guard bypassed — the
// provider, not the local estimator, judges the folded transcript.
func TestContextRecoveryRetriesRejectedTurnAboveAdvisoryLimit(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
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
			if !w.engine.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()

	realCalls, hiddenCalls := 0, 0
	firstTurnMessages, retriedTurnMessages := -1, -1
	retryBypassed := false
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			hiddenCalls++
			if isCompactionFinalRequest(req) {
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered prefix summary"}}}, nil
			}
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
		}
		realCalls++
		if realCalls == 1 {
			firstTurnMessages = len(req.Messages)
			return nil, recoveryLimitErr()
		}
		retriedTurnMessages = len(req.Messages)
		retryBypassed = req.BypassContextGuard
		// Visible turns assemble the assistant message from streamed chunks;
		// mirror the provider's stream before delivering the final response.
		sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: "recovered answer"})
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "recovered answer"}},
			StopReason: "end_turn",
		}, nil
	}

	w.driveStrategyLoop(t, "Hello", false)

	if realCalls != 2 {
		t.Fatalf("real calls = %d, want the rejected attempt plus exactly one retry", realCalls)
	}
	if hiddenCalls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", hiddenCalls)
	}
	if firstTurnMessages != 5 || retriedTurnMessages != 2 {
		t.Fatalf("turn messages %d -> %d, want 5 rejected, 2 after the fold (summary plus the live user message)", firstTurnMessages, retriedTurnMessages)
	}
	if !retryBypassed {
		t.Fatal("post-fold retry re-entered guarded admission; it must dispatch bypassed")
	}

	items := w.doc.GetItems()
	var summaries, assistants int
	for _, item := range items {
		switch item.Type {
		case ItemTypeThread:
			if item.BoundedCompaction {
				summaries++
				if got := threadResultString(item); got != "recovered prefix summary" {
					t.Fatalf("summary result = %q", got)
				}
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

// TestContextRecoveryShrinksOversizedTrailingToolResult covers the active
// tool-loop case: a provider tool result so large the next call can never fit
// — here larger than one compaction input budget, so the reducer must split
// it across map calls. The result is summarized in place (the tool pair stays
// intact and visible), the older history folds, and recovery succeeds.
func TestContextRecoveryShrinksOversizedTrailingToolResult(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	giantResult, _ := json.Marshal(map[string]any{"content": strings.Repeat("r", 15_000), "isError": false})
	items := recoveryTestItems()[:3]
	items = append(items, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-giant", ToolUseID: "tu-giant", ToolName: "read_file",
		ToolInput: json.RawMessage(`{"path":"/tmp/big.txt"}`),
		State:     StateCompleted, Result: giantResult, TransactionID: "txn-giant",
	})
	w.doc.InsertMessage(0, items...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}
	if *calls < 4 {
		t.Fatalf("hidden calls = %d, want split shrink maps plus prefix maps plus finals", *calls)
	}

	got := w.doc.GetItems()
	if len(got) != 2 {
		t.Fatalf("items = %d, want prefix summary plus the intact tool batch", len(got))
	}
	if got[0].Type != ItemTypeThread || !got[0].BoundedCompaction || !strings.Contains(got[0].Summary, "3 earlier items") {
		t.Fatalf("items[0] = %q (%q), want the three old items folded into a summary thread", got[0].Type, got[0].Summary)
	}
	tool := got[1]
	if tool.ItemID != "ta-giant" || tool.ToolUseID != "tu-giant" || tool.State != StateCompleted {
		t.Fatalf("tool item = %+v, want the original completed pair intact", tool)
	}
	var payload struct {
		Content string `json:"content"`
		IsError bool   `json:"isError"`
	}
	if err := json.Unmarshal(tool.Result, &payload); err != nil {
		t.Fatalf("shrunk result does not unmarshal: %v", err)
	}
	if !strings.HasPrefix(payload.Content, recoveryShrunkResultMarker) {
		t.Fatalf("shrunk result lacks the marker: %.80q", payload.Content)
	}
	if !strings.Contains(payload.Content, "recovered prefix summary") {
		t.Fatalf("shrunk result lacks the reducer summary: %.120q", payload.Content)
	}
	if strings.Contains(payload.Content, strings.Repeat("r", 15_000)) {
		t.Fatal("shrunk result still carries the original oversized payload")
	}
	if payload.IsError {
		t.Fatal("shrunk result must preserve isError=false")
	}
}

// TestContextRecoveryShrinkKeepsResultRenderingFields pins the UI-only half of
// an in-place shrink: the wire-visible content is replaced, everything else in
// the result blob survives. The transcript row reads its completed state off
// result.fullResult, so a shrink that dropped that field would leave a finished
// tool call rendering as though it were still running.
func TestContextRecoveryShrinkKeepsResultRenderingFields(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	giantResult, _ := json.Marshal(map[string]any{
		"content": strings.Repeat("r", 15_000),
		"isError": false,
		"fullResult": map[string]any{
			"actionId":    "read-file",
			"success":     true,
			"displayData": map[string]any{"path": "/tmp/big.txt"},
		},
	})
	items := recoveryTestItems()[:3]
	items = append(items, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-giant", ToolUseID: "tu-giant", ToolName: "read_file",
		ToolInput: json.RawMessage(`{"path":"/tmp/big.txt"}`),
		State:     StateCompleted, Result: giantResult, TransactionID: "txn-giant",
	})
	w.doc.InsertMessage(0, items...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	_, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}

	got := w.doc.GetItems()
	tool := got[len(got)-1]
	var payload struct {
		Content    string         `json:"content"`
		IsError    bool           `json:"isError"`
		FullResult map[string]any `json:"fullResult"`
	}
	if err := json.Unmarshal(tool.Result, &payload); err != nil {
		t.Fatalf("shrunk result does not unmarshal: %v", err)
	}
	if !strings.HasPrefix(payload.Content, recoveryShrunkResultMarker) {
		t.Fatalf("shrunk result lacks the marker: %.80q", payload.Content)
	}
	if payload.FullResult == nil {
		t.Fatal("shrink dropped result.fullResult, so the transcript row falls back to a running state")
	}
	if payload.FullResult["success"] != true || payload.FullResult["actionId"] != "read-file" {
		t.Fatalf("fullResult = %v, want the original rendering fields", payload.FullResult)
	}
	display, _ := payload.FullResult["displayData"].(map[string]any)
	if display["path"] != "/tmp/big.txt" {
		t.Fatalf("fullResult.displayData = %v, want the original display payload", payload.FullResult["displayData"])
	}
}

// TestContextRecoveryTrailingToolBatchGiantInputStaysTerminal is the negative
// case: the trailing batch is oversized by its tool INPUT, not its result, so
// in-place result summarization has nothing to shrink and recovery stays a
// concise terminal error.
func TestContextRecoveryTrailingToolBatchGiantInputStaysTerminal(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	giantInput, _ := json.Marshal(map[string]any{"command": strings.Repeat("c", 20_000)})
	smallResult, _ := json.Marshal(map[string]any{"content": "ok", "isError": false})
	items := recoveryTestItems()[:3]
	items = append(items, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-giant-in", ToolUseID: "tu-giant-in", ToolName: "bash",
		ToolInput: giantInput, State: StateCompleted, Result: smallResult, TransactionID: "txn-giant-in",
	})
	w.doc.InsertMessage(0, items...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	result, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned)
	if err != nil {
		t.Fatal(err)
	}
	if result.Changed {
		t.Fatalf("result = %+v, want no structural progress", result)
	}
	if *calls != 0 {
		t.Fatalf("hidden calls = %d, want none — nothing shrinkable", *calls)
	}
	if got := w.doc.GetItems(); len(got) != 4 {
		t.Fatalf("items = %d, want the untouched original four", len(got))
	}
}

// TestToolResultPushingNextCallOverContextRecovers drives the active tool
// loop end to end: turn one runs a tool, its oversized result makes the
// continuation request inadmissible, recovery shrinks the result and folds
// the old history, and the SAME loop continues to completion — with the tool
// executed exactly once.
func TestToolResultPushingNextCallOverContextRecovers(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "test-conv"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	executes := make(chan string, 8)
	w.SetCallback("engine", func(b []byte) {
		var m ToolCommand
		if json.Unmarshal(b, &m) == nil && m.Type == "execute-tool" {
			executes <- m.ToolUseID
		}
	})
	w.SetEngineClientID("engine")

	w.currentRun().storeState(StateProcessing)
	w.doc.InsertMessage(0, recoveryTestItems()[:3]...)

	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(ToolsResultMessage{
			Type:  "tools-result",
			Tools: []ToolDefinition{{Name: "bash"}},
		})
		for {
			if !w.engine.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()

	realCalls := 0
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			if isCompactionFinalRequest(req) {
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered prefix summary"}}}, nil
			}
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
		}
		realCalls++
		switch realCalls {
		case 1:
			return &LLMResponse{
				Blocks:     []LLMResponseBlock{{Type: "tool_use", ID: "tu-1", Name: "bash", Input: json.RawMessage(`{"command":"cat /tmp/big"}`)}},
				StopReason: "tool_use",
			}, nil
		case 2:
			// Precondition: the giant tool result really pushed this request
			// past the window — otherwise the fixture is not exercising
			// recovery at all.
			estimate := provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total
			if estimate+300 <= 4_000 {
				t.Fatalf("continuation request fits (%d + 300 <= 4000); the fixture is not oversized", estimate)
			}
			return nil, recoveryLimitErr()
		default:
			estimate := provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total
			if estimate+300 > 4_000 {
				t.Fatalf("retried request still does not fit: %d + 300 > 4000", estimate)
			}
			sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: "continued after recovery"})
			return &LLMResponse{
				Blocks:     []LLMResponseBlock{{Type: "text", Content: "continued after recovery"}},
				StopReason: "end_turn",
			}, nil
		}
	}

	// Turn 1: the model calls bash; the async tool-action parks the loop after
	// an evaluate-tool command. The engine's approval verdict lands as a sync…
	w.driveStrategyLoop(t, "run the tool", false)
	if err := w.doc.UpdateItemByToolUseID("tu-1", "state", StateApproved); err != nil {
		t.Fatal(err)
	}
	// …the next drive tick commands the execution (counted by the callback)…
	w.driveToolActions()
	// …and the engine writes the oversized result back when it finishes.
	if err := w.doc.UpdateItemByToolUseID("tu-1", "state", StateCompleted); err != nil {
		t.Fatal(err)
	}
	if err := w.doc.UpdateItemByToolUseID("tu-1", "result", map[string]any{"content": strings.Repeat("r", 15_000), "isError": false}); err != nil {
		t.Fatal(err)
	}

	// Continuation: rejected, recovered, retried — on a turn of its own, as the
	// reducer's dispatchCallLLMOnThread would start it.
	w.driveStrategyLoop(t, "", true)

	if realCalls != 3 {
		t.Fatalf("real calls = %d, want tool turn, rejected continuation, retried continuation", realCalls)
	}
	if got := drainExecuteIDs(executes); len(got) != 1 || got[0] != "tu-1" {
		t.Fatalf("execute-tool dispatches = %v, want exactly one (tu-1); tools must not repeat", got)
	}

	items := w.doc.GetItems()
	var summaries, assistants, toolActions int
	for _, item := range items {
		switch item.Type {
		case ItemTypeThread:
			if item.BoundedCompaction {
				summaries++
			}
		case ItemTypeAssistant:
			assistants++
			if item.Content != "continued after recovery" {
				t.Fatalf("assistant content = %q", item.Content)
			}
		case ItemTypeToolAction:
			toolActions++
			if item.ToolUseID != "tu-1" || item.State != StateCompleted {
				t.Fatalf("tool item = %+v, want tu-1 completed", item)
			}
			var payload struct {
				Content string `json:"content"`
			}
			if err := json.Unmarshal(item.Result, &payload); err != nil ||
				!strings.HasPrefix(payload.Content, recoveryShrunkResultMarker) {
				t.Fatalf("tool result was not shrunk in place: %.80q", payload.Content)
			}
		case ItemTypeError:
			t.Fatalf("unexpected error item after recovery: %q", item.Content)
		}
	}
	if summaries != 1 || assistants != 1 || toolActions != 1 {
		t.Fatalf("summaries=%d assistants=%d toolActions=%d, want one of each", summaries, assistants, toolActions)
	}
}

func drainExecuteIDs(ch chan string) []string {
	var ids []string
	for {
		select {
		case id := <-ch:
			ids = append(ids, id)
		default:
			return ids
		}
	}
}

// TestContextRecoveryTerminalWhenNewestImageAloneExceeds mirrors the text
// giant case for media: when the newest item's image attachment alone busts
// the window, recovery cannot fold anything and fails terminally without a
// single hidden call.
func TestContextRecoveryTerminalWhenNewestImageAloneExceeds(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0,
		ConversationItem{Type: ItemTypeUser, ItemID: "old-0", Content: "small old question"},
		ConversationItem{
			Type: ItemTypeUser, ItemID: "img", Content: "what is in this image?",
			Attachments: []AssetRef{{ID: "asset-1", Mime: "image/png", Width: 8_000, Height: 6_000}},
		},
	)
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	result, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned)
	if err != nil {
		t.Fatal(err)
	}
	if result.Changed {
		t.Fatalf("result = %+v, want no structural progress", result)
	}
	if *calls != 0 {
		t.Fatalf("hidden calls = %d, want none for an unrecoverable suffix", *calls)
	}
	if items := w.doc.GetItems(); len(items) != 2 {
		t.Fatalf("items = %d, want the untouched original two", len(items))
	}
}

// TestFoldPrefixIntoSummaryIfUnchangedAbortsOnConcurrentEdit proves the context
// recovery fold closes its check-then-write race: a doc mutation landing between
// the fingerprint snapshot and the fold must abort (leaving the array intact)
// rather than splice at now-stale indices. Before the guard was moved inside the
// lock, the fingerprint compare and the Delete/Insert ran under separate ycrdtMu
// acquisitions, so a concurrent ApplySyncUpdate could invalidate start/count in
// between and the fold would delete the wrong items.
func TestFoldPrefixIntoSummaryIfUnchangedAbortsOnConcurrentEdit(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.InsertMessage(0, recoveryTestItems()...)
	arr := w.currentRun().getTargetItemsYArray()

	// A promptID that matches no item in the array (mirrors what recovery passes
	// for its not-yet-inserted synthesized prompt item), so canonical records
	// exclude nothing.
	const foldTestPromptID = "\x00fold-test-prompt"

	// Snapshot the fingerprint the recovery path captures before it reduces.
	records, err := canonicalCompactionRecords(w.currentRun().getTargetItems(), foldTestPromptID)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := compactionSourceFingerprint(records)
	summary := ConversationItem{Type: ItemTypeThread, ItemID: "sum", BoundedCompaction: true, Result: json.RawMessage(`"folded"`)}

	// A concurrent browser edit lands after the snapshot (prepends an item), so
	// the captured start/count no longer describe the intended prefix.
	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "raced-in", Content: "concurrent edit"})

	if w.doc.FoldPrefixIntoSummaryIfUnchanged(arr, 0, 3, summary, foldTestPromptID, fingerprint) {
		t.Fatal("fold committed against a changed array; TOCTOU not closed")
	}
	if got := w.doc.GetItems(); len(got) != 8 || got[0].ItemID != "raced-in" {
		t.Fatalf("aborted fold mutated the array: len=%d first=%q, want 8 with the raced-in edit intact", len(got), got[0].ItemID)
	}

	// Positive control: against the current (unchanged) fingerprint the fold commits.
	records2, err := canonicalCompactionRecords(w.currentRun().getTargetItems(), foldTestPromptID)
	if err != nil {
		t.Fatal(err)
	}
	if !w.doc.FoldPrefixIntoSummaryIfUnchanged(arr, 0, 3, summary, foldTestPromptID, compactionSourceFingerprint(records2)) {
		t.Fatal("fold aborted against an unchanged array")
	}
	if after := w.doc.GetItems(); len(after) != 6 || after[0].Type != ItemTypeThread {
		t.Fatalf("fold outcome = %d items (first %q), want 3 folded into a summary plus 5 remaining", len(after), after[0].Type)
	}
}

// TestContextRecoveryShrinkOnlySucceedsWithoutFold covers the shrink-only path:
// when summarizing an oversized trailing tool result in place brings the whole
// conversation back under the window, recovery must succeed with NO prefix fold
// (no summary item) so the caller's retry proceeds against the smaller history.
// Regression for the branch that previously returned a spurious context_bound
// error once the suffix walk had consumed every unit. The assertions prove the
// shrink happened AND that nothing was folded, which is what distinguishes this
// path from an ordinary fold.
func TestContextRecoveryShrinkOnlySucceedsWithoutFold(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Small older history that fits verbatim on its own, plus one giant tool
	// result that busts the window but shrinks to a short summary in place. After
	// the in-place shrink the whole conversation fits, so recovery must not fold.
	giantResult, _ := json.Marshal(map[string]any{"content": strings.Repeat("r", 15_000), "isError": false})
	items := []ConversationItem{
		{Type: ItemTypeUser, ItemID: "old-0", Content: "first small question"},
		{Type: ItemTypeUser, ItemID: "old-1", Content: "second small question"},
		{
			Type: ItemTypeToolAction, ItemID: "ta-giant", ToolUseID: "tu-giant", ToolName: "read_file",
			ToolInput: json.RawMessage(`{"path":"/tmp/big.txt"}`),
			State:     StateCompleted, Result: giantResult, TransactionID: "txn-giant",
		},
	}
	w.doc.InsertMessage(0, items...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}
	calls, stub := newRecoveryStub(t, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
		t.Fatalf("shrink-only recovery must succeed, got: %v", err)
	}
	if *calls == 0 {
		t.Fatal("expected hidden calls summarizing the oversized result")
	}

	got := w.doc.GetItems()
	// No fold: the three originals remain and no summary item was inserted.
	if len(got) != 3 {
		t.Fatalf("items = %d, want the three originals with nothing folded", len(got))
	}
	for _, item := range got {
		if item.BoundedCompaction {
			t.Fatal("a compaction summary was inserted; shrink-only must not fold the prefix")
		}
	}
	if got[0].ItemID != "old-0" || got[1].ItemID != "old-1" {
		t.Fatalf("older history not preserved verbatim: %q, %q", got[0].ItemID, got[1].ItemID)
	}
	// The trailing result was shrunk in place, which is what made the turn fit.
	tool := got[2]
	if tool.ItemID != "ta-giant" || tool.State != StateCompleted {
		t.Fatalf("tool pair not intact: %+v", tool)
	}
	var payload struct {
		Content string `json:"content"`
		IsError bool   `json:"isError"`
	}
	if err := json.Unmarshal(tool.Result, &payload); err != nil {
		t.Fatalf("shrunk result does not unmarshal: %v", err)
	}
	if !strings.HasPrefix(payload.Content, recoveryShrunkResultMarker) {
		t.Fatalf("trailing result was not shrunk in place: %.80q", payload.Content)
	}
	if strings.Contains(payload.Content, strings.Repeat("r", 15_000)) {
		t.Fatal("shrunk result still carries the oversized payload")
	}
}

// newLargeOverheadRecoveryStub asserts every hidden request fits the FULL
// context window with the provider overhead counted once. Before the fix the
// reducer ran against a window with the overhead subtracted out and then re-added
// it, so this invariant is exactly what the regression violated.
func newLargeOverheadRecoveryStub(t *testing.T, window, overhead, reserve int64, pinned *ModelConfig) (*int, func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error)) {
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
		estimate := provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), overhead).Total
		if estimate+reserve > window {
			t.Fatalf("hidden request %d does not fit full window: %d + %d > %d", *calls, estimate, reserve, window)
		}
		if isCompactionFinalRequest(req) {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "large-overhead summary"}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}
}

// TestContextRecoveryShrinkPathToleratesLargeProviderOverhead is the regression
// for the Claude Code CLI's 40k fixed provider overhead on the trailing-result
// shrink path. The shrink reducer used a reserve+floor window (~1.3k), so the
// empty hidden envelope (~40k of overhead) could never fit and ANY oversized
// trailing tool result failed recovery with `bounded compaction fixed request
// envelope exceeds model context`. The reducer must run against the full context
// window, counting the overhead exactly once.
func TestContextRecoveryShrinkPathToleratesLargeProviderOverhead(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	giantResult, _ := json.Marshal(map[string]any{"content": strings.Repeat("r", 15_000), "isError": false})
	items := recoveryTestItems()[:3]
	items = append(items, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-giant", ToolUseID: "tu-giant", ToolName: "read_file",
		ToolInput: json.RawMessage(`{"path":"/tmp/big.txt"}`),
		State:     StateCompleted, Result: giantResult, TransactionID: "txn-giant",
	})
	w.doc.InsertMessage(0, items...)

	const window, overhead, reserve int64 = 60_000, 40_000, 300
	limitErr := &provider.ContextLimitExceededError{
		EstimatedInputTokens: window,
		OutputReserveTokens:  reserve,
		ContextWindowTokens:  window,
		Breakdown: provider.RequestTokenEstimate{
			Total: 65_000, MessageTokens: 20_000, ProviderOverheadTokens: overhead,
		},
	}
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newLargeOverheadRecoveryStub(t, window, overhead, reserve, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(limitErr, pinned); err != nil {
		t.Fatalf("recovery failed at 40k provider overhead: %v", err)
	}
	if *calls == 0 {
		t.Fatal("no hidden calls — the shrink reducer never ran")
	}

	got := w.doc.GetItems()
	var tool *ConversationItem
	for i := range got {
		if got[i].ItemID == "ta-giant" {
			tool = &got[i]
		}
	}
	if tool == nil {
		t.Fatal("trailing tool item vanished")
	}
	var payload struct {
		Content string `json:"content"`
		IsError bool   `json:"isError"`
	}
	if err := json.Unmarshal(tool.Result, &payload); err != nil {
		t.Fatalf("shrunk result does not unmarshal: %v", err)
	}
	if !strings.HasPrefix(payload.Content, recoveryShrunkResultMarker) || !strings.Contains(payload.Content, "large-overhead summary") {
		t.Fatalf("trailing result was not shrunk in place: %.80q", payload.Content)
	}
	if strings.Contains(payload.Content, strings.Repeat("r", 15_000)) {
		t.Fatal("shrunk result still carries the oversized payload")
	}
}

// TestContextRecoveryFoldPathToleratesLargeProviderOverhead is the regression
// for the same 40k overhead on the main history-fold path. reducerWindow used to
// be window-envelope-suffix; because envelope already includes the 40k overhead
// and the reducer re-adds it, the effective window dropped below the empty hidden
// envelope and the fold failed the same way. The reducer must run against the
// full window with the overhead counted once.
func TestContextRecoveryFoldPathToleratesLargeProviderOverhead(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	items := make([]ConversationItem, 0, 5)
	for i := 0; i < 5; i++ {
		items = append(items, ConversationItem{
			Type: ItemTypeUser, ItemID: fmt.Sprintf("item-%d", i),
			Content: strings.Repeat("x", 5_000),
		})
	}
	w.doc.InsertMessage(0, items...)

	const window, overhead, reserve int64 = 60_000, 40_000, 300
	limitErr := &provider.ContextLimitExceededError{
		EstimatedInputTokens: 65_000,
		OutputReserveTokens:  reserve,
		ContextWindowTokens:  window,
		Breakdown: provider.RequestTokenEstimate{
			Total: 65_000, MessageTokens: 20_000, ProviderOverheadTokens: overhead,
		},
	}
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newLargeOverheadRecoveryStub(t, window, overhead, reserve, pinned)
	w.llmCallFunc = stub

	if _, err := w.ownedRun(t).compactToFit(limitErr, pinned); err != nil {
		t.Fatalf("fold failed at 40k provider overhead: %v", err)
	}
	if *calls == 0 {
		t.Fatal("no hidden calls — the fold reducer never ran")
	}

	got := w.doc.GetItems()
	if len(got) != 2 {
		t.Fatalf("items after fold = %d, want summary plus the newest verbatim item", len(got))
	}
	if got[0].Type != ItemTypeThread || !got[0].BoundedCompaction || !strings.Contains(got[0].Summary, "4 earlier items") {
		t.Fatalf("items[0] = %q (%q), want the four oldest folded into a summary thread", got[0].Type, got[0].Summary)
	}
	if got[1].ItemID != "item-4" {
		t.Fatalf("verbatim suffix = %q, want item-4", got[1].ItemID)
	}
}

// TestContextRecoveryShrinkChargesMapOutputCap pins F1b on the shrink path: a
// large trailing tool result is shrunk on a 128k window with a 16,384 reserve.
// Because map calls charge the 4,096 wire output cap rather than the full
// reserve, a map chunk that would NOT fit under reserve-charging
// (estimate + 16,384 > 128,000) still fits under the cap (estimate + 4,096 ≤
// 128,000). The test asserts shrink succeeds, at least one such chunk existed,
// and the call count stays far below the hard cap.
func TestContextRecoveryShrinkChargesMapOutputCap(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// ~118k-token trailing result: above (window - reserve) = 111,616 but below
	// (window - cap) = 123,904, so it packs into one chunk only under cap-charging.
	giantResult, _ := json.Marshal(map[string]any{"content": strings.Repeat("r", 118_000), "isError": false})
	items := recoveryTestItems()[:3]
	items = append(items, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-cap", ToolUseID: "tu-cap", ToolName: "read_file",
		ToolInput: json.RawMessage(`{"path":"/tmp/big.txt"}`),
		State:     StateCompleted, Result: giantResult, TransactionID: "txn-cap",
	})
	w.doc.InsertMessage(0, items...)

	const window, reserve int64 = 128_000, 16_384
	limitErr := &provider.ContextLimitExceededError{
		EstimatedInputTokens: window + 1,
		OutputReserveTokens:  reserve,
		ContextWindowTokens:  window,
		Breakdown: provider.RequestTokenEstimate{
			Total: window + 1, MessageTokens: 120_000,
		},
	}
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}

	calls := new(int)
	sawCapOnlyFit := false
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		*calls++
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		estimate := provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total
		// Effective reserve mirrors admission/outputCapFor: min(reserve, cap) for
		// capped map calls, else the full reserve.
		effective := reserve
		if req.MaxOutputTokens > 0 && req.MaxOutputTokens < reserve {
			effective = req.MaxOutputTokens
		}
		if estimate+effective > window {
			t.Fatalf("hidden call %d does not fit under effective reserve: %d + %d > %d", *calls, estimate, effective, window)
		}
		if !isCompactionFinalRequest(req) && estimate+reserve > window {
			// A map chunk that only fit because the cap (not the full reserve)
			// was charged — exactly the F1b benefit.
			sawCapOnlyFit = true
		}
		if isCompactionFinalRequest(req) {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "cap-path summary"}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}

	if _, err := w.ownedRun(t).compactToFit(limitErr, pinned); err != nil {
		t.Fatalf("shrink recovery failed at 128k/16384: %v", err)
	}
	if *calls == 0 {
		t.Fatal("no hidden calls — the shrink reducer never ran")
	}
	if *calls >= boundedCompactionMaxCalls {
		t.Fatalf("hidden calls = %d, want far below the %d cap", *calls, boundedCompactionMaxCalls)
	}
	if !sawCapOnlyFit {
		t.Fatal("expected at least one map chunk that fit only under the output cap, not the full reserve")
	}

	got := w.doc.GetItems()
	var tool *ConversationItem
	for i := range got {
		if got[i].ItemID == "ta-cap" {
			tool = &got[i]
		}
	}
	if tool == nil {
		t.Fatal("trailing tool item vanished")
	}
	var payload struct {
		Content string `json:"content"`
		IsError bool   `json:"isError"`
	}
	if err := json.Unmarshal(tool.Result, &payload); err != nil {
		t.Fatalf("shrunk result does not unmarshal: %v", err)
	}
	if !strings.HasPrefix(payload.Content, recoveryShrunkResultMarker) || !strings.Contains(payload.Content, "cap-path summary") {
		t.Fatalf("trailing result was not shrunk in place: %.80q", payload.Content)
	}
	if strings.Contains(payload.Content, strings.Repeat("r", 118_000)) {
		t.Fatal("shrunk result still carries the oversized payload")
	}
}

// TestContextGuardLogRestatesOnlyWhatChanged pins the guard's logging policy.
// A standing condition — a transcript that cannot be reduced — re-derives the
// same verdict on every dispatch, and a dispatch happens between every pair of
// tool calls, so the line must be emitted on change rather than on occurrence:
// a new verdict, a new basis, or an estimate that has moved far enough against
// the window to be worth reading.
func TestContextGuardLogRestatesOnlyWhatChanged(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	const window int64 = 200_000
	const irreducible = "nothing left to reduce; dispatching one irreducible fallback"

	if !w.noteContextGuardDecision(irreducible, "estimated", 220_956, window) {
		t.Fatal("first override went unlogged; nothing else in the system records one")
	}
	if w.noteContextGuardDecision(irreducible, "estimated", 225_000, window) {
		t.Fatal("same verdict, estimate moved 4k of a 200k window: a restatement, not information")
	}
	if !w.noteContextGuardDecision(irreducible, "estimated", 235_000, window) {
		t.Fatal("estimate drifted past the step and the trajectory went unlogged")
	}
	if w.noteContextGuardDecision(irreducible, "estimated", 235_000, window) {
		t.Fatal("identical line repeated after the drift re-anchored")
	}
	if !w.noteContextGuardDecision(irreducible, "measured", 235_000, window) {
		t.Fatal("basis moved from guess to billed count and was suppressed as a repeat")
	}
	if !w.noteContextGuardDecision("recovery attempt bound reached; dispatching one fallback", "measured", 235_000, window) {
		t.Fatal("a different verdict was suppressed")
	}
}
