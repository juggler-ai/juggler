//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// enableEventTape turns the worker event tape on for the duration of a test.
// tracingEnabled is resolved once at package init from JUGGLER_TRACE, so unit
// tests flip the package var directly before the worker (and its tape) is
// constructed.
func enableEventTape(t *testing.T) {
	t.Helper()
	old := tracingEnabled
	tracingEnabled = true
	t.Cleanup(func() { tracingEnabled = old })
}

// observedRecoveryStub answers hidden map calls with a fragment and the final
// call with the handoff summary, reporting fixed per-call usage so accounting
// assertions have real numbers to check.
func observedRecoveryStub(t *testing.T, calls *int) func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
	t.Helper()
	return func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		*calls++
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if len(req.Tools) > 0 {
			return &LLMResponse{
				Blocks:           []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "return_result", Input: json.RawMessage(`{"result":"recovered prefix summary"}`)}},
				InputTokens:      150,
				OutputTokens:     40,
				CachedTokens:     10,
				CacheWriteTokens: 5,
			}, nil
		}
		return &LLMResponse{
			Blocks:      []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}},
			InputTokens: 150, OutputTokens: 40,
		}, nil
	}
}

func tapeEventsOfKind(events []EventTapeEntry, kind string) []EventTapeEntry {
	var out []EventTapeEntry
	for _, e := range events {
		if e.Kind == kind {
			out = append(out, e)
		}
	}
	return out
}

// numAsInt64 reads a numeric tape/accounting value regardless of the concrete
// number type it survived storage as (int, int64, or JSON float64).
func numAsInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), true
	case int64:
		return n, true
	case float64:
		return int64(n), true
	}
	return 0, false
}

func mustTapeNum(t *testing.T, e EventTapeEntry, key string) int64 {
	t.Helper()
	v, ok := e.Summary[key]
	if !ok {
		t.Fatalf("%s event lacks key %q: %v", e.Kind, key, e.Summary)
	}
	n, ok := numAsInt64(v)
	if !ok {
		t.Fatalf("%s event key %q = %#v, want a number", e.Kind, key, v)
	}
	return n
}

func jsonNum(t *testing.T, m map[string]any, key string) float64 {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("missing key %q in %v", key, m)
	}
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("key %q = %#v, want a JSON number", key, v)
	}
	return f
}

func requireHexFingerprint(t *testing.T, fp string) {
	t.Helper()
	if len(fp) != 64 {
		t.Fatalf("sourceFingerprint = %q, want 64 hex chars", fp)
	}
	if _, err := hex.DecodeString(fp); err != nil {
		t.Fatalf("sourceFingerprint = %q is not hex: %v", fp, err)
	}
}

func TestCompactionAccountingPersistedOnSummaryItem(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls := 0
	w.llmCallFunc = observedRecoveryStub(t, &calls)

	if err := w.tryContextRecovery(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}
	if calls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", calls)
	}

	var summary *ConversationItem
	for i, item := range w.doc.GetItems() {
		if item.Type == ItemTypeCompactionSummary {
			summary = &w.doc.GetItems()[i]
		}
	}
	if summary == nil {
		t.Fatal("no compaction summary item after a successful recovery")
	}
	var accounting map[string]any
	if err := json.Unmarshal(summary.Data, &accounting); err != nil {
		t.Fatalf("summary item data does not unmarshal: %v (raw %q)", err, summary.Data)
	}
	// Calls includes the rejected original request attempt in addition to the
	// hidden reducer calls the stub counted.
	if got := jsonNum(t, accounting, "calls"); int(got) != calls+1 {
		t.Fatalf("accounting calls = %v, want %d (hidden calls plus the rejected request)", got, calls+1)
	}
	if got := jsonNum(t, accounting, "passes"); got < 1 {
		t.Fatalf("accounting passes = %v, want at least one reduction pass", got)
	}
	if got := jsonNum(t, accounting, "estimatedSpend"); got <= 0 {
		t.Fatalf("accounting estimatedSpend = %v, want positive", got)
	}
	if _, ok := accounting["durationMs"]; !ok {
		t.Fatalf("accounting lacks durationMs: %v", accounting)
	}
	fp, _ := accounting["sourceFingerprint"].(string)
	requireHexFingerprint(t, fp)

	usage, ok := accounting["usage"].(map[string]any)
	if !ok {
		t.Fatalf("accounting usage = %#v, want an object", accounting["usage"])
	}
	if got := jsonNum(t, usage, "inputTokens"); int(got) != 150*calls {
		t.Fatalf("usage inputTokens = %v, want %d (150 per call)", got, 150*calls)
	}
	if got := jsonNum(t, usage, "outputTokens"); int(got) != 40*calls {
		t.Fatalf("usage outputTokens = %v, want %d (40 per call)", got, 40*calls)
	}
	if got := jsonNum(t, usage, "cachedTokens"); got != 10 {
		t.Fatalf("usage cachedTokens = %v, want 10 (final call only)", got)
	}
	if got := jsonNum(t, usage, "cacheWriteTokens"); got != 5 {
		t.Fatalf("usage cacheWriteTokens = %v, want 5 (final call only)", got)
	}
}

func TestCompactionTapeRecords(t *testing.T) {
	enableEventTape(t)
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls := 0
	w.llmCallFunc = observedRecoveryStub(t, &calls)

	if err := w.tryContextRecovery(recoveryLimitErr(), pinned); err != nil {
		t.Fatal(err)
	}

	events := w.tape.DumpAll()
	starts := tapeEventsOfKind(events, "compaction-start")
	if len(starts) != 1 {
		t.Fatalf("compaction-start events = %d, want exactly one", len(starts))
	}
	start := starts[0]
	if start.Summary["kind"] != compactionKindRecovery {
		t.Fatalf("compaction-start kind = %v, want %q", start.Summary["kind"], compactionKindRecovery)
	}
	if got := mustTapeNum(t, start, "window"); got != 4_000 {
		t.Fatalf("compaction-start window = %d, want 4000", got)
	}
	if got := mustTapeNum(t, start, "reserve"); got != 300 {
		t.Fatalf("compaction-start reserve = %d, want 300", got)
	}
	if got := mustTapeNum(t, start, "envelope"); got != 200 {
		t.Fatalf("compaction-start envelope = %d, want 200", got)
	}

	passes := tapeEventsOfKind(events, "compaction-pass")
	if len(passes) < 1 {
		t.Fatal("no compaction-pass events recorded")
	}
	for _, p := range passes {
		if got := mustTapeNum(t, p, "pass"); got < 1 {
			t.Fatalf("compaction-pass pass = %d, want one-based", got)
		}
		if got := mustTapeNum(t, p, "chunks"); got < 1 {
			t.Fatalf("compaction-pass chunks = %d, want at least one", got)
		}
	}

	callEvents := tapeEventsOfKind(events, "compaction-call")
	if len(callEvents) != calls {
		t.Fatalf("compaction-call events = %d, want one per hidden call (%d)", len(callEvents), calls)
	}
	for _, c := range callEvents {
		if got := mustTapeNum(t, c, "input"); got != 150 {
			t.Fatalf("compaction-call input = %d, want 150", got)
		}
		if got := mustTapeNum(t, c, "output"); got != 40 {
			t.Fatalf("compaction-call output = %d, want 40", got)
		}
	}

	outcomes := tapeEventsOfKind(events, "compaction-outcome")
	if len(outcomes) != 1 {
		t.Fatalf("compaction-outcome events = %d, want exactly one", len(outcomes))
	}
	outcome := outcomes[0]
	if outcome.Summary["outcome"] != "fold" {
		t.Fatalf("compaction-outcome outcome = %v, want fold", outcome.Summary["outcome"])
	}
	if got := mustTapeNum(t, outcome, "foldedItems"); got != 3 {
		t.Fatalf("compaction-outcome foldedItems = %d, want 3", got)
	}
	// Outcome calls include the rejected original request attempt; the per-call
	// events above counted hidden dispatches only.
	if got := mustTapeNum(t, outcome, "calls"); int(got) != calls+1 {
		t.Fatalf("compaction-outcome calls = %d, want %d", got, calls+1)
	}
	if _, ok := outcome.Summary["durationMs"]; !ok {
		t.Fatalf("compaction-outcome lacks durationMs: %v", outcome.Summary)
	}

	// Hidden reducer output must never leak into the visible conversation:
	// map fragments appear nowhere, and the final summary only in the summary
	// item itself.
	summaryCount := 0
	for _, item := range w.doc.GetItems() {
		if strings.Contains(item.Content, "condensed fragment") {
			t.Fatalf("hidden map output leaked into item %s (%q)", item.ItemID, item.Type)
		}
		if strings.Contains(item.Content, "recovered prefix summary") {
			summaryCount++
			if item.Type != ItemTypeCompactionSummary {
				t.Fatalf("final summary leaked into non-summary item %s (%q)", item.ItemID, item.Type)
			}
		}
	}
	if summaryCount != 1 {
		t.Fatalf("items carrying the final summary = %d, want exactly one (the summary item)", summaryCount)
	}
}

func TestCompactionCancellationTapeAndAccounting(t *testing.T) {
	enableEventTape(t)
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	pinned := &ModelConfig{Provider: "test", Model: "test"}

	calls := 0
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		w.storeState(StateCancelling)
		return &LLMResponse{
			Blocks:      []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}},
			InputTokens: 150, OutputTokens: 40,
		}, nil
	}

	err := w.tryContextRecovery(recoveryLimitErr(), pinned)
	if !errors.Is(err, errBoundedCompactionCancelled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	var cancelled *BoundedCompactionCancelledError
	if !errors.As(err, &cancelled) {
		t.Fatalf("error = %#v, want BoundedCompactionCancelledError", err)
	}
	if cancelled.Result.Calls == 0 || cancelled.Result.EstimatedSpend == 0 {
		t.Fatalf("cancelled result calls=%d spend=%d, want partial accounting", cancelled.Result.Calls, cancelled.Result.EstimatedSpend)
	}
	if cancelled.Result.Usage.InputTokens != 150 {
		t.Fatalf("cancelled usage input = %d, want 150 from the one completed call", cancelled.Result.Usage.InputTokens)
	}

	outcomes := tapeEventsOfKind(w.tape.DumpAll(), "compaction-outcome")
	if len(outcomes) != 1 || outcomes[0].Summary["outcome"] != "cancelled" {
		t.Fatalf("compaction-outcome events = %+v, want exactly one cancelled outcome", outcomes)
	}
	if got := mustTapeNum(t, outcomes[0], "calls"); got < 1 {
		t.Fatalf("cancelled outcome calls = %d, want the partial count", got)
	}

	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeCompactionSummary {
			t.Fatal("a compaction summary was committed despite cancellation")
		}
	}
}

func TestCompactionFoldedThreadAccountingPersisted(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	threadID := insertBoundedCompactionThread(t, w, strings.Repeat("large history λ🙂 ", 500))

	const window int64 = 2400
	const reserve int64 = 300
	calls := 0
	w.llmCallFunc = observedRecoveryStub(t, &calls)

	handled, err := w.tryBoundedCompaction(&provider.ContextLimitExceededError{
		EstimatedInputTokens: 5_000, OutputReserveTokens: reserve, ContextWindowTokens: window,
	}, &ModelConfig{Provider: "test", Model: "test"})
	if err != nil || !handled {
		t.Fatalf("tryBoundedCompaction = (%v, %v), want handled success", handled, err)
	}
	if calls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", calls)
	}

	thread := w.doc.GetThreadYMap(threadID)
	raw := thread.Get("compactionAccounting")
	if raw == nil {
		t.Fatal("thread lacks the compactionAccounting map after a successful fold")
	}
	accounting, ok := fromYcrdt(raw).(map[string]any)
	if !ok {
		t.Fatalf("compactionAccounting = %#v, want a map", raw)
	}
	// Calls includes the rejected original request attempt (see CompactionResult).
	if got, _ := numAsInt64(accounting["calls"]); int(got) != calls+1 {
		t.Fatalf("accounting calls = %v, want %d", accounting["calls"], calls+1)
	}
	if got, _ := numAsInt64(accounting["estimatedSpend"]); got <= 0 {
		t.Fatalf("accounting estimatedSpend = %v, want positive", accounting["estimatedSpend"])
	}
	if _, ok := accounting["durationMs"]; !ok {
		t.Fatalf("accounting lacks durationMs: %v", accounting)
	}
	fp, _ := accounting["sourceFingerprint"].(string)
	requireHexFingerprint(t, fp)

	usage, ok := fromYcrdt(accounting["usage"]).(map[string]any)
	if !ok {
		t.Fatalf("accounting usage = %#v, want a map", accounting["usage"])
	}
	if got, _ := numAsInt64(usage["inputTokens"]); int(got) != 150*calls {
		t.Fatalf("usage inputTokens = %v, want %d", usage["inputTokens"], 150*calls)
	}
	if got, _ := numAsInt64(usage["cacheWriteTokens"]); got != 5 {
		t.Fatalf("usage cacheWriteTokens = %v, want 5", usage["cacheWriteTokens"])
	}
}

func TestCompactionErrorDataExtraction(t *testing.T) {
	t.Run("bounded error carries reason and partial accounting", func(t *testing.T) {
		err := error(fmt.Errorf("outer: %w", &BoundedCompactionError{
			Reason: BoundedCompactionContextBound, Calls: 2, Spend: 500,
			Usage: CompactionUsage{InputTokens: 10, OutputTokens: 4},
		}))
		data := compactionErrorData(err)
		if data["compactionReason"] != string(BoundedCompactionContextBound) {
			t.Fatalf("compactionReason = %v, want context_bound", data["compactionReason"])
		}
		if data["compactionCalls"] != 2 || data["compactionSpend"] != int64(500) {
			t.Fatalf("calls/spend = %v/%v, want 2/500", data["compactionCalls"], data["compactionSpend"])
		}
		usage, ok := data["compactionUsage"].(map[string]any)
		if !ok || usage["inputTokens"] != int64(10) || usage["outputTokens"] != int64(4) {
			t.Fatalf("compactionUsage = %#v, want input 10 output 4", data["compactionUsage"])
		}
	})

	t.Run("cancellation carries the full partial result", func(t *testing.T) {
		err := error(&BoundedCompactionCancelledError{Result: CompactionResult{
			Calls: 1, EstimatedSpend: 100, DurationMs: 7,
			Usage:             CompactionUsage{InputTokens: 42},
			SourceFingerprint: strings.Repeat("ab", 32),
		}})
		data := compactionErrorData(err)
		if data["compactionReason"] != "cancelled" {
			t.Fatalf("compactionReason = %v, want cancelled", data["compactionReason"])
		}
		if data["calls"] != 1 || data["estimatedSpend"] != int64(100) {
			t.Fatalf("calls/spend = %v/%v, want 1/100", data["calls"], data["estimatedSpend"])
		}
		if _, ok := data["durationMs"]; !ok {
			t.Fatalf("cancelled data lacks durationMs: %v", data)
		}
	})

	t.Run("unrelated errors carry nothing", func(t *testing.T) {
		if data := compactionErrorData(errors.New("boom")); data != nil {
			t.Fatalf("compactionErrorData = %v, want nil", data)
		}
	})
}

// TestCompactionFailureAccountingOnErrorItem drives the strategy loop into the
// terminal case — the user's own newest message alone exceeds the window — and
// asserts the durable error item carries the recovery's failure accounting.
func TestCompactionFailureAccountingOnErrorItem(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "old-0", Content: "small old question"})

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
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			hiddenCalls++
			return nil, errors.New("unexpected hidden call for an unrecoverable request")
		}
		realCalls++
		return nil, recoveryLimitErr()
	}

	// The user's own message is the newest unit and alone exceeds the window:
	// recovery cannot fold anything, so the turn fails terminally.
	w.runStrategyLoop(strings.Repeat("x", 25_000), false)

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
		case ItemTypeCompactionSummary:
			t.Fatal("a compaction summary was committed for an unrecoverable request")
		}
	}
	if errorItem == nil {
		t.Fatal("no error item after a terminal recovery failure")
	}
	var data map[string]any
	if err := json.Unmarshal(errorItem.Data, &data); err != nil {
		t.Fatalf("error item data does not unmarshal: %v (raw %q)", err, errorItem.Data)
	}
	if data["compactionReason"] != string(BoundedCompactionContextBound) {
		t.Fatalf("error item compactionReason = %v, want context_bound", data["compactionReason"])
	}
	if data["provider"] != "test" || data["model"] != "test" {
		t.Fatalf("error item provider/model = %v/%v, want test/test", data["provider"], data["model"])
	}
}
