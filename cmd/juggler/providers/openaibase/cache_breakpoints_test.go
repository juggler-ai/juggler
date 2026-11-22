//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// cacheBreakpointsRequest sends one Chat Completions turn with a system prompt
// through a client with the given quirks and returns the decoded request body.
func cacheBreakpointsRequest(t *testing.T, quirks Quirks) map[string]any {
	t.Helper()
	var body map[string]any
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "anthropic/claude-haiku-4.5",
		BaseURL:    "https://example.test",
		HTTPClient: captureBody(t, &body, "chat"),
		Quirks:     quirks,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = c.streamMessage(context.Background(), provider.MessageRequest{
		SystemPrompt: "You are a helpful agent.",
		Messages:     []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	return body
}

// TestChatCompletionsCacheBreakpoints proves a model that caches only on
// explicit breakpoints (Anthropic's, through OpenRouter) is sent them: the
// top-level cache_control that rolls a breakpoint onto the request's last
// cacheable block, and one on the system prompt so tools+system stay cached
// when the history behind them changes. Without these every turn re-bills the
// whole prompt, and nothing but the bill shows it.
func TestChatCompletionsCacheBreakpoints(t *testing.T) {
	body := cacheBreakpointsRequest(t, Quirks{CacheBreakpoints: true})

	top, _ := body["cache_control"].(map[string]any)
	if top["type"] != "ephemeral" {
		t.Fatalf("top-level cache_control = %v, want {type: ephemeral}", body["cache_control"])
	}

	messages, _ := body["messages"].([]any)
	if len(messages) == 0 {
		t.Fatalf("no messages in request: %v", body)
	}
	system, _ := messages[0].(map[string]any)
	if system["role"] != "system" {
		t.Fatalf("first message role = %v, want system", system["role"])
	}
	parts, ok := system["content"].([]any)
	if !ok || len(parts) != 1 {
		t.Fatalf("system content = %#v, want one text part", system["content"])
	}
	part, _ := parts[0].(map[string]any)
	if part["type"] != "text" || part["text"] != "You are a helpful agent." {
		t.Fatalf("system part = %v, want the prompt as a text part", part)
	}
	cc, _ := part["cache_control"].(map[string]any)
	if cc["type"] != "ephemeral" {
		t.Fatalf("system part cache_control = %v, want {type: ephemeral}", part["cache_control"])
	}
}

// TestChatCompletionsNoCacheBreakpointsByDefault proves every other model's
// request is unchanged: no cache_control, and the system prompt stays a plain
// string. An endpoint that does not know the field may reject it.
func TestChatCompletionsNoCacheBreakpointsByDefault(t *testing.T) {
	body := cacheBreakpointsRequest(t, Quirks{})

	if _, ok := body["cache_control"]; ok {
		t.Fatalf("cache_control sent without the quirk: %v", body["cache_control"])
	}
	messages, _ := body["messages"].([]any)
	system, _ := messages[0].(map[string]any)
	if _, ok := system["content"].(string); !ok {
		t.Fatalf("system content = %#v, want a plain string", system["content"])
	}
}

// TestChatCompletionsReadsCacheWriteTokens proves the tokens a call wrote to the
// cache (prompt_tokens_details.cache_write_tokens, which OpenRouter reports for
// models with explicit caching) reach the result. Left unread, the UI shows
// "? written" on a turn that paid the write premium.
func TestChatCompletionsReadsCacheWriteTokens(t *testing.T) {
	c, err := NewClient(Config{
		APIKey:  "test",
		Model:   "anthropic/claude-haiku-4.5",
		BaseURL: "https://example.test",
		HTTPClient: streamClient(sseBody(
			`{"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5000,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":4800}}}`,
		)),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if res.CacheWriteTokens == nil || *res.CacheWriteTokens != 4800 {
		t.Fatalf("CacheWriteTokens = %v, want 4800", res.CacheWriteTokens)
	}
	if res.CachedTokens == nil || *res.CachedTokens != 0 {
		t.Fatalf("CachedTokens = %v, want a reported 0", res.CachedTokens)
	}
}

// TestChatCompletionsCacheWriteUnknownWhenOmitted proves an endpoint that
// reports cache reads but not writes leaves the write count unknown rather
// than a fabricated zero.
func TestChatCompletionsCacheWriteUnknownWhenOmitted(t *testing.T) {
	c, err := NewClient(Config{
		APIKey:  "test",
		Model:   "glm-4.6",
		BaseURL: "https://example.test",
		HTTPClient: streamClient(sseBody(
			`{"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5000,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":4000}}}`,
		)),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if res.CacheWriteTokens != nil {
		t.Fatalf("CacheWriteTokens = %d, want nil (unreported)", *res.CacheWriteTokens)
	}
}
