//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// strategyPreamble sets up the standard prerequisites for strategy loop tests:
// mock engine, model config metadata. Returns the TestSession.
func strategyPreamble(t *testing.T) *helpers.TestSession {
	t.Helper()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine(worker.ToolDefinition{Name: "bash"})
	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})
	return ts
}

// triggerSendMessage sends a user message through the manager to trigger the strategy loop.
func triggerSendMessage(ts *helpers.TestSession, text string) {
	payload, _ := json.Marshal(worker.SendMessageMessage{
		Type: "send-message",
		Text: text,
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", payload, nil)
}

// completeToolAction simulates the browser completing a tool by setting state and result.
func completeToolAction(t *testing.T, ts *helpers.TestSession, toolUseID, resultContent string) {
	t.Helper()
	if err := ts.GetDocument().UpdateItemByToolUseID(toolUseID, "state", worker.StateCompleted); err != nil {
		t.Fatalf("Failed to set tool-action state %q: %v", toolUseID, err)
	}
	if err := ts.GetDocument().UpdateItemByToolUseID(toolUseID, "result", map[string]any{
		"content": resultContent,
		"isError": false,
	}); err != nil {
		t.Fatalf("Failed to complete tool-action %q: %v", toolUseID, err)
	}
}

// waitForToolAction waits for a tool-action with the given toolUseID to appear in the document.
func waitForToolAction(t *testing.T, ts *helpers.TestSession, toolUseID string) {
	t.Helper()
	err := helpers.WaitForItem(t, ts.Worker, fmt.Sprintf("tool-action %q", toolUseID), func(item worker.ConversationItem) bool {
		return item.ToolUseID == toolUseID
	})
	if err != nil {
		t.Fatalf("Tool-action %q did not appear: %v", toolUseID, err)
	}
}

// TestStrategyLoopTextResponse tests the complete flow: send-message → LLM text response → idle.
func TestStrategyLoopTextResponse(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)
	seq := ts.SetLLMSequence(helpers.TextResponse("Hello from LLM"))

	triggerSendMessage(ts, "Hi there")

	// Wait for assistant response to appear (proves the full strategy loop ran)
	err := helpers.WaitForItem(t, ts.Worker, "the assistant reply", func(item worker.ConversationItem) bool {
		return item.Type == "assistant" && item.Content == "Hello from LLM"
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Assistant response did not appear: %v", err)
	}

	if seq.CallCount() != 1 {
		t.Fatalf("Expected 1 LLM call, got %d", seq.CallCount())
	}

	// Verify document: user message exists and is stamped with the round-trip's
	// transaction id. Items inserted during a round-trip share the same id;
	// the corresponding blob is stored on disk via TransactionStore.
	items := ts.GetDocument().GetItems()
	var userTxnID string
	hasUser := false
	for _, item := range items {
		if item.Type == "user" {
			hasUser = true
			userTxnID = item.TransactionID
		}
	}
	if !hasUser {
		t.Fatal("Document missing user message")
	}
	if userTxnID == "" {
		t.Fatal("User message missing transactionId — should be stamped after the round-trip completes")
	}

	t.Log("SUCCESS: Strategy loop processes text response end-to-end")
}

// TestStrategyLoopToolUseAndBatchComplete tests: LLM returns tool_use → tool completes → LLM returns text.
func TestStrategyLoopToolUseAndBatchComplete(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)
	ts.SetLLMSequence(
		helpers.ToolUseResponse("tool-1", "bash", map[string]any{"command": "echo hello"}),
		helpers.TextResponse("Tool finished successfully"),
	)

	triggerSendMessage(ts, "Run a command")

	// Wait for tool-action to appear
	waitForToolAction(t, ts, "tool-1")

	// Simulate browser executing the tool and setting result
	completeToolAction(t, ts, "tool-1", "hello\n")

	// Wait for the second LLM call's output to appear. With non-blocking
	// tool wait the worker goes idle between tool dispatch and the next
	// LLM call, so the worker being idle isn't a reliable gate.
	err := helpers.WaitForDocument(t, ts.Worker, "the tool result and the second reply", func(doc *worker.ConversationDocument) bool {
		items := doc.GetItems()
		hasUser := false
		hasToolWithResult := false
		hasAssistant := false
		for _, item := range items {
			switch {
			case item.Type == "user":
				hasUser = true
			case item.Type == "tool-action" && item.ToolUseID == "tool-1" && len(item.Result) > 0:
				hasToolWithResult = true
			case item.Type == "assistant" && item.Content == "Tool finished successfully":
				hasAssistant = true
			}
		}
		return hasUser && hasToolWithResult && hasAssistant
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Document missing expected items: %v", err)
	}

	t.Log("SUCCESS: Strategy loop handles tool_use → batch complete → text response")
}

// TestStrategyLoopMultipleIterations tests multiple tool_use iterations before final text.
func TestStrategyLoopMultipleIterations(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)
	ts.SetLLMSequence(
		helpers.ToolUseResponse("iter-tool-1", "bash", map[string]any{"command": "ls"}),
		helpers.ToolUseResponse("iter-tool-2", "bash", map[string]any{"command": "pwd"}),
		helpers.TextResponse("All done"),
	)

	triggerSendMessage(ts, "Run multiple commands")

	// Iteration 1: wait for first tool, complete it
	waitForToolAction(t, ts, "iter-tool-1")
	completeToolAction(t, ts, "iter-tool-1", "file1.txt\nfile2.txt\n")

	// Iteration 2: wait for second tool, complete it
	waitForToolAction(t, ts, "iter-tool-2")
	completeToolAction(t, ts, "iter-tool-2", "/home/user\n")

	// Wait for the final assistant message. With non-blocking tool wait
	// the worker goes idle between tool dispatches, so its state isn't a
	// reliable gate for multi-iteration flows.
	err := helpers.WaitForDocument(t, ts.Worker, "both tool results and the final reply", func(doc *worker.ConversationDocument) bool {
		items := doc.GetItems()
		tool1Done := false
		tool2Done := false
		hasAssistant := false
		for _, item := range items {
			switch {
			case item.ToolUseID == "iter-tool-1" && len(item.Result) > 0:
				tool1Done = true
			case item.ToolUseID == "iter-tool-2" && len(item.Result) > 0:
				tool2Done = true
			case item.Type == "assistant" && item.Content == "All done":
				hasAssistant = true
			}
		}
		return tool1Done && tool2Done && hasAssistant
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Document missing expected items: %v", err)
	}

	t.Log("SUCCESS: Strategy loop iterates 3 times with multiple tool batches")
}

// TestStrategyLoopLLMError tests that an LLM error inserts an error item and the worker returns to idle.
//
// The mock error must be a TERMINAL one. classifyLLMError inspects the message
// text, and anything it reads as a rate limit or transient failure (an overload,
// a stalled stream — see providerutils.TransientMessage) is retried by
// callLLMWithRetry instead of surfacing, which is a different code path than the
// one under test here.
func TestStrategyLoopLLMError(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)

	ts.Worker.SetLLMCaller(func(ctx context.Context, req json.RawMessage, streamCB func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		return nil, fmt.Errorf("mock LLM error: invalid request")
	})

	triggerSendMessage(ts, "This will fail")

	// Each turn is awaited by what it does — the item it writes, its model
	// call — before the worker being idle, which it still is before a queued
	// turn starts.
	err := helpers.WaitForItem(t, ts.Worker, "the error item", func(item worker.ConversationItem) bool {
		return item.Type == "error"
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Error item did not appear: %v", err)
	}

	err = helpers.WaitForState(t, ts.Worker, worker.StateIdle)
	if err != nil {
		t.Fatalf("Worker did not return to idle after LLM error: %v", err)
	}

	// Verify worker is still functional — can process another message
	var recoveredCalls atomic.Int32
	ts.Worker.SetLLMCaller(func(ctx context.Context, req json.RawMessage, streamCB func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		recoveredCalls.Add(1)
		resp := helpers.TextResponse("Recovered")
		if streamCB != nil {
			for _, block := range resp.Blocks {
				if block.Type == "text" && block.Content != "" {
					streamCB(worker.StreamChunk{Type: "text", Content: block.Content})
				}
			}
		}
		return resp, nil
	})

	triggerSendMessage(ts, "Try again")

	if err := helpers.WaitUntil(t, "the second turn to call the model", func() bool { return recoveredCalls.Load() >= 1 }); err != nil {
		t.Fatal(err)
	}
	err = helpers.WaitForState(t, ts.Worker, worker.StateIdle)
	if err != nil {
		t.Fatalf("Worker did not return to idle on second attempt: %v", err)
	}

	t.Log("SUCCESS: LLM error handled gracefully, worker recovers")
}

// TestStrategyLoopCancellation tests cancelling during active processing.
func TestStrategyLoopCancellation(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)

	// Set up a blocking LLM call
	blockChan := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-blockChan:
		default:
			close(blockChan)
		}
	})

	ts.Worker.SetLLMCaller(func(ctx context.Context, req json.RawMessage, streamCB func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		select {
		case <-blockChan:
			return helpers.TextResponse("Should not see this"), nil
		case <-ctx.Done():
			return nil, fmt.Errorf("cancelled")
		}
	})

	triggerSendMessage(ts, "This will be cancelled")

	// Wait for processing state
	err := helpers.WaitForState(t, ts.Worker, worker.StateProcessing)
	if err != nil {
		t.Fatalf("Worker did not start processing: %v", err)
	}

	// Send cancel message
	cancelPayload, _ := json.Marshal(map[string]string{"type": "cancel"})
	ts.Manager.HandleMessage(ts.ConvID, "cancel", cancelPayload, nil)

	// Worker should return to idle
	err = helpers.WaitForState(t, ts.Worker, worker.StateIdle)
	if err != nil {
		t.Fatalf("Worker did not return to idle after cancel: %v", err)
	}

	t.Log("SUCCESS: Strategy loop cancellation works correctly")
}

// TestStrategyLoopStateTransitions verifies idle → processing → idle state transitions.
func TestStrategyLoopStateTransitions(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)

	// Verify initial state
	if ts.Worker.State() != worker.StateIdle {
		t.Fatalf("Expected initial state idle, got %s", ts.Worker.State())
	}

	// Set up a blocking LLM call so we can observe the processing state
	blockChan := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-blockChan:
		default:
			close(blockChan)
		}
	})

	ts.Worker.SetLLMCaller(func(ctx context.Context, req json.RawMessage, streamCB func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		select {
		case <-blockChan:
			resp := helpers.TextResponse("Done")
			if streamCB != nil {
				for _, block := range resp.Blocks {
					if block.Type == "text" && block.Content != "" {
						streamCB(worker.StreamChunk{Type: "text", Content: block.Content})
					}
				}
			}
			return resp, nil
		case <-ctx.Done():
			return nil, fmt.Errorf("cancelled")
		}
	})

	triggerSendMessage(ts, "Hello")

	// Verify: state transitions to processing
	err := helpers.WaitForState(t, ts.Worker, worker.StateProcessing)
	if err != nil {
		t.Fatalf("Worker did not transition to processing: %v", err)
	}

	// Unblock LLM
	close(blockChan)

	// Verify: state transitions back to idle
	err = helpers.WaitForState(t, ts.Worker, worker.StateIdle)
	if err != nil {
		t.Fatalf("Worker did not transition back to idle: %v", err)
	}

	t.Log("SUCCESS: State transitions idle → processing → idle verified")
}

// TestStrategyLoopRetryToolAction tests that retrying a tool-action sets it to
// 'approved' with a cleared result, so the frontend reducer can atomically claim
// approved → running before launching execution.
func TestStrategyLoopRetryToolAction(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)
	seq := ts.SetLLMSequence(
		helpers.ToolUseResponse("retry-tool-1", "bash", map[string]any{"command": "echo retry"}),
		helpers.TextResponse("Retried tool finished"),
	)

	triggerSendMessage(ts, "Run a command")

	// Wait for tool-action to appear
	waitForToolAction(t, ts, "retry-tool-1")

	// Simulate: tool got stuck, user sets it as cancelled with a result
	if err := ts.GetDocument().UpdateItemByToolUseID("retry-tool-1", "state", "cancelled"); err != nil {
		t.Fatalf("Failed to set cancelled state: %v", err)
	}
	if err := ts.GetDocument().UpdateItemByToolUseID("retry-tool-1", "result", map[string]any{
		"content":   "Action was cancelled.",
		"isError":   false,
		"cancelled": true,
	}); err != nil {
		t.Fatalf("Failed to set cancelled result: %v", err)
	}

	// Send retry-tool-action message
	retryPayload, _ := json.Marshal(map[string]any{
		"type":      "retry-tool-action",
		"toolUseId": "retry-tool-1",
	})
	ts.Manager.HandleMessage(ts.ConvID, "retry-tool-action", retryPayload, nil)

	// Verify: state was set to 'approved' (rerun = "ready to run". The
	// frontend reducer atomically claims approved → running before
	// launching execution; the worker only writes 'approved'.)
	err := helpers.WaitForDocument(t, ts.Worker, "the retried tool-action to be approved", func(doc *worker.ConversationDocument) bool {
		for _, item := range doc.GetItems() {
			if item.ToolUseID == "retry-tool-1" {
				resultIsEmpty := len(item.Result) == 0 || string(item.Result) == "null"
				return item.State == worker.StateApproved && resultIsEmpty
			}
		}
		return false
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Tool-action was not set to 'approved': %v", err)
	}

	// Simulate frontend completing the retried tool
	completeToolAction(t, ts, "retry-tool-1", "hello from retry\n")

	// Wait for strategy loop to complete: the sequence's second response is
	// taken, then the worker settles. The worker may be idle while a tool is
	// out, so idle alone says nothing.
	if err := helpers.WaitUntil(t, "the second model call", func() bool { return seq.CallCount() >= 2 }); err != nil {
		t.Fatal(err)
	}
	err = helpers.WaitForState(t, ts.Worker, worker.StateIdle)
	if err != nil {
		t.Fatalf("Worker did not return to idle after retry: %v", err)
	}

	t.Log("SUCCESS: Retry tool-action sets state to 'approved' and completes")
}

// TestStrategyLoopToolUseStreaming tests that tool_use chunks are streamed
// like real providers do (triggering processStreamChunk → finalizeStreaming).
func TestStrategyLoopToolUseStreaming(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)

	// Use TextAndToolResponse to have text followed by tool_use.
	// The mock streams tool_use chunks, which trigger finalizeStreaming()
	// to flush any accumulated text before the tool_use block.
	seq := ts.SetLLMSequence(
		helpers.TextAndToolResponse("Let me run that for you",
			helpers.ToolUse{ID: "stream-tool-1", Name: "bash", Input: map[string]any{"command": "echo streaming"}}),
		helpers.TextResponse("Streaming tool finished"),
	)

	triggerSendMessage(ts, "Run a command with streaming")

	// Wait for tool-action to appear
	waitForToolAction(t, ts, "stream-tool-1")

	// Verify: the text message was finalized (separate from tool-action)
	err := helpers.WaitForItem(t, ts.Worker, "the text before the tool_use", func(item worker.ConversationItem) bool {
		return item.Type == "assistant" && item.Content == "Let me run that for you"
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Text message was not finalized before tool_use: %v", err)
	}

	// Complete the tool
	completeToolAction(t, ts, "stream-tool-1", "streaming output\n")

	// Wait for completion: the turn after the tool reaches the model, then
	// settles. The worker may already be idle while the tool is out.
	if err := helpers.WaitUntil(t, "the turn after the tool to call the model", func() bool { return seq.CallCount() >= 2 }); err != nil {
		t.Fatal(err)
	}
	err = helpers.WaitForState(t, ts.Worker, worker.StateIdle)
	if err != nil {
		t.Fatalf("Worker did not return to idle: %v", err)
	}

	t.Log("SUCCESS: Tool_use streaming triggers finalizeStreaming correctly")
}
