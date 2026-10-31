//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// sseBody packs chat.completion.chunk JSON objects into a Server-Sent Events
// stream the OpenAI SDK can decode: each event is a `data: <json>` line
// followed by a blank line, terminated by `data: [DONE]`.
func sseBody(events ...string) string {
	var b strings.Builder
	for _, e := range events {
		b.WriteString("data: ")
		b.WriteString(e)
		b.WriteString("\n\n")
	}
	b.WriteString("data: [DONE]\n\n")
	return b.String()
}

// streamingClientWithSSE returns a client whose transport answers the
// chat-completions request with a fixed SSE body.
func streamingClientWithSSE(t *testing.T, body string) *Client {
	t.Helper()
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
		Model:      "glm-4.6", // non-codex → Chat Completions path
		BaseURL:    "https://example.test",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

// TestReasoningContentSurfacedAsThinking proves that a GLM/DeepSeek-style stream
// — which carries its chain-of-thought in the non-standard `reasoning_content`
// delta field rather than `content` — is surfaced to the worker as live
// thinking AND drives the output-token progress estimate. Before the fix the
// parser read only `content`/`tool_calls`, so a model that "thinks" for minutes
// streamed nothing observable: the spinner sat frozen on "Receiving" with no
// token movement, and a reasoning run that overran the output cap produced an
// empty turn.
func TestReasoningContentSurfacedAsThinking(t *testing.T) {
	body := sseBody(
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Let me work through this carefully."},"finish_reason":null}]}`,
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"reasoning_content":" Still reasoning about the answer."},"finish_reason":null}]}`,
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":42}}`,
	)
	c := streamingClientWithSSE(t, body)

	var thinking strings.Builder
	var sawProgress bool
	var text strings.Builder
	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		switch chunk.Type {
		case provider.ContentBlockTypeThinking:
			thinking.WriteString(chunk.Content)
		case provider.ContentBlockTypeProgress:
			sawProgress = true
		case provider.ContentBlockTypeText:
			text.WriteString(chunk.Content)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}

	if got := thinking.String(); got != "Let me work through this carefully. Still reasoning about the answer." {
		t.Fatalf("reasoning_content was not surfaced as thinking; got %q", got)
	}
	if !sawProgress {
		t.Fatal("reasoning_content did not drive a progress chunk — the spinner would stay frozen on \"Receiving\"")
	}
	if got := text.String(); got != "Done." {
		t.Fatalf("final content text = %q, want \"Done.\"", got)
	}
}

// TestArrayContentChunksSurfacedAsThinkingAndText proves a Mistral-style
// stream — `delta.content` as an array of typed chunks, with chain-of-thought
// in `thinking` chunks — is split into live thinking and answer text. The SDK
// types `content` as a string and drops the array's raw JSON into it, so
// reading that string alone shows `[{"type":"thinking",…}]` as the answer.
func TestArrayContentChunksSurfacedAsThinkingAndText(t *testing.T) {
	body := sseBody(
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm","choices":[{"index":0,"delta":{"role":"assistant","content":[{"type":"thinking","thinking":[{"type":"text","text":"The"}],"closed":true}]},"finish_reason":null}]}`,
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":" user sent"},{"type":"text","text":" \"test\""}],"closed":true},{"type":"mystery","data":1}]},"finish_reason":null}]}`,
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm","choices":[{"index":0,"delta":{"content":[{"type":"text","text":" there."}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":42}}`,
	)
	c := streamingClientWithSSE(t, body)

	var thinkingChunks []string
	var sawProgressDuringThinking bool
	var text strings.Builder
	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		switch chunk.Type {
		case provider.ContentBlockTypeThinking:
			if chunk.Content != "" {
				thinkingChunks = append(thinkingChunks, chunk.Content)
			}
		case provider.ContentBlockTypeProgress:
			if text.Len() == 0 {
				sawProgressDuringThinking = true
			}
		case provider.ContentBlockTypeText:
			text.WriteString(chunk.Content)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}

	if got, want := strings.Join(thinkingChunks, "|"), `The| user sent "test"`; got != want {
		t.Fatalf("thinking chunks = %q, want %q", got, want)
	}
	if !sawProgressDuringThinking {
		t.Fatal("array-form thinking did not drive a progress chunk")
	}
	got := text.String()
	if strings.Contains(got, `"type":`) || strings.Contains(got, `[{`) {
		t.Fatalf("raw content-chunk JSON leaked into the text: %q", got)
	}
	if got != "Hello there." {
		t.Fatalf("text = %q, want \"Hello there.\"", got)
	}
}

// TestOpenRouterReasoningFieldSurfacedAsThinking proves the OpenRouter relay
// key — `reasoning` rather than GLM/DeepSeek's `reasoning_content` — is also
// surfaced as live thinking. OpenRouter routes through openaibase, so without
// the alias its reasoning models would still show a frozen "Receiving" spinner.
func TestOpenRouterReasoningFieldSurfacedAsThinking(t *testing.T) {
	body := sseBody(
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"or","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"Thinking via the relay key."},"finish_reason":null}]}`,
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"or","choices":[{"index":0,"delta":{"content":"Answer."},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`,
	)
	c := streamingClientWithSSE(t, body)

	var thinking, text strings.Builder
	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		switch chunk.Type {
		case provider.ContentBlockTypeThinking:
			thinking.WriteString(chunk.Content)
		case provider.ContentBlockTypeText:
			text.WriteString(chunk.Content)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if got := thinking.String(); got != "Thinking via the relay key." {
		t.Fatalf("`reasoning` field not surfaced as thinking; got %q", got)
	}
	if got := text.String(); got != "Answer." {
		t.Fatalf("final text = %q, want \"Answer.\"", got)
	}
}

func TestChatCompletionsMarksFallbackInputUsageApproximate(t *testing.T) {
	body := sseBody(
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}]}`,
	)
	c := streamingClientWithSSE(t, body)

	result, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello world"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if result.InputTokens == 0 || !result.InputTokensApproximate {
		t.Fatalf("fallback input usage = %+v, want positive approximate count", result)
	}

	reported := sseBody(
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":17,"completion_tokens":1}}`,
	)
	c = streamingClientWithSSE(t, reported)
	result, err = c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello world"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage with usage: %v", err)
	}
	if result.InputTokens != 17 || result.InputTokensApproximate {
		t.Fatalf("reported input usage = %+v, want 17 authoritative tokens", result)
	}
}

// TestReasoningContentNonStringEmitsNoThinking proves the ExtraFields parse is
// defensive: a null or non-string reasoning_content (and an absent field) must
// NOT emit a spurious thinking chunk. Without the type guard these would either
// panic or surface garbage.
func TestReasoningContentNonStringEmitsNoThinking(t *testing.T) {
	body := sseBody(
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":null}}]}`,
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"reasoning_content":42}}]}`,
		`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`,
	)
	c := streamingClientWithSSE(t, body)

	var thinking, text strings.Builder
	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		switch chunk.Type {
		case provider.ContentBlockTypeThinking:
			thinking.WriteString(chunk.Content)
		case provider.ContentBlockTypeText:
			text.WriteString(chunk.Content)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if got := thinking.String(); got != "" {
		t.Fatalf("null/non-string reasoning_content emitted thinking %q, want none", got)
	}
	if got := text.String(); got != "Done." {
		t.Fatalf("final text = %q, want \"Done.\"", got)
	}
}
