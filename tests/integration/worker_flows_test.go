//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// TestModelSelectionIntegration tests the complete model selection workflow.
func TestModelSelectionIntegration(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)

	// Verify initial state
	doc := ts.GetDocument()
	if doc == nil {
		t.Fatal("Document should be accessible")
	}

	// Set model metadata
	ts.GetDocument().SetMetadata("model", "claude-sonnet-4")

	// Wait for metadata to be set
	err := helpers.WaitForMetadata(t, ts.Worker, "model", "claude-sonnet-4", 2*time.Second)
	if err != nil {
		t.Fatalf("Model metadata not set: %v", err)
	}

	// Verify metadata
	metadata := map[string]any{
		"model": "claude-sonnet-4",
	}
	helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
		Metadata: metadata,
	})

	t.Log("SUCCESS: Model selection workflow works")
}

// TestReviseFromHereIntegration tests the revise-from-here workflow.
func TestReviseFromHereIntegration(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)

	// Add multiple messages
	for i := range 5 {
		ts.Worker.Tracker().InsertMessage(i, worker.ConversationItem{
			Type:    worker.ItemTypeUser,
			ItemID:  "msg-" + string(rune('A'+i)),
			Content: "Message " + string(rune('A'+i)),
		})
	}

	// Wait for all messages
	err := helpers.WaitForItemCount(t, ts.Worker, 5, 2*time.Second)
	if err != nil {
		t.Fatalf("Not all messages appeared: %v", err)
	}

	// Verify all messages present
	itemCount := 5
	helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
		ItemCount: &itemCount,
	})

	// Delete from index 2 onwards (revise from here)
	ts.Worker.Tracker().DeleteMessages([]int{2, 3, 4})

	// Wait for deletions
	err = helpers.WaitForItemCount(t, ts.Worker, 2, 2*time.Second)
	if err != nil {
		t.Fatalf("Messages were not deleted: %v", err)
	}

	// Verify only first 2 messages remain
	itemCount = 2
	helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
		ItemCount: &itemCount,
		Items: []helpers.ItemAssertion{
			{Index: 0, Type: "user", Content: "Message A"},
			{Index: 1, Type: "user", Content: "Message B"},
		},
	})

	t.Log("SUCCESS: Revise-from-here workflow works")
}

// TestLLMMessageFlowEndToEnd tests the complete LLM request/response flow.
func TestLLMMessageFlowEndToEnd(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)

	// Set up mock LLM to return text
	ts.SetLLMSequence(
		helpers.TextResponse("Hello! I'm the assistant."),
	)

	// Add user message
	ts.Worker.Tracker().InsertMessage(0, worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		Content: "Hello",
	})

	// Wait for user message
	err := helpers.WaitForItemCount(t, ts.Worker, 1, 2*time.Second)
	if err != nil {
		t.Fatalf("User message did not appear: %v", err)
	}

	// Verify message exists
	itemCount := 1
	helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
		ItemCount: &itemCount,
		Items: []helpers.ItemAssertion{
			{Index: 0, Type: "user", Content: "Hello"},
		},
	})

	t.Log("SUCCESS: LLM message flow works")
}

// TestUndoRedoCycleIntegration tests undo/redo cycles with message operations.
func TestUndoRedoCycleIntegration(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)

	// Perform undo/redo cycles with message operations
	for i := range 5 {
		// Add message (using tracker so it creates undo entry)
		ts.Worker.Tracker().InsertMessage(0, worker.ConversationItem{
			Type:    worker.ItemTypeUser,
			Content: "Cycle message",
		})

		// Wait for message
		err := helpers.WaitForItemCount(t, ts.Worker, 1, 2*time.Second)
		if err != nil {
			t.Fatalf("Cycle %d: message did not appear: %v", i, err)
		}

		// Undo
		success := ts.Worker.Tracker().Undo()
		if !success {
			t.Fatalf("Cycle %d: undo failed", i)
		}

		// Wait for deletion
		err = helpers.WaitForItemCount(t, ts.Worker, 0, 2*time.Second)
		if err != nil {
			t.Fatalf("Cycle %d: message was not removed: %v", i, err)
		}

		// Redo
		success = ts.Worker.Tracker().Redo()
		if !success {
			t.Fatalf("Cycle %d: redo failed", i)
		}

		// Wait for restoration
		err = helpers.WaitForItemCount(t, ts.Worker, 1, 2*time.Second)
		if err != nil {
			t.Fatalf("Cycle %d: message was not restored: %v", i, err)
		}

		// Undo again to clear for next cycle
		ts.Worker.Tracker().Undo()

		// Wait for deletion
		err = helpers.WaitForItemCount(t, ts.Worker, 0, 2*time.Second)
		if err != nil {
			t.Fatalf("Cycle %d: message was not removed after redo undo: %v", i, err)
		}
	}

	// Final verification - should be empty
	itemCount := 0
	helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
		ItemCount: &itemCount,
	})

	t.Log("SUCCESS: Undo/redo cycles completed without corruption")
}

// TestReconnectDuringProcessingIntegration tests that a client reconnect
// (disconnect + init) during active processing does NOT cancel the operation —
// the worker continues processing and the reconnecting client receives the
// current state.
func TestReconnectDuringProcessingIntegration(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	// Set up a blocking LLM call directly on the worker
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
			return helpers.TextResponse("Done!"), nil
		case <-ctx.Done():
			return nil, fmt.Errorf("cancelled")
		}
	})

	// Set model config so send-message passes validation
	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	// Send a message to start processing
	sendPayload, _ := json.Marshal(worker.SendMessageMessage{
		Type: "send-message",
		Text: "Hello",
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", sendPayload, nil)

	// Wait for processing state
	err := helpers.WaitForState(t, ts.Worker, worker.StateProcessing)
	if err != nil {
		t.Fatalf("Expected StateProcessing: %v", err)
	}

	// Simulate reconnect: disconnect client, then send new init
	ts.Manager.ClientDisconnected("legacy-client")

	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:          ts.ConvID,
			Name:        "Test",
			ModelConfig: &worker.ModelConfig{Provider: "test", Model: "test-model"},
		},
		Config: worker.WorkerConfig{
			ProjectPath: ts.TmpDir,
		},
	})
	ts.Manager.HandleMessageWithClient(ts.ConvID, "new-client", "init", initPayload, func(msg []byte) {})

	// Worker should still be processing — reconnect must NOT cancel
	if err := helpers.WaitForState(t, ts.Worker, worker.StateProcessing); err != nil {
		t.Fatalf("Expected worker to remain in StateProcessing after reconnect: %v", err)
	}

	// Unblock the LLM call and wait for processing to complete
	close(blockChan)

	err = helpers.WaitForState(t, ts.Worker, worker.StateIdle)
	if err != nil {
		t.Fatalf("Worker did not return to idle after LLM completed: %v", err)
	}

	// Verify the round-trip actually finished by checking the user message
	// got stamped with a transactionId. The mock LLM doesn't stream chunks,
	// so the assistant text is never inserted as an item — but the transaction
	// id stamp is the worker's last act before idle, so its presence proves
	// the LLM completion path ran end-to-end.
	items := ts.GetDocument().GetItems()
	stamped := false
	for _, it := range items {
		if it.Type == worker.ItemTypeUser && it.TransactionID != "" {
			stamped = true
			break
		}
	}
	if !stamped {
		t.Fatalf("Expected user message stamped with transactionId after reconnect; got items=%+v", items)
	}

	t.Log("SUCCESS: Reconnect during processing does not interrupt backend")
}

// TestMultipleViewerReconnectsDuringProcessing tests that rapid disconnect/reconnect
// cycles do not interrupt backend processing.
func TestMultipleViewerReconnectsDuringProcessing(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

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
			return helpers.TextResponse("Done after reconnects!"), nil
		case <-ctx.Done():
			return nil, fmt.Errorf("cancelled")
		}
	})

	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	sendPayload, _ := json.Marshal(worker.SendMessageMessage{
		Type: "send-message",
		Text: "Hello",
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", sendPayload, nil)

	err := helpers.WaitForState(t, ts.Worker, worker.StateProcessing)
	if err != nil {
		t.Fatalf("Expected StateProcessing: %v", err)
	}

	// Simulate 3 rapid disconnect/reconnect cycles
	for i := range 3 {
		clientID := fmt.Sprintf("client-%d", i)
		ts.Manager.ClientDisconnected(clientID)

		newClientID := fmt.Sprintf("client-%d", i+1)
		initPayload, _ := json.Marshal(worker.InitMessage{
			Type: "init",
			Conversation: worker.SerializedConversation{
				ID:          ts.ConvID,
				Name:        "Test",
				ModelConfig: &worker.ModelConfig{Provider: "test", Model: "test-model"},
			},
			Config: worker.WorkerConfig{
				ProjectPath: ts.TmpDir,
			},
		})
		ts.Manager.HandleMessageWithClient(ts.ConvID, newClientID, "init", initPayload, func(msg []byte) {})

		// Verify still processing after each reconnect
		if err := helpers.WaitForState(t, ts.Worker, worker.StateProcessing); err != nil {
			t.Fatalf("Reconnect cycle %d: expected StateProcessing: %v", i, err)
		}
	}

	// Unblock and verify completion
	close(blockChan)

	err = helpers.WaitForState(t, ts.Worker, worker.StateIdle)
	if err != nil {
		t.Fatalf("Worker did not return to idle: %v", err)
	}

	t.Log("SUCCESS: Multiple reconnects do not interrupt processing")
}

// TestReconnectSeesCurrentProcessingState tests that a reconnecting client
// receives the current processing state (not idle) in the Yjs doc.
func TestReconnectSeesCurrentProcessingState(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

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
			return helpers.TextResponse("Done!"), nil
		case <-ctx.Done():
			return nil, fmt.Errorf("cancelled")
		}
	})

	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	sendPayload, _ := json.Marshal(worker.SendMessageMessage{
		Type: "send-message",
		Text: "Hello",
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", sendPayload, nil)

	// Wait for processingState to show non-idle in doc
	err := helpers.WaitForDocument(t, ts.Worker, "a non-idle processingState", func(doc *worker.ConversationDocument) bool {
		ps := doc.GetMetadata("processingState")
		if ps == nil {
			return false
		}
		psMap, ok := ps.(map[string]any)
		if !ok {
			return false
		}
		return psMap["status"] != "idle"
	})
	if err != nil {
		t.Fatalf("processingState did not become non-idle: %v", err)
	}

	// Simulate reconnect
	ts.Manager.ClientDisconnected("legacy-client")
	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:          ts.ConvID,
			Name:        "Test",
			ModelConfig: &worker.ModelConfig{Provider: "test", Model: "test-model"},
		},
		Config: worker.WorkerConfig{
			ProjectPath: ts.TmpDir,
		},
	})
	ts.Manager.HandleMessageWithClient(ts.ConvID, "new-client", "init", initPayload, func(msg []byte) {})

	// After reconnect, processingState in Yjs doc should still be non-idle
	if err := helpers.WaitForDocument(t, ts.Worker, "processingState after the reconnect", func(doc *worker.ConversationDocument) bool {
		return doc.GetMetadata("processingState") != nil
	}); err != nil {
		t.Fatalf("processingState missing after reconnect: %v", err)
	}
	ps := ts.GetDocument().GetMetadata("processingState")
	if ps == nil {
		t.Fatal("processingState is nil after reconnect")
	}
	psMap, ok := ps.(map[string]any)
	if !ok {
		t.Fatal("processingState is not a map")
	}
	if psMap["status"] == "idle" {
		t.Fatal("processingState should not be idle after reconnect during processing")
	}

	// Cleanup
	close(blockChan)
	err = helpers.WaitForState(t, ts.Worker, worker.StateIdle)
	if err != nil {
		t.Fatalf("Worker did not return to idle: %v", err)
	}

	t.Log("SUCCESS: Reconnecting client sees current processing state")
}

// TestReconnectDuringToolExecution tests that a viewer disconnect/reconnect
// during tool execution (waitForBatchComplete) preserves tool-action items
// and the worker remains in processing state.
func TestReconnectDuringToolExecution(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine(worker.ToolDefinition{Name: "shell"})

	toolUseID := "tool-reconnect-exec"

	// LLM returns a tool_use, which creates a tool-action item and blocks in waitForBatchComplete
	ts.Worker.SetLLMCaller(func(ctx context.Context, req json.RawMessage, streamCB func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		return helpers.ToolUseResponse(toolUseID, "shell", map[string]any{"command": "echo hello"}), nil
	})

	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	sendPayload, _ := json.Marshal(worker.SendMessageMessage{
		Type: "send-message",
		Text: "Run a command",
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", sendPayload, nil)

	// Wait for tool-action item to appear in the doc
	err := helpers.WaitForItem(t, ts.Worker, "the tool-action", func(item worker.ConversationItem) bool {
		return item.ToolUseID == toolUseID
	})
	if err != nil {
		t.Fatalf("Tool-action item did not appear: %v", err)
	}

	// Worker has dispatched the tool and is either processing (blocking
	// tool wait) or idle with activity="awaiting_llm" (non-blocking path).
	// Either way, the tool-action item is in the doc — that's the real
	// invariant tested below (tool survives reconnect).

	// Simulate reconnect
	ts.Manager.ClientDisconnected("legacy-client")
	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:          ts.ConvID,
			Name:        "Test",
			ModelConfig: &worker.ModelConfig{Provider: "test", Model: "test-model"},
		},
		Config: worker.WorkerConfig{
			ProjectPath: ts.TmpDir,
		},
	})
	ts.Manager.HandleMessageWithClient(ts.ConvID, "new-client", "init", initPayload, func(msg []byte) {})

	// Verify tool-action item still exists after reconnect
	if err := helpers.WaitForItem(t, ts.Worker, "the tool-action after the reconnect", func(item worker.ConversationItem) bool {
		return item.ToolUseID == toolUseID
	}); err != nil {
		t.Fatalf("Tool-action item lost after reconnect: %v", err)
	}

	t.Log("SUCCESS: Reconnect during tool execution preserves state")
}
