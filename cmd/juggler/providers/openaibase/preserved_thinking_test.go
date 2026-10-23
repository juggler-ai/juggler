//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"

	"github.com/openai/openai-go/v3"
)

const glmProducer = "zai/glm-5.3"

// zaiReplay is Z.ai's Preserved Thinking: reasoning_content, nothing where a
// message has no reasoning of its own.
var zaiReplay = ReasoningReplay{Field: "reasoning_content"}

// glmThinking is a thinking block as the zai client stores it: stamped with
// the provider/model that produced it.
func glmThinking(content string) provider.Message {
	return provider.Message{
		Type:         "thinking",
		Content:      content,
		ProviderData: map[string]any{reasoningProducerKey: glmProducer},
	}
}

// glmAgentRun is shaped like a real GLM agent run: a reasoned first call with
// text and a tool call, a second call that produced no reasoning at all, then a
// call whose reasoning arrived as two consecutive blocks.
func glmAgentRun() []provider.Message {
	return []provider.Message{
		{Type: "user", Content: "Fix the bug."},
		glmThinking("A: read a.go first."),
		{Type: "assistant", Content: "Looking."},
		{Type: "tool-use", ToolUseID: "call_1", ToolName: "read", ToolInput: map[string]any{"path": "a.go"}},
		{Type: "tool-result", ToolUseID: "call_1", Content: "package a"},
		{Type: "tool-use", ToolUseID: "call_2", ToolName: "read", ToolInput: map[string]any{"path": "b.go"}},
		{Type: "tool-result", ToolUseID: "call_2", Content: "package b"},
		glmThinking("B: the nil check is missing. "),
		glmThinking("C: add it in a.go."),
		{Type: "tool-use", ToolUseID: "call_3", ToolName: "edit", ToolInput: map[string]any{"path": "a.go"}},
		{Type: "tool-result", ToolUseID: "call_3", Content: "ok"},
	}
}

// assertWireJSON compares the transformed messages with the expected wire JSON
// structurally, so key order is irrelevant but every field and value counts.
func assertWireJSON(t *testing.T, msgs []openai.ChatCompletionMessageParamUnion, want string) {
	t.Helper()
	gotBytes, err := json.Marshal(msgs)
	if err != nil {
		t.Fatalf("marshal messages: %v", err)
	}
	var got, exp any
	if err := json.Unmarshal(gotBytes, &got); err != nil {
		t.Fatalf("unmarshal got: %v", err)
	}
	if err := json.Unmarshal([]byte(want), &exp); err != nil {
		t.Fatalf("unmarshal want: %v", err)
	}
	if !reflect.DeepEqual(got, exp) {
		t.Fatalf("wire JSON mismatch\n got: %s\nwant: %s", gotBytes, want)
	}
}

// TestPreservedThinkingEchoesEachBlockOnce pins Z.ai's Preserved Thinking
// contract: each reasoning block goes back on the assistant message built from
// the output that followed it, once, unmodified; consecutive blocks are joined
// in order; a call that produced no reasoning carries none.
func TestPreservedThinkingEchoesEachBlockOnce(t *testing.T) {
	msgs := transformMessages(glmAgentRun(), false, zaiReplay, glmProducer, "")
	assertWireJSON(t, msgs, `[
		{"role":"user","content":"Fix the bug."},
		{"role":"assistant","content":"Looking.","reasoning_content":"A: read a.go first.",
		 "tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\"path\":\"a.go\"}"}}]},
		{"role":"tool","tool_call_id":"call_1","content":"package a"},
		{"role":"assistant",
		 "tool_calls":[{"id":"call_2","type":"function","function":{"name":"read","arguments":"{\"path\":\"b.go\"}"}}]},
		{"role":"tool","tool_call_id":"call_2","content":"package b"},
		{"role":"assistant","reasoning_content":"B: the nil check is missing. C: add it in a.go.",
		 "tool_calls":[{"id":"call_3","type":"function","function":{"name":"edit","arguments":"{\"path\":\"a.go\"}"}}]},
		{"role":"tool","tool_call_id":"call_3","content":"ok"}
	]`)
}

// TestReasoningReplayRequiredFillsPlaceholder runs the same history under a
// Required contract (DeepSeek, Kimi): the call that produced no reasoning
// carries the placeholder instead of nothing — and never the previous call's
// reasoning.
func TestReasoningReplayRequiredFillsPlaceholder(t *testing.T) {
	kimi := ReasoningReplay{Field: "reasoning_content", Required: true, Placeholder: " "}
	msgs := transformMessages(glmAgentRun(), false, kimi, glmProducer, "")
	assertWireJSON(t, msgs, `[
		{"role":"user","content":"Fix the bug."},
		{"role":"assistant","content":"Looking.","reasoning_content":"A: read a.go first.",
		 "tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\"path\":\"a.go\"}"}}]},
		{"role":"tool","tool_call_id":"call_1","content":"package a"},
		{"role":"assistant","reasoning_content":" ",
		 "tool_calls":[{"id":"call_2","type":"function","function":{"name":"read","arguments":"{\"path\":\"b.go\"}"}}]},
		{"role":"tool","tool_call_id":"call_2","content":"package b"},
		{"role":"assistant","reasoning_content":"B: the nil check is missing. C: add it in a.go.",
		 "tool_calls":[{"id":"call_3","type":"function","function":{"name":"edit","arguments":"{\"path\":\"a.go\"}"}}]},
		{"role":"tool","tool_call_id":"call_3","content":"ok"}
	]`)
}

// TestReasoningReplayUsesProviderField pins the key: Ollama reads the
// reasoning back only under "reasoning" (measured: the prompt grows by the
// reasoning's tokens) and silently ignores "reasoning_content".
func TestReasoningReplayUsesProviderField(t *testing.T) {
	msgs := transformMessages(glmAgentRun(), false, ReasoningReplay{Field: "reasoning"}, glmProducer, "")
	got := splitAssistantJSONs(t, msgs)
	if !strings.Contains(got[0], `"reasoning":"A: read a.go first."`) || strings.Contains(got[0], "reasoning_content") {
		t.Fatalf("reasoning not sent under the provider's field; got %s", got[0])
	}
}

// foreignReasoningRun is a conversation that switched models: a signed Claude
// block, an unstamped block (another chat-completions vendor, or the worker's
// own "Dropped N context items" note) and another GLM model's reasoning, then a
// block whose output was lost (compacted away).
func foreignReasoningRun() []provider.Message {
	return []provider.Message{
		{Type: "user", Content: "Go on."},
		{Type: "thinking", Content: "claude reasoning", ProviderData: map[string]any{"signature": "sig"}},
		{Type: "tool-use", ToolUseID: "call_1", ToolName: "read", ToolInput: map[string]any{"path": "a.go"}},
		{Type: "tool-result", ToolUseID: "call_1", Content: "package a"},
		{Type: "thinking", Content: "Dropped 2 context items"},
		{Type: "tool-use", ToolUseID: "call_2", ToolName: "read", ToolInput: map[string]any{"path": "b.go"}},
		{Type: "tool-result", ToolUseID: "call_2", Content: "package b"},
		{Type: "thinking", Content: "older model", ProviderData: map[string]any{reasoningProducerKey: "zai/glm-5.2"}},
		{Type: "tool-use", ToolUseID: "call_3", ToolName: "read", ToolInput: map[string]any{"path": "c.go"}},
		{Type: "tool-result", ToolUseID: "call_3", Content: "package c"},
		glmThinking("orphan: its tool call was compacted away"),
		{Type: "tool-result", ToolUseID: "call_9", Content: "summary of folded work"},
		{Type: "tool-use", ToolUseID: "call_4", ToolName: "read", ToolInput: map[string]any{"path": "d.go"}},
		{Type: "tool-result", ToolUseID: "call_4", Content: "package d"},
	}
}

// TestPreservedThinkingSkipsReasoningItDidNotProduce proves none of
// foreignReasoningRun's reasoning is this model's own sequence, so none goes
// back — not even where a Required contract must put something on every
// message, which gets the placeholder — and the orphaned block does not drift
// onto the next call's message.
func TestPreservedThinkingSkipsReasoningItDidNotProduce(t *testing.T) {
	for _, replay := range []ReasoningReplay{zaiReplay, {Field: "reasoning_content", Required: true}} {
		msgs := transformMessages(foreignReasoningRun(), false, replay, glmProducer, "")
		for i, m := range splitAssistantJSONs(t, msgs) {
			var fields map[string]any
			if err := json.Unmarshal([]byte(m), &fields); err != nil {
				t.Fatalf("unmarshal assistant %d: %v", i, err)
			}
			rc, ok := fields["reasoning_content"]
			switch {
			case replay.Required && (!ok || rc != ""):
				t.Fatalf("required=%v: assistant message %d should carry only the placeholder, got %q", replay.Required, i, rc)
			case !replay.Required && ok:
				t.Fatalf("required=%v: assistant message %d carries reasoning GLM did not produce for it: %q", replay.Required, i, rc)
			}
		}
	}
}

// TestPreservedThinkingStampsReasoningProducer proves the stream marks the
// reasoning it surfaces with the provider/model that produced it — the stamp
// the transform matches on — in a contentless thinking chunk that ends the
// block before the text that follows, and only for a provider in that mode.
func TestPreservedThinkingStampsReasoningProducer(t *testing.T) {
	body := sseBody(
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Think."},"finish_reason":null}]}`,
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}`,
	)
	for _, preserved := range []bool{true, false} {
		c := streamingClientWithSSE(t, body)
		c.providerName = "zai"
		if preserved {
			c.quirks.ReasoningReplay = zaiReplay
		}

		var seq []string
		_, err := c.streamMessage(context.Background(), provider.MessageRequest{
			Messages: []provider.Message{{Type: "user", Content: "hello"}},
		}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
			switch chunk.Type {
			case provider.ContentBlockTypeThinking:
				if chunk.Content != "" {
					seq = append(seq, "thinking:"+chunk.Content)
				} else {
					seq = append(seq, "stamp:"+stringFromMap(chunk.Metadata, reasoningProducerKey))
				}
			case provider.ContentBlockTypeText:
				seq = append(seq, "text:"+chunk.Content)
			}
			return nil, nil
		})
		if err != nil {
			t.Fatalf("streamMessage: %v", err)
		}
		want := []string{"thinking:Think.", "text:Done."}
		if preserved {
			want = []string{"thinking:Think.", "stamp:zai/glm-4.6", "text:Done."}
		}
		if !reflect.DeepEqual(seq, want) {
			t.Fatalf("preserved=%v: chunk sequence %v, want %v", preserved, seq, want)
		}
	}
}

func stringFromMap(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}
