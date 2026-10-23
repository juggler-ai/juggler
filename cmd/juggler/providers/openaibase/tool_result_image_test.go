//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestToolResultImageBecomesTrailingUserMessage: role="tool" messages are
// text-only, so a tool-result image is carried by a following user message with
// an image_url part — emitted AFTER the tool message (Chat Completions path).
func TestToolResultImageBecomesTrailingUserMessage(t *testing.T) {
	data := []byte{1, 2, 3, 4, 5}
	msgs := []provider.Message{
		{Type: "assistant", Content: "looking"},
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{}},
		{Type: "tool-result", ToolUseID: "t1", Content: "Read image", Parts: []provider.MediaPart{
			{Type: "image", Mime: "image/png", Data: data},
		}},
	}

	out := transformMessages(msgs, false, ReasoningReplay{}, "", "")
	blob, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(blob)

	wantURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	if !strings.Contains(s, wantURI) {
		t.Fatalf("image data URI missing from request: %s", s)
	}
	// The tool message (identified by tool_call_id) must precede the image turn.
	ti := strings.Index(s, "tool_call_id")
	ii := strings.Index(s, wantURI)
	if ti < 0 || ii < 0 || ti > ii {
		t.Fatalf("expected tool message before image turn (tool=%d image=%d): %s", ti, ii, s)
	}
}

// TestTextOnlyModelGetsNoToolResultImage: a provider that declares its models'
// input modalities never sends an image to a model it declares text-only —
// a tool that renders an image (query_code's image(), read on a PNG) would
// otherwise turn every later request into a 400 from a text-only endpoint
// (z.ai's GLM-5.3 does exactly that). The tool result tells the model the
// image was withheld, so it doesn't reason as if it had seen it. A model the
// provider declares multimodal still gets the image.
func TestTextOnlyModelGetsNoToolResultImage(t *testing.T) {
	data := []byte{1, 2, 3, 4, 5}
	uri := "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	name := "openaibase-text-only-" + t.Name()
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, sseBody(`{"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	}))
	t.Cleanup(srv.Close)
	Register(Descriptor{
		Name:            name,
		BaseURL:         srv.URL,
		ContextWindowFn: func(string) (int, int) { return 200000, 8192 },
		InputModalitiesFn: func(model string) []string {
			if model == "vision-model" {
				return []string{"text", "image"}
			}
			return nil
		},
	})
	msgs := []provider.Message{
		{Type: "user", Content: "render it"},
		{Type: "tool-use", ToolUseID: "t1", ToolName: "query_code", ToolInput: map[string]any{}},
		{Type: "tool-result", ToolUseID: "t1", Content: "see attached", Parts: []provider.MediaPart{
			{Type: "image", Mime: "image/png", Data: data},
		}},
	}
	send := func(model string) string {
		t.Helper()
		p, err := provider.InitializeProvider(name, provider.Config{APIKey: "test", Model: model})
		if err != nil {
			t.Fatalf("InitializeProvider(%s): %v", model, err)
		}
		for {
			u, wrapped := p.(provider.Unwrapper)
			if !wrapped {
				break
			}
			p = u.Unwrap()
		}
		c, ok := p.(*openAICompatClient)
		if !ok {
			t.Fatalf("provider is %T, want *openAICompatClient", p)
		}
		body = ""
		if _, err := c.streamMessage(context.Background(), provider.MessageRequest{Messages: msgs},
			func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
			t.Fatalf("streamMessage(%s): %v", model, err)
		}
		return body
	}

	textOnly := send("text-model")
	if strings.Contains(textOnly, uri) || strings.Contains(textOnly, "image_url") {
		t.Fatalf("a text-only model was sent the tool result's image: %s", textOnly)
	}
	if !strings.Contains(textOnly, "not sent") {
		t.Fatalf("the tool result doesn't tell the model its image was withheld: %s", textOnly)
	}
	if vision := send("vision-model"); !strings.Contains(vision, uri) {
		t.Fatalf("a multimodal model lost the tool result's image: %s", vision)
	}
}

// TestResponsesToolResultImageBecomesTrailingUserMessage: the Responses API
// path (function_call_output is text-only) carries the image in a following
// user input message.
func TestResponsesToolResultImageBecomesTrailingUserMessage(t *testing.T) {
	data := []byte{9, 9, 9, 8}
	msgs := []provider.Message{
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{}},
		{Type: "tool-result", ToolUseID: "t1", Content: "Read image", Parts: []provider.MediaPart{
			{Type: "image", Mime: "image/png", Data: data},
		}},
	}

	in := transformMessagesToResponsesInput(msgs)
	blob, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(blob), "data:image/png;base64,"+base64.StdEncoding.EncodeToString(data)) {
		t.Fatalf("image data URI missing from responses input: %s", string(blob))
	}
}
