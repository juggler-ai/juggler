//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/worker"
	"juggler/tests/helpers"
	ihelpers "juggler/tests/integration/helpers"

	"github.com/gorilla/mux"
)

// TestDuplicateWhileRunning_ClonePersistsParkedMarker is the end-to-end guard for
// forking a conversation mid-turn over the real HTTP create+duplicate path. A
// source worker is held in a running turn (a blocking mock LLM keeps it in
// StateProcessing); a POST /api/conversations?duplicateFrom= then clones it. The
// clone's on-disk doc must carry the one-shot forkParked marker — proving the
// handler routed through the in-memory snapshot (which can't be flushed mid-turn)
// rather than a would-block flush, and that the clone will load stopped.
func TestDuplicateWhileRunning_ClonePersistsParkedMarker(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	sm, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer sm.Shutdown()

	// Source conversation, registered in the SessionManager (valid conv_ id).
	srcID, _, err := sm.CreateConversation("fork source")
	helpers.AssertNoError(t, err)

	// Worker manager sharing the SessionManager's conversation folders.
	wm := worker.NewManager()
	defer wm.Shutdown()
	wm.SetPathProvider(func(id string) (string, bool) { return sm.ConvDir(id) })
	wm.SetSaveBinary(func(id string, data []byte) error {
		dir, ok := sm.ConvDir(id)
		if !ok {
			return os.ErrNotExist
		}
		return os.WriteFile(filepath.Join(dir, "doc.yjs"), data, 0o644)
	})

	// A blocking LLM: signals when the turn's call is in flight, then holds it so
	// the worker stays in StateProcessing while we issue the duplicate.
	llmEntered := make(chan struct{}, 1)
	release := make(chan struct{})
	llm := func(_ context.Context, _ json.RawMessage, _ func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		select {
		case llmEntered <- struct{}{}:
		default:
		}
		<-release
		return ihelpers.TextResponse("done"), nil
	}
	wm.SetLLMCaller(llm)

	// Init the source worker, give it a model, and stand up a mock engine so the
	// strategy loop can reach the LLM call.
	w := initRunningWorker(t, wm, projectDir, srcID)
	w.SetLLMCaller(llm)
	w.Document().SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test-model"})
	attachMockEngine(w)

	api := handlers.NewSessionAPI(func() *core.SessionManager { return sm }, wm, nil, nil, nil)
	router := mux.NewRouter()
	router.HandleFunc("/api/conversations", api.HandleCreateConversation).Methods("POST")

	// Start a turn and wait until the LLM call is in flight (worker running).
	sendPayload, _ := json.Marshal(worker.SendMessageMessage{Type: "send-message", Text: "hello"})
	wm.HandleMessage(srcID, "send-message", sendPayload, nil)
	select {
	case <-llmEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("LLM turn never started")
	}
	if err := ihelpers.WaitForWorkerState(t, w, worker.StateProcessing, 2*time.Second); err != nil {
		close(release)
		t.Fatalf("source worker not in StateProcessing: %v", err)
	}

	// Duplicate WHILE the turn is running.
	body, _ := json.Marshal(map[string]any{"name": "fork source (copy)", "duplicateFrom": srcID})
	req := httptest.NewRequest("POST", "/api/conversations", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		close(release)
		t.Fatalf("duplicate: status %d, body %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	helpers.AssertNoError(t, json.Unmarshal(rec.Body.Bytes(), &created))

	// The clone's on-disk doc must carry the one-shot parked marker AND the
	// copied conversation content.
	cloneDir, ok := sm.ConvDir(created.ID)
	if !ok {
		close(release)
		t.Fatal("clone dir not found")
	}
	cloneBytes, err := os.ReadFile(filepath.Join(cloneDir, "doc.yjs"))
	if err != nil {
		close(release)
		t.Fatalf("read clone doc.yjs: %v", err)
	}
	probe := worker.NewConversationDocument("probe", "user:test")
	defer probe.Destroy()
	helpers.AssertNoError(t, probe.LoadFromState(cloneBytes))
	if b, _ := probe.GetMetadata("forkParked").(bool); !b {
		close(release)
		t.Fatal("clone of a running source must carry the forkParked marker")
	}
	if len(probe.GetItems()) == 0 {
		close(release)
		t.Fatal("clone doc should carry the source's items, not be empty")
	}

	// Release the turn and let the source settle for a clean shutdown.
	close(release)
	_ = ihelpers.WaitForWorkerState(t, w, worker.StateIdle, 5*time.Second)
}

// initRunningWorker boots a worker for convID through the manager and waits for
// its ready signal. Mirrors the helpers' private initWorker for tests that need
// a SessionManager-issued id rather than the fixed SetupTestSession id.
func initRunningWorker(t *testing.T, mgr *worker.Manager, projectDir, convID string) *worker.ConversationWorker {
	t.Helper()
	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:   convID,
			Name: "fork source",
		},
		Config: worker.WorkerConfig{ProjectPath: projectDir},
	})
	ready := make(chan struct{}, 1)
	cb := func(msg []byte) {
		var parsed map[string]any
		if json.Unmarshal(msg, &parsed) == nil && parsed["type"] == "ready" {
			select {
			case ready <- struct{}{}:
			default:
			}
		}
	}
	if !mgr.HandleMessage(convID, "init", initPayload, cb) {
		t.Fatal("init not handled")
	}
	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for ready")
	}
	w := mgr.Get(convID)
	if w == nil {
		t.Fatal("worker not found after init")
	}
	return w
}

// attachMockEngine registers a mock engine client that auto-responds to the
// strategy loop's request-tools / render-context-items requests, so a send
// reaches the LLM call. Mirrors TestSession.SetupMockEngine.
func attachMockEngine(w *worker.ConversationWorker) {
	w.SetCallback("mock-engine", func(msg []byte) {
		var parsed map[string]any
		if err := json.Unmarshal(msg, &parsed); err != nil {
			return
		}
		// Answers quote the id of the request they answer; the worker refuses one
		// that names no request (see replySlot).
		requestID, _ := parsed["requestId"].(string)
		switch parsed["type"] {
		case "request-tools":
			resp, _ := json.Marshal(worker.ToolsResultMessage{Type: "tools-result", RequestID: requestID, Tools: []worker.ToolDefinition{}})
			w.Send("tools-result", resp)
		case "render-context-items-request":
			resp, _ := json.Marshal(worker.RenderContextItemsResponse{Type: "render-context-items-response", RequestID: requestID})
			w.Send("render-context-items-response", resp)
		}
	})
}
