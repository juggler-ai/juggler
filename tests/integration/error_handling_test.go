//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// TestErrorUndoOnEmptyStack tests undo when nothing to undo.
func TestErrorUndoOnEmptyStack(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)

	tracker := ts.Worker.Tracker()
	if tracker.CanUndo() {
		t.Error("Should not be able to undo initially")
	}

	success := tracker.Undo()
	if success {
		t.Error("Undo should fail when stack is empty")
	}

	doc := ts.GetDocument()
	if doc == nil {
		t.Fatal("Document should still be accessible")
	}

	t.Log("SUCCESS: Undo on empty stack handled gracefully")
}

// TestErrorRedoOnEmptyStack tests redo when nothing to redo.
func TestErrorRedoOnEmptyStack(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)

	tracker := ts.Worker.Tracker()
	if tracker.CanRedo() {
		t.Error("Should not be able to redo initially")
	}

	success := tracker.Redo()
	if success {
		t.Error("Redo should fail when stack is empty")
	}

	doc := ts.GetDocument()
	if doc == nil {
		t.Fatal("Document should still be accessible")
	}

	t.Log("SUCCESS: Redo on empty stack handled gracefully")
}

// TestLLMErrorRecovery tests that the worker recovers after an LLM error that
// ends the turn, and can process subsequent messages normally. The error is
// one no retry clears; a retryable one would be absorbed inside the turn.
func TestLLMErrorRecovery(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	var callCount atomic.Int32

	ts.Worker.SetLLMCaller(func(ctx context.Context, req json.RawMessage, streamCB func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		n := callCount.Add(1)
		if n == 1 {
			return nil, fmt.Errorf("mock LLM error: invalid request: the prompt was rejected")
		}
		// Second call succeeds
		resp := helpers.TextResponse("Recovery successful")
		if streamCB != nil {
			for _, block := range resp.Blocks {
				if block.Type == "text" && block.Content != "" {
					streamCB(worker.StreamChunk{Type: "text", Content: block.Content})
				}
			}
		}
		return resp, nil
	})

	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	// First message — LLM returns error
	sendPayload, _ := json.Marshal(worker.SendMessageMessage{
		Type: "send-message",
		Text: "First message",
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", sendPayload, nil)

	// Each turn is awaited by what it does — reaching the model, then writing
	// its item — never by the worker being idle, which it still is before a
	// queued turn starts.
	hasItem := func(match func(worker.ConversationItem) bool) func() bool {
		return func() bool {
			doc := ts.Worker.Document()
			if doc == nil {
				return false
			}
			for _, item := range doc.GetItems() {
				if match(item) {
					return true
				}
			}
			return false
		}
	}
	if err := helpers.WaitUntil(t, "the first turn to call the model", func() bool { return callCount.Load() >= 1 }); err != nil {
		t.Fatal(err)
	}
	if err := helpers.WaitUntil(t, "the error item", hasItem(func(item worker.ConversationItem) bool { return item.Type == "error" })); err != nil {
		t.Fatalf("Error item did not appear: %v", err)
	}
	if err := helpers.WaitUntil(t, "the worker to settle after the error", func() bool { return ts.Worker.State() == worker.StateIdle }); err != nil {
		t.Fatalf("Worker did not return to idle after error: %v", err)
	}

	// Second message — LLM succeeds
	sendPayload2, _ := json.Marshal(worker.SendMessageMessage{
		Type: "send-message",
		Text: "Second message",
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", sendPayload2, nil)

	if err := helpers.WaitUntil(t, "the second turn to call the model", func() bool { return callCount.Load() >= 2 }); err != nil {
		t.Fatal(err)
	}
	if err := helpers.WaitUntil(t, "the recovered assistant reply", hasItem(func(item worker.ConversationItem) bool {
		return item.Type == "assistant" && item.Content == "Recovery successful"
	})); err != nil {
		t.Fatalf("Assistant response did not appear after recovery: %v", err)
	}

	t.Log("SUCCESS: Worker recovers after LLM error")
}

// TestLLMErrorStampsTransaction verifies that an LLM round-trip that fails
// still produces a viewable transaction blob, and that both the user message
// and the resulting error item carry the same transactionId — so the user
// can click "View Transaction" on the error item to see what was sent and
// why the call failed.
func TestLLMErrorStampsTransaction(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	const errText = "mock LLM error: provider exploded"
	ts.Worker.SetLLMCaller(func(ctx context.Context, req json.RawMessage, streamCB func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		return nil, fmt.Errorf("%s", errText)
	})

	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	sendPayload, _ := json.Marshal(worker.SendMessageMessage{
		Type: "send-message",
		Text: "What broke?",
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", sendPayload, nil)

	if err := helpers.WaitForWorkerState(t, ts.Worker, worker.StateIdle, 5*time.Second); err != nil {
		t.Fatalf("Worker did not return to idle after error: %v", err)
	}

	if err := helpers.WaitForDocumentCondition(t, ts.Worker, 5*time.Second, func(doc *worker.ConversationDocument) bool {
		for _, item := range doc.GetItems() {
			if item.Type == "error" {
				return true
			}
		}
		return false
	}); err != nil {
		t.Fatalf("Error item did not appear: %v", err)
	}

	// Pull the user msg + error item, assert they share a non-empty txn id.
	var userTxn, errTxn string
	for _, item := range ts.GetDocument().GetItems() {
		switch item.Type {
		case "user":
			userTxn = item.TransactionID
		case "error":
			errTxn = item.TransactionID
		}
	}
	if userTxn == "" {
		t.Fatalf("user message has no transactionId after failed round-trip")
	}
	if errTxn == "" {
		t.Fatalf("error item has no transactionId after failed round-trip")
	}
	if userTxn != errTxn {
		t.Fatalf("user and error items should share the round-trip transactionId; got user=%q err=%q", userTxn, errTxn)
	}

	// The blob must exist on disk and round-trip through the store, including
	// the captured error text — that's what the View Transaction panel reads.
	convDir := convDirByID(t, ts.TmpDir, ts.ConvID)
	store := worker.NewTransactionStore(func(id string) (string, bool) {
		if id == ts.ConvID {
			return convDir, true
		}
		return "", false
	})
	data, err := store.Load(ts.ConvID, errTxn)
	if err != nil {
		t.Fatalf("transaction blob missing for failed round-trip %s: %v", errTxn, err)
	}
	var blob struct {
		StopReason string `json:"stopReason"`
		Output     struct {
			Error string `json:"error"`
		} `json:"output"`
		Input struct {
			Messages []map[string]any `json:"messages"`
		} `json:"input"`
	}
	if err := json.Unmarshal(data, &blob); err != nil {
		t.Fatalf("blob is not valid JSON: %v", err)
	}
	if blob.StopReason != "error" {
		t.Fatalf("blob stopReason should be 'error', got %q", blob.StopReason)
	}
	if !strings.Contains(blob.Output.Error, errText) {
		t.Fatalf("blob output.error should contain %q, got %q", errText, blob.Output.Error)
	}
	if len(blob.Input.Messages) == 0 {
		t.Fatalf("blob.input.messages should record what was sent to the provider")
	}

	// Also verify the file lives where the GC expects it.
	expected := filepath.Join(convDir, "txns", errTxn+".json")
	if _, err := store.List(ts.ConvID); err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if data2, err := store.Load(ts.ConvID, errTxn); err != nil || len(data2) == 0 {
		t.Fatalf("blob not loadable from %s: %v", expected, err)
	}
}
