//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"

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
		items := ycrdt.NewYArray()
		items.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: content})})
		items.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: promptID, Content: "orchestration prompt"})})
		thread.Set("items", items)
		w.doc.ensureItems().Push(ycrdt.ArrayAny{thread})
	}, w.doc.authorID)
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	return threadID
}

// TestCompactionFoldKeepsDelegatedRunRecords holds the /compact fold to the same
// contract the recovery fold keeps (see
// TestContextRecoveryKeepsDelegatedRunRecords): a session thread's history folds
// whole, invocation messages included, and the fold carries their run records —
// so the caller still gets one tool_use/tool_result pair per call it made, and
// the session still knows which tool owns it.
func TestCompactionFoldKeepsDelegatedRunRecords(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	_, arr := sessionThreadForTest(t, w, "explore-1", "tu-1", "tu-2")
	wireBefore, err := json.Marshal(appendThreadMessages(nil, w.doc.GetItems()[0], w.doc.GetItems()))
	if err != nil {
		t.Fatal(err)
	}

	foldID, folded, err := w.currentRun().foldConversationForCompaction(false)
	if err != nil || !folded {
		t.Fatalf("foldConversationForCompaction = (%q, %v, %v), want a fold", foldID, folded, err)
	}

	items := w.doc.GetItemsFromArray(arr)
	// [rule, fold(invoc-tu-1, body-tu-1), invoc-tu-2, body-tu-2]
	if len(items) != 4 {
		t.Fatalf("nested items after fold = %s", itemIDs(items))
	}
	if items[0].ItemID != "seeded-rule" {
		t.Fatalf("the fold took the standing context: %s", itemIDs(items))
	}
	if items[1].ItemID != foldID || !items[1].BoundedCompaction {
		t.Fatalf("items[1] = %q, want the new fold thread", items[1].ItemID)
	}
	if items[2].ItemID != "invoc-tu-2" {
		t.Fatalf("the thread's most recent invocation message was folded away: %s", itemIDs(items))
	}
	if len(items[1].FoldedRuns) != 1 || items[1].FoldedRuns[0].ToolUseID != "tu-1" {
		t.Fatalf("the fold dropped the record of the call it swallowed: %+v", items[1].FoldedRuns)
	}

	child := w.doc.GetItems()[0]
	runs := threadRunRecords(child)
	if len(runs) != 2 || runs[0].call.ToolUseID != "tu-1" || runs[1].call.ToolUseID != "tu-2" {
		t.Fatalf("run records after the fold = %+v, want tu-1 then tu-2", runs)
	}
	wireAfter, err := json.Marshal(appendThreadMessages(nil, child, nil))
	if err != nil {
		t.Fatal(err)
	}
	if string(wireAfter) != string(wireBefore) {
		t.Errorf("the fold rewrote the caller's transcript:\n before %s\n after  %s", wireBefore, wireAfter)
	}
	if tool := sessionToolOf(child); tool != "Explore" {
		t.Errorf("session tool after the fold = %q, want Explore — a resume would create instead", tool)
	}
}

// sessionThreadForTest builds a delegated session thread carrying a standing
// rule and one settled run per toolUseID: an invocation message and the body of
// work that run produced.
func sessionThreadForTest(t *testing.T, w *ConversationWorker, name string, toolUseIDs ...string) (string, *ycrdt.YArray) {
	t.Helper()
	threadID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		thread := conversationItemToYMap(ConversationItem{
			Type: ItemTypeThread, ItemID: threadID, Goal: "Research", SessionName: name,
		})
		thread.Set("items", ycrdt.NewYArray())
		w.doc.ensureItems().Push(ycrdt.ArrayAny{thread})
	}, w.doc.authorID)
	arr := w.doc.GetThreadItemsArray(threadID)
	items := []ConversationItem{{Type: "rule", ItemID: "seeded-rule", Content: "a standing rule"}}
	for _, id := range toolUseIDs {
		items = append(items,
			invocationItemForTest("invoc-"+id, id, "answer for "+id),
			ConversationItem{Type: ItemTypeAssistant, ItemID: "body-" + id, Content: "the work behind " + id},
		)
	}
	w.doc.InsertMessageIntoArray(arr, 0, items...)
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = arr
	return threadID, arr
}

// commitFoldSummaryForTest writes a fold's summary the way the summarizer's
// commit does, so a later pass sees a fold that has come to rest rather than
// one still owed a result.
func commitFoldSummaryForTest(t *testing.T, w *ConversationWorker, foldID, summary string) {
	t.Helper()
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(w.doc.getItems(), foldID)
	if m == nil {
		t.Fatalf("fold %s not found", foldID)
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) { m.Set("result", summary) }, w.doc.authorID)
}

// boundedFoldsIn counts the compaction folds among a thread's items.
func boundedFoldsIn(items []ConversationItem) int {
	n := 0
	for _, it := range items {
		if it.Type == ItemTypeThread && it.BoundedCompaction {
			n++
		}
	}
	return n
}

// TestSessionFoldsConvergeToOneSummary is the convergence guard for a long-lived
// session. Every other transcript folds to [standing context][one summary]
// [recent tail]; a session must too, however many times it has been called. Two
// passes here, with a fresh run between them: the second swallows the first's
// summary rather than settling beside it.
//
// The two properties that make that safe are asserted alongside it, because a
// fold that converges by losing them is worse than one that does not converge.
// The caller keeps one tool_use/tool_result pair per call it made, in call
// order, and the pairs for calls that have already returned come back byte for
// byte — everything in an earlier result is frozen at the moment that run
// settled, so a later call cannot slide the committed prefix out from under a
// warm prompt cache.
func TestSessionFoldsConvergeToOneSummary(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	_, arr := sessionThreadForTest(t, w, "explore-1", "tu-1", "tu-2", "tu-3")
	wireBefore, err := json.Marshal(appendThreadMessages(nil, w.doc.GetItems()[0], w.doc.GetItems()))
	if err != nil {
		t.Fatal(err)
	}

	foldID, folded, err := w.currentRun().foldConversationForCompaction(false)
	if err != nil || !folded {
		t.Fatalf("first fold = (%q, %v, %v), want a fold", foldID, folded, err)
	}
	commitFoldSummaryForTest(t, w, foldID, "what the first two runs found")

	// A fourth call lands, and the thread busts its window again.
	w.doc.InsertMessageIntoArray(arr, w.doc.GetItemsLengthFromArray(arr),
		invocationItemForTest("invoc-tu-4", "tu-4", "answer for tu-4"),
		ConversationItem{Type: ItemTypeAssistant, ItemID: "body-tu-4", Content: "the work behind tu-4"},
	)
	secondFoldID, folded, err := w.currentRun().foldConversationForCompaction(false)
	if err != nil || !folded {
		t.Fatalf("second fold = (%q, %v, %v), want a fold", secondFoldID, folded, err)
	}
	commitFoldSummaryForTest(t, w, secondFoldID, "what the first three runs found")

	items := w.doc.GetItemsFromArray(arr)
	if n := boundedFoldsIn(items); n != 1 {
		t.Fatalf("summaries after two passes = %d, want one: %s", n, itemIDs(items))
	}
	if items[0].ItemID != "seeded-rule" {
		t.Errorf("the standing context moved: %s", itemIDs(items))
	}

	child := w.doc.GetItems()[0]
	runs := threadRunRecords(child)
	if len(runs) != 4 {
		t.Fatalf("run records after two folds = %d, want one per call: %+v", len(runs), runs)
	}
	for i, want := range []string{"tu-1", "tu-2", "tu-3", "tu-4"} {
		if runs[i].call.ToolUseID != want {
			t.Errorf("run %d paired against %q, want %q", i+1, runs[i].call.ToolUseID, want)
		}
	}
	if tool := sessionToolOf(child); tool != "Explore" {
		t.Errorf("session tool after two folds = %q, want Explore — a resume would create instead", tool)
	}

	wireAfter, err := json.Marshal(appendThreadMessages(nil, child, nil)[:6])
	if err != nil {
		t.Fatal(err)
	}
	if string(wireAfter) != string(wireBefore) {
		t.Errorf("the folds rewrote already-returned results:\n before %s\n after  %s", wireBefore, wireAfter)
	}
}

// TestCompactRefusesWhileLLMClaimHeld pins the busy guard against the reported
// failure: /compact folded the conversation, the fold appeared as a thread tile,
// and it then sat unrun forever with the conversation reporting idle. The cause
// is that run state and the doc-native LLM claim are separate — a turn can leave
// state Idle while still holding the claim — so the old state-only guard folded
// at a moment the pickup could not claim. A fold that cannot be summarized must
// not be committed at all; say "busy" instead.
func TestCompactRefusesWhileLLMClaimHeld(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0,
		ConversationItem{Type: ItemTypeUser, ItemID: "u1", Content: "do some work"},
		ConversationItem{Type: ItemTypeAssistant, ItemID: "a1", Content: "did some work"},
	)
	// State Idle, claim still held — the exact divergence that stranded the fold.
	w.claimLLM("")
	w.currentRun().storeState(StateIdle)

	payload, _ := json.Marshal(CompactMessage{Type: "compact", AckID: "ack-1"})
	w.currentRun().handleCompact(payload)

	for _, it := range w.doc.GetItems() {
		if it.Type == ItemTypeThread {
			t.Fatalf("compaction folded while the LLM claim was held; the fold can never be summarized and the conversation reports %v", w.currentRun().loadState())
		}
	}
}

// TestStrategyRunThreadRecoveredByReconcileTick pins the other half: a fold that
// IS committed and then loses the claim race must still run. needsStrategyRun is
// consumed only after a successful claim, and the release that frees the claim
// writes processingState rather than items — so the items observer never fires
// again. The reducer tick is the retry; without it the thread waits forever.
func TestStrategyRunThreadRecoveredByReconcileTick(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Recovered summary."}}, StopReason: "end_turn"},
	})

	// A root turn is live when the fold lands, holding the conversation's one
	// write-capable slot, so the observer's pickup is refused admission.
	holder := w.currentRun().beginTurn("")
	w.claimLLM("")
	threadID := insertThreadWithOpts(w, threadOpts{
		goal: "Compacted conversation history", needsStrategyRun: true,
		noAutoSelect: true, boundedCompaction: true, userMessage: "history to summarize",
	})
	if got, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); got != "" {
		t.Fatalf("fold summarized while the claim was held: %q", got)
	}
	if n := len(w.sched.dispatchQueue); n != 0 {
		t.Fatalf("fold was dispatched beside a live write-capable turn (%d queued)", n)
	}
	if !w.sched.reconcilePending() {
		t.Fatal("a fold that lost the claim race left no reconcile armed — nothing will ever revisit it")
	}

	// The in-flight turn ends and is retired, freeing the slot; the reducer ticks.
	w.releaseLLM("")
	w.currentRun().finishRetiredTurn(holder.t)
	w.quiesce(t)

	if got, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); got != "Recovered summary." {
		t.Fatalf("thread result = %q, want the fold summarized once the claim freed", got)
	}
}

// TestResummarizeCompactionThreadRerunsSummarizer pins the Re-summarise route
// for a /compact (or /handoff) fold: the folded summarizer is re-run over the
// SAME source — the committed summary is replaced and nothing is appended to the
// thread. Routing a re-summarise through the ordinary summarise turn instead
// would inject a "summarise this thread" instruction into the very transcript
// being summarized, which the summarizer then feeds back to the model.
func TestResummarizeCompactionThreadRerunsSummarizer(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	threadID := insertBoundedCompactionThread(t, w, "history to summarize")
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		w.doc.GetThreadYMap(threadID).Set("result", "Stale summary.")
	}, w.doc.authorID)
	w.currentRun().resetThreadContext()

	stop := make(chan struct{})
	defer close(stop)
	ctxResp, _ := json.Marshal(map[string]any{
		"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
	})
	toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
	go func() {
		for {
			if !w.engine.contextReply.inject(stop, ctxResp) {
				return
			}
		}
	}()
	go func() {
		for {
			if !w.engine.toolsReply.inject(stop, toolsResp) {
				return
			}
		}
	}()

	itemsBefore := len(w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID)))
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Fresh summary."}}, StopReason: "end_turn"},
	})

	payload, _ := json.Marshal(ResummarizeCompactionThreadMessage{
		Type: "resummarize-compaction-thread", ThreadItemID: threadID,
	})
	w.currentRun().handleResummarizeCompactionThread(payload)
	w.quiesce(t)

	if got, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); got != "Fresh summary." {
		t.Fatalf("thread result = %q, want the regenerated summary", got)
	}
	if itemsAfter := len(w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))); itemsAfter != itemsBefore {
		t.Fatalf("thread items = %d, want %d unchanged — re-summarise must not append to the source", itemsAfter, itemsBefore)
	}
}

// TestRunFoldedThreadCompactionOnePassAppendsPrompt pins the cache-preserving
// probe: ordinary history remains a message prefix and the summary instruction
// is appended as the final user message rather than replacing the system prompt.
func TestRunFoldedThreadCompactionOnePassAppendsPrompt(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	threadID := insertBoundedCompactionThread(t, w, "a short conversation history to summarize")

	calls := 0
	var sawReq hiddenLLMRequest
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		if err := json.Unmarshal(raw, &sawReq); err != nil {
			t.Fatal(err)
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "the handoff summary"}}}, nil
	}

	probeTools := []ToolDefinition{{Name: "edit", Description: "Edit a file", InputSchema: json.RawMessage(`{"type":"object"}`)}}
	handled, err := w.currentRun().runFoldedThreadCompaction(&ModelConfig{Provider: "test", Model: "test"}, &ContextResult{SystemPrompt: "ordinary system prompt"}, probeTools)
	if !handled || err != nil {
		t.Fatalf("runFoldedThreadCompaction = (%v, %v), want handled success", handled, err)
	}
	if calls != 1 {
		t.Fatalf("hidden calls = %d, want a single one-pass probe", calls)
	}
	if sawReq.SystemPrompt != "ordinary system prompt" {
		t.Fatalf("folded probe system prompt = %q, want ordinary prompt unchanged", sawReq.SystemPrompt)
	}
	if len(sawReq.Messages) != 2 || sawReq.Messages[0].Content != "a short conversation history to summarize" || sawReq.Messages[1].Content != DefaultSummarizationPrompt {
		t.Fatalf("folded probe messages = %#v, want history plus appended summary prompt", sawReq.Messages)
	}
	if sawReq.ThreadID != "" || len(sawReq.Tools) != 1 || sawReq.Tools[0].Name != "edit" {
		t.Fatalf("folded probe identity/tools = (%q, %#v), want parent request shape", sawReq.ThreadID, sawReq.Tools)
	}
	// It borrows the parent thread's id, so an unmarked probe would file its own
	// measurement as that thread's measured prefix — the one hidden call that can
	// overwrite a real anchor rather than merely add one.
	if !sawReq.SyntheticTranscript {
		t.Fatal("folded probe was not marked synthetic, so its measurement would anchor the parent thread")
	}
	if fmt.Sprint(sawReq.ToolChoice["mode"]) != provider.ToolChoiceNone {
		t.Fatalf("folded probe tool choice = %#v, want tools preserved but disabled", sawReq.ToolChoice)
	}
	thread := w.doc.GetThreadYMap(threadID)
	if got, _ := thread.Get("result").(string); got != "the handoff summary" {
		t.Fatalf("thread result = %q, want %q", got, "the handoff summary")
	}
}

// TestRunFoldedThreadCompactionProbeOverflowChunks pins the probe-then-reduce
// fallback: when the one-pass probe is rejected as too large, the reported
// window seeds the bounded reducer to map/reduce, and the final summary is still
// committed.
func TestRunFoldedThreadCompactionProbeOverflowChunks(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
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
			// The probe (whole transcript) and any oversized map chunk are
			// rejected with the real window, driving the reducer to split.
			return nil, &provider.ContextLimitExceededError{EstimatedInputTokens: estimate, OutputReserveTokens: reserve, ContextWindowTokens: window}
		}
		// Every compaction call is tool-free, so map and final are told apart by
		// their system prompt, not by whether tools were offered.
		if req.SystemPrompt != boundedCompactionMapPrompt {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "final compact summary"}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}

	handled, err := w.currentRun().runFoldedThreadCompaction(&ModelConfig{Provider: "test", Model: "test"}, &ContextResult{}, nil)
	if !handled || err != nil {
		t.Fatalf("runFoldedThreadCompaction = (%v, %v), want handled success after overflow", handled, err)
	}
	if calls < 3 {
		t.Fatalf("hidden calls = %d, want probe overflow plus map(s) plus final", calls)
	}
	thread := w.doc.GetThreadYMap(threadID)
	if got, _ := thread.Get("result").(string); got != "final compact summary" {
		t.Fatalf("thread result = %q, want %q", got, "final compact summary")
	}
}

// TestFoldedCompactionPublishesBusyStatus pins the only sign of life a
// summarizer run gives the UI. Every one of its LLM calls is hidden, so nothing
// streams into the transcript and no item lands while it works: the doc's
// processingState is the sole thing the spinner, its label, and the elapsed
// digit are driven from. A run that leaves the previous turn's resting "idle"
// frame in place is indistinguishable from a conversation doing nothing.
func TestFoldedCompactionPublishesBusyStatus(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	// The resting frame every real /compact starts from: the preceding turn ended
	// at idle, and the pickup's claim deliberately leaves status untouched.
	w.currentRun().sendStatus("idle", "")
	insertBoundedCompactionThread(t, w, "history to summarize")

	var sawStatus, sawMessage string
	var sawStarted bool
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		state := w.readProcessingState()
		sawStatus, _ = state["status"].(string)
		sawMessage, _ = state["message"].(string)
		_, sawStarted = state["startedAt"]
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "the handoff summary"}}}, nil
	}

	handled, err := w.currentRun().runFoldedThreadCompaction(&ModelConfig{Provider: "test", Model: "test"}, &ContextResult{}, nil)
	if !handled || err != nil {
		t.Fatalf("runFoldedThreadCompaction = (%v, %v), want handled success", handled, err)
	}
	if sawStatus != "compacting" {
		t.Fatalf("processingState.status during the summarizer call = %q, want %q — the run is invisible to the UI", sawStatus, "compacting")
	}
	if sawMessage == "" {
		t.Fatal("processingState.message during the summarizer call is empty — the spinner has no label")
	}
	if !sawStarted {
		t.Fatal("processingState.startedAt missing during the summarizer call — the spinner shows no elapsed time")
	}
}

func TestBoundedCompactionMapsReducesAndPublishesOnlyFinalResult(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
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
		if req.SystemPrompt != boundedCompactionMapPrompt {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "final compact summary"}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
	}

	handled, err := w.currentRun().tryBoundedCompaction(&provider.ContextLimitExceededError{
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

func TestBoundedCompactionPinsRejectedRequestModel(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
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
		if req.SystemPrompt != boundedCompactionMapPrompt {
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "done"}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "short"}}}, nil
	}
	_, err := w.currentRun().tryBoundedCompaction(&provider.ContextLimitExceededError{EstimatedInputTokens: 3_000, OutputReserveTokens: 300, ContextWindowTokens: 3000}, pinned)
	if err != nil {
		t.Fatal(err)
	}
	if calls < 2 {
		t.Fatalf("calls = %d, want map and final", calls)
	}
}

func TestCanonicalCompactionRecordsStripDisplaySnapshots(t *testing.T) {
	large := strings.Repeat("whole file contents", 1000)
	prompt := ConversationItem{Type: ItemTypeUser, ItemID: "prompt", Content: "exclude me"}
	source := ConversationItem{
		Type: ItemTypeToolAction, ItemID: "item", ToolUseID: "tool-use", ToolName: "edit",
		ToolInput: json.RawMessage(`{"file_path":"file.txt","old_string":"before","new_string":"after"}`), State: StateCompleted,
		ApprovalOptions: json.RawMessage(`[{"option":"allow"}]`), DisplayData: json.RawMessage(`{"diffData":{"oldContent":` + mustJSON(t, large) + `,"newContent":` + mustJSON(t, large) + `}}`),
		Result:        json.RawMessage(`{"content":"Edited file: file.txt","isError":false,"fullResult":{"displayData":{"diffData":{"oldContent":` + mustJSON(t, large) + `,"newContent":` + mustJSON(t, large) + `}}}}`),
		TransactionID: "transaction", TaskSource: &TaskSourceRef{TaskID: "task", Label: "monitor"},
	}
	records, err := canonicalCompactionRecords([]ConversationItem{prompt, source}, prompt.ItemID)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("records = %d, want 1", len(records))
	}
	if strings.Contains(records[0], large) || strings.Contains(records[0], "displayData") || strings.Contains(records[0], "fullResult") {
		t.Fatalf("canonical record retained UI snapshot: %s", records[0][:min(len(records[0]), 500)])
	}
	if !strings.Contains(records[0], `Edited file: file.txt`) || !strings.Contains(records[0], `old_string`) {
		t.Fatalf("canonical record lost semantic tool data: %s", records[0])
	}
	if len(records[0]) >= len(large) {
		t.Fatalf("canonical record length = %d, want smaller than one file snapshot (%d)", len(records[0]), len(large))
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestCanonicalCompactionRecordsFailClosedOnMarshalError(t *testing.T) {
	// A thinking item carries providerData onto the wire, so an unmarshalable
	// value there reaches json.Marshal and must fail closed with item identity.
	items := []ConversationItem{{
		Type: ItemTypeThinking, ItemID: "bad", Content: "reasoning", ProviderData: map[string]any{"invalid": math.NaN()},
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

// TestSummarizationPromptDeclaresScratchpadStripped pins the prompt's contract:
// the summary IS the response text, so the prompt must tell the model its
// <analysis> scratchpad is discarded — otherwise it is asked to both write the
// block and not return it.
func TestSummarizationPromptDeclaresScratchpadStripped(t *testing.T) {
	if !strings.Contains(DefaultSummarizationPrompt, "it is stripped from the stored summary") {
		t.Fatalf("summarization prompt does not tell the model its <analysis> scratchpad is stripped:\n%s", DefaultSummarizationPrompt)
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
	id, reason := w.resolveCompactionPromptItemID("missing", items)
	if reason != "" || id != "prompt" {
		t.Fatalf("legacy prompt = (%q, %q), want provable prompt", id, reason)
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
	if _, reason := w.resolveCompactionPromptItemID("missing", items); reason != BoundedCompactionUnsafeLegacyPrompt {
		t.Fatalf("unprovable legacy prompt reason = %q, want %q", reason, BoundedCompactionUnsafeLegacyPrompt)
	}
}

// TestBoundedCompactionMissingPromptDistinctFromLegacy pins N5: a marked thread
// whose recorded compactionPromptItemId no longer resolves reports the distinct
// BoundedCompactionMissingPrompt reason, not the legacy-prompt reason.
func TestBoundedCompactionMissingPromptDistinctFromLegacy(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	threadID := insertBoundedCompactionThread(t, w, strings.Repeat("source ", 50))

	// Point the thread at a prompt item id that does not exist in its items.
	m := w.doc.GetThreadYMap(threadID)
	if m == nil {
		t.Fatal("thread map missing")
	}
	ycrdtMu.Lock()
	m.Set("compactionPromptItemId", "does-not-exist")
	ycrdtMu.Unlock()

	items := w.currentRun().getTargetItems()
	id, reason := w.resolveCompactionPromptItemID(threadID, items)
	if id != "" || reason != BoundedCompactionMissingPrompt {
		t.Fatalf("resolve = (%q, %q), want ('', %q)", id, reason, BoundedCompactionMissingPrompt)
	}
}

func TestBoundedCompactionRejectsNonConvergence(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	insertBoundedCompactionThread(t, w, strings.Repeat("source ", 2000))
	w.llmCallFunc = func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		_ = json.Unmarshal(raw, &req)
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: strings.Repeat("expanded ", 3000)}}}, nil
	}
	_, err := w.currentRun().tryBoundedCompaction(&provider.ContextLimitExceededError{OutputReserveTokens: 200, ContextWindowTokens: 1800}, &ModelConfig{Provider: "test", Model: "test"})
	if err == nil || !strings.Contains(err.Error(), "no progress") {
		t.Fatalf("error = %v, want no progress", err)
	}
}

func TestBoundedCompactionCancellationPublishesNothing(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	threadID := insertBoundedCompactionThread(t, w, strings.Repeat("source ", 2000))
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		w.currentRun().storeState(StateCancelling)
		return nil, context.Canceled
	}
	_, err := w.currentRun().tryBoundedCompaction(&provider.ContextLimitExceededError{OutputReserveTokens: 200, ContextWindowTokens: 1800}, &ModelConfig{Provider: "test", Model: "test"})
	if !errors.Is(err, errBoundedCompactionCancelled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	result, _ := w.doc.GetThreadYMap(threadID).Get("result").(string)
	if result != "" {
		t.Fatalf("partial result was published: %q", result)
	}
}

func TestBoundedCompactionCancellationCarriesPartialAccounting(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	insertBoundedCompactionThread(t, w, strings.Repeat("source ", 2000))
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		w.currentRun().storeState(StateCancelling)
		return nil, context.Canceled
	}
	_, err := w.currentRun().tryBoundedCompaction(&provider.ContextLimitExceededError{OutputReserveTokens: 200, ContextWindowTokens: 1800}, &ModelConfig{Provider: "test", Model: "test"})
	if !errors.Is(err, errBoundedCompactionCancelled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	var cancelled *BoundedCompactionCancelledError
	if !errors.As(err, &cancelled) {
		t.Fatalf("error = %T, want partial-accounting cancellation", err)
	}
	if cancelled.Result.Calls != 2 {
		t.Fatalf("partial calls = %d, want rejected request plus first hidden attempt", cancelled.Result.Calls)
	}
	if cancelled.Result.EstimatedSpend <= 0 || cancelled.Result.SourceFingerprint == "" {
		t.Fatalf("partial accounting lost: %+v", cancelled.Result)
	}
}

func TestBoundedCompactionDoesNotHandleRoot(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	handled, err := w.currentRun().tryBoundedCompaction(&provider.ContextLimitExceededError{ContextWindowTokens: 100}, &ModelConfig{Provider: "test", Model: "test"})
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
	t         *testing.T
	window    int64
	reserve   int64
	submits   int
	threadIDs []string
	// scripted, when set, supplies the stream for a visible turn instead of the
	// fixed hidden-compaction chunks below, and reports what to answer with.
	scripted func(req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error)
}

// assertFits is the invariant every dispatch must satisfy, checked at the point
// a request would really go on the wire: nothing reaches a provider over its
// context window unless the caller deliberately said so with BypassContextGuard.
//
// It lives in the stub rather than in one test so that every test driving turns
// through this conversation enforces it for free. Both compaction bugs it now
// guards against — a request dispatched over budget mid-tool-chain, and history
// folded at a moment that did not help — were invisible to a suite that only
// ever asserted on the internals of a fold.
func (cv *compactionAdmissionConversation) assertFits(req provider.MessageRequest) {
	if cv.t == nil || cv.window <= 0 || req.BypassContextGuard {
		return
	}
	cv.t.Helper()
	reserve := cv.reserve
	if req.MaxOutputTokens > 0 && req.MaxOutputTokens < reserve {
		reserve = req.MaxOutputTokens
	}
	estimate := provider.EstimateMessageRequestTokenBreakdown(req, 0).Total
	if estimate+reserve > cv.window {
		cv.t.Errorf("dispatch %d went out over the window: %d estimated + %d reserved > %d",
			cv.submits+1, estimate, reserve, cv.window)
	}
}

func (cv *compactionAdmissionConversation) Submit(_ context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	cv.assertFits(req)
	cv.submits++
	cv.threadIDs = append(cv.threadIDs, req.ThreadID)
	if cv.scripted != nil {
		return cv.scripted(req, callback)
	}
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
func (cv *compactionAdmissionConversation) Cancel(string)               {}
func (cv *compactionAdmissionConversation) Close() error                { return nil }

func openCompactionAdmissionConversation(t *testing.T, window, reserve int64) (*compactionAdmissionConversation, provider.Conversation) {
	t.Helper()
	underlying := &compactionAdmissionConversation{t: t, window: window, reserve: reserve}
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
	w.currentRun().storeState(StateProcessing)
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
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "submit_summary", Input: json.RawMessage(`{"summary":"admitted final"}`)}}}, nil
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "short"}}}, nil
	}

	handled, err := w.currentRun().tryBoundedCompaction(&provider.ContextLimitExceededError{
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

	// A hidden compaction request carries its own bounded pack/split controller,
	// so it bypasses the admission ceiling and dispatches however large it looks —
	// and its stream still reaches the caller's callback.
	dispatchedUnderlying, dispatched := openCompactionAdmissionConversation(t, 100, 20)
	oversized := provider.MessageRequest{
		Messages:           []provider.Message{{Type: "user", Content: strings.Repeat("oversized ", 1000)}},
		BypassContextGuard: true,
	}
	callbackCalls := 0
	_, err = dispatched.Submit(context.Background(), oversized, func(provider.StreamChunk) (*provider.ToolResult, error) {
		callbackCalls++
		return nil, nil
	})
	if err != nil {
		t.Fatalf("estimated oversized request rejected: %v", err)
	}
	if dispatchedUnderlying.submits != 1 || callbackCalls == 0 {
		t.Fatalf("oversized dispatch = submits %d callbacks %d, want provider and callback invoked", dispatchedUnderlying.submits, callbackCalls)
	}
}

func TestCompactionResponseTextJoinsTextBlocks(t *testing.T) {
	tests := []struct {
		name   string
		blocks []LLMResponseBlock
		want   string
	}{
		{name: "text blocks joined, thinking ignored", blocks: []LLMResponseBlock{
			{Type: provider.ContentBlockTypeText, Content: "first "},
			{Type: provider.ContentBlockTypeThinking, Content: "ignored"},
			{Type: provider.ContentBlockTypeText, Content: "second"},
		}, want: "first second"},
		{name: "leading scratchpad stripped from text", blocks: []LLMResponseBlock{
			{Type: provider.ContentBlockTypeText, Content: "<analysis>walked the log</analysis>\n\n1. Intent"},
		}, want: "1. Intent"},
		// The summary is the response text: a tool_use block is never the
		// deliverable, since no compaction call offers a tool to call.
		{name: "tool call contributes nothing", blocks: []LLMResponseBlock{
			{Type: provider.ContentBlockTypeToolUse, Name: "submit_summary", Input: json.RawMessage(`{"summary":"tool result"}`)},
			{Type: provider.ContentBlockTypeText, Content: "the summary"},
		}, want: "the summary"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := compactionResponseText(&LLMResponse{Blocks: test.blocks}); got != test.want {
				t.Fatalf("compactionResponseText = %q, want %q", got, test.want)
			}
		})
	}
}

func TestStripAnalysisScratchpad(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{name: "no tag passes through", in: "1. Intent\n2. Files", want: "1. Intent\n2. Files"},
		{name: "leading block dropped", in: "<analysis>chronological walk</analysis>\n\n1. Intent", want: "1. Intent"},
		{name: "whole summary wrapped is unwrapped", in: "  <analysis>\n1. Intent\n2. Files\n</analysis>  ", want: "1. Intent\n2. Files"},
		{name: "unclosed tag is a wrapper", in: "<analysis>\n1. Intent\n2. Files", want: "1. Intent\n2. Files"},
		{name: "tag mid-text untouched", in: "1. Intent mentions <analysis> literally", want: "1. Intent mentions <analysis> literally"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := stripAnalysisScratchpad(test.in); got != test.want {
				t.Fatalf("stripAnalysisScratchpad = %q, want %q", got, test.want)
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
	if !w.writeBoundedCompactionResult(threadID, CompactionResult{Summary: "final result"}) {
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
