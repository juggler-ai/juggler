//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/worker"
)

// TestSession represents a fully initialized test session with worker and manager.
// It provides convenience methods for common test operations.
type TestSession struct {
	Manager *worker.Manager
	Worker  *worker.ConversationWorker
	ConvID  string
	TmpDir  string
	t       *testing.T
}

// SetupTestSession creates a fully initialized test session.
// This handles all the boilerplate of creating temp directories, manager, and worker.
func SetupTestSession(t *testing.T) *TestSession {
	t.Helper()

	// Create temp directory for test
	tmpDir := t.TempDir()

	// Create manager
	manager := worker.NewManager()
	t.Cleanup(func() {
		manager.Shutdown()
	})

	// Wire up a no-op path provider/save-binary so workers can persist.
	// Tests don't care about folder names, so we use a single
	// "test-conv--<id>" folder per conv id.
	pathProvider := TestPathProvider(tmpDir)
	manager.SetPathProvider(pathProvider)
	manager.SetSaveBinary(TestSaveBinary(tmpDir, pathProvider))

	// Initialize worker through manager
	convID := "test-conv-" + t.Name()
	w := initWorker(t, manager, tmpDir, convID)

	return &TestSession{
		Manager: manager,
		Worker:  w,
		ConvID:  convID,
		TmpDir:  tmpDir,
		t:       t,
	}
}

// TestPathProvider returns a worker.PathProviderFunc that maps every
// conversation id to `<tmpDir>/.juggler/test--<id>/`. Used by tests that
// don't drive a full SessionManager.
func TestPathProvider(tmpDir string) worker.PathProviderFunc {
	return func(convID string) (string, bool) {
		return filepath.Join(tmpDir, ".juggler", "test--"+convID), true
	}
}

// TestSaveBinary returns a worker.SaveBinaryFunc that writes doc.yjs
// inside the path provider's folder, creating the folder on demand.
func TestSaveBinary(tmpDir string, pathProvider worker.PathProviderFunc) worker.SaveBinaryFunc {
	return func(convID string, data []byte) error {
		dir, _ := pathProvider(convID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		dst := filepath.Join(dir, "doc.yjs")
		tmp := dst + ".tmp"
		if err := os.WriteFile(tmp, data, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, dst); err != nil {
			os.Remove(tmp)
			return err
		}
		return nil
	}
}

// initWorker initializes a worker by sending an init message through the manager.
func initWorker(t *testing.T, manager *worker.Manager, tmpDir string, convID string) *worker.ConversationWorker {
	t.Helper()

	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:   convID,
			Name: "Test Conversation",
		},
		Config: worker.WorkerConfig{
			ProjectPath: tmpDir,
		},
	})

	readyChan := make(chan struct{}, 1)
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

	handled := manager.HandleMessage(convID, "init", initPayload, sendCallback)
	if !handled {
		t.Fatal("Init not handled")
	}

	if err := WaitForReady(t, readyChan); err != nil {
		t.Fatal(err)
	}

	w := manager.Get(convID)
	if w == nil {
		t.Fatal("Worker not found after init")
	}

	return w
}

// SetLLMSequence sets up a mock LLM with the given responses.
// Returns the sequence so tests can check call counts if needed.
func (ts *TestSession) SetLLMSequence(responses ...*worker.LLMResponse) *LLMSequence {
	ts.t.Helper()

	seq := NewLLMSequence(responses...)
	fn := seq.AsCallFunc()
	ts.Manager.SetLLMCaller(fn)
	ts.Worker.SetLLMCaller(fn)
	return seq
}

// SetMockSequence is the MockResponse-typed variant of SetLLMSequence.
// Use it when a test needs rate-limit injection, mid-stream errors, or
// scripted streaming.
func (ts *TestSession) SetMockSequence(responses ...MockResponse) *LLMSequence {
	ts.t.Helper()

	seq := NewMockSequence(responses...)
	fn := seq.AsCallFunc()
	ts.Manager.SetLLMCaller(fn)
	ts.Worker.SetLLMCaller(fn)
	return seq
}

// GetDocument returns the worker's document.
func (ts *TestSession) GetDocument() *worker.ConversationDocument {
	return ts.Worker.Document()
}

// DumpDocument dumps the document state for debugging.
func (ts *TestSession) DumpDocument() {
	ts.t.Helper()
	doc := ts.GetDocument()
	if doc != nil {
		DumpDocument(ts.t, doc)
	}
}

// SetupMockEngine registers a mock engine client on the worker that auto-responds
// to "request-tools" and "render-context-items" messages from the strategy loop.
// This is required for tests that trigger the strategy loop (send-message)
// since it waits for these responses from the engine browser.
func (ts *TestSession) SetupMockEngine(tools ...worker.ToolDefinition) {
	ts.t.Helper()

	w := ts.Worker
	w.SetCallback("mock-engine", func(msg []byte) {
		var parsed map[string]any
		if err := json.Unmarshal(msg, &parsed); err != nil {
			return
		}

		// An answer quotes the id of the request it answers, as a real client's
		// does: the worker takes only the answer to the request it has in flight
		// (see replySlot), so an unstamped reply is refused and the turn waits out
		// its timeout instead.
		requestID, _ := parsed["requestId"].(string)

		switch parsed["type"] {
		case "request-tools":
			resp, _ := json.Marshal(worker.ToolsResultMessage{
				Type:      "tools-result",
				RequestID: requestID,
				Tools:     tools,
			})
			w.Send("tools-result", resp)

		case "render-context-items-request":
			resp, _ := json.Marshal(worker.RenderContextItemsResponse{
				Type:      "render-context-items-response",
				RequestID: requestID,
			})
			w.Send("render-context-items-response", resp)
		}
	})
}
