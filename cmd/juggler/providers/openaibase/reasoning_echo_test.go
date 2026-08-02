//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"encoding/json"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"

	"github.com/openai/openai-go/v3"
)

// reasoningTurn is a representative thinking+text+tool-call assistant turn:
// DeepSeek streams chain-of-thought, then a tool call. The continuation request
// that carries the tool result back must replay the reasoning or DeepSeek's
// thinking mode 400s with "The reasoning_content ... must be passed back".
func reasoningTurn() []provider.Message {
	return []provider.Message{
		{Type: "user", Content: "What's the weather?"},
		{Type: "thinking", Content: "The user wants weather; I should call the tool."},
		{Type: "assistant", Content: "Let me check."},
		{Type: "tool-use", ToolUseID: "call_1", ToolName: "get_weather", ToolInput: map[string]any{"city": "SF"}},
		{Type: "tool-result", ToolUseID: "call_1", Content: "sunny"},
	}
}

// assistantJSON marshals the first assistant message in the transformed set so
// tests can assert on the exact wire shape (including non-modeled extra fields).
func assistantJSON(t *testing.T, msgs []openai.ChatCompletionMessageParamUnion) string {
	t.Helper()
	for _, m := range msgs {
		if m.OfAssistant != nil {
			data, err := json.Marshal(m)
			if err != nil {
				t.Fatalf("marshal assistant message: %v", err)
			}
			return string(data)
		}
	}
	t.Fatal("no assistant message found in transformed set")
	return ""
}

// TestEchoReasoningContentReplaysThinking proves that with the quirk enabled the
// assistant turn carries reasoning_content back on the wire (DeepSeek thinking
// mode requires it), alongside the normal content and tool_calls.
func TestEchoReasoningContentReplaysThinking(t *testing.T) {
	msgs := transformMessages(reasoningTurn(), false, true, "")
	got := assistantJSON(t, msgs)

	if !strings.Contains(got, `"reasoning_content":"The user wants weather; I should call the tool."`) {
		t.Fatalf("reasoning_content not replayed on assistant turn; got %s", got)
	}
	// The reasoning must not clobber the real answer or the tool call.
	if !strings.Contains(got, `"content":"Let me check."`) {
		t.Fatalf("assistant content missing; got %s", got)
	}
	if !strings.Contains(got, `"tool_calls"`) {
		t.Fatalf("tool_calls missing; got %s", got)
	}
}

// TestEchoReasoningContentDisabledDropsThinking proves the default (every vendor
// but DeepSeek) still omits reasoning_content — replaying it to OpenAI/OpenRouter
// is at best ignored and at worst rejected.
func TestEchoReasoningContentDisabledDropsThinking(t *testing.T) {
	msgs := transformMessages(reasoningTurn(), false, false, "")
	got := assistantJSON(t, msgs)

	if strings.Contains(got, "reasoning_content") {
		t.Fatalf("reasoning_content leaked with echo disabled; got %s", got)
	}
	if !strings.Contains(got, `"content":"Let me check."`) {
		t.Fatalf("assistant content missing; got %s", got)
	}
}

// splitAssistantJSONs returns every assistant message in the transformed set,
// in wire order. reasoning_echo_test's single-message helper cannot express
// multi-assistant wire shapes.
func splitAssistantJSONs(t *testing.T, msgs []openai.ChatCompletionMessageParamUnion) []string {
	t.Helper()
	var out []string
	for _, m := range msgs {
		if m.OfAssistant != nil {
			data, err := json.Marshal(m)
			if err != nil {
				t.Fatalf("marshal assistant message: %v", err)
			}
			out = append(out, string(data))
		}
	}
	if len(out) == 0 {
		t.Fatal("no assistant message found in transformed set")
	}
	return out
}

// TestEchoReasoningContentCoversSplitAssistantTurns pins the delegated-subthread
// case: a turn whose tool calls arrive as several use/result pairs (thread items
// emit one pair each) flushes one assistant message per pair. DeepSeek requires
// reasoning_content on EVERY assistant message carrying tool_calls — the second
// split message without it 400s with "The `reasoning_content` in the thinking
// mode must be passed back to the API."
func TestEchoReasoningContentCoversSplitAssistantTurns(t *testing.T) {
	msgs := transformMessages([]provider.Message{
		{Type: "user", Content: "Summarize these pages."},
		{Type: "thinking", Content: "I need both pages; delegate each fetch."},
		{Type: "tool-use", ToolUseID: "call_1", ToolName: "WebFetch", ToolInput: map[string]any{"url": "a"}},
		{Type: "tool-result", ToolUseID: "call_1", Content: "page a"},
		{Type: "tool-use", ToolUseID: "call_2", ToolName: "WebFetch", ToolInput: map[string]any{"url": "b"}},
		{Type: "tool-result", ToolUseID: "call_2", Content: "page b"},
	}, false, true, "")

	got := splitAssistantJSONs(t, msgs)
	if len(got) != 2 {
		t.Fatalf("expected 2 assistant messages (one per use/result pair), got %d: %v", len(got), got)
	}
	for i, m := range got {
		if !strings.Contains(m, `"reasoning_content":"I need both pages; delegate each fetch."`) {
			t.Fatalf("assistant message %d missing reasoning_content (DeepSeek 400s without it); got %s", i, m)
		}
	}
}
