//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// responsesInputItems runs the Responses input transform and decodes the result
// into plain maps, so a test can assert what actually goes on the wire rather
// than what the SDK structs look like in memory.
func responsesInputItems(t *testing.T, msgs []provider.Message) []map[string]any {
	t.Helper()
	raw, err := json.Marshal(transformMessagesToResponsesInput(msgs).OfInputItemList)
	if err != nil {
		t.Fatalf("marshal input items: %v", err)
	}
	var items []map[string]any
	if err := json.Unmarshal(raw, &items); err != nil {
		t.Fatalf("decode input items: %v", err)
	}
	return items
}

// TestResponsesReplaysReasoningItem covers the round trip that keeps a chain of
// thought alive across a tool call. These calls are stateless (store=false), so
// the model cannot retrieve its own earlier reasoning: unless the encrypted
// blob travels back in the next request, every tool result arrives with the
// reasoning that led to the call already forgotten.
func TestResponsesReplaysReasoningItem(t *testing.T) {
	items := responsesInputItems(t, []provider.Message{
		{Type: "user", Content: "What's the weather?"},
		{
			Type: "provider-state",
			ProviderData: map[string]any{
				"provider":         "openai-responses",
				"itemType":         "reasoning",
				"reasoningItemId":  "rs_abc",
				"encryptedContent": "gAAAAA-blob",
				"summary": []any{
					map[string]any{"type": "summary_text", "text": "I should call the weather tool."},
				},
			},
		},
		{Type: "tool-use", ToolUseID: "call_1", ToolName: "get_weather", ToolInput: map[string]any{"city": "London"}},
		{Type: "tool-result", ToolUseID: "call_1", Content: "sunny"},
	})

	reasoningIdx, callIdx := -1, -1
	for i, item := range items {
		switch item["type"] {
		case "reasoning":
			reasoningIdx = i
			if got, _ := item["id"].(string); got != "rs_abc" {
				t.Errorf("reasoning id = %q, want rs_abc", got)
			}
			if got, _ := item["encrypted_content"].(string); got != "gAAAAA-blob" {
				t.Errorf("encrypted_content = %q, want gAAAAA-blob", got)
			}
			summary, _ := item["summary"].([]any)
			if len(summary) != 1 {
				t.Fatalf("summary = %v, want the stored reasoning text", item["summary"])
			}
			first, _ := summary[0].(map[string]any)
			if got, _ := first["text"].(string); got != "I should call the weather tool." {
				t.Errorf("summary text = %q, want the stored reasoning", got)
			}
		case "function_call":
			callIdx = i
		}
	}

	if reasoningIdx < 0 {
		t.Fatalf("no reasoning item on the wire; items = %+v", items)
	}
	if callIdx < 0 {
		t.Fatalf("precondition: no function_call item; items = %+v", items)
	}
	// A reasoning item describes the call it preceded, so it has to arrive
	// before it — the API rejects one that dangles.
	if reasoningIdx > callIdx {
		t.Errorf("reasoning@%d must precede its function_call@%d; items = %+v", reasoningIdx, callIdx, items)
	}
}

// TestResponsesDropsUnfollowedReasoning: a reasoning item is replayable only
// with the output it led to. A stream cut off (or stopped) after a reasoning
// item finished but before its call or message did leaves that item in history
// with nothing after it, and the API rejects every later request carrying it —
// "provided without its required following item" — so the conversation could
// never go on.
func TestResponsesDropsUnfollowedReasoning(t *testing.T) {
	reasoning := func(id string) provider.Message {
		return provider.Message{Type: "provider-state", ProviderData: map[string]any{
			"provider": "openai-responses", "itemType": "reasoning",
			"reasoningItemId": id, "encryptedContent": "blob-" + id,
		}}
	}
	items := responsesInputItems(t, []provider.Message{
		{Type: "user", Content: "review this"},
		reasoning("rs_kept_call"),
		reasoning("rs_kept_chain"),
		{Type: "tool-use", ToolUseID: "call_1", ToolName: "bash", ToolInput: map[string]any{"command": "ls"}},
		{Type: "tool-result", ToolUseID: "call_1", Content: "a.go"},
		reasoning("rs_kept_text"),
		{Type: "assistant", Content: "Looking further."},
		reasoning("rs_cut_before_user"),
		{Type: "user", Content: "carry on"},
		reasoning("rs_cut_at_end"),
	})

	var got []string
	for _, item := range items {
		if item["type"] == "reasoning" {
			id, _ := item["id"].(string)
			got = append(got, id)
		}
	}
	want := []string{"rs_kept_call", "rs_kept_chain", "rs_kept_text"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("reasoning items sent = %v, want %v", got, want)
	}
}

// TestResponsesSkipsUnreplayableThinking pins the skip rule. Reasoning stored
// before this round trip existed has no id or blob, and thinking carried over
// from another provider after a mid-conversation switch has someone else's
// metadata — an Anthropic signature means nothing to OpenAI. Neither can be
// replayed, and a reasoning item with an empty id is a hard rejection, so both
// must be left out rather than half-built.
func TestResponsesSkipsUnreplayableThinking(t *testing.T) {
	for _, tc := range []struct {
		name         string
		providerData map[string]any
	}{
		{"no provider data at all", nil},
		{"anthropic signature after a provider switch", map[string]any{"signature": "sig-abc"}},
		{"id with no encrypted content", map[string]any{"reasoningItemId": "rs_abc"}},
		{"encrypted content with no id", map[string]any{"encryptedContent": "gAAAAA"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			items := responsesInputItems(t, []provider.Message{
				{Type: "user", Content: "hi"},
				{Type: "thinking", Content: "reasoning", ProviderData: tc.providerData},
				{Type: "assistant", Content: "hello"},
			})
			for _, item := range items {
				if item["type"] == "reasoning" {
					t.Fatalf("unreplayable thinking was sent as a reasoning item: %+v", item)
				}
			}
			// The surrounding turn must still transform normally.
			if len(items) < 2 {
				t.Fatalf("expected the user and assistant items to survive; items = %+v", items)
			}
		})
	}
}

// TestResponsesCapturesReasoningItem covers the capture half: a finished
// reasoning item on the stream must reach the worker as hidden provider state,
// or there is nothing to replay in the first place.
func TestResponsesCapturesReasoningItem(t *testing.T) {
	body := sseBody(
		`{"type":"response.reasoning_summary_text.delta","delta":"Weighing the options.","item_id":"rs_abc","output_index":0,"sequence_number":1,"summary_index":0}`,
		`{"type":"response.output_item.done","output_index":0,"sequence_number":2,"item":{"type":"reasoning","id":"rs_abc","summary":[{"type":"summary_text","text":"Weighing the options."}],"encrypted_content":"gAAAAA-blob"}}`,
		`{"type":"response.output_text.delta","delta":"Done.","item_id":"m1","output_index":1,"content_index":0,"sequence_number":3}`,
	)
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    r,
		}, nil
	})}
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-5-codex",
		BaseURL:    "https://example.test",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	var captured map[string]any
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if chunk.Type == provider.ContentBlockTypeProviderState && len(chunk.Metadata) > 0 {
			captured = chunk.Metadata
		}
		return nil, nil
	}); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}

	if captured == nil {
		t.Fatal("the finished reasoning item never reached the worker — nothing to replay next turn")
	}
	if got, _ := captured["reasoningItemId"].(string); got != "rs_abc" {
		t.Errorf("reasoningItemId = %q, want rs_abc", got)
	}
	if got, _ := captured["encryptedContent"].(string); got != "gAAAAA-blob" {
		t.Errorf("encryptedContent = %q, want gAAAAA-blob", got)
	}
}

// TestResponsesRequestsEncryptedContent pins the request side of the same round
// trip: the backend returns an encrypted reasoning blob only when asked, and
// without it every replayed item would be an id pointing at nothing.
func TestResponsesRequestsEncryptedContent(t *testing.T) {
	var body map[string]any
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-5-codex",
		BaseURL:    "https://example.test",
		HTTPClient: captureBody(t, &body, "responses"),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c.thinkingSpec = OpenAIThinkingSpec("gpt-5-codex")
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}

	include, _ := body["include"].([]any)
	found := false
	for _, v := range include {
		if s, _ := v.(string); s == "reasoning.encrypted_content" {
			found = true
		}
	}
	if !found {
		t.Fatalf("include = %v, want reasoning.encrypted_content", body["include"])
	}
}

// TestResponsesOmitsIncludeForNonReasoningModels is the counterpart: a model
// advertising no levels is not a reasoning model, so asking for encrypted
// reasoning is meaningless and, on some endpoints, rejected.
func TestResponsesOmitsIncludeForNonReasoningModels(t *testing.T) {
	var body map[string]any
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-4o",
		BaseURL:    "https://example.test",
		HTTPClient: captureBody(t, &body, "responses"),
		Quirks:     Quirks{ForceResponsesAPI: true},
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if _, ok := body["include"]; ok {
		t.Fatalf("include sent (%v) to a model advertising no levels", body["include"])
	}
}
