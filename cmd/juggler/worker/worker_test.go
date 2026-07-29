//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// msgChan wraps a buffered channel for use as a worker send callback.
// It provides deterministic waiting without sleeps.
type msgChan struct {
	ch chan []byte
}

func newMsgChan() *msgChan { return &msgChan{ch: make(chan []byte, 1000)} }

func (m *msgChan) callback(msg []byte) { m.ch <- msg }

// waitForType blocks until a message with the given "type" field arrives or timeout.
func (m *msgChan) waitForType(t *testing.T, msgType string) map[string]any {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case raw := <-m.ch:
			var msg map[string]any
			if json.Unmarshal(raw, &msg) == nil && msg["type"] == msgType {
				return msg
			}
		case <-deadline.C:
			t.Fatalf("timeout waiting for message type %q", msgType)
			return nil
		}
	}
}

func TestConversationDocument(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")

	// Test inserting messages
	msg := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "msg1",
		Content: "Hello",
	}
	doc.InsertMessage(0, msg)

	items := doc.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item, got %d", len(items))
	}
	if items[0].Content != "Hello" {
		t.Errorf("Expected content 'Hello', got '%s'", items[0].Content)
	}

	// Test appending
	msg2 := ConversationItem{
		Type:    ItemTypeAssistant,
		ItemID:  "msg2",
		Content: "Hi there!",
	}
	doc.AppendMessage(msg2)

	items = doc.GetItems()
	if len(items) != 2 {
		t.Errorf("Expected 2 items, got %d", len(items))
	}

	// Test deleting
	doc.DeleteMessages([]int{0})
	items = doc.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item after delete, got %d", len(items))
	}
	if items[0].Content != "Hi there!" {
		t.Errorf("Expected remaining content 'Hi there!', got '%s'", items[0].Content)
	}

	// Test context items (items with an itemId in items array)
	contextItem := ConversationItem{
		Type:   "rule",
		ItemID: "ci1",
		Data:   []byte(`{"type":"test"}`),
	}
	doc.AppendMessage(contextItem)

	items = doc.GetItems()
	if len(items) != 2 {
		t.Errorf("Expected 2 items (message + context item), got %d", len(items))
	}
	if items[1].ItemID != "ci1" {
		t.Errorf("Expected context item with ID 'ci1', got '%s'", items[1].ItemID)
	}

	doc.Destroy()
}

func TestOperationTracker(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert a message via tracker
	msg := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "msg1",
		Content: "Test message",
	}
	tracker.InsertMessage(0, msg)

	// Verify message was inserted
	items := doc.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item, got %d", len(items))
	}

	// Test undo
	if !tracker.CanUndo() {
		t.Error("Expected to be able to undo")
	}

	tracker.Undo()
	items = doc.GetItems()
	if len(items) != 0 {
		t.Errorf("Expected 0 items after undo, got %d", len(items))
	}

	// Test redo
	if !tracker.CanRedo() {
		t.Error("Expected to be able to redo")
	}

	tracker.Redo()
	items = doc.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item after redo, got %d", len(items))
	}

	doc.Destroy()
}

func TestWorkerManager(t *testing.T) {
	manager := NewManager()

	// Create an init message
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:                "conv1",
			Name:              "Test",
			CurrentStrategyID: "default",
		},
		Config: WorkerConfig{
			ProjectPath: "/test",
		},
	})

	// Track sent messages
	var sentMessages [][]byte
	sendCallback := func(msg []byte) {
		sentMessages = append(sentMessages, msg)
	}

	// Handle init message - should create worker
	handled := manager.HandleMessage("conv1", "init", initPayload, sendCallback)
	if !handled {
		t.Error("Expected message to be handled")
	}

	// HandleMessage is synchronous with the manager; Count/Get are also serialized
	// through the manager ops channel, so they reflect the current state immediately.
	if manager.Count() != 1 {
		t.Errorf("Expected 1 worker, got %d", manager.Count())
	}

	// Get the worker
	w := manager.Get("conv1")
	if w == nil {
		t.Error("Expected to get worker")
	}

	// Shutdown
	manager.Shutdown()
	if manager.Count() != 0 {
		t.Errorf("Expected 0 workers after shutdown, got %d", manager.Count())
	}
}

func TestYjsDocument(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")

	// Test state encoding/decoding
	msg := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "msg1",
		Content: "Test",
	}
	doc.InsertMessage(0, msg)

	state := doc.ToState()
	if len(state) == 0 {
		t.Error("Expected non-empty state")
	}

	// Create new doc and load state
	doc2 := NewConversationDocument("test-conv2", "user:test")
	err := doc2.LoadFromState(state)
	if err != nil {
		t.Errorf("LoadFromState failed: %v", err)
	}

	items := doc2.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item in loaded doc, got %d", len(items))
	}

	doc.Destroy()
	doc2.Destroy()
}

// TestCompletedTurnsSurvivesPersistence proves the durable turn fence lives in
// its own top-level `completedTurns` metadata key (not the ephemeral
// processingState blob) and survives a save/load round-trip. The ephemeral
// processingState is left in the persisted bytes by design — handleInit rebuilds
// it to idle on load — so the only correctness requirement here is that the
// counter, the one value deliberately read back across a load, round-trips.
func TestCompletedTurnsSurvivesPersistence(t *testing.T) {
	doc := NewConversationDocument("persist-conv", "user:test")
	defer doc.Destroy()

	doc.SetMetadata("completedTurns", int64(7))

	state := doc.ToState()
	if len(state) == 0 {
		t.Fatal("ToState returned empty bytes")
	}

	fresh := NewConversationDocument("persist-conv2", "user:test")
	defer fresh.Destroy()
	if err := fresh.LoadFromState(state); err != nil {
		t.Fatalf("LoadFromState failed: %v", err)
	}

	switch v := fresh.GetMetadata("completedTurns").(type) {
	case int64:
		if v != 7 {
			t.Errorf("completedTurns = %d, want 7", v)
		}
	case float64:
		if v != 7 {
			t.Errorf("completedTurns = %v, want 7", v)
		}
	case int:
		if v != 7 {
			t.Errorf("completedTurns = %d, want 7", v)
		}
	default:
		t.Errorf("completedTurns did not survive persistence (got %T: %#v)", v, v)
	}
}

// TestClientCallbackCleanup tests the full client lifecycle:
// 1. Single client connects and receives messages
// 2. Client reloads (disconnect + reconnect with new callback) - old callback should stop receiving
// 3. Multiple clients - each should receive messages
// 4. One client disconnects - only that client's callback is removed
//
// This is critical for multi-tab scenarios and page reloads.
func TestClientCallbackCleanup(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown()

	// Create init message
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:                "conv1",
			Name:              "Test",
			CurrentStrategyID: "default",
		},
		Config: WorkerConfig{
			ProjectPath: "/test",
		},
	})

	// --- Scenario 1: Single client connects ---
	recA1 := newMsgChan()
	handled := manager.HandleMessageWithClient("conv1", "client-A", "init", initPayload, recA1.callback)
	if !handled {
		t.Fatal("Expected first init message to be handled")
	}
	// "ready" is the last message sent by init; waiting for it drains all prior messages
	// (yjs-sync, status, undoState) so the channel is empty when we disconnect.
	recA1.waitForType(t, "ready")
	t.Logf("Scenario 1: Client A connected and received messages")

	// --- Scenario 2: Client A reloads (disconnect + reconnect) ---
	// ClientDisconnected is synchronous with the manager ops channel; the callback
	// is removed before HandleMessageWithClient registers the new one, so no
	// messages from the reconnect can reach recA1.
	manager.ClientDisconnected("client-A")

	recA2 := newMsgChan()
	handled = manager.HandleMessageWithClient("conv1", "client-A", "init", initPayload, recA2.callback)
	if !handled {
		t.Fatal("Expected reconnect init to be handled")
	}
	recA2.waitForType(t, "ready") // drain all reconnect messages

	// Old callback must NOT have received "ready" from the reconnect.
	// (Batch-timer yjs-sync messages from before disconnect may still be buffered —
	// they're background noise from the init flow. "ready" is only sent on init, so
	// its presence here means the wrong callback was called.)
	for len(recA1.ch) > 0 {
		raw := <-recA1.ch
		var msg map[string]any
		if json.Unmarshal(raw, &msg) == nil && msg["type"] == "ready" {
			t.Fatal("BUG: old callback received 'ready' from reconnect — callback was not removed")
		}
	}
	t.Logf("Scenario 2: Client A reloaded, old callback got no reconnect messages")

	// --- Scenario 3: Second client connects (multi-tab) ---
	recB := newMsgChan()
	handled = manager.HandleMessageWithClient("conv1", "client-B", "init", initPayload, recB.callback)
	if !handled {
		t.Fatal("Expected client B init to be handled")
	}
	recB.waitForType(t, "ready")
	t.Logf("Scenario 3: Client B connected and received messages")

	// --- Scenario 4: Client A disconnects, Client B should still work ---
	manager.ClientDisconnected("client-A")

	// Trigger a ping; recB must receive the pong
	manager.HandleMessageWithClient("conv1", "client-B", "ping", nil, recB.callback)
	recB.waitForType(t, "pong")

	// Disconnected client-A must NOT have received the pong.
	// Background yjs-sync batch-timer messages may still be buffered from prior inits —
	// those are fine. "pong" is only sent in response to a ping sent AFTER disconnect.
	for len(recA2.ch) > 0 {
		raw := <-recA2.ch
		var msg map[string]any
		if json.Unmarshal(raw, &msg) == nil && msg["type"] == "pong" {
			t.Fatal("BUG: disconnected client received pong — callback was not removed")
		}
	}
	t.Logf("Scenario 4: Client A disconnected, Client B still receiving")

	// Verify worker still exists
	if manager.Count() != 1 {
		t.Errorf("Expected exactly 1 worker, got %d", manager.Count())
	}

	t.Log("SUCCESS: All client lifecycle scenarios passed")
}

// TestModelValidation verifies that worker rejects messages when modelConfig is nil/empty.
// This test catches Bug 1: "Please choose a model" error even when model is selected.
func TestModelValidation(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown()

	// Init worker WITHOUT model config
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:                "conv1",
			Name:              "Test",
			CurrentStrategyID: "default",
			// ModelConfig is nil - simulating new conversation
		},
		Config: WorkerConfig{
			ProjectPath: "/test",
		},
	})

	rec := newMsgChan()

	// Handle init
	handled := manager.HandleMessage("conv1", "init", initPayload, rec.callback)
	if !handled {
		t.Fatal("Expected init message to be handled")
	}

	// Try to send message without model - should fail validation
	sendPayload, _ := json.Marshal(SendMessageMessage{
		Type:           "send-message",
		Text:           "Test message",
		IsContinuation: false,
	})

	handled = manager.HandleMessage("conv1", "send-message", sendPayload, rec.callback)
	if !handled {
		t.Fatal("Expected send-message to be handled")
	}

	// Wait for the validation-error status message
	msg := rec.waitForType(t, "status")
	for msg["status"] != "validation-error" {
		msg = rec.waitForType(t, "status")
	}
	msgText, ok := msg["message"].(string)
	if !ok {
		t.Fatal("Validation error message should be a string")
	}
	if msgText != "Please select a model before sending a message" {
		t.Errorf("Expected 'Please select a model' error, got: %s", msgText)
	}
	// The recoverable divergence code lets the client self-heal (re-broadcast its
	// own model config + retry once) rather than only surfacing a dead-end warning.
	if code, _ := msg["code"].(string); code != "no-model" {
		t.Errorf("Expected validation code 'no-model', got: %q", code)
	}
	t.Logf("SUCCESS: Got expected validation error: %s", msgText)
}

// TestProviderUnavailableSurfacedAsValidationError verifies Guard B: when the LLM
// dispatch fails because the selected model's provider isn't configured (the
// caller wraps ErrProviderUnavailable), the worker surfaces a validation-error
// with code "provider-unavailable" — a user-fixable "pick another model" prompt —
// rather than a generic error item, and does not retry a model that cannot run.
func TestProviderUnavailableSurfacedAsValidationError(t *testing.T) {
	w := NewConversationWorker("conv-pu", "user:test")
	defer w.doc.Destroy()

	// Seed a resolvable default model so the mapped message can name it.
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:                "conv-pu",
			CurrentStrategyID: "default",
			ModelConfig:       &ModelConfig{Provider: "test", Model: "test-model"},
		},
		Config: WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.handleInit(initPayload)

	// Real dispatch path (no mock): the caller fails with a wrapped
	// ErrProviderUnavailable, exactly as createLLMCaller does when credentials
	// for the stored provider are missing.
	var calls int32
	w.llmCallFunc = func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		atomic.AddInt32(&calls, 1)
		return nil, fmt.Errorf("%w: no API key configured for provider: test", ErrProviderUnavailable)
	}

	// Capture the worker's broadcast status messages.
	statusCh := make(chan map[string]any, 16)
	w.SetCallback("viewer", func(b []byte) {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["type"] == "status" {
			statusCh <- m
		}
	})

	// Feed context/tools so the turn reaches dispatch without a live engine
	// (mirrors TestToolTurnPushesStateToEngine).
	done := make(chan struct{})
	defer close(done)
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{}})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			select {
			case <-done:
				return
			case w.contextResultChan <- ctxResp:
			}
			select {
			case <-done:
				return
			case w.toolsResultChan <- toolsResp:
			}
		}
	}()

	w.runStrategyLoop("Hello", false)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case m := <-statusCh:
			if m["status"] != "validation-error" {
				continue
			}
			if code, _ := m["code"].(string); code != "provider-unavailable" {
				t.Fatalf("expected code 'provider-unavailable', got %q (message=%v)", code, m["message"])
			}
			if got := atomic.LoadInt32(&calls); got != 1 {
				t.Fatalf("provider dispatch calls = %d, want 1 (an unusable model must not be retried)", got)
			}
			return
		case <-deadline:
			t.Fatal("timeout waiting for validation-error status with code provider-unavailable")
		}
	}
}

// TestDeleteRangeBasic verifies delete-range deletes from fromIndex to end.
// This test catches Bug 2: "Revise from here" broken - loop condition bug.
func TestDeleteRangeBasic(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert 5 messages
	for i := range 5 {
		msg := ConversationItem{
			Type:    ItemTypeUser,
			ItemID:  fmt.Sprintf("msg%d", i),
			Content: fmt.Sprintf("Message %d", i),
		}
		doc.AppendMessage(msg)
	}

	// Verify we have 5 messages
	items := doc.GetItems()
	if len(items) != 5 {
		t.Fatalf("Expected 5 items initially, got %d", len(items))
	}

	// Delete from index 2 onwards (should delete messages 2, 3, 4)
	indices := []int{2, 3, 4}
	tracker.DeleteMessages(indices)

	items = doc.GetItems()
	if len(items) != 2 {
		t.Errorf("Expected 2 items remaining, got %d", len(items))
	}
	if items[0].Content != "Message 0" || items[1].Content != "Message 1" {
		t.Error("Wrong messages remained after delete-range")
	}

	// Verify undo restores all 3 deleted messages
	if !tracker.CanUndo() {
		t.Fatal("Should be able to undo")
	}
	tracker.Undo()
	items = doc.GetItems()
	if len(items) != 5 {
		t.Errorf("Expected 5 items after undo, got %d", len(items))
	}

	doc.Destroy()
}

// TestDeleteRangeEdgeCases tests delete-range edge cases.
func TestDeleteRangeEdgeCases(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert 3 messages
	for i := range 3 {
		doc.AppendMessage(ConversationItem{
			Type:    ItemTypeUser,
			ItemID:  fmt.Sprintf("msg%d", i),
			Content: fmt.Sprintf("Message %d", i),
		})
	}

	// Test 1: Delete from 0 (delete all)
	tracker.DeleteMessages([]int{0, 1, 2})
	if len(doc.GetItems()) != 0 {
		t.Error("Expected empty after deleting all messages")
	}

	// Undo
	tracker.Undo()
	if len(doc.GetItems()) != 3 {
		t.Error("Expected 3 items after undo")
	}

	// Test 2: Delete empty range (should be no-op)
	tracker.DeleteMessages([]int{})
	if len(doc.GetItems()) != 3 {
		t.Error("Delete empty range should not delete anything")
	}

	doc.Destroy()
}

// TestStreamingNoDuplicateMessages verifies that streaming text chunks followed
// by the final LLM response does NOT create duplicate assistant messages.
//
// This test catches the bug where:
// 1. Streaming chunks create/update an assistant message via processStreamChunk
// 2. A tool_use chunk arrives, triggering finalizeStreaming() via default case
// 3. processLLMResponse then adds ANOTHER assistant message for the same content
//
// Expected: Only ONE assistant message with accumulated content "Hello world!"
func TestStreamingNoDuplicateMessages(t *testing.T) {
	// Create worker directly (not through manager, to avoid async issues)
	w := NewConversationWorker("test-conv", "user:test")

	// Simulate streaming text chunks
	// These should all accumulate into a SINGLE assistant message
	w.processStreamChunk(StreamChunk{Type: "text", Content: "Hello"})
	w.processStreamChunk(StreamChunk{Type: "text", Content: " world"})
	w.processStreamChunk(StreamChunk{Type: "text", Content: "!"})

	// Verify streaming created exactly ONE message
	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Errorf("After streaming: expected 1 item, got %d", len(items))
		for i, item := range items {
			t.Logf("  Item %d: type=%s content=%q", i, item.Type, item.Content)
		}
	}

	// Verify content was accumulated
	if len(items) > 0 && items[0].Content != "Hello world!" {
		t.Errorf("Streaming content: expected 'Hello world!', got %q", items[0].Content)
	}

	// CRITICAL: Simulate a tool_use chunk arriving after text streaming
	// This triggers the "default" case in processStreamChunk which calls finalizeStreaming()
	// and clears streamingTextMessageID - THIS IS WHERE THE BUG MANIFESTS
	w.processStreamChunk(StreamChunk{Type: "tool_use"})

	// Verify streaming was finalized (IDs cleared)
	if w.streaming.textMsgID != "" {
		t.Error("streaming.textMsgID should be cleared after tool_use chunk")
	}

	// Now simulate the final LLM response (which contains the same text)
	// This is what the LLM sends after streaming completes
	response := &LLMResponse{
		Blocks: []LLMResponseBlock{
			{Type: "text", Content: "Hello world!"},
		},
		StopReason: "end_turn",
	}

	// Process the response - this should NOT add duplicate messages
	shouldContinue, err := w.processLLMResponse(response)
	if err != nil {
		t.Fatalf("processLLMResponse failed: %v", err)
	}
	if shouldContinue {
		t.Error("Expected shouldContinue=false for end_turn")
	}

	// CRITICAL ASSERTION: Still only ONE assistant message
	items = w.doc.GetItems()
	if len(items) != 1 {
		t.Errorf("After processLLMResponse: expected 1 item, got %d", len(items))
		for i, item := range items {
			t.Logf("  Item %d: type=%s content=%q", i, item.Type, item.Content)
		}
		t.Fatal("BUG: Duplicate messages created!")
	}

	// Verify the message content is correct
	if items[0].Type != ItemTypeAssistant {
		t.Errorf("Expected assistant message, got type=%s", items[0].Type)
	}
	if items[0].Content != "Hello world!" {
		t.Errorf("Expected content 'Hello world!', got %q", items[0].Content)
	}

	w.doc.Destroy()
	t.Log("SUCCESS: No duplicate messages after streaming + response")
}

// TestMultipleTextBlocksNoDuplicates verifies that multiple text blocks
// (text → tool_use → text) are handled correctly without duplicates.
//
// This tests the fix for the bug where streamingTextContent accumulated across
// ALL text blocks instead of resetting for each new block.
func TestMultipleTextBlocksNoDuplicates(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// First text block: "Hello"
	w.processStreamChunk(StreamChunk{Type: "text", Content: "Hello"})

	// Verify first message created
	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("After first text block: expected 1 item, got %d", len(items))
	}
	if items[0].Content != "Hello" {
		t.Errorf("First message content: expected 'Hello', got %q", items[0].Content)
	}

	// tool_use chunk arrives - this triggers finalizeStreaming via default case
	w.processStreamChunk(StreamChunk{Type: "tool_use"})

	// Verify streaming was finalized
	if w.streaming.textMsgID != "" {
		t.Error("streaming.textMsgID should be cleared after tool_use")
	}

	// Second text block: "World"
	w.processStreamChunk(StreamChunk{Type: "text", Content: "World"})

	// Verify second message was created correctly
	items = w.doc.GetItems()
	if len(items) != 2 {
		t.Fatalf("After second text block: expected 2 items, got %d", len(items))
	}

	// CRITICAL: Second message should have "World", not "HelloWorld" —
	// streamingTextContent must reset per block, not accumulate across them.
	if items[1].Content != "World" {
		t.Errorf("Second message content: expected 'World', got %q (bug: accumulated from previous block)", items[1].Content)
	}

	// Now simulate final LLM response with both text blocks (no tool_use to avoid waiting)
	// In practice, tool_use would be processed separately, but for this test we only
	// need to verify that text blocks are deduplicated correctly
	response := &LLMResponse{
		Blocks: []LLMResponseBlock{
			{Type: "text", Content: "Hello"},
			{Type: "text", Content: "World"},
		},
		StopReason: "end_turn",
	}

	// Process the response - should NOT add duplicate messages
	_, err := w.processLLMResponse(response)
	if err != nil {
		t.Fatalf("processLLMResponse failed: %v", err)
	}

	// CRITICAL: Still only 2 assistant messages (no duplicates)
	items = w.doc.GetItems()

	// Count assistant messages
	assistantCount := 0
	for _, item := range items {
		if item.Type == ItemTypeAssistant {
			assistantCount++
			t.Logf("Assistant message: %q", item.Content)
		}
	}

	if assistantCount != 2 {
		t.Errorf("After processLLMResponse: expected 2 assistant messages, got %d", assistantCount)
		for i, item := range items {
			t.Logf("  Item %d: type=%s content=%q", i, item.Type, item.Content)
		}
		t.Fatal("BUG: Duplicate messages created for multiple text blocks!")
	}

	w.doc.Destroy()
	t.Log("SUCCESS: Multiple text blocks handled correctly without duplicates")
}

// TestStreamingUpdatesCorrectMessage verifies that streaming from a NEW LLM response
// creates a NEW message after the user message, not updating an OLD assistant message.
//
// This test catches the bug where:
// 1. Previous turn ends with text streaming (streamingTextMessageID = "old-msg")
// 2. User sends new message
// 3. New LLM response starts streaming
// 4. BUT streamingTextMessageID was never cleared!
// 5. First chunks UPDATE the old message (before user message) instead of creating new
//
// The fix: runStrategyLoop must call finalizeStreaming() before starting.
func TestStreamingUpdatesCorrectMessage(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Turn 1: Simulate previous conversation ending with text streaming
	// The key is that streaming.textMsgID is still set (not cleared)
	w.streaming.textMsgID = "old-assistant-msg"
	oldAssistantMsg := ConversationItem{
		Type:    ItemTypeAssistant,
		ItemID:  "old-assistant-msg",
		Content: "Previous response",
	}
	w.tracker.InsertMessage(0, oldAssistantMsg)

	// Turn 2: New user message arrives. finalizeStreaming() clears
	// streamingTextMessageID so new streaming creates a new message rather
	// than updating the previous turn's assistant message.
	w.finalizeStreaming()

	userMsg := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "user-1",
		Content: "New question",
	}
	w.tracker.InsertMessage(w.doc.GetItemsLength(), userMsg)

	// Verify state before new LLM response
	items := w.doc.GetItems()
	if len(items) != 2 {
		t.Fatalf("Expected 2 items before LLM response, got %d", len(items))
	}
	t.Logf("Before new LLM response: [%s: %q, %s: %q]",
		items[0].Type, items[0].Content, items[1].Type, items[1].Content)

	// First text chunk of the new LLM response must create a new message,
	// not update "old-assistant-msg".
	w.processTextChunk(StreamChunk{Type: "text", Content: "New response"})

	// Verify order: should be [old-assistant, user, new-assistant]
	items = w.doc.GetItems()
	t.Logf("After streaming: %d items", len(items))
	for i, item := range items {
		t.Logf("  Item %d: type=%s msgId=%s content=%q", i, item.Type, item.ItemID, item.Content)
	}

	if len(items) != 3 {
		t.Fatalf("Expected 3 items (old assistant, user, new assistant), got %d", len(items))
	}

	// First item: should be OLD assistant with UNCHANGED content
	if items[0].Type != ItemTypeAssistant {
		t.Errorf("First item should be assistant, got %s", items[0].Type)
	}
	if items[0].Content != "Previous response" {
		t.Errorf("First item (old assistant) should have unchanged content 'Previous response', got %q (BUG: new content was written here!)", items[0].Content)
	}
	if items[0].ItemID != "old-assistant-msg" {
		t.Errorf("First item should have old message ID")
	}

	// Second item: should be user message
	if items[1].Type != ItemTypeUser {
		t.Errorf("Second item should be user, got %s", items[1].Type)
	}

	// Third item: should be NEW assistant with new content
	if items[2].Type != ItemTypeAssistant {
		t.Errorf("Third item should be assistant, got %s", items[2].Type)
	}
	if items[2].Content != "New response" {
		t.Errorf("Third item (new assistant) should have 'New response', got %q", items[2].Content)
	}
	if items[2].ItemID == "old-assistant-msg" {
		t.Errorf("Third item should have NEW message ID, not old one")
	}

	w.doc.Destroy()
	t.Log("SUCCESS: New streaming creates new message after user message")
}

// TestMetaToolsContinueLoop verifies that when an LLM response contains ONLY
// meta tools (drop_context_items), the strategy loop continues.
func TestMetaToolsContinueLoop(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Add a context item so drop_context_items has something to drop
	w.tracker.InsertMessage(0, ConversationItem{
		Type:   "rule",
		ItemID: "ci-test",
		Data:   []byte(`{"type":"test"}`),
	})

	response := &LLMResponse{
		Blocks: []LLMResponseBlock{
			{
				Type:  "tool_use",
				ID:    "tool-1",
				Name:  "drop_context_items",
				Input: json.RawMessage(`{"itemIds": ["ci-test"]}`),
			},
		},
		StopReason: "tool_use",
	}

	shouldContinue, err := w.processLLMResponse(response)
	if err != nil {
		t.Fatalf("processLLMResponse failed: %v", err)
	}

	// CRITICAL: Meta tools should continue the loop
	if !shouldContinue {
		t.Error("BUG: processLLMResponse returned false for meta tools - loop stopped!")
	}

	w.doc.Destroy()
}

// TestLLMResponseBlockJSONCompatibility verifies that LLMResponseBlock correctly
// deserializes JSON from the server format (provider.ContentBlock field names).
//
// This is a regression test for a bug where LLMResponseBlock used different JSON
// field names than provider.ContentBlock:
//   - LLMResponseBlock had: json:"id", json:"name", json:"input"
//   - provider.ContentBlock has: json:"toolUseId", json:"toolName", json:"toolInput"
//
// The mismatch caused toolName to be empty when deserializing server responses,
// leading to "Cannot read properties of undefined (reading 'toLowerCase')" errors
// in the frontend action registry.
func TestLLMResponseBlockJSONCompatibility(t *testing.T) {
	// JSON as server sends it (provider.ContentBlock format)
	serverJSON := `{
		"type": "tool_use",
		"toolUseId": "test-id-123",
		"toolName": "read_file",
		"toolInput": {"path": "test.txt"}
	}`

	var block LLMResponseBlock
	if err := json.Unmarshal([]byte(serverJSON), &block); err != nil {
		t.Fatalf("Failed to unmarshal: %v", err)
	}

	if block.Type != "tool_use" {
		t.Errorf("Expected Type 'tool_use', got %q", block.Type)
	}
	if block.ID != "test-id-123" {
		t.Errorf("Expected ID 'test-id-123', got %q (JSON field mismatch?)", block.ID)
	}
	if block.Name != "read_file" {
		t.Errorf("Expected Name 'read_file', got %q (JSON field mismatch?)", block.Name)
	}

	// Verify Input can be parsed
	var input map[string]any
	if err := json.Unmarshal(block.Input, &input); err != nil {
		t.Fatalf("Failed to parse Input: %v", err)
	}
	if input["path"] != "test.txt" {
		t.Errorf("Expected input.path 'test.txt', got %v", input["path"])
	}
}

// TestInitResetsStaleProcessingState verifies that handleInit clears stale
// processingState metadata from the Yjs doc (e.g., after loading from disk).
func TestInitResetsStaleProcessingState(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Manually set stale processingState (simulates state loaded from disk)
	w.doc.SetMetadata("processingState", map[string]any{
		"status":       "streaming",
		"message":      "",
		"threadItemId": "",
	})

	// Verify it's set
	ps := w.doc.GetMetadata("processingState")
	psMap, _ := ps.(map[string]any)
	if psMap == nil || psMap["status"] != "streaming" {
		t.Fatal("processingState not set to streaming")
	}

	// Call handleInit directly (worker not started, same-package access)
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:                "test-conv",
			CurrentStrategyID: "default",
		},
		Config: WorkerConfig{
			ProjectPath: t.TempDir(),
		},
	})
	w.handleInit(initPayload)

	// Verify processingState is now idle
	ps = w.doc.GetMetadata("processingState")
	psMap, _ = ps.(map[string]any)
	if psMap == nil {
		t.Fatal("processingState is nil after init")
	}
	if psMap["status"] != "idle" {
		t.Errorf("Expected processingState status 'idle', got %q", psMap["status"])
	}

	w.doc.Destroy()
}

// TestInitCancelsStaleToolActions verifies that handleInit cancels tool-action
// items that were left running when the app was killed.
func TestInitCancelsStaleToolActions(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Insert a stale tool-action: approved, running, no result (simulates crash mid-execution)
	w.doc.InsertMessage(0, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-stale",
		ToolUseID: "tu-stale",
		ToolName:  "bash",
		State:     StateRunning,
	})

	// Verify no result before init
	items := w.doc.GetItems()
	if len(items[0].Result) != 0 {
		t.Fatal("Expected no result before handleInit")
	}

	// The repair / stale-tool cleanup pass in handleInit only runs on the
	// load-from-disk path, so we need a real on-disk doc.yjs reachable
	// through the worker's path provider. Wire a tmpdir-backed provider
	// and seed the file with the worker's current Yjs state so the
	// inserted stale tool-action is re-applied on load.
	tmpDir := t.TempDir()
	convDir := filepath.Join(tmpDir, ".juggler", "test--test-conv")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(convDir, "doc.yjs"), w.doc.ToState(), 0o644); err != nil {
		t.Fatalf("seed doc.yjs: %v", err)
	}
	w.SetPathProvider(func(string) (string, bool) { return convDir, true })

	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:                "test-conv",
			CurrentStrategyID: "default",
			LoadFromDisk:      true,
		},
		Config: WorkerConfig{
			ProjectPath: tmpDir,
		},
	})
	w.handleInit(initPayload)

	// Verify the stale tool-action was cancelled
	items = w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item, got %d", len(items))
	}
	if len(items[0].Result) == 0 {
		t.Fatal("Expected stale tool-action to have interrupted result after init")
	}
	var r map[string]any
	if err := json.Unmarshal(items[0].Result, &r); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}
	if r["content"] != "Interrupted" {
		t.Errorf("Expected content 'Interrupted', got %v", r["content"])
	}
	if r["cancelled"] != true {
		t.Errorf("Expected cancelled=true, got %v", r["cancelled"])
	}

	w.doc.Destroy()
}

// TestInitPreservesAwaitingLLMForPendingTool verifies that handleInit does NOT
// clobber processingState.activity to idle when the on-disk doc still has a
// pending tool-action awaiting approval. If activity is cleared, then after the
// user approves and the tool completes, the thread reducer sees activity=""
// and returns ActionNone instead of dispatching the next LLM turn — the bash
// command runs but the conversation hangs without a follow-up LLM response.
func TestInitPreservesAwaitingLLMForPendingTool(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Seed a pending tool-action and an awaiting-LLM activity marker — the
	// state we'd be in at restart while the user has an approval dialog open.
	w.doc.InsertMessage(0, ConversationItem{
		Type:      ItemTypeUser,
		ItemID:    "u-1",
		Content:   "run bash",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type:      ItemTypeAssistant,
		ItemID:    "a-1",
		Content:   "I'll run that.",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-pending",
		ToolUseID: "tu-pending",
		ToolName:  "bash",
		State:     StatePending,
	})
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
	})

	// Stage doc.yjs on disk so the load-from-disk path replays the seeded state.
	tmpDir := t.TempDir()
	convDir := filepath.Join(tmpDir, ".juggler", "test--test-conv")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(convDir, "doc.yjs"), w.doc.ToState(), 0o644); err != nil {
		t.Fatalf("seed doc.yjs: %v", err)
	}
	w.SetPathProvider(func(string) (string, bool) { return convDir, true })

	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:                "test-conv",
			CurrentStrategyID: "default",
			LoadFromDisk:      true,
		},
		Config: WorkerConfig{ProjectPath: tmpDir},
	})
	w.handleInit(initPayload)

	// The pending tool must NOT have been cancelled — CancelStaleToolActions
	// skips StatePending, but cross-check here so a regression in that path
	// shows up as a clear failure on this test rather than silent drift.
	items := w.doc.GetItems()
	if len(items) != 3 || items[2].State != StatePending {
		t.Fatalf("Expected pending tool-action preserved, got items=%+v", items)
	}

	// The activity marker must still be awaiting_llm so that when the user
	// approves and the tool completes, decideNextAction dispatches CallLLM.
	if got := w.getActivity(); got != ActivityAwaitingLLM {
		t.Errorf("Expected activity %q after init with pending tool, got %q",
			ActivityAwaitingLLM, got)
	}

	w.doc.Destroy()
}

// TestInitLeavesResultlessThreadOpen verifies that a thread with no result
// survives a reload / server restart as OPEN. Under the new model a resultless
// thread is the normal open resting state (a thread closes only on an explicit
// return_result call or a hard error), so the load path must NOT stamp any
// result on it — the old "Thread was interrupted" crash-repair is gone.
func TestInitLeavesResultlessThreadOpen(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	w.doc.AppendMessage(ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "Hello"})
	threadArr := w.doc.InsertThread(1, "Open thread")
	// A thread that ended its turn on plain assistant text — open, no result,
	// no live tool. This is exactly the state the old repair used to "close".
	w.doc.InsertMessageIntoArray(threadArr, 0, ConversationItem{
		Type:    ItemTypeAssistant,
		ItemID:  "a-1",
		Content: "I did some work.",
	})

	var threadItemID string
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeThread {
			threadItemID = item.ItemID
			break
		}
	}
	if threadItemID == "" {
		t.Fatal("thread item not found")
	}

	// Stage doc.yjs on disk so the load-from-disk path replays the seeded state.
	tmpDir := t.TempDir()
	convDir := filepath.Join(tmpDir, ".juggler", "test--test-conv")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(convDir, "doc.yjs"), w.doc.ToState(), 0o644); err != nil {
		t.Fatalf("seed doc.yjs: %v", err)
	}
	w.SetPathProvider(func(string) (string, bool) { return convDir, true })

	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:                "test-conv",
			CurrentStrategyID: "default",
			LoadFromDisk:      true,
		},
		Config: WorkerConfig{ProjectPath: tmpDir},
	})
	w.handleInit(initPayload)

	threadYMap := w.doc.GetThreadYMap(threadItemID)
	if threadYMap == nil {
		t.Fatal("thread Y.Map not found after init")
	}
	if result, _ := threadYMap.Get("result").(string); result != "" {
		t.Errorf("resultless thread was closed on reload (result=%q) — an open thread must survive a restart as open", result)
	}

	w.doc.Destroy()
}

// TestInitDuringProcessingCancelsAndResetsState verifies that receiving an init
// message while the strategy loop is running cancels the operation and resets state.
func TestInitDuringProcessingDoesNotCancel(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown()

	tmpDir := t.TempDir()

	// Set up a blocking LLM call that waits on a channel
	blockChan := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-blockChan:
		default:
			close(blockChan)
		}
	})

	manager.SetLLMCaller(func(ctx context.Context, req json.RawMessage, streamCB func(StreamChunk)) (*LLMResponse, error) {
		select {
		case <-blockChan:
			return &LLMResponse{StopReason: "end_turn"}, nil
		case <-ctx.Done():
			return nil, ErrCancelled
		}
	})

	// Init with model config so send-message passes validation
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:                "conv1",
			Name:              "Test",
			CurrentStrategyID: "default",
			ModelConfig:       &ModelConfig{Provider: "test", Model: "test-model"},
		},
		Config: WorkerConfig{
			ProjectPath: tmpDir,
		},
	})

	readyChan := make(chan struct{}, 2)
	sendCallback := func(msg []byte) {
		var parsed map[string]any
		if err := json.Unmarshal(msg, &parsed); err == nil {
			if parsed["type"] == "ready" {
				select {
				case readyChan <- struct{}{}:
				default:
				}
			}
		}
	}

	// First init
	manager.HandleMessage("conv1", "init", initPayload, sendCallback)
	select {
	case <-readyChan:
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for ready")
	}

	w := manager.Get("conv1")
	if w == nil {
		t.Fatal("Worker not found")
	}

	// Send a message to start processing
	sendPayload, _ := json.Marshal(SendMessageMessage{
		Type: "send-message",
		Text: "Hello",
	})
	manager.HandleMessage("conv1", "send-message", sendPayload, nil)

	// Wait for worker to enter processing state
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if w.State() == StateProcessing {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if w.State() != StateProcessing {
		t.Fatalf("Expected StateProcessing, got %s", w.State())
	}

	// Send second init (simulates viewer reconnect) — this should NOT cancel
	manager.HandleMessage("conv1", "init", initPayload, sendCallback)

	// Wait for the reconnect init to be processed (it sends "ready")
	select {
	case <-readyChan:
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for ready after reconnect")
	}

	// Worker should still be processing — reconnect does not cancel
	if w.State() != StateProcessing {
		t.Fatalf("Expected StateProcessing after reconnect init, got %s", w.State())
	}

	// Verify processingState metadata is NOT idle (still actively processing)
	ps := w.Document().GetMetadata("processingState")
	psMap, _ := ps.(map[string]any)
	if psMap != nil && psMap["status"] == "idle" {
		t.Error("processingState should not be idle during active processing")
	}
}

// TestCancelStaleToolActions verifies that CancelStaleToolActions marks in-flight
// tool-action items as interrupted based on their state.
func TestCancelStaleToolActions(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Insert tool-action items with different states
	resultDone, _ := json.Marshal(map[string]any{"content": "done"})

	items := []ConversationItem{
		// Item 0: needs evaluation (no state) → should be interrupted
		{Type: ItemTypeToolAction, ItemID: "ta-0", ToolUseID: "tu-0", ToolName: "bash", State: ""},
		// Item 1: running → should be interrupted
		{Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1", ToolName: "bash", State: StateRunning},
		// Item 2: pending approval → should NOT be interrupted
		{Type: ItemTypeToolAction, ItemID: "ta-2", ToolUseID: "tu-2", ToolName: "bash", State: StatePending},
		// Item 3: completed → should NOT be interrupted
		{Type: ItemTypeToolAction, ItemID: "ta-3", ToolUseID: "tu-3", ToolName: "bash", State: StateCompleted, Result: resultDone},
	}
	for i, item := range items {
		w.doc.InsertMessage(i, item)
	}

	// Call CancelStaleToolActions
	w.CancelStaleToolActions()

	// Verify results
	updatedItems := w.doc.GetItems()
	if len(updatedItems) != 4 {
		t.Fatalf("Expected 4 items, got %d", len(updatedItems))
	}

	// Item 0: should be interrupted
	if len(updatedItems[0].Result) == 0 {
		t.Error("Item 0 (no approval, no result): expected interrupted result, got nil")
	} else {
		var r map[string]any
		_ = json.Unmarshal(updatedItems[0].Result, &r)
		if r["content"] != "Interrupted" {
			t.Errorf("Item 0: expected content 'Interrupted', got %v", r["content"])
		}
	}

	// Item 1: should be interrupted
	if len(updatedItems[1].Result) == 0 {
		t.Error("Item 1 (approved, no result): expected interrupted result, got nil")
	} else {
		var r map[string]any
		_ = json.Unmarshal(updatedItems[1].Result, &r)
		if r["content"] != "Interrupted" {
			t.Errorf("Item 1: expected content 'Interrupted', got %v", r["content"])
		}
	}

	// Item 2: should NOT be interrupted (pending)
	if len(updatedItems[2].Result) != 0 {
		t.Errorf("Item 2 (pending, no result): should not be interrupted, got result: %s", updatedItems[2].Result)
	}

	// Item 3: should NOT be interrupted (already has result)
	var r3 map[string]any
	_ = json.Unmarshal(updatedItems[3].Result, &r3)
	if r3["content"] != "done" {
		t.Errorf("Item 3 (approved, has result): expected original result 'done', got %v", r3["content"])
	}

	w.doc.Destroy()
}

// TestCancelParksWhenToolExecuting verifies the executing-must-park rule AND
// that the cancel preserves the warm session: when the user cancels while a turn
// parked in awaiting_llm has a genuinely executing tool (not merely awaiting
// approval), the worker (a) keeps any queued message (promotes it into the
// thread) and rests at idle WITHOUT driving a new LLM turn — the interrupted
// work must not be silently re-driven — and (b) releases the provider session,
// which is warm-preserving (the resume anchor survives), so the next turn
// resumes via regimeResumeDelta rather than cold-starting the conversation. The
// browser harness cannot pin a running tool under awaiting_llm (pauseBeforeReturn
// pins the LLM call, i.e. StateProcessing), so this branch is covered here; the
// pure-approval continue path is covered by the queued-message integration tests.
func TestCancelParksWhenToolExecuting(t *testing.T) {
	w := NewConversationWorker("test-cancel-park", "user:test")

	// A turn parked in awaiting_llm with one tool genuinely executing (running)
	// AND one still pending approval — the "mixed" case: approvals plus a
	// long-running task in flight.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "do work",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "Working.",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-run", ToolUseID: "tu-run",
		ToolName: "bash", State: StateRunning,
	})
	w.doc.InsertMessage(3, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-pend", ToolUseID: "tu-pend",
		ToolName: "bash", State: StatePending,
	})

	// Queue a follow-up message at root while the turn is in flight.
	w.enqueuePendingMessage("", UserMessageInput{Text: "queued follow-up"})

	// A turn that began a minute ago is anchored in memory and in the doc.
	oldAnchor := time.Now().Add(-60 * time.Second).UnixMilli()
	w.processingStartedAt = oldAnchor

	// Record that the worker released the provider session (warm-preserving).
	var released bool
	w.SetCancelLLMSession(func(_ string) { released = true })

	// The post-tool branch: worker idle, activity=awaiting_llm, the minute-old
	// anchor visible in the doc.
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
		"startedAt":    oldAnchor,
	})
	w.storeState(StateIdle)

	// Precondition: a running tool means this is NOT a pure-approval block.
	if w.blockedOnlyByApprovals() {
		t.Fatal("precondition: a running tool must make blockedOnlyByApprovals=false")
	}

	w.handleCancel()

	// The elapsed-time anchor must reset on the stop. Parking rests the turn via
	// sendStatus("idle"), so the NEXT turn — a Continue the user presses to start
	// the queued message — begins its timer from zero instead of inheriting this
	// cancelled turn's minute-old anchor (the "elapsed time didn't reset" bug).
	if w.processingStartedAt != 0 {
		t.Errorf("park: expected in-memory elapsed anchor reset to 0, got %d", w.processingStartedAt)
	}
	if startedAtPresent(t, w) {
		t.Error("park: expected doc startedAt dropped once the turn rests at idle")
	}

	// Real work was in flight: the worker releases the provider session, which
	// is warm-preserving (the resume anchor + sidecar survive). Re-driving the
	// interrupted tools is prevented by the parking below, NOT by dropping the
	// session — dropping it would force a multi-minute cold start, the dominant
	// spurious-cold-start path, since Claude emits multi-tool batches where one
	// tool executes while a sibling still awaits approval.
	if !released {
		t.Error("executing-tool cancel: expected the provider session to be released")
	}

	// Parked: activity cleared, no new LLM claim.
	if got := w.getActivity(); got != ActivityNone {
		t.Errorf("park: expected activity=%q (rested), got %q", ActivityNone, got)
	}
	if w.isLLMClaimed() {
		t.Error("park: expected no LLM claim after cancel")
	}

	// The queue was kept (promoted into items), not dropped, and is now empty.
	if w.hasPendingItems("") {
		t.Error("park: expected the pending queue to be promoted (empty)")
	}
	items := w.doc.GetItems()
	last := items[len(items)-1]
	if last.Type != ItemTypeUser || last.Content != "queued follow-up" {
		t.Errorf("park: expected last item to be the promoted user message, got type=%q content=%q",
			last.Type, last.Content)
	}

	// Every in-flight tool — running AND pending — was cancelled (Escape = stop all).
	for _, it := range items {
		if it.Type != ItemTypeToolAction {
			continue
		}
		if it.State != StateCancelled {
			t.Errorf("park: expected tool %q cancelled, got state=%q", it.ToolUseID, it.State)
		}
	}

	w.doc.Destroy()
}

// TestPureApprovalCancelPreservesWarmSession verifies that cancelling a turn
// parked PURELY on tool approval — nothing executing, e.g. an AskUserQuestion
// awaiting the user's answer — releases the provider session (always
// warm-preserving) and hands off to the reducer (needsReconcile) so a queued
// turn continues, rather than parking. Keeping the resume anchor warm lets the
// re-run resume via the provider's regimeResumeDelta and deliver the fresh
// answer to the model instead of cold-starting.
func TestPureApprovalCancelPreservesWarmSession(t *testing.T) {
	w := NewConversationWorker("test-pure-approval-cancel", "user:test")

	// Record that the worker released the provider session.
	var called bool
	w.SetCancelLLMSession(func(_ string) {
		called = true
	})

	// A turn parked in awaiting_llm with a single tool-action awaiting approval
	// and nothing executing anywhere — the AskUserQuestion-awaiting-answer shape.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "ask me",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "Asking.",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-ask", ToolUseID: "tu-ask",
		ToolName: "AskUserQuestion", State: StatePending,
	})

	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
	})
	w.storeState(StateIdle)

	// Precondition: a lone pending tool is a pure-approval block.
	if !w.blockedOnlyByApprovals() {
		t.Fatal("precondition: a lone pending tool must make blockedOnlyByApprovals=true")
	}

	w.handleCancel()

	if !called {
		t.Fatal("expected handleCancel to release the provider session")
	}
	// Pure-approval cancel hands to the reducer (continue what's queued) rather
	// than parking: it sets needsReconcile and deliberately leaves activity at
	// awaiting_llm so the reducer can run, rather than clearing it to idle.
	if !w.needsReconcile {
		t.Error("pure-approval cancel: expected needsReconcile=true (hand off to reducer)")
	}
	if got := w.getActivity(); got != ActivityAwaitingLLM {
		t.Errorf("pure-approval cancel: expected activity preserved as %q for the reducer, got %q",
			ActivityAwaitingLLM, got)
	}

	w.doc.Destroy()
}

// startedAtMillis reads processingState.startedAt from the doc as int64,
// coercing whatever numeric shape ycrdt round-trips it to.
func startedAtMillis(t *testing.T, w *ConversationWorker) int64 {
	t.Helper()
	state := w.readProcessingState()
	if state == nil {
		t.Fatal("processingState absent")
	}
	switch v := state["startedAt"].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case int:
		return int64(v)
	default:
		t.Fatalf("startedAt missing or non-numeric: %T %v", state["startedAt"], state["startedAt"])
		return 0
	}
}

// startedAtPresent reports whether processingState carries a startedAt anchor.
// The spinner's elapsed digit renders only when it is present, so its absence is
// how "show no timer" (idle, or parked on an approval) is expressed.
func startedAtPresent(t *testing.T, w *ConversationWorker) bool {
	t.Helper()
	state := w.readProcessingState()
	if state == nil {
		return false
	}
	_, ok := state["startedAt"]
	return ok
}

// TestApprovalWaitHidesThenExcludesElapsedTimer verifies the approval-wait
// accounting: when a turn parks PURELY on a human approval the worker REMOVES
// startedAt (so every client shows no elapsed digit while awaiting), and when the
// user approves and work resumes the worker advances startedAt FORWARD by the
// wait and writes it back — so the digit reappears counting active work with the
// deliberation excluded, never snapping to 0. Mirrors the parked→approved edge: a
// lone pending tool-action the user then approves (state=approved → executing).
func TestApprovalWaitHidesThenExcludesElapsedTimer(t *testing.T) {
	w := NewConversationWorker("test-approval-wait", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "do it",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "May I?",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-pend", ToolUseID: "tu-pend",
		ToolName: "bash", State: StatePending,
	})

	// A turn that began a minute ago and is now parked awaiting approval.
	oldAnchor := time.Now().Add(-60 * time.Second).UnixMilli()
	w.processingStartedAt = oldAnchor
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
		"startedAt":    oldAnchor,
	})

	// Tick 1: parked→ enter edge. startedAt is removed (digit hidden) and the
	// in-memory wait marker is set; the in-memory anchor is left intact so a
	// cancel-at-prompt loses nothing.
	w.updateApprovalWaitAnchor()
	if !w.wasBlockedOnApprovals {
		t.Fatal("parked on a lone pending tool: expected wasBlockedOnApprovals=true")
	}
	if startedAtPresent(t, w) {
		t.Error("on entering an approval park: expected startedAt to be removed (digit hidden)")
	}
	if w.approvalWaitStartedAt == 0 {
		t.Error("on entering an approval park: expected approvalWaitStartedAt to be recorded")
	}
	if w.processingStartedAt != oldAnchor {
		t.Errorf("while parked: in-memory anchor must not move, got %d want %d", w.processingStartedAt, oldAnchor)
	}

	// Simulate a 10s deliberation by backdating the in-memory wait marker.
	waitMs := int64(10_000)
	w.approvalWaitStartedAt = time.Now().UnixMilli() - waitMs

	// The user approves: the pending tool becomes approved (executing).
	if !w.doc.UpdateToolActionFieldsRecursive("tu-pend", map[string]any{"state": StateApproved}) {
		t.Fatal("failed to mark tu-pend approved")
	}

	// Tick 2: parked→working edge. startedAt reappears, advanced forward by ~the
	// wait, so the elapsed digit excludes the deliberation but never snaps to 0.
	w.updateApprovalWaitAnchor()
	if w.wasBlockedOnApprovals {
		t.Error("after approve: expected wasBlockedOnApprovals=false (work executing)")
	}
	if w.approvalWaitStartedAt != 0 {
		t.Error("after approve: expected approvalWaitStartedAt to be cleared")
	}
	if !startedAtPresent(t, w) {
		t.Fatal("after approve: expected startedAt to reappear")
	}
	got := startedAtMillis(t, w)
	if got != w.processingStartedAt {
		t.Errorf("after approve: doc startedAt (%d) must match in-memory anchor (%d)", got, w.processingStartedAt)
	}
	// startedAt should have advanced by ~waitMs (allow generous slack for the
	// real elapsed between backdating and the resume tick).
	advance := got - oldAnchor
	if advance < waitMs-2_000 || advance > waitMs+5_000 {
		t.Errorf("after approve: startedAt should advance by ~%dms (the wait), advanced %dms", waitMs, advance)
	}
}

// TestAutoApproveLeavesElapsedTimerUntouched verifies that a tool which is
// auto-approved — Unevaluated→Approved without ever sitting in StatePending —
// neither hides nor advances the elapsed-time anchor. The timer keeps counting
// the running turn; only a genuine human approval at a prompt is accounted for.
func TestAutoApproveLeavesElapsedTimerUntouched(t *testing.T) {
	w := NewConversationWorker("test-autoapprove-timer", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "go",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-auto", ToolUseID: "tu-auto",
		ToolName: "bash", State: StateUnevaluated,
	})

	oldAnchor := time.Now().Add(-30 * time.Second).UnixMilli()
	w.processingStartedAt = oldAnchor
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityCallingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
		"startedAt":    oldAnchor,
	})

	// Tick 1: an unevaluated tool is neither pending nor executing — not a park.
	w.updateApprovalWaitAnchor()
	if w.wasBlockedOnApprovals {
		t.Fatal("unevaluated tool: expected wasBlockedOnApprovals=false")
	}

	// Engine auto-approves: Unevaluated→Approved, never pending.
	if !w.doc.UpdateToolActionFieldsRecursive("tu-auto", map[string]any{"state": StateApproved}) {
		t.Fatal("failed to mark tu-auto approved")
	}

	// Tick 2: now executing, but the turn was never parked on approval, so the
	// digit is never hidden and the anchor must NOT move.
	w.updateApprovalWaitAnchor()
	if w.approvalWaitStartedAt != 0 {
		t.Error("auto-approve must never record an approval wait")
	}
	if w.processingStartedAt != oldAnchor {
		t.Errorf("auto-approve must not move the anchor: got %d want %d", w.processingStartedAt, oldAnchor)
	}
	if got := startedAtMillis(t, w); got != oldAnchor {
		t.Errorf("auto-approve must not touch doc startedAt: got %d want %d", got, oldAnchor)
	}
}

// TestFrozenGapExcludesSuspendedTimeFromElapsed verifies the general frozen-gap
// detector: when a liveness tick lands far later than its interval — meaning the
// process wasn't running (system sleep, VM/host hibernate, a stop-the-world pause)
// — the excess dead time is pushed out of the elapsed anchor, so the digit resumes
// counting only wall-clock time the process was actually alive. Deliberately not
// sleep-specific: the detector observes missed ticks, whatever their cause.
func TestFrozenGapExcludesSuspendedTimeFromElapsed(t *testing.T) {
	w := NewConversationWorker("test-frozen-gap", "user:test")
	defer w.doc.Destroy()

	// A turn that began a minute ago, actively running (anchor in memory + doc).
	oldAnchor := time.Now().Add(-60 * time.Second).UnixMilli()
	w.processingStartedAt = oldAnchor
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":  ActivityCallingLLM,
		"status":    "streaming",
		"startedAt": oldAnchor,
	})

	// First tick just seeds lastLivenessMs — no comparison point yet, no change.
	w.detectFrozenGap()
	if w.processingStartedAt != oldAnchor {
		t.Fatalf("first tick must not move the anchor: got %d want %d", w.processingStartedAt, oldAnchor)
	}

	// Simulate the process having been frozen for 30s: backdate the last tick so
	// this tick lands 30s + one interval later than expected.
	frozenMs := int64(30_000)
	w.lastLivenessMs = time.Now().UnixMilli() - frozenMs - livenessInterval.Milliseconds()

	w.detectFrozenGap()

	// The anchor must advance by ~the frozen span, so `now - startedAt` sheds the
	// dead time instead of counting it.
	advance := w.processingStartedAt - oldAnchor
	if advance < frozenMs-2_000 || advance > frozenMs+2_000 {
		t.Errorf("frozen gap: anchor should advance by ~%dms, advanced %dms", frozenMs, advance)
	}
	if got := startedAtMillis(t, w); got != w.processingStartedAt {
		t.Errorf("frozen gap: doc startedAt (%d) must match in-memory anchor (%d)", got, w.processingStartedAt)
	}
}

// TestFrozenGapIgnoredWhenIdleOrParked verifies the detector is inert when there
// is no actively-running turn to correct: idle (no anchor) and parked-on-approval
// (the approval-wait mechanism already excludes the whole park, this freeze
// included, so advancing here too would double-count it).
func TestFrozenGapIgnoredWhenIdleOrParked(t *testing.T) {
	w := NewConversationWorker("test-frozen-gap-inert", "user:test")
	defer w.doc.Destroy()

	backdate := func() {
		w.lastLivenessMs = time.Now().UnixMilli() - 30_000 - livenessInterval.Milliseconds()
	}

	// Idle: no anchor. A large gap must not create one.
	w.processingStartedAt = 0
	w.detectFrozenGap() // seed
	backdate()
	w.detectFrozenGap()
	if w.processingStartedAt != 0 {
		t.Errorf("idle: frozen gap must not set an anchor, got %d", w.processingStartedAt)
	}

	// Parked on an approval: anchor present but approvalWaitStartedAt set. The
	// detector must leave the anchor alone (the approval-wait path owns exclusion).
	oldAnchor := time.Now().Add(-60 * time.Second).UnixMilli()
	w.processingStartedAt = oldAnchor
	w.approvalWaitStartedAt = time.Now().UnixMilli()
	backdate()
	w.detectFrozenGap()
	if w.processingStartedAt != oldAnchor {
		t.Errorf("parked: frozen gap must not move the anchor, got %d want %d", w.processingStartedAt, oldAnchor)
	}
}

// TestStrategyLoopExitCleansUpToolActions verifies that when the strategy loop
// exits (via cancellation), stale tool-actions are cleaned up with interrupted results.
func TestStrategyLoopExitCleansUpToolActions(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Set up mock mode with a response that creates tool actions
	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "bash", Input: json.RawMessage(`{"command":"ls"}`)},
			},
			StopReason: "tool_use",
		},
	})

	// Add a tool-action item manually (simulating what addToolAction does)
	// to represent an in-flight tool that won't complete
	w.doc.InsertMessage(0, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-stale",
		ToolUseID: "tu-stale",
		ToolName:  "bash",
	})

	// Call CancelStaleToolActions directly (as the strategy loop defer would)
	w.CancelStaleToolActions()

	// Verify the stale tool-action was marked as interrupted
	items := w.doc.GetItems()
	found := false
	for _, item := range items {
		if item.ToolUseID == "tu-stale" {
			found = true
			if len(item.Result) == 0 {
				t.Error("Stale tool-action should have interrupted result")
			} else {
				var r map[string]any
				_ = json.Unmarshal(item.Result, &r)
				if r["content"] != "Interrupted" {
					t.Errorf("Expected 'Interrupted', got %v", r["content"])
				}
				if r["cancelled"] != true {
					t.Error("Expected cancelled=true")
				}
			}
		}
	}
	if !found {
		t.Error("Stale tool-action not found in items")
	}

	w.doc.Destroy()
}

// TestThreadWithoutReturnResultStaysOpen verifies that when a thread's LLM
// responds with text and end_turn WITHOUT calling return_result, the thread
// stays OPEN (no result on its Y.Map) rather than auto-closing on the trailing
// assistant text. A thread closes only on an explicit return_result call (or a
// hard error). Exercises the full production path: LLM calls create_thread →
// executeCreateThread → nested strategy loop → loop ends → thread left open.
func TestThreadWithoutReturnResultStaysOpen(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateProcessing)

	// Mock responses:
	// 1. Parent LLM calls create_thread tool
	// 2. Thread LLM responds with text + end_turn (no return_result) → open
	// The parent is NOT resumed (the open child never signals it), so no
	// parent-turn-2 mock is needed.
	w.setMockResponses([]MockResponse{
		// Parent turn 1: calls create_thread
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "create_thread", Input: json.RawMessage(`{"goal":"Test thread","prompt":"Do the task"}`)},
			},
			StopReason: "tool_use",
		},
		// Thread turn: responds with text, no return_result → thread stays open
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "I completed the task successfully."},
			},
			StopReason: "end_turn",
		},
	})

	// Feed context and tools results for the two LLM iterations:
	// parent turn 1 and the thread turn.
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

		for i := 0; i < 2; i++ {
			w.contextResultChan <- ctxResponse
			w.toolsResultChan <- toolsResponse
		}
	}()

	// Run the strategy loop as production does — starts from a user message
	w.runStrategyLoop("Hello", false)

	// Find the thread item and verify it has NO result (stays open).
	items := w.doc.GetItems()
	threadFound := false
	var threadResult string
	for _, item := range items {
		if item.Type == ItemTypeThread {
			threadFound = true
			threadYMap := w.doc.GetThreadYMap(item.ItemID)
			if threadYMap != nil {
				threadResult, _ = threadYMap.Get("result").(string)
			}
			break
		}
	}

	if !threadFound {
		t.Fatal("no thread item found — create_thread did not insert a thread")
	}
	if threadResult != "" {
		t.Errorf("thread result = %q, want empty — a thread ending in plain assistant text must stay OPEN, not auto-close", threadResult)
	}

	w.doc.Destroy()
}

// TestCreateThreadInjectsToolUseInParentMessages verifies that when the parent
// LLM calls create_thread, the parent's subsequent buildMessages output
// contains the assistant tool_use block AND a user tool_result with the
// thread's summary. Without this, the parent LLM has no memory that it
// spawned a thread and will re-do the work on continuation.
func TestCreateThreadInjectsToolUseInParentMessages(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateProcessing)

	w.setMockResponses([]MockResponse{
		// Parent turn 1: calls create_thread
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-create-1", Name: "create_thread", Input: json.RawMessage(`{"goal":"Test thread","prompt":"Do the task"}`)},
			},
			StopReason: "tool_use",
		},
		// Child thread: closes via return_result (threads no longer auto-close on text)
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-ret-1", Name: "return_result", Input: json.RawMessage(`{"result":"Task completed successfully."}`)},
			},
			StopReason: "tool_use",
		},
		// Parent continuation
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Got it."},
			},
			StopReason: "end_turn",
		},
	})

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
		for i := 0; i < 3; i++ {
			w.contextResultChan <- ctxResponse
			w.toolsResultChan <- toolsResponse
		}
	}()

	w.runStrategyLoop("Hello", false)

	// After the loop, w.thread is reset, so buildMessages walks the root
	// items — exactly the view the parent LLM would see on continuation.
	messages := w.buildMessages(nil)

	var foundToolUse, foundToolResult bool
	var toolResultContent string
	var toolInput map[string]any
	for _, m := range messages {
		if m["type"] == "tool-use" && m["toolUseId"] == "tu-create-1" && m["toolName"] == "create_thread" {
			foundToolUse = true
			toolInput, _ = m["toolInput"].(map[string]any)
		}
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-create-1" {
			foundToolResult = true
			toolResultContent, _ = m["content"].(string)
		}
	}

	if !foundToolUse {
		t.Errorf("expected tool-use block for create_thread (tu-create-1) in parent messages; messages=%+v", messages)
	}
	if !foundToolResult {
		t.Errorf("expected tool-result block for tu-create-1 in parent messages; messages=%+v", messages)
	}
	if foundToolResult && !strings.Contains(toolResultContent, "Task completed successfully.") {
		t.Errorf("tool-result content should contain the thread's summary; got %q", toolResultContent)
	}
	// The tool_use block must carry the LLM's original input object; without
	// this, providers see {"input": null} and the model treats the call as
	// invalid (i.e. "I never spawned this thread").
	if toolInput == nil {
		t.Fatalf("tool-use block has nil toolInput — provider will see null input; messages=%+v", messages)
	}
	if got, _ := toolInput["goal"].(string); got != "Test thread" {
		t.Errorf("toolInput.goal = %q, want %q", got, "Test thread")
	}
	if got, _ := toolInput["prompt"].(string); got != "Do the task" {
		t.Errorf("toolInput.prompt = %q, want %q", got, "Do the task")
	}

	w.doc.Destroy()
}

// TestReducer_EmptyUserThreadDoesNotAutoRunUnderAwaitingLLM reproduces the
// "the new thread immediately starts running" bug at the reducer level.
//
// When the parent conversation is parked at activity=awaiting_llm (the marker a
// pending tool / in-flight turn leaves on the ROOT thread) and the user presses
// the input-box "New Thread" button, an empty thread is inserted at root as a
// pure Yjs mutation with no user message. The reducer's walk-down then descends
// into that empty child and — because "empty nested thread under awaiting_llm"
// is the continuation dispatch trigger — borrows the PARENT's awaiting_llm
// marker to fire an LLM turn on the brand-new thread.
//
// That marker does not belong to the new thread: a user-created thread must
// wait for the user to actually send a message. The legitimate empty-thread
// auto-run (continueInNewThread / the orchestrator) always targets the thread
// directly via processingState.threadItemID, so it is reached as the walk-down
// ROOT, never by descending into it.
func TestReducer_EmptyUserThreadDoesNotAutoRunUnderAwaitingLLM(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// A single text response: if the empty thread wrongly runs, it consumes this
	// and appends an assistant item — the evidence of the bug.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN"}}, StopReason: "end_turn"},
	})

	// Feed context/tools so that IF the buggy dispatch fires the turn COMPLETES
	// (leaving evidence) instead of blocking the test on the context channel.
	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "You are a helpful assistant.",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for i := 0; i < 2; i++ {
			w.contextResultChan <- ctxResponse
			w.toolsResultChan <- toolsResponse
		}
	}()

	// Parent parked at awaiting_llm on the ROOT thread (threadItemID="").
	w.requestLLM("")

	// User presses "New Thread": empty thread inserted at root.
	threadItemID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		item := ConversationItem{Type: ItemTypeThread, ItemID: threadItemID, Goal: "Thread"}
		ymap := conversationItemToYMap(item)
		ymap.Set("items", ycrdt.NewYArray())
		ymap.Set("strategyCreated", true)
		w.doc.ensureItems().Push(ycrdt.ArrayAny{ymap})
	}, w.doc.authorID)

	// Drive the reducer exactly as the event loop would after the insert.
	w.needsReconcile = true
	for i := 0; i < 10 && w.needsReconcile; i++ {
		w.tryReconcile()
	}

	arr := w.doc.GetThreadItemsArray(threadItemID)
	if arr == nil {
		t.Fatal("thread items array missing")
	}
	items := w.doc.GetItemsFromArray(arr)
	if len(items) != 0 {
		t.Fatalf("empty user-created thread auto-ran under awaiting_llm: thread has %d item(s): %+v; it must wait for the user to send a message", len(items), items)
	}
}

// TestQueuedMessageJoinsToolResultContinuation pins turn composition for a
// message typed while a tool is running (parked in the pending "type while
// busy" queue). The strategy loop promotes the queue at EVERY turn boundary —
// including a tool-result continuation — so the queued message is delivered at
// the earliest opportunity: spliced in after the completed tool batch, riding
// the SAME turn that delivers the tool results, not deferred to end-of-run.
// The splice is append-only (the promoted item lands after the tool batch), so
// stateless providers' prefix caches are unaffected; claudecode pays a warm
// resume respawn, an accepted price for prompt delivery.
//
// Observable proof at the worker layer: ONE LLM turn runs, and the promoted
// queued user item lands after the completed tool action but BEFORE that
// turn's assistant reply.
func TestQueuedMessageJoinsToolResultContinuation(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Seed a completed tool batch awaiting the model's reaction: user asked,
	// assistant called a tool, the tool has completed. The user's original
	// message is already stamped (it drove the first turn).
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "run bash",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll run that.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateCompleted, Result: resultJSON("ok"),
		TransactionID: "txn-0",
	})
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	// User types a follow-up while the tool was running — parked in the queue.
	w.enqueuePendingMessage("", UserMessageInput{Text: "queued follow-up"})

	// ONE scripted turn: the tool-result continuation with the queued message
	// spliced in. If the queued message were deferred to a second turn, the
	// loop would run again and fail on the exhausted script.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "reply to tools and follow-up"}}, StopReason: "end_turn"},
	})

	// Supply context/tools on demand so each dispatched turn completes. Two
	// independent feeders avoid any ctx-vs-tools ordering dependency.
	stop := make(chan struct{})
	defer close(stop)
	ctxResp, _ := json.Marshal(map[string]any{
		"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
	})
	toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
	go func() {
		for {
			select {
			case <-stop:
				return
			case w.contextResultChan <- ctxResp:
			}
		}
	}()
	go func() {
		for {
			select {
			case <-stop:
				return
			case w.toolsResultChan <- toolsResp:
			}
		}
	}()

	// Drive the reducer exactly as the event loop would after the tool completes.
	w.needsReconcile = true
	for i := 0; i < 10 && w.needsReconcile; i++ {
		w.tryReconcile()
	}

	// Exactly the one scripted turn must have run.
	if n := len(w.mock.responses); n != 0 {
		t.Fatalf("expected the single scripted turn consumed, %d left — the queued message was not promoted into the tool-result continuation", n)
	}

	// Full item sequence: the promoted queued user message lands after the
	// completed tool action and BEFORE the turn's assistant reply, proving it
	// was spliced into the continuation rather than deferred.
	items := w.doc.GetItems()
	gotTypes := make([]string, len(items))
	for i, it := range items {
		gotTypes[i] = it.Type
	}
	// u-1 "run bash" / a-1 "I'll run that." / ta-1 completed /
	// promoted "queued follow-up" / the single turn's reply.
	wantTypes := []string{
		ItemTypeUser,
		ItemTypeAssistant,
		ItemTypeToolAction,
		ItemTypeUser,
		ItemTypeAssistant,
	}
	if len(gotTypes) != len(wantTypes) {
		t.Fatalf("item count = %d, want %d; types=%v full=%+v", len(gotTypes), len(wantTypes), gotTypes, items)
	}
	for i := range wantTypes {
		if gotTypes[i] != wantTypes[i] {
			t.Fatalf("item[%d] type = %q, want %q; full types=%v", i, gotTypes[i], wantTypes[i], gotTypes)
		}
	}
	if items[3].Content != "queued follow-up" {
		t.Errorf("item[3] (promoted queued message) content = %q, want %q", items[3].Content, "queued follow-up")
	}
	if items[4].Content != "reply to tools and follow-up" {
		t.Errorf("item[4] (turn reply) content = %q, want %q", items[4].Content, "reply to tools and follow-up")
	}
	if w.hasPendingItems("") {
		t.Errorf("pending queue should be drained after the queued message was promoted")
	}
}

// TestInjectedSystemReminderReachesMessages pins the worker-path half of the
// strategy message-injection model: a system-reminder item written into the
// conversation doc (e.g. by a strategy's injectGuidance) must be emitted by
// buildMessages so it actually reaches the LLM.
func TestInjectedSystemReminderReachesMessages(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	const reminder = "RESEARCH MODE ACTIVE: read-only this turn."

	w.tracker.InsertMessage(w.doc.GetItemsLength(),
		ConversationItem{Type: ItemTypeUser, Content: "Explain the auth module."},
		ConversationItem{Type: ItemTypeSystemReminder, Content: reminder, Summary: "research-mode"},
	)

	messages := w.buildMessages(nil)

	var found bool
	for _, m := range messages {
		if m["type"] == ItemTypeSystemReminder && m["content"] == reminder {
			found = true
		}
	}
	if !found {
		t.Errorf("injected system-reminder did not reach buildMessages output; messages=%+v", messages)
	}
}

// TestInjectedGuidanceReachesMessages is the guidance-typed sibling of the
// above: the worker must also surface a 'guidance' item, matching the
// context-builder fallback which passes both types through.
func TestInjectedGuidanceReachesMessages(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	const guidance = "Choose ONE path per response."

	w.tracker.InsertMessage(w.doc.GetItemsLength(),
		ConversationItem{Type: ItemTypeUser, Content: "Fix the bug."},
		ConversationItem{Type: ItemTypeGuidance, Content: guidance},
	)

	messages := w.buildMessages(nil)

	var found bool
	for _, m := range messages {
		if m["type"] == ItemTypeGuidance && m["content"] == guidance {
			found = true
		}
	}
	if !found {
		t.Errorf("injected guidance did not reach buildMessages output; messages=%+v", messages)
	}
}

// TestThreadDepthCap pins the runaway-recursion backstop: create_thread may
// nest up to maxThreadDepth levels, and a spawn from a thread already at that
// depth is refused. The refusal must not silently vanish (that would leave the
// parent's tool_use unanswered) nor create the over-deep thread — instead the
// worker appends a meta-tool-result error bound to the create_thread tool_use,
// telling the model to do the sub-task inline. Below the cap, spawning works
// normally.
func TestThreadDepthCap(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)

	// Build a thread chain root -> L1 -> ... -> L{maxThreadDepth}, each level
	// holding the next as its only nested item. Record each level's id+array.
	type level struct {
		id  string
		arr *ycrdt.YArray
	}
	levels := make([]level, 0, maxThreadDepth)
	arr := w.doc.ensureItems()
	for i := 1; i <= maxThreadDepth; i++ {
		nested := w.doc.InsertThreadIntoArray(arr, w.doc.GetItemsLengthFromArray(arr), fmt.Sprintf("L%d", i))
		items := w.doc.GetItemsFromArray(arr)
		levels = append(levels, level{id: items[len(items)-1].ItemID, arr: nested})
		arr = nested
	}

	// threadDepth must count root ("") as 0 and each level as its 1-based depth.
	if got := w.doc.threadDepth(""); got != 0 {
		t.Fatalf("threadDepth(root) = %d, want 0", got)
	}
	for i, lv := range levels {
		if got := w.doc.threadDepth(lv.id); got != i+1 {
			t.Fatalf("threadDepth(L%d) = %d, want %d", i+1, got, i+1)
		}
	}

	deepest := levels[len(levels)-1] // depth == maxThreadDepth

	// A spawn from the deepest thread is refused.
	w.thread.itemID = deepest.id
	w.thread.itemsArray = deepest.arr
	beforeLen := w.doc.GetItemsLengthFromArray(deepest.arr)
	input := json.RawMessage(`{"goal":"too deep","prompt":"spawn another"}`)
	if err := w.executeCreateThread("tu-deep", "create_thread", input); err != nil {
		t.Fatalf("executeCreateThread returned error: %v", err)
	}

	deepItems := w.doc.GetItemsFromArray(deepest.arr)
	for _, it := range deepItems {
		if it.Type == ItemTypeThread {
			t.Fatalf("depth cap breached: a child thread was created below depth %d", maxThreadDepth)
		}
	}
	if got := w.doc.GetItemsLengthFromArray(deepest.arr); got != beforeLen+1 {
		t.Fatalf("expected exactly one item appended (the refusal), before=%d after=%d", beforeLen, got)
	}
	var refusal *ConversationItem
	for i := range deepItems {
		if deepItems[i].Type == ItemTypeMetaToolResult && deepItems[i].ToolUseID == "tu-deep" {
			refusal = &deepItems[i]
		}
	}
	if refusal == nil {
		t.Fatalf("expected a meta-tool-result refusal bound to tu-deep; items=%+v", deepItems)
	}
	if !refusal.IsError {
		t.Errorf("refusal meta-tool-result should be isError=true")
	}

	// The refusal must reach the LLM as a paired create_thread tool_use +
	// tool_result, never a dangling tool_use the provider would reject.
	msgs := w.buildMessages(nil)
	var sawToolUse, sawResult bool
	for _, m := range msgs {
		if m["type"] == "tool-use" && m["toolUseId"] == "tu-deep" {
			sawToolUse = true
		}
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-deep" {
			sawResult = true
		}
	}
	if !sawToolUse || !sawResult {
		t.Errorf("refusal must emit a paired tool_use+tool_result for tu-deep; sawToolUse=%v sawResult=%v", sawToolUse, sawResult)
	}

	// A spawn one level above the cap (depth maxThreadDepth-1) is allowed.
	parent := levels[len(levels)-2]
	w.thread.itemID = parent.id
	w.thread.itemsArray = parent.arr
	if err := w.executeCreateThread("tu-ok", "create_thread", json.RawMessage(`{"goal":"ok","prompt":"work"}`)); err != nil {
		t.Fatalf("executeCreateThread (below cap) returned error: %v", err)
	}
	var spawned bool
	for _, it := range w.doc.GetItemsFromArray(parent.arr) {
		if it.Type == ItemTypeThread && it.ItemID != deepest.id {
			spawned = true
		}
	}
	if !spawned {
		t.Errorf("expected a child thread to be created below the depth cap")
	}
}

// TestThreadBreadthCap pins the runaway fan-out backstop: create_thread is
// refused once maxLiveThreads llmCreated children are already in flight, even
// though the nesting depth is well under maxThreadDepth. This is the case the
// depth cap alone misses — a model re-delegating the same task into ever more
// shallow siblings. Like the depth refusal, it must emit a paired
// meta-tool-result (never a dangling tool_use) and must not create the thread.
// The cap self-heals: once a child records a result, liveThreadCount drops and
// spawning is allowed again.
func TestThreadBreadthCap(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateProcessing)

	// Fill the document with maxLiveThreads in-flight llmCreated siblings at
	// root (no result). These count toward liveThreadCount.
	root := w.doc.ensureItems()
	ids := make([]string, 0, maxLiveThreads)
	for i := 0; i < maxLiveThreads; i++ {
		w.doc.InsertThreadIntoArray(root, w.doc.GetItemsLengthFromArray(root), fmt.Sprintf("T%d", i))
		items := w.doc.GetItemsFromArray(root)
		id := items[len(items)-1].ItemID
		w.doc.SetThreadField(id, "llmCreated", true)
		ids = append(ids, id)
	}
	if got := w.doc.liveThreadCount(); got != maxLiveThreads {
		t.Fatalf("liveThreadCount = %d, want %d", got, maxLiveThreads)
	}

	// A create_thread from root (depth 0, far under the depth cap) is refused
	// purely because too many threads are already live.
	beforeLen := w.doc.GetItemsLengthFromArray(root)
	if err := w.executeCreateThread("tu-breadth", "create_thread",
		json.RawMessage(`{"goal":"more","prompt":"spawn another"}`)); err != nil {
		t.Fatalf("executeCreateThread returned error: %v", err)
	}
	if got := w.doc.GetItemsLengthFromArray(root); got != beforeLen+1 {
		t.Fatalf("expected exactly one item appended (the refusal), before=%d after=%d", beforeLen, got)
	}
	rootItems := w.doc.GetItemsFromArray(root)
	var refusal *ConversationItem
	for i := range rootItems {
		if rootItems[i].Type == ItemTypeThread && rootItems[i].ItemID != "" {
			if !containsID(ids, rootItems[i].ItemID) {
				t.Fatalf("breadth cap breached: a new thread was created while %d were live", maxLiveThreads)
			}
		}
		if rootItems[i].Type == ItemTypeMetaToolResult && rootItems[i].ToolUseID == "tu-breadth" {
			refusal = &rootItems[i]
		}
	}
	if refusal == nil {
		t.Fatalf("expected a meta-tool-result refusal bound to tu-breadth")
	}
	if !refusal.IsError {
		t.Errorf("refusal meta-tool-result should be isError=true")
	}

	// The refusal reaches the LLM as a paired create_thread tool_use+tool_result.
	msgs := w.buildMessages(nil)
	var sawToolUse, sawResult bool
	for _, m := range msgs {
		if m["type"] == "tool-use" && m["toolUseId"] == "tu-breadth" {
			sawToolUse = true
		}
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-breadth" {
			sawResult = true
		}
	}
	if !sawToolUse || !sawResult {
		t.Errorf("refusal must emit a paired tool_use+tool_result for tu-breadth; sawToolUse=%v sawResult=%v", sawToolUse, sawResult)
	}

	// Self-heal: once one live thread records a result, the count drops below
	// the cap and a spawn is allowed again.
	w.doc.SetThreadField(ids[0], "result", "done")
	if got := w.doc.liveThreadCount(); got != maxLiveThreads-1 {
		t.Fatalf("liveThreadCount after one result = %d, want %d", got, maxLiveThreads-1)
	}
	if err := w.executeCreateThread("tu-ok", "create_thread",
		json.RawMessage(`{"goal":"ok","prompt":"work"}`)); err != nil {
		t.Fatalf("executeCreateThread (below breadth cap) returned error: %v", err)
	}
	var spawned bool
	for _, it := range w.doc.GetItemsFromArray(root) {
		if it.Type == ItemTypeThread && !containsID(ids, it.ItemID) {
			spawned = true
		}
	}
	if !spawned {
		t.Errorf("expected a child thread to be created below the breadth cap")
	}
}

// containsID reports whether id is in ids.
func containsID(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func TestBrowserCreateThreadUsesRequestedParentThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "anthropic", "model": "claude-test"})

	// Some root history (threads are isolated, so this is not inherited).
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeUser, ItemID: "root-user", Content: "Root context"})

	// Create a parent thread under root with one nested user message.
	parentItems := w.doc.InsertThreadIntoArray(w.doc.getItems(), w.doc.GetItemsLength(), "Parent thread")
	rootItems := w.doc.GetItems()
	parentThreadID := rootItems[len(rootItems)-1].ItemID
	w.doc.InsertMessageIntoArray(parentItems, 0, ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "parent-user",
		Content: "Parent context",
	})

	w.setMockResponses([]MockResponse{
		// Continuation child: emits its assistant output AND closes via
		// return_result in the same turn (threads no longer auto-close on text).
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Child completed."},
				{Type: "tool_use", ID: "tu-ret-1", Name: "return_result", Input: json.RawMessage(`{"result":"Child completed."}`)},
			},
			StopReason: "tool_use",
		},
	})

	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "Test",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []any{},
		})
		w.contextResultChan <- ctxResponse
		w.toolsResultChan <- toolsResponse
	}()

	payload, _ := json.Marshal(CreateThreadMessage{
		Type:           "create-thread",
		RequestID:      "req-1",
		Goal:           "Child thread",
		Prompt:         "",
		ThreadItemID:   parentThreadID,
		IsContinuation: true,
	})

	w.handleCreateThread(payload)

	// Root should still contain exactly one thread: the parent.
	items := w.doc.GetItems()
	if len(items) != 2 {
		t.Fatalf("expected 2 root items (root user + parent thread), got %d", len(items))
	}
	if items[1].Type != ItemTypeThread || items[1].ItemID != parentThreadID {
		t.Fatalf("expected root child to remain parent thread %q, got %+v", parentThreadID, items[1])
	}

	childItems := w.doc.GetItemsFromArray(parentItems)
	if len(childItems) != 2 {
		t.Fatalf("expected parent thread to contain 2 items (existing user + child thread), got %d", len(childItems))
	}
	childThread := childItems[1]
	if childThread.Type != ItemTypeThread {
		t.Fatalf("expected nested child thread, got type %q", childThread.Type)
	}

	childThreadMap := w.doc.GetThreadYMap(childThread.ItemID)
	if childThreadMap == nil {
		t.Fatal("expected nested child thread Y.Map")
	}
	if result, _ := childThreadMap.Get("result").(string); result != "Child completed." {
		t.Fatalf("expected child thread result to be written, got %q", result)
	}

	// The continuation child was created under the requested parent thread,
	// not inserted as a new root-level thread.
	childArr := w.doc.GetThreadItemsArray(childThread.ItemID)
	if childArr == nil {
		t.Fatal("expected nested child thread items array")
	}
	childNestedItems := w.doc.GetItemsFromArray(childArr)
	if len(childNestedItems) == 0 {
		t.Fatal("expected continuation child thread to contain assistant output")
	}
	if childNestedItems[0].Type != ItemTypeAssistant || childNestedItems[0].Content != "Child completed." {
		t.Fatalf("expected child thread to start with assistant continuation output, got %+v", childNestedItems[0])
	}
	for _, item := range childNestedItems {
		if item.Type == ItemTypeUser {
			t.Fatalf("did not expect continuation child thread to contain a synthetic user message: %+v", item)
		}
	}

	w.doc.Destroy()
}

// TestThreadErrorLeavesThreadOpenNotResumeParent pins the contract that a
// sub-thread which stops on an error stays OPEN and resumable — the worker
// never fabricates a failure result on the thread's behalf. An error is just
// an item in the thread's history, identical to a turn that ended on plain
// assistant text: the thread carries no result, the conversation goes idle,
// and the parent is NOT auto-resumed. The user reviews the error (visible as
// an error item) and resumes the thread or closes it explicitly; the thread
// itself may later call return_result to report the error as its result.
func TestThreadErrorLeavesThreadOpenNotResumeParent(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Add a user message so the conversation isn't empty
	w.doc.AppendMessage(ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "msg-1",
		Content: "Hello",
	})

	// Mock: parent calls create_thread, the thread's LLM call fails (simulated
	// transient network error). A THIRD response is supplied to prove the parent
	// is NOT auto-resumed: if the broken behaviour returns (the defer signals the
	// parent after an errored child), the parent would consume this turn and emit
	// "Continuing after thread." — which the assertions below forbid.
	w.setMockResponses([]MockResponse{
		// Parent turn 1: calls create_thread
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "create_thread", Input: json.RawMessage(`{"goal":"Error test","prompt":"Do the task"}`)},
			},
			StopReason: "tool_use",
		},
		// Thread turn: the provider errors (e.g. a dropped connection).
		{
			Error: "connection reset by peer",
		},
		// Parent turn 2: must NEVER run — an errored child does not resume parent.
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Continuing after thread."},
			},
			StopReason: "end_turn",
		},
	})

	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "Test",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []any{},
		})
		// Parent turn 1 + thread turn (error). The buffered channels (cap 1)
		// absorb a third send harmlessly if the parent never resumes.
		for i := 0; i < 3; i++ {
			w.contextResultChan <- ctxResponse
			w.toolsResultChan <- toolsResponse
		}
	}()

	w.runStrategyLoop("Start", false)

	// After thread error:
	// 1. Thread context should be reset
	if w.thread.itemID != "" {
		t.Errorf("thread.itemID should be empty after thread error, got %q", w.thread.itemID)
	}
	if w.thread.itemsArray != nil {
		t.Error("thread.itemsArray should be nil after thread error")
	}

	// 2. The thread must stay OPEN — no result was fabricated. The worker
	//    never stamps an error as the thread's result; the thread closes only
	//    via return_result or the user's explicit footer close.
	items := w.doc.GetItems()
	var threadItemID string
	for _, item := range items {
		if item.Type == ItemTypeThread {
			threadItemID = item.ItemID
			break
		}
	}
	if threadItemID == "" {
		t.Fatal("no thread item found — create_thread did not insert a thread")
	}
	threadYMap := w.doc.GetThreadYMap(threadItemID)
	if threadYMap == nil {
		t.Fatal("expected thread Y.Map")
	}
	if result, _ := threadYMap.Get("result").(string); result != "" {
		t.Errorf("errored thread must stay open (no result), but result was stamped: %q", result)
	}

	// 3. The error must be visible in the thread's history as an error item —
	//    not hidden inside a fabricated result string. This is exactly the
	//    state the user can review and resume from.
	threadArr := w.doc.GetThreadItemsArray(threadItemID)
	if threadArr == nil {
		t.Fatal("expected thread items array")
	}
	threadItems := w.doc.GetItemsFromArray(threadArr)
	foundErr := false
	for _, it := range threadItems {
		if it.Type == ItemTypeError && strings.Contains(it.Content, "connection reset by peer") {
			foundErr = true
			break
		}
	}
	if !foundErr {
		t.Errorf("expected the error to be visible as an error item in the thread, got items %+v", threadItems)
	}

	// 4. Worker should be idle
	if w.loadState() != StateIdle {
		t.Errorf("worker state should be idle after error recovery, got %v", w.loadState())
	}

	// 5. The conversation must be fully at rest — no LLM claim left dangling.
	if act := w.getActivity(); act != ActivityNone {
		t.Errorf("activity should be cleared (idle) after a child thread error, got %q", act)
	}

	// 6. The PARENT must NOT have auto-resumed. An errored sub-thread stops the
	//    whole conversation; bubbling the error up and silently continuing the
	//    parent is the bug this test guards against. The root thread therefore
	//    has no assistant turn after the thread item, and the parent-turn-2 mock
	//    was never consumed.
	for _, item := range items {
		if item.Type == ItemTypeAssistant && strings.Contains(item.Content, "Continuing after thread.") {
			t.Errorf("parent auto-resumed after a child thread error — found assistant continuation %q; the conversation should have stopped", item.Content)
		}
	}

	w.doc.Destroy()
}

// =============================================================================
// NEEDS-STRATEGY-RUN THREAD AUTO-DETECTION TESTS
//
// These tests verify that checkForNewThreads correctly processes threads
// marked with needsStrategyRun=true and ignores all other threads.
// =============================================================================

// threadOpts configures a test thread.
type threadOpts struct {
	goal             string
	needsStrategyRun bool
	noAutoSelect     bool // If set, thread folds in place (e.g. /compact)
	userMessage      string
	result           string // If set, thread is pre-completed
	forceTool        string // If set, thread forces the model to call this tool
	llmCreated       bool   // If set, marks the thread as LLM tool-created
	canSpawnThreads  bool   // If set, thread's LLM may itself use create_thread
	delegated        bool   // If set, marks the thread as delegatesToSubthread-spawned
	// boundedCompaction, if set, marks the thread as a browser /compact fold: it
	// carries the boundedCompaction flag and a compactionPromptItemId pointing at
	// an appended summarization-prompt item, so the worker summarizes it with the
	// bounded reducer instead of a return_result strategy turn.
	boundedCompaction bool
}

// insertThreadWithOpts creates a thread in the doc in a single transaction
// to avoid observer races. Returns the thread itemId.
func insertThreadWithOpts(w *ConversationWorker, opts threadOpts) string {
	threadItemID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		item := ConversationItem{
			Type:   ItemTypeThread,
			ItemID: threadItemID,
			Goal:   opts.goal,
		}
		compactionPromptID := ""
		if opts.boundedCompaction {
			compactionPromptID = generateItemID()
			item.BoundedCompaction = true
			item.CompactionPromptItemID = compactionPromptID
		}
		ymap := conversationItemToYMap(item)
		yarr := ycrdt.NewYArray()
		ymap.Set("items", yarr)
		if opts.needsStrategyRun {
			ymap.Set("needsStrategyRun", true)
		}
		if opts.noAutoSelect {
			ymap.Set("noAutoSelect", true)
		}
		if opts.result != "" {
			ymap.Set("result", opts.result)
		}
		if opts.forceTool != "" {
			ymap.Set("forceTool", opts.forceTool)
		}
		if opts.llmCreated {
			ymap.Set("llmCreated", true)
		}
		if opts.canSpawnThreads {
			ymap.Set("canSpawnThreads", true)
		}
		if opts.delegated {
			ymap.Set("delegated", true)
		}
		if opts.userMessage != "" {
			userItem := ConversationItem{
				Type:    ItemTypeUser,
				ItemID:  generateItemID(),
				Content: opts.userMessage,
			}
			yarr.Push(ycrdt.ArrayAny{conversationItemToYMap(userItem)})
		}
		if compactionPromptID != "" {
			yarr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{
				Type: ItemTypeUser, ItemID: compactionPromptID, Content: "Summarize this conversation",
			})})
		}
		w.doc.ensureItems().Push(ycrdt.ArrayAny{ymap})
	}, w.doc.authorID)
	// Fire handleItemsChange synchronously (the docChangeChan path only runs
	// when run() is active; tests drive the observer inline here).
	w.handleItemsChange()
	return threadItemID
}

// TestBuildLLMRequest_ForcedToolChoice verifies the generic forced-tool
// mechanism at the worker boundary: a thread carrying a `forceTool` Yjs field
// (set by a plugin, e.g. /compact forcing return_result) makes buildLLMRequest
// emit a provider-agnostic toolChoice on the request. A thread WITHOUT the
// field emits no toolChoice (the model decides — the normal case).
func TestBuildLLMRequest_ForcedToolChoice(t *testing.T) {
	tools := []ToolDefinition{
		{Name: "return_result", Description: "Return result", InputSchema: json.RawMessage(`{"type":"object"}`)},
	}
	ctxResult := &ContextResult{SystemPrompt: "sys"}

	t.Run("forced", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
		threadID := insertThreadWithOpts(w, threadOpts{goal: "Compact", forceTool: "return_result"})
		w.thread.itemID = threadID

		raw := w.buildLLMRequest(ctxResult, tools, "txn-1", false)
		var req map[string]any
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		tc, ok := req["toolChoice"].(map[string]any)
		if !ok {
			t.Fatalf("expected toolChoice object on forced request, got %v (keys: %v)", req["toolChoice"], req)
		}
		if tc["mode"] != "tool" || tc["name"] != "return_result" {
			t.Errorf("toolChoice = %v, want {mode:tool, name:return_result}", tc)
		}
	})

	t.Run("not forced", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
		threadID := insertThreadWithOpts(w, threadOpts{goal: "Plain"})
		w.thread.itemID = threadID

		raw := w.buildLLMRequest(ctxResult, tools, "txn-2", false)
		var req map[string]any
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		if _, present := req["toolChoice"]; present {
			t.Errorf("unforced request must not carry toolChoice, got %v", req["toolChoice"])
		}
	})
}

// TestFilterToolsForThread verifies the per-thread canSpawnThreads capability
// gate at the worker boundary: create_thread is offered to root and to
// user-created (/thread, canSpawnThreads=true) threads, and withheld from every
// other thread — LLM-created children, and compaction-shaped threads carrying
// neither llmCreated nor strategyCreated (the auto-compact regression). Other
// tools and their order are always preserved. The final case asserts the wiring
// through buildLLMRequest (call site + ordering vs. the forced-tool resolve).
func TestFilterToolsForThread(t *testing.T) {
	tools := []ToolDefinition{
		{Name: "bash", Description: "Run bash", InputSchema: json.RawMessage(`{"type":"object"}`)},
		{Name: "create_thread", Description: "Spawn a thread", InputSchema: json.RawMessage(`{"type":"object"}`)},
		{Name: "read", Description: "Read a file", InputSchema: json.RawMessage(`{"type":"object"}`)},
	}
	hasCreateThread := func(ts []ToolDefinition) bool {
		for _, t := range ts {
			if t.Name == "create_thread" {
				return true
			}
		}
		return false
	}
	otherToolsIntact := func(t *testing.T, ts []ToolDefinition) {
		t.Helper()
		var names []string
		for _, td := range ts {
			if td.Name != "create_thread" {
				names = append(names, td.Name)
			}
		}
		if len(names) != 2 || names[0] != "bash" || names[1] != "read" {
			t.Errorf("other tools not intact/ordered: got %v, want [bash read]", names)
		}
	}

	t.Run("root scope keeps create_thread", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.thread.itemID = "" // root
		got := w.filterToolsForThread(tools)
		if !hasCreateThread(got) {
			t.Error("root scope must keep create_thread")
		}
		otherToolsIntact(t, got)
	})

	t.Run("restricted llm-created thread withholds create_thread", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		threadID := insertThreadWithOpts(w, threadOpts{goal: "Delegated", llmCreated: true})
		w.thread.itemID = threadID
		got := w.filterToolsForThread(tools)
		if hasCreateThread(got) {
			t.Error("llm-created thread must not see create_thread")
		}
		otherToolsIntact(t, got)
	})

	t.Run("user thread with canSpawnThreads keeps create_thread", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		threadID := insertThreadWithOpts(w, threadOpts{goal: "User", canSpawnThreads: true})
		w.thread.itemID = threadID
		got := w.filterToolsForThread(tools)
		if !hasCreateThread(got) {
			t.Error("canSpawnThreads thread must keep create_thread")
		}
		otherToolsIntact(t, got)
	})

	// Regression for the auto-compact incident: a client-side fold thread carries
	// neither llmCreated nor strategyCreated nor canSpawnThreads, so it must be
	// restricted purely by absence of the flag. Asserted through buildLLMRequest.
	t.Run("compaction-shaped thread withholds create_thread via buildLLMRequest", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
		threadID := insertThreadWithOpts(w, threadOpts{goal: "Compaction fold"})
		w.thread.itemID = threadID

		raw := w.buildLLMRequest(&ContextResult{SystemPrompt: "sys"}, tools, "txn-compact", false)
		var req struct {
			Tools []ToolDefinition `json:"tools"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		if hasCreateThread(req.Tools) {
			t.Error("compaction-shaped thread must not see create_thread in the built request")
		}
		otherToolsIntact(t, req.Tools)
	})
}

// TestPromoteThreadSpawnCapable verifies the "human-steered ⇒ spawn-capable"
// promotion: a genuine user message into an LLM-created leaf thread stamps
// canSpawnThreads (so its own agent may then create_thread), while root and
// delegated threads are never promoted, and an already-capable thread is a no-op.
func TestPromoteThreadSpawnCapable(t *testing.T) {
	canSpawn := func(w *ConversationWorker, id string) bool {
		m := w.doc.GetThreadYMap(id)
		if m == nil {
			return false
		}
		ycrdtMu.Lock()
		defer ycrdtMu.Unlock()
		v, _ := m.Get("canSpawnThreads").(bool)
		return v
	}

	t.Run("llm-created leaf is promoted when user steers it", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		id := insertThreadWithOpts(w, threadOpts{goal: "Leaf", llmCreated: true})
		if canSpawn(w, id) {
			t.Fatal("precondition: llm-created leaf must not start spawn-capable")
		}
		w.promoteThreadSpawnCapable(id)
		if !canSpawn(w, id) {
			t.Error("user-steered llm-created thread must become spawn-capable")
		}
	})

	t.Run("root is never promoted", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.promoteThreadSpawnCapable("") // must not panic; root has the full list already
	})

	t.Run("delegated subthread is never promoted", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		id := insertThreadWithOpts(w, threadOpts{goal: "Delegated", delegated: true})
		w.promoteThreadSpawnCapable(id)
		if canSpawn(w, id) {
			t.Error("delegated subthread must not be promoted (decision #3)")
		}
	})

	t.Run("already-capable thread stays capable (idempotent)", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		id := insertThreadWithOpts(w, threadOpts{goal: "User", canSpawnThreads: true})
		w.promoteThreadSpawnCapable(id)
		if !canSpawn(w, id) {
			t.Error("already spawn-capable thread must remain spawn-capable")
		}
	})
}

func TestCheckForNewThreads_ProcessesNeedsStrategyRun(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateIdle)

	// Set up mock mode BEFORE creating thread (observer fires during creation)
	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-compact", Name: "return_result", Input: json.RawMessage(`{"result":"Summary of conversation"}`)},
			},
			StopReason: "tool_use",
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
		w.contextResultChan <- ctxResponse
		w.toolsResultChan <- toolsResponse
	}()

	// Create a thread with needsStrategyRun=true and a user message
	// The observer fires during creation and auto-processes the thread
	threadID := insertThreadWithOpts(w, threadOpts{goal: "Compaction thread", needsStrategyRun: true, userMessage: "Summarize this conversation"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

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
	if w.loadState() != StateIdle {
		t.Errorf("worker state = %v, want StateIdle", w.loadState())
	}

	w.doc.Destroy()
}

// TestCompactionSubthread_DrainsRootQueueOnCompletion reproduces the /compact
// orphaned-queue bug: a needsStrategyRun sub-thread (exactly what /compact
// inserts — noAutoSelect + forceTool return_result) runs to completion while the
// user has queued a follow-up at the ROOT. Because the sub-thread's loop is
// scoped to its own thread, its end-of-run drain only ever checks the sub-
// thread's own queue, and signalParentThread declines to re-drive the parent
// (a compaction thread is not llmCreated). Nothing else drains the root queue,
// so the queued message is stranded at idle. The completion path must drain the
// root queue itself and drive a turn to answer it.
func TestCompactionSubthread_DrainsRootQueueOnCompletion(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Two calls through the shared transport (callLLMWithSink pops the mock queue
	// in order): (1) the bounded reducer's hidden compaction probe takes
	// return_result and becomes the thread summary; (2) the queued root follow-up
	// is answered by a normal strategy turn. If the root queue is never drained,
	// the follow-up is never answered and its scripted response is left unconsumed.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{
			{Type: "tool_use", ID: "tu-compact", Name: "return_result",
				Input: json.RawMessage(`{"result":"Summary of conversation"}`)},
		}, StopReason: "tool_use"},
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
			select {
			case <-stop:
				return
			case w.contextResultChan <- ctxResp:
			}
		}
	}()
	go func() {
		for {
			select {
			case <-stop:
				return
			case w.toolsResultChan <- toolsResp:
			}
		}
	}()

	// The user queued a follow-up at the ROOT while compaction was in flight.
	w.enqueuePendingMessage("", UserMessageInput{Text: "follow-up while compacting"})

	// Insert the compaction sub-thread. handleItemsChange → checkForNewThreads
	// runs the whole compaction loop (and its completion defer) synchronously.
	threadID := insertThreadWithOpts(w, threadOpts{
		goal: "Compacted conversation history", needsStrategyRun: true,
		noAutoSelect: true, boundedCompaction: true,
		userMessage: "prior conversation history to summarize",
	})

	// Drive reconcile as the event loop would, in case the completion path
	// scheduled a root turn rather than running it entirely inline.
	for i := 0; i < 20 && (w.needsReconcile || w.HasPendingItems("")); i++ {
		w.needsReconcile = true
		w.tryReconcile()
	}

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
	if n := len(w.mock.responses); n != 0 {
		t.Fatalf("expected both scripted turns consumed, %d left", n)
	}

	if w.loadState() != StateIdle {
		t.Errorf("worker state = %v, want StateIdle", w.loadState())
	}
}

func TestCheckForNewThreads_IgnoresThreadWithoutFlag(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateIdle)

	// Create a thread WITHOUT needsStrategyRun (simulates /thread command)
	threadID := insertThreadWithOpts(w, threadOpts{goal: "User thread", userMessage: "Hello world"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// checkForNewThreads should NOT process this thread
	w.checkForNewThreads()

	// Worker should still be idle (didn't start processing)
	if w.loadState() != StateIdle {
		t.Errorf("worker state = %v, want StateIdle (should not process thread without flag)", w.loadState())
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
	w.storeState(StateIdle)

	// Create a thread with needsStrategyRun AND a result (already completed, single transaction)
	threadID := insertThreadWithOpts(w, threadOpts{
		goal: "Done thread", needsStrategyRun: true, userMessage: "Summarize", result: "Already summarized",
	})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// checkForNewThreads should NOT process this (already has result)
	w.checkForNewThreads()

	// Result should be unchanged
	threadYMap := w.doc.GetThreadYMap(threadID)
	result, _ := threadYMap.Get("result").(string)
	if result != "Already summarized" {
		t.Errorf("thread result = %q, want %q", result, "Already summarized")
	}

	w.doc.Destroy()
}

func TestCheckForNewThreads_IgnoresWhenBusy(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateProcessing) // Worker is busy

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Queued thread", needsStrategyRun: true, userMessage: "Summarize"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// checkForNewThreads should skip when worker is busy
	w.checkForNewThreads()

	// Thread should have no result (not processed)
	threadYMap := w.doc.GetThreadYMap(threadID)
	result, _ := threadYMap.Get("result").(string)
	if result != "" {
		t.Errorf("thread should have no result when worker is busy, got %q", result)
	}

	w.doc.Destroy()
}

func TestCheckForNewThreads_SkipsCompletedThreads(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateIdle)

	// Set up mock mode BEFORE creating thread (observer fires during creation)
	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-compact", Name: "return_result", Input: json.RawMessage(`{"result":"First run"}`)},
			},
			StopReason: "tool_use",
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
		w.contextResultChan <- ctxResponse
		w.toolsResultChan <- toolsResponse
	}()

	// Creating the thread triggers processing via observer
	threadID := insertThreadWithOpts(w, threadOpts{goal: "Once-only thread", needsStrategyRun: true, userMessage: "Summarize"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	threadYMap := w.doc.GetThreadYMap(threadID)
	result, _ := threadYMap.Get("result").(string)
	if result != "First run" {
		t.Fatalf("thread result = %q, want %q", result, "First run")
	}

	// Second call — skipped because the thread already has a result.
	// No mock responses needed (won't reach LLM).
	w.checkForNewThreads()

	result, _ = threadYMap.Get("result").(string)
	if result != "First run" {
		t.Errorf("thread result changed unexpectedly: got %q, want %q", result, "First run")
	}

	w.doc.Destroy()
}

func TestCheckForNewThreads_CancelDoesNotRetriggerNeedsStrategyRunThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateIdle)
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
	w.contextResultChan <- ctxResponse
	w.toolsResultChan <- toolsResponse

	calls := 0
	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		calls++
		w.storeState(StateCancelling)
		return nil, ErrCancelled
	}

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Cancellable thread", needsStrategyRun: true, userMessage: "Summarize"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	if calls != 1 {
		t.Fatalf("LLM calls after initial cancellation = %d, want 1", calls)
	}
	if w.loadState() != StateIdle {
		t.Fatalf("worker state = %v, want StateIdle", w.loadState())
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
	w.handleItemsChange()
	w.tryReconcile()
	if calls != 1 {
		t.Fatalf("LLM calls after observer tick = %d, want 1 (no retrigger)", calls)
	}

	w.doc.Destroy()
}

func TestHandleItemsChange_CancelsWhenCurrentThreadDeleted(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.storeState(StateIdle)

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Continuation"})
	if threadID == "" {
		t.Fatal("failed to create thread")
	}

	// Simulate worker mid-processing on this thread
	w.storeState(StateProcessing)
	w.thread.itemID = threadID

	// Delete the thread from the doc (simulates browser deletion via Yjs sync)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		w.doc.ensureItems().Delete(ycrdt.Number(0), 1)
	}, w.doc.authorID)

	w.handleItemsChange()

	if w.loadState() != StateCancelling {
		t.Errorf("worker state = %v, want StateCancelling after current thread deleted", w.loadState())
	}

	w.doc.Destroy()
}

// =============================================================================
// STREAMING INTEGRITY TESTS
//
// These tests exercise the REAL streaming path: queueStreamChunk → channel →
// worker goroutine → processStreamChunk. The mock path (popMockResponse) calls
// processStreamChunk directly on the same goroutine, completely bypassing the
// channel — which is why it never caught the dropped-chunks bug.
// =============================================================================

// generateLongText builds a deterministic string of the given word count.
func generateLongText(wordCount int) string {
	words := []string{
		"The", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog.",
		"Pack", "my", "box", "with", "five", "dozen", "liquor", "jugs.",
		"How", "vexingly", "quick", "daft", "zebras", "jump.",
	}
	var b strings.Builder
	for i := 0; i < wordCount; i++ {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(words[i%len(words)])
	}
	return b.String()
}

// TestStreamingLongMessageIntact verifies that a long message streamed
// word-by-word through the real channel path arrives without any dropped content.
func TestStreamingLongMessageIntact(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	fullText := generateLongText(500)
	wordsInText := strings.Fields(fullText)

	// llmCallFunc streams one word per chunk (simulates real LLM token streaming).
	// The callback IS queueStreamChunk — same path as production.
	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		for i, word := range wordsInText {
			tok := word
			if i > 0 {
				tok = " " + word
			}
			chunkHandler(StreamChunk{Type: "text", Content: tok})
		}
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: fullText}},
			StopReason: "end_turn",
		}, nil
	}

	// callLLM spawns the provider goroutine and enters waitForLLMResponse,
	// which processes chunks from the inbound channel on THIS goroutine.
	_, err := w.callLLM(nil)
	if err != nil {
		t.Fatalf("callLLM failed: %v", err)
	}

	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item, got %d", len(items))
	}

	got := items[0].Content
	if got != fullText {
		// Find first divergence point for a useful error message
		minLen := len(got)
		if len(fullText) < minLen {
			minLen = len(fullText)
		}
		diffPos := minLen // assume divergence is at the end (length mismatch)
		for i := 0; i < minLen; i++ {
			if got[i] != fullText[i] {
				diffPos = i
				break
			}
		}
		t.Errorf("Content mismatch (expected %d bytes, got %d bytes, first diff at byte %d)",
			len(fullText), len(got), diffPos)
		// Show a window around the divergence
		start := diffPos - 20
		if start < 0 {
			start = 0
		}
		endE := diffPos + 40
		if endE > len(fullText) {
			endE = len(fullText)
		}
		endG := diffPos + 40
		if endG > len(got) {
			endG = len(got)
		}
		t.Errorf("  expected[%d:%d]: %q", start, endE, fullText[start:endE])
		t.Errorf("  got     [%d:%d]: %q", start, endG, got[start:endG])
	}
}

// TestStreamingNoBottleneck verifies that once the LLM provider has finished
// sending all chunks, the worker processes them without unnecessary delay.
// A slow pipeline would mean the worker is still trickling through chunks
// long after the provider goroutine has returned.
func TestStreamingNoBottleneck(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	fullText := generateLongText(500)
	wordsInText := strings.Fields(fullText)

	var providerDone time.Time

	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		for i, word := range wordsInText {
			tok := word
			if i > 0 {
				tok = " " + word
			}
			chunkHandler(StreamChunk{Type: "text", Content: tok})
		}
		providerDone = time.Now()
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: fullText}},
			StopReason: "end_turn",
		}, nil
	}

	_, err := w.callLLM(nil)
	callLLMDone := time.Now()
	if err != nil {
		t.Fatalf("callLLM failed: %v", err)
	}

	delay := callLLMDone.Sub(providerDone)

	// After the provider goroutine returns, the worker should finish near-instantly.
	// The only remaining work is draining any buffered chunks — this should take
	// microseconds, not hundreds of milliseconds. 200ms is a generous upper bound.
	const maxDelay = 200 * time.Millisecond
	if delay > maxDelay {
		t.Errorf("Worker took %v after provider finished (max allowed: %v) — streaming pipeline is bottlenecked", delay, maxDelay)
	} else {
		t.Logf("Worker finished %v after provider (within %v limit)", delay, maxDelay)
	}
}

// TestStatusChunkSurfacesPhase verifies that a provider-emitted status chunk
// (the cold-start liveness label) lands in processingState as `phase` so every
// observing client's spinner can show what's happening instead of a static
// "Receiving...". Exercises the real channel path (queueStreamChunk → worker
// goroutine → processStreamChunk), same as the streaming-integrity tests above.
func TestStatusChunkSurfacesPhase(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	// mergeProcessingPhase only writes while a live status is set — mirror the
	// strategy loop, which sends "streaming" just before the provider call.
	w.sendStatus("streaming", "")

	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		// A phase label arrives before any content, then the first token.
		chunkHandler(StreamChunk{Type: "status", Content: "Starting Claude Code"})
		chunkHandler(StreamChunk{Type: "text", Content: "hi"})
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "hi"}},
			StopReason: "end_turn",
		}, nil
	}

	if _, err := w.callLLM(nil); err != nil {
		t.Fatalf("callLLM failed: %v", err)
	}

	state := w.readProcessingState()
	if state == nil {
		t.Fatal("processingState is nil after streaming a status chunk")
	}
	if got, _ := state["phase"].(string); got != "Starting Claude Code" {
		t.Errorf("processingState.phase = %q, want %q", got, "Starting Claude Code")
	}
}

// TestStatusChunkIgnoredWhenIdle verifies the liveness guard: a status chunk
// arriving when no live status is set must not revive a stale spinner by
// writing a `phase` into an idle processingState.
func TestStatusChunkIgnoredWhenIdle(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.sendStatus("idle", "")
	w.processStreamChunk(StreamChunk{Type: "status", Content: "Starting Claude Code"})

	state := w.readProcessingState()
	if state != nil {
		if _, has := state["phase"]; has {
			t.Errorf("phase written into a non-live processingState: %+v", state)
		}
	}
}

// enqueuePendingItemForTest inserts an arbitrary item onto a thread's pending
// queue, mimicking the client enqueuing an @-mention / dropped-file read
// alongside a message typed while busy (web: MessageThread.enqueuePendingItem).
func enqueuePendingItemForTest(w *ConversationWorker, threadItemID string, item ConversationItem) {
	ycrdtMu.Lock()
	arr := w.doc.ensurePendingArrayLocked(threadItemID)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr.Insert(arr.GetLength(), ycrdt.ArrayAny{conversationItemToYMap(item)})
	}, w.doc.txOrigin())
	ycrdtMu.Unlock()
}

// TestPromotePendingKeepsReadGroupedWithMessage verifies the guarantee the
// "queue reads with the message" fix depends on: when a mid-turn @-mention
// enqueues a file-content read onto pendingItems ahead of the queued user
// message, promoting the queue lands the read immediately before its message
// (grouped, in order) with its context-item payload intact — never separated by
// the in-flight turn's output.
func TestPromotePendingKeepsReadGroupedWithMessage(t *testing.T) {
	w := NewConversationWorker("conv-pending-read-group", "user:test")
	defer w.doc.Destroy()

	// Some in-flight turn output already sits in items.
	w.doc.InsertMessage(w.doc.GetItemsLength(), ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "working",
		Timestamp: time.Now().Format(time.RFC3339),
	})

	// Client enqueues the read first, then the worker queues the user message.
	enqueuePendingItemForTest(w, "", ConversationItem{
		Type: "file-content", ItemID: "FILE_1", IsNew: true,
		Data: json.RawMessage(`{"path":"foo.txt"}`),
	})
	w.enqueuePendingMessage("", UserMessageInput{Text: "look at @foo.txt"})

	if n := w.promotePendingItems(""); n != 2 {
		t.Fatalf("expected 2 items promoted (read + message), got %d", n)
	}
	if w.hasPendingItems("") {
		t.Error("expected the pending queue to be empty after promotion")
	}

	items := w.doc.GetItems()
	fileIdx, userIdx := -1, -1
	for i, it := range items {
		switch {
		case it.ItemID == "FILE_1":
			fileIdx = i
		case it.Type == ItemTypeUser && it.Content == "look at @foo.txt":
			userIdx = i
		}
	}
	if fileIdx < 0 || userIdx < 0 {
		t.Fatalf("promoted items missing: fileIdx=%d userIdx=%d items=%+v", fileIdx, userIdx, items)
	}
	// The read must sit immediately before its message — grouped, not separated.
	if userIdx != fileIdx+1 {
		t.Errorf("expected the read immediately before the message, got fileIdx=%d userIdx=%d", fileIdx, userIdx)
	}
	// The context-item payload survives the promote round-trip.
	if got := items[fileIdx]; got.Type != "file-content" || !strings.Contains(string(got.Data), "foo.txt") {
		t.Errorf("read payload lost through promotion: type=%q data=%s", got.Type, string(got.Data))
	}
}
