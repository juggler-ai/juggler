//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// checkForNewThreads: which doc-inserted threads the reducer picks up and runs,
// and which it must ignore — completed, unflagged, busy, or cancelled.

func TestCheckForNewThreads_ProcessesNeedsStrategyRun(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)

	// Set up mock mode BEFORE creating thread (observer fires during creation)
	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Summary of conversation"},
			},
			StopReason: "end_turn",
		},
	})
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Feed context and tools results for the LLM call
	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "You are a helpful assistant.",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []any{},
		})
		w.engine.contextReply.inject(w.done, ctxResponse)
		w.engine.toolsReply.inject(w.done, toolsResponse)
	}()

	// Create a thread with needsStrategyRun=true and a user message
	// The observer fires during creation and auto-processes the thread
	threadID := insertThreadWithOpts(w, threadOpts{goal: "Compaction thread", needsStrategyRun: true, userMessage: "Summarize this conversation"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}
	w.quiesce(t)

	// Verify the worker processed it
	threadYMap := w.doc.GetThreadYMap(threadID)
	if threadYMap == nil {
		t.Fatal("thread Y.Map not found after processing")
	}
	result, _ := threadYMap.Get("result").(string)
	if result == "" {
		t.Fatal("thread should have a result after processing")
	}
	if result != "Summary of conversation" {
		t.Errorf("thread result = %q, want %q", result, "Summary of conversation")
	}

	// Worker should be back to idle
	if w.currentRun().loadState() != StateIdle {
		t.Errorf("worker state = %v, want StateIdle", w.currentRun().loadState())
	}

	w.doc.Destroy()
}

// TestCompactionSubthread_DrainsRootQueueOnCompletion reproduces the /compact
// orphaned-queue bug: a needsStrategyRun sub-thread (exactly what /compact
// inserts, noAutoSelect and all) runs to completion while the
// user has queued a follow-up at the ROOT. Because the sub-thread's loop is
// scoped to its own thread, its end-of-run drain only ever checks the sub-
// thread's own queue, and signalParentThread declines to re-drive the parent
// (a compaction thread is not llmCreated). Nothing else drains the root queue,
// so the queued message is stranded at idle. The completion path must drain the
// root queue itself and drive a turn to answer it.
func TestCompactionSubthread_DrainsRootQueueOnCompletion(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Two calls through the shared transport (callLLMWithSink pops the mock queue
	// in order): (1) the bounded reducer's hidden compaction probe, whose reply
	// text becomes the thread summary (the probe is tool-free); (2) the queued
	// root follow-up is answered by a normal strategy turn. If the root queue is
	// never drained, the follow-up is never answered and its scripted response is
	// left unconsumed.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Summary of conversation"}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "answer to follow-up"}}, StopReason: "end_turn"},
	})

	// Continuous ctx/tools feeders so each dispatched turn completes.
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

	// The user queued a follow-up at the ROOT while compaction was in flight.
	w.enqueuePendingMessage("", UserMessageInput{Text: "follow-up while compacting"})

	// Insert the compaction sub-thread. handleItemsChange → checkForNewThreads
	// posts the pickup; quiescing the actor runs the compaction loop, its
	// completion defer and whatever root turn that completion asks for.
	threadID := insertThreadWithOpts(w, threadOpts{
		goal: "Compacted conversation history", needsStrategyRun: true,
		noAutoSelect: true, boundedCompaction: true,
		userMessage: "prior conversation history to summarize",
	})

	w.quiesce(t)

	// Compaction closed with its result.
	threadYMap := w.doc.GetThreadYMap(threadID)
	if got, _ := threadYMap.Get("result").(string); got != "Summary of conversation" {
		t.Fatalf("compaction thread result = %q, want %q", got, "Summary of conversation")
	}

	// The root queue must be drained — the crux of the bug.
	if w.HasPendingItems("") {
		t.Fatal("root pending queue was NOT drained after the compaction sub-thread completed — the queued follow-up is stranded")
	}

	// The follow-up must have been promoted to a root user item AND answered.
	items := w.doc.GetItems()
	var sawFollowUp, sawAnswer bool
	for _, it := range items {
		if it.Type == ItemTypeUser && it.Content == "follow-up while compacting" {
			sawFollowUp = true
		}
		if it.Type == ItemTypeAssistant && it.Content == "answer to follow-up" {
			sawAnswer = true
		}
	}
	if !sawFollowUp {
		t.Errorf("queued follow-up was never promoted into the root items; items=%+v", items)
	}
	if !sawAnswer {
		t.Errorf("queued follow-up was never answered by a root turn; items=%+v", items)
	}

	// Both scripted turns must have been consumed.
	if n := w.mock.remaining(); n != 0 {
		t.Fatalf("expected both scripted turns consumed, %d left", n)
	}

	if w.currentRun().loadState() != StateIdle {
		t.Errorf("worker state = %v, want StateIdle", w.currentRun().loadState())
	}
}

func TestCheckForNewThreads_IgnoresThreadWithoutFlag(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)

	// Create a thread WITHOUT needsStrategyRun (simulates /thread command)
	threadID := insertThreadWithOpts(w, threadOpts{goal: "User thread", userMessage: "Hello world"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// checkForNewThreads should NOT process this thread
	w.currentRun().checkForNewThreads()

	// Worker should still be idle (didn't start processing)
	if w.currentRun().loadState() != StateIdle {
		t.Errorf("worker state = %v, want StateIdle (should not process thread without flag)", w.currentRun().loadState())
	}

	// Thread should have no result
	threadYMap := w.doc.GetThreadYMap(threadID)
	result, _ := threadYMap.Get("result").(string)
	if result != "" {
		t.Errorf("thread should have no result, got %q", result)
	}

	w.doc.Destroy()
}

func TestCheckForNewThreads_IgnoresCompletedThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)

	// Create a thread with needsStrategyRun AND a result (already completed, single transaction)
	threadID := insertThreadWithOpts(w, threadOpts{
		goal: "Done thread", needsStrategyRun: true, userMessage: "Summarize", result: "Already summarized",
	})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// checkForNewThreads should NOT process this (already has result)
	w.currentRun().checkForNewThreads()

	// Result should be unchanged
	threadYMap := w.doc.GetThreadYMap(threadID)
	result, _ := threadYMap.Get("result").(string)
	if result != "Already summarized" {
		t.Errorf("thread result = %q, want %q", result, "Already summarized")
	}

	w.doc.Destroy()
}

// TestCheckForNewThreads_IgnoresWhenBusy: a write-capable turn already live is
// what makes the conversation busy for a pickup — the registry's one writer slot
// is taken — so the thread is neither claimed nor dispatched, and its one-shot
// trigger stays armed for the reducer pass after that turn retires.
func TestCheckForNewThreads_IgnoresWhenBusy(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	busy := w.currentRun().beginTurn("") // a root turn is streaming
	t.Cleanup(func() {
		w.sched.unregister(busy.t)
		w.sched.releaseActivity()
	})

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Queued thread", needsStrategyRun: true, userMessage: "Summarize"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	if w.currentRun().checkForNewThreads() {
		t.Fatal("checkForNewThreads picked a thread up beside a live write-capable turn")
	}
	if n := len(w.sched.dispatchQueue); n != 0 {
		t.Fatalf("%d run(s) dispatched while the worker was busy, want 0", n)
	}
	if got := w.threadActivity(threadID); got != ActivityNone {
		t.Errorf("thread claimed while the worker was busy: activity = %q", got)
	}
	ymap := w.doc.GetThreadYMap(threadID)
	ycrdtMu.Lock()
	armed, _ := ymap.Get("needsStrategyRun").(bool)
	ycrdtMu.Unlock()
	if !armed {
		t.Error("needsStrategyRun was consumed by a pickup that never ran")
	}
	if !w.sched.reconcilePending() {
		t.Error("a refused pickup left no reconcile armed to revisit it")
	}
}

func TestCheckForNewThreads_SkipsCompletedThreads(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)

	// Set up mock mode BEFORE creating thread (observer fires during creation)
	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "First run"},
			},
			StopReason: "end_turn",
		},
	})
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Feed context and tools results
	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "You are a helpful assistant.",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []any{},
		})
		w.engine.contextReply.inject(w.done, ctxResponse)
		w.engine.toolsReply.inject(w.done, toolsResponse)
	}()

	// Creating the thread triggers processing via observer
	threadID := insertThreadWithOpts(w, threadOpts{goal: "Once-only thread", needsStrategyRun: true, userMessage: "Summarize"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}
	w.quiesce(t)

	threadYMap := w.doc.GetThreadYMap(threadID)
	result, _ := threadYMap.Get("result").(string)
	if result != "First run" {
		t.Fatalf("thread result = %q, want %q", result, "First run")
	}

	// Second call — skipped because the thread already has a result.
	// No mock responses needed (won't reach LLM).
	w.currentRun().checkForNewThreads()

	result, _ = threadYMap.Get("result").(string)
	if result != "First run" {
		t.Errorf("thread result changed unexpectedly: got %q, want %q", result, "First run")
	}

	w.doc.Destroy()
}

func TestCheckForNewThreads_CancelDoesNotRetriggerNeedsStrategyRunThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	ctxResponse, _ := json.Marshal(map[string]any{
		"type":         "render-context-items-result",
		"systemPrompt": "You are a helpful assistant.",
		"contexts":     []any{},
	})
	toolsResponse, _ := json.Marshal(map[string]any{
		"type":  "tools-result",
		"tools": []any{},
	})
	w.engine.contextReply.inject(w.done, ctxResponse)
	w.engine.toolsReply.inject(w.done, toolsResponse)

	calls := 0
	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		calls++
		cancelLiveRuns(w)
		return nil, ErrCancelled
	}

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Cancellable thread", needsStrategyRun: true, userMessage: "Summarize"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}
	w.quiesce(t)

	if calls != 1 {
		t.Fatalf("LLM calls after initial cancellation = %d, want 1", calls)
	}
	if w.currentRun().loadState() != StateIdle {
		t.Fatalf("worker state = %v, want StateIdle", w.currentRun().loadState())
	}

	threadYMap := w.doc.GetThreadYMap(threadID)
	if threadYMap == nil {
		t.Fatal("thread Y.Map not found")
	}
	if needsStrategyRun, _ := threadYMap.Get("needsStrategyRun").(bool); needsStrategyRun {
		t.Fatal("needsStrategyRun should be cleared after dispatch/cancel")
	}
	if result, _ := threadYMap.Get("result").(string); result != "" {
		t.Fatalf("cancelled thread result = %q, want empty", result)
	}

	// Simulate the observer firing again after the idle/cancel updates. Before
	// the fix this immediately restarted the same needsStrategyRun thread.
	w.currentRun().handleItemsChange()
	w.quiesce(t)
	if calls != 1 {
		t.Fatalf("LLM calls after observer tick = %d, want 1 (no retrigger)", calls)
	}

	w.doc.Destroy()
}

func TestHandleItemsChange_CancelsWhenCurrentThreadDeleted(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Continuation"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	// Simulate worker mid-processing on this thread
	w.currentRun().storeState(StateProcessing)
	w.turn.thread.itemID = threadID

	// Delete the thread from the doc (simulates browser deletion via Yjs sync)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		w.doc.ensureItems().Delete(ycrdt.Number(0), 1)
	}, w.doc.authorID)

	w.currentRun().handleItemsChange()

	if w.currentRun().loadState() != StateCancelling {
		t.Errorf("worker state = %v, want StateCancelling after current thread deleted", w.currentRun().loadState())
	}

	w.doc.Destroy()
}

// A thread queued for dispatch (awaiting_llm) and then deleted before it ran —
// a rewind past the item that hosts it — leaves its claim standing in
// processingState, which outlives the item. The reducer anchors its walk on that
// claim, finds no items for the vanished thread, and must not read that as an
// empty continuation thread: running it sends the provider a request with no
// messages and no system prompt. The claim is released and nothing is called.
func TestReconcile_DeletedThreadWithStandingClaimDoesNotRun(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Feed context/tools so that a wrong dispatch completes and is counted rather
	// than blocking the test on the context channel.
	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		w.engine.contextReply.inject(w.done, ctxResponse)
		w.engine.toolsReply.inject(w.done, toolsResponse)
	}()

	calls := 0
	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		calls++
		return &LLMResponse{StopReason: "end_turn"}, nil
	}

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Child"})
	if !w.requestLLM(threadID) {
		t.Fatal("requestLLM refused the thread")
	}

	// The rewind: the thread's host item is deleted; its claim is not.
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		w.doc.ensureItems().Delete(ycrdt.Number(0), 1)
	}, w.doc.authorID)
	if w.doc.GetThreadYMap(threadID) != nil {
		t.Fatal("thread still present after delete")
	}

	w.sched.markReconcile()
	w.quiesce(t)

	if calls != 0 {
		t.Fatalf("LLM called %d time(s) for a deleted thread, want 0", calls)
	}
	if got := w.threadActivity(threadID); got != ActivityNone {
		t.Fatalf("deleted thread's claim = %q, want released", got)
	}
}

// The turn itself refuses a thread that no longer exists, whoever dispatched it:
// the reducer is one route to a turn, the pending-request orchestrator and the
// needsStrategyRun pickup are others, and a request built for a vanished thread
// has nothing in it to send.
func TestRunOneTurn_DeletedThreadDoesNotCallLLM(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		w.engine.contextReply.inject(w.done, ctxResponse)
		w.engine.toolsReply.inject(w.done, toolsResponse)
	}()

	calls := 0
	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		calls++
		return &LLMResponse{StopReason: "end_turn"}, nil
	}

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Child"})
	w.requestLLM(threadID)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		w.doc.ensureItems().Delete(ycrdt.Number(0), 1)
	}, w.doc.authorID)

	w.currentRun().dispatchCallLLMOnThread(threadID)
	w.quiesce(t)

	if calls != 0 {
		t.Fatalf("LLM called %d time(s) for a deleted thread, want 0", calls)
	}
}

// =============================================================================
// STREAMING INTEGRITY TESTS
//
// These tests exercise the REAL streaming path: queueStreamChunk → channel →
// worker goroutine → processStreamChunk. The mock path (popMockResponse) calls
// processStreamChunk directly on the same goroutine, completely bypassing the
// channel — which is why it never caught the dropped-chunks bug.
// =============================================================================
