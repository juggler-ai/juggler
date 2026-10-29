//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside compaction_trigger_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestContextRecoveryRetriesRejectedTurnAboveAdvisoryLimit drives the full strategy loop:
// the first real request is rejected by the provider, recovery folds the old
// history into the doc, and the loop retries with the guard bypassed — the
// provider, not the local estimator, judges the folded transcript.
func TestContextRecoveryRetriesRejectedTurnAboveAdvisoryLimit(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Four oversized old items; the turn's own user message lands after them.
	w.doc.InsertMessage(0, recoveryTestItems()[:4]...)

	// Feed context/tools for the initial and retried turns (hidden recovery
	// calls do not consume these).
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			if !w.engine.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()

	realCalls, hiddenCalls := 0, 0
	firstTurnMessages, retriedTurnMessages := -1, -1
	retryBypassed := false
	w.SetLLMCaller(func(_ context.Context, raw json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			hiddenCalls++
			if isCompactionFinalRequest(req) {
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered prefix summary"}}}, nil
			}
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
		}
		realCalls++
		if realCalls == 1 {
			firstTurnMessages = len(req.Messages)
			return nil, recoveryLimitErr()
		}
		retriedTurnMessages = len(req.Messages)
		retryBypassed = req.BypassContextGuard
		// Visible turns assemble the assistant message from streamed chunks;
		// mirror the provider's stream before delivering the final response.
		sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: "recovered answer"})
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "recovered answer"}},
			StopReason: "end_turn",
		}, nil
	})

	w.driveStrategyLoop(t, "Hello", false)

	if realCalls != 2 {
		t.Fatalf("real calls = %d, want the rejected attempt plus exactly one retry", realCalls)
	}
	if hiddenCalls < 2 {
		t.Fatalf("hidden calls = %d, want map(s) plus final", hiddenCalls)
	}
	if firstTurnMessages != 5 || retriedTurnMessages != 2 {
		t.Fatalf("turn messages %d -> %d, want 5 rejected, 2 after the fold (summary plus the live user message)", firstTurnMessages, retriedTurnMessages)
	}
	if !retryBypassed {
		t.Fatal("post-fold retry re-entered guarded admission; it must dispatch bypassed")
	}

	items := w.doc.GetItems()
	var summaries, assistants int
	for _, item := range items {
		switch item.Type {
		case ItemTypeThread:
			if item.BoundedCompaction {
				summaries++
				if got := threadResultString(item); got != "recovered prefix summary" {
					t.Fatalf("summary result = %q", got)
				}
			}
		case ItemTypeAssistant:
			assistants++
			if item.Content != "recovered answer" {
				t.Fatalf("assistant content = %q", item.Content)
			}
		case ItemTypeError:
			t.Fatalf("unexpected error item after recovery: %q", item.Content)
		}
	}
	if summaries != 1 || assistants != 1 {
		t.Fatalf("items have %d summaries and %d assistants, want exactly one of each", summaries, assistants)
	}
}

// TestToolResultPushingNextCallOverContextRecovers drives the active tool
// loop end to end: turn one runs a tool, its oversized result makes the
// continuation request inadmissible, recovery shrinks the result and folds
// the old history, and the SAME loop continues to completion — with the tool
// executed exactly once.
func TestToolResultPushingNextCallOverContextRecovers(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "test-conv"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	executes := make(chan string, 8)
	w.SetCallback("engine", func(b []byte) {
		var m ToolCommand
		if json.Unmarshal(b, &m) == nil && m.Type == "execute-tool" {
			executes <- m.ToolUseID
		}
	})
	w.SetEngineClientID("engine")

	w.currentRun().storeState(StateProcessing)
	w.doc.InsertMessage(0, recoveryTestItems()[:3]...)

	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(ToolsResultMessage{
			Type:  "tools-result",
			Tools: []ToolDefinition{{Name: "bash"}},
		})
		for {
			if !w.engine.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()

	realCalls := 0
	w.SetLLMCaller(func(_ context.Context, raw json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(req.ThreadID, ":bounded:") {
			if isCompactionFinalRequest(req) {
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered prefix summary"}}}, nil
			}
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
		}
		realCalls++
		switch realCalls {
		case 1:
			return &LLMResponse{
				Blocks:     []LLMResponseBlock{{Type: "tool_use", ID: "tu-1", Name: "bash", Input: json.RawMessage(`{"command":"cat /tmp/big"}`)}},
				StopReason: "tool_use",
			}, nil
		case 2:
			// Precondition: the giant tool result really pushed this request
			// past the window — otherwise the fixture is not exercising
			// recovery at all.
			estimate := provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total
			if estimate+300 <= 4_000 {
				t.Fatalf("continuation request fits (%d + 300 <= 4000); the fixture is not oversized", estimate)
			}
			return nil, recoveryLimitErr()
		default:
			estimate := provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total
			if estimate+300 > 4_000 {
				t.Fatalf("retried request still does not fit: %d + 300 > 4000", estimate)
			}
			sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: "continued after recovery"})
			return &LLMResponse{
				Blocks:     []LLMResponseBlock{{Type: "text", Content: "continued after recovery"}},
				StopReason: "end_turn",
			}, nil
		}
	})

	// Turn 1: the model calls bash; the async tool-action parks the loop after
	// an evaluate-tool command. The engine's approval verdict lands as a sync…
	w.driveStrategyLoop(t, "run the tool", false)
	if err := w.doc.UpdateItemByToolUseID("tu-1", "state", StateApproved); err != nil {
		t.Fatal(err)
	}
	// …the next drive tick commands the execution (counted by the callback)…
	w.driveToolActions()
	// …and the engine writes the oversized result back when it finishes.
	if err := w.doc.UpdateItemByToolUseID("tu-1", "state", StateCompleted); err != nil {
		t.Fatal(err)
	}
	if err := w.doc.UpdateItemByToolUseID("tu-1", "result", map[string]any{"content": strings.Repeat("r", 15_000), "isError": false}); err != nil {
		t.Fatal(err)
	}

	// Continuation: rejected, recovered, retried — on a turn of its own, as the
	// reducer's dispatchCallLLMOnThread would start it.
	w.driveStrategyLoop(t, "", true)

	if realCalls != 3 {
		t.Fatalf("real calls = %d, want tool turn, rejected continuation, retried continuation", realCalls)
	}
	if got := drainExecuteIDs(executes); len(got) != 1 || got[0] != "tu-1" {
		t.Fatalf("execute-tool dispatches = %v, want exactly one (tu-1); tools must not repeat", got)
	}

	items := w.doc.GetItems()
	var summaries, assistants, toolActions int
	for _, item := range items {
		switch item.Type {
		case ItemTypeThread:
			if item.BoundedCompaction {
				summaries++
			}
		case ItemTypeAssistant:
			assistants++
			if item.Content != "continued after recovery" {
				t.Fatalf("assistant content = %q", item.Content)
			}
		case ItemTypeToolAction:
			toolActions++
			if item.ToolUseID != "tu-1" || item.State != StateCompleted {
				t.Fatalf("tool item = %+v, want tu-1 completed", item)
			}
			var payload struct {
				Content string `json:"content"`
			}
			if err := json.Unmarshal(item.Result, &payload); err != nil ||
				!strings.HasPrefix(payload.Content, recoveryShrunkResultMarker) {
				t.Fatalf("tool result was not shrunk in place: %.80q", payload.Content)
			}
		case ItemTypeError:
			t.Fatalf("unexpected error item after recovery: %q", item.Content)
		}
	}
	if summaries != 1 || assistants != 1 || toolActions != 1 {
		t.Fatalf("summaries=%d assistants=%d toolActions=%d, want one of each", summaries, assistants, toolActions)
	}
}
