//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside engine_push_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

// TestToolTurnPushesStateToEngine is the behavioural guard for the tool-execution
// wedge fix. When a turn produces tool-actions, the worker pushes full document
// state to the engine (the single tool executor) so it is a loaded peer that can
// run the reducer — rather than relying on the engine to auto-load reactively on
// an incidental sync, which was racy and left approved tools stuck forever.
//
// We register both an "engine" client and a plain "viewer" client. Both receive
// the worker's normal broadcasts; only the engine additionally receives the
// targeted full-state push. So after a tool-producing turn the engine must have
// received strictly more yjs-sync messages than the viewer. Without the fix the
// counts are equal.
func TestToolTurnPushesStateToEngine(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "test-conv"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	var engineSyncs, viewerSyncs atomic.Int64
	countYjsSync := func(c *atomic.Int64) func([]byte) {
		return func(b []byte) {
			var m struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(b, &m) == nil && m.Type == "yjs-sync" {
				c.Add(1)
			}
		}
	}
	// Register AFTER handleInit so neither sees the init broadcast — the only
	// asymmetry we measure is the per-tool-turn engine push.
	w.SetCallback("viewer", countYjsSync(&viewerSyncs))
	w.SetCallback("engine", countYjsSync(&engineSyncs))
	w.SetEngineClientID("engine")

	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "bash", Input: json.RawMessage(`{"command":"ls"}`)},
			},
			StopReason: "tool_use",
		},
	})

	done := make(chan struct{})
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(ToolsResultMessage{
			Type:  "tools-result",
			Tools: []ToolDefinition{{Name: "bash"}},
		})
		for {
			if !w.engine.contextReply.inject(done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(done, toolsResp) {
				return
			}
		}
	}()

	// Drives one turn that emits a bash tool_use, creating an async tool-action
	// and parking (no executor in the test). The push fires inside that turn.
	w.driveStrategyLoop(t, "do a tool", false)
	close(done)

	// Await mailbox-delivery quiescence: the engine must end up with strictly
	// more yjs-syncs than the viewer (the extra full-state push).
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if engineSyncs.Load() > viewerSyncs.Load() {
			return // fix verified: engine got the extra push the viewer did not
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("engine was not pushed conversation state on a tool turn (wedge): engine=%d viewer=%d",
		engineSyncs.Load(), viewerSyncs.Load())
}
