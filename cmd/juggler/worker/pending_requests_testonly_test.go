//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside pending_requests_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestPendingRequests_SubmitToTerminalRoundtrip simulates the full
// client-strategy flow: a JS-style submitter writes a request entry, the
// worker scan claims and dispatches it via the real worker code path, the
// thread completes, and the entry transitions to 'completed' with the
// thread's result. This is the highest-confidence regression test for the
// orchestrator end-to-end. Uses the same mock-LLM pattern as
// TestThreadUsesAssistantTextAsResult.
func TestPendingRequests_SubmitToTerminalRoundtrip(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	// Ensure the root items array exists. In production the first message
	// from the client triggers this; in unit tests we have to do it eagerly.
	ycrdtMu.Lock()
	w.doc.ensureItems()
	ycrdtMu.Unlock()
	// dispatchThread asserts the worker is StateIdle (the default
	// zero value of an atomic.Int32 is 0, which equals StateIdle). The
	// nested strategy loop transitions through StateProcessing during the
	// LLM call and back to StateIdle on completion.
	w.setMockResponses([]MockResponse{
		// Thread LLM: its trailing text is what the run returns, and so becomes
		// the thread/pending result.
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Sub-thread done."},
			},
			StopReason: "end_turn",
		},
	})

	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "You are helpful.",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []any{},
		})
		// One LLM iteration for the thread.
		w.engine.contextReply.inject(w.done, ctxResponse)
		w.engine.toolsReply.inject(w.done, toolsResponse)
	}()

	// Stage a 'requested' createThread entry — the same Y.Map shape that
	// submitPendingRequest writes from the JS side.
	pushRequestedEntry(t, w, "createThread", "rt-1", func(req *ycrdt.YMap) {
		req.Set("goal", "Test")
		req.Set("prompt", "Do something")
		req.Set("isContinuation", false)
	})

	// First scan: claim + dispatch. dispatchThread asks the reducer for
	// the pass that starts the thread; quiescing the actor runs it to completion.
	w.currentRun().scanPendingRequests()
	w.quiesce(t)
	// Second scan: advance the 'claimed' entry once the thread Y.Map's
	// result is populated.
	w.currentRun().scanPendingRequests()

	if s := findEntryStatus(w, "rt-1"); s != "completed" {
		t.Fatalf("status = %q, want 'completed'", s)
	}

	// Verify the entry's result Y.Map carries what the thread produced.
	ycrdtMu.Lock()
	_, ymap, _ := w.pendingEntryByIDLocked("", "rt-1")
	r, _ := ymap.Get("result").(*ycrdt.YMap)
	threadItemID, _ := r.Get("threadItemId").(string)
	result, _ := r.Get("result").(string)
	ycrdtMu.Unlock()
	if threadItemID == "" {
		t.Error("result.threadItemId is empty")
	}
	if result != "Sub-thread done." {
		t.Errorf("result.result = %q, want 'Sub-thread done.'", result)
	}
}
