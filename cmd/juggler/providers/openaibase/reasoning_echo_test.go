//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"

	"github.com/openai/openai-go/v3"
)

const deepseekProducer = "deepseek/deepseek-v4-flash"

// deepseekReplay is DeepSeek's contract: reasoning_content on every assistant
// message, "" where a message has none of its own.
var deepseekReplay = ReasoningReplay{Field: "reasoning_content", Required: true}

// reasoningTurn is a representative thinking+text+tool-call assistant turn:
// DeepSeek streams chain-of-thought, then a tool call. The continuation request
// that carries the tool result back must replay the reasoning or DeepSeek's
// thinking mode 400s with "The reasoning_content ... must be passed back".
func reasoningTurn() []provider.Message {
	return []provider.Message{
		{Type: "user", Content: "What's the weather?"},
		{Type: "thinking", Content: "The user wants weather; I should call the tool.",
			ProviderData: map[string]any{reasoningProducerKey: deepseekProducer}},
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

// TestReasoningReplayCarriesThinking proves a replaying provider sends the
// turn's reasoning back as reasoning_content alongside the normal content and
// tool_calls.
func TestReasoningReplayCarriesThinking(t *testing.T) {
	msgs := transformMessages(reasoningTurn(), false, deepseekReplay, deepseekProducer, "")
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

// TestReasoningReplayOffDropsThinking proves the zero value — every API with
// no field for it — still omits the reasoning: Mistral 422s on the unknown key.
func TestReasoningReplayOffDropsThinking(t *testing.T) {
	msgs := transformMessages(reasoningTurn(), false, ReasoningReplay{}, deepseekProducer, "")
	got := assistantJSON(t, msgs)

	if strings.Contains(got, "reasoning") {
		t.Fatalf("reasoning leaked with replay off; got %s", got)
	}
	if !strings.Contains(got, `"content":"Let me check."`) {
		t.Fatalf("assistant content missing; got %s", got)
	}
}

// splitAssistantJSONs returns every assistant message in the transformed set,
// in wire order.
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

// TestReasoningReplayRequiredCoversSplitAssistantTurns pins the
// delegated-subthread case: a response whose tool calls arrive as several
// use/result pairs (thread items emit one pair each) flushes one assistant
// message per pair. DeepSeek 400s on any of them without reasoning_content, so
// the first carries the reasoning and the second the empty placeholder —
// never a second copy of the same reasoning.
func TestReasoningReplayRequiredCoversSplitAssistantTurns(t *testing.T) {
	msgs := transformMessages([]provider.Message{
		{Type: "user", Content: "Summarize these pages."},
		{Type: "thinking", Content: "I need both pages; delegate each fetch.",
			ProviderData: map[string]any{reasoningProducerKey: deepseekProducer}},
		{Type: "tool-use", ToolUseID: "call_1", ToolName: "WebFetch", ToolInput: map[string]any{"url": "a"}},
		{Type: "tool-result", ToolUseID: "call_1", Content: "page a"},
		{Type: "tool-use", ToolUseID: "call_2", ToolName: "WebFetch", ToolInput: map[string]any{"url": "b"}},
		{Type: "tool-result", ToolUseID: "call_2", Content: "page b"},
	}, false, deepseekReplay, deepseekProducer, "")

	got := splitAssistantJSONs(t, msgs)
	if len(got) != 2 {
		t.Fatalf("expected 2 assistant messages (one per use/result pair), got %d: %v", len(got), got)
	}
	if !strings.Contains(got[0], `"reasoning_content":"I need both pages; delegate each fetch."`) {
		t.Fatalf("first message missing its reasoning; got %s", got[0])
	}
	if !strings.Contains(got[1], `"reasoning_content":""`) {
		t.Fatalf("second message missing the placeholder DeepSeek requires; got %s", got[1])
	}
}
