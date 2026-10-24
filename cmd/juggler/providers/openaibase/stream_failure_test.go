//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// cutBody yields its prefix and then fails, as a body does when the connection
// under it dies mid-stream.
type cutBody struct {
	prefix io.Reader
	err    error
}

func (b *cutBody) Read(p []byte) (int, error) {
	if n, err := b.prefix.Read(p); n > 0 || err != io.EOF {
		return n, err
	}
	return 0, b.err
}

func (b *cutBody) Close() error { return nil }

func eventStream(r *http.Request, body io.ReadCloser) *http.Response {
	header := make(http.Header)
	header.Set("Content-Type", "text/event-stream")
	return &http.Response{StatusCode: http.StatusOK, Header: header, Body: body, Request: r}
}

func jsonStatus(r *http.Request, status int, header http.Header, body string) *http.Response {
	if header == nil {
		header = make(http.Header)
	}
	header.Set("Content-Type", "application/json")
	return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body)), Request: r}
}

// sseData packs payloads as the data frames of an SSE body.
func sseData(payloads ...string) string {
	var b strings.Builder
	for _, p := range payloads {
		b.WriteString("data: ")
		b.WriteString(p)
		b.WriteString("\n\n")
	}
	return b.String()
}

const (
	chatDelta  = `{"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Half an ans"}}]}`
	chatFinish = `{"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`
)

// failureClient is an openaibase client for model whose transport answers
// every request with respond, counting the requests.
func failureClient(t *testing.T, model string, requests *int, respond func(*http.Request) *http.Response) *Client {
	t.Helper()
	c, err := NewClient(Config{
		APIKey:  "test",
		Model:   model,
		BaseURL: "https://example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			*requests++
			return respond(r), nil
		})},
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

func streamFailure(c *Client) error {
	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	return err
}

// TestStreamFailuresClassify drives each way an OpenAI-compatible call fails
// through the real SDK, on both wires, and asserts the kind the worker will
// see. Each case also counts requests: the worker's retry loop owns every
// retry, so the SDK must make exactly one.
func TestStreamFailuresClassify(t *testing.T) {
	const chat, responses = "gpt-4o", "gpt-5-codex"
	tests := []struct {
		name    string
		model   string
		respond func(*http.Request) *http.Response
		want    provider.FailureKind
	}{
		{"500", chat, func(r *http.Request) *http.Response {
			return jsonStatus(r, 500, nil, `{"error":{"message":"The server had an error","type":"server_error","code":null}}`)
		}, provider.FailureServerError},
		{"503", chat, func(r *http.Request) *http.Response {
			return jsonStatus(r, 503, nil, `{"error":{"message":"Slow down","type":"server_error"}}`)
		}, provider.FailureOverloaded},
		{"400", chat, func(r *http.Request) *http.Response {
			return jsonStatus(r, 400, nil, `{"error":{"message":"bad","type":"invalid_request_error"}}`)
		}, provider.FailureInvalidRequest},
		{"429 out of quota", chat, func(r *http.Request) *http.Response {
			return jsonStatus(r, 429, nil, `{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}`)
		}, provider.FailureQuotaExhausted},
		{"connection drops mid-stream", chat, func(r *http.Request) *http.Response {
			return eventStream(r, &cutBody{prefix: strings.NewReader(sseData(chatDelta)), err: io.ErrUnexpectedEOF})
		}, provider.FailureConnectionDropped},
		{"chat stream ends with neither finish_reason nor [DONE]", chat, func(r *http.Request) *http.Response {
			return eventStream(r, io.NopCloser(strings.NewReader(sseData(chatDelta))))
		}, provider.FailureTruncated},
		{"chat error event mid-stream", chat, func(r *http.Request) *http.Response {
			return eventStream(r, io.NopCloser(strings.NewReader(sseData(chatDelta, `{"error":{"message":"overloaded","type":"server_error"}}`))))
		}, provider.FailureServerError},
		{"responses stream ends before response.completed", responses, func(r *http.Request) *http.Response {
			return eventStream(r, io.NopCloser(strings.NewReader(sseData(
				`{"type":"response.created","sequence_number":0,"response":{"id":"r1","object":"response","created_at":1,"status":"in_progress","model":"gpt-5-codex","output":[]}}`,
				`{"type":"response.output_text.delta","sequence_number":1,"item_id":"m1","output_index":0,"content_index":0,"delta":"Half an ans"}`,
			))))
		}, provider.FailureTruncated},
		{"responses in-band server error", responses, func(r *http.Request) *http.Response {
			return eventStream(r, io.NopCloser(strings.NewReader(sseData(
				`{"type":"error","sequence_number":0,"code":"server_error","message":"The server had an error","param":null}`,
			))))
		}, provider.FailureServerError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requests := 0
			err := streamFailure(failureClient(t, tt.model, &requests, tt.respond))
			if err == nil {
				t.Fatal("streamMessage succeeded")
			}
			if got := provider.ClassifyFailure(err).Kind; got != tt.want {
				t.Fatalf("classified %v, want %v: %v", got, tt.want, err)
			}
			if requests != 1 {
				t.Fatalf("the SDK made %d requests, want 1 — retrying is the worker's job", requests)
			}
		})
	}
}

// TestChatStreamWithOnlyOneEndMarkerIsComplete: a server that sends
// finish_reason but no [DONE], or [DONE] but no finish_reason, finished its
// answer. Only a stream missing both was cut off.
func TestChatStreamWithOnlyOneEndMarkerIsComplete(t *testing.T) {
	for name, body := range map[string]string{
		"finish_reason, no [DONE]": sseData(chatDelta, chatFinish),
		"[DONE], no finish_reason": sseData(chatDelta) + "data: [DONE]\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			requests := 0
			c := failureClient(t, "gpt-4o", &requests, func(r *http.Request) *http.Response {
				return eventStream(r, io.NopCloser(strings.NewReader(body)))
			})
			if err := streamFailure(c); err != nil {
				t.Fatalf("streamMessage: %v", err)
			}
		})
	}
}

// TestAPIErrorsCarryTheProviderMessage: the SDK's error text is a bare status
// line ("OpenAI API error: 429 Too Many Requests"), but the body's own message
// is what tells the reader what happened — for Z.ai's coding-plan cap it is
// the only place the reset time appears (no Retry-After is sent).
func TestAPIErrorsCarryTheProviderMessage(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"usage cap 429", 429,
			`{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-24 22:19:30"}}`,
			"Usage limit reached for 5 hour. Your limit will reset at 2026-10-24 22:19:30"},
		{"400", 400, `{"error":{"message":"messages[3]: tool_call_id not found","type":"invalid_request_error"}}`,
			"messages[3]: tool_call_id not found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requests := 0
			err := streamFailure(failureClient(t, "gpt-4o", &requests, func(r *http.Request) *http.Response {
				return jsonStatus(r, tt.status, nil, tt.body)
			}))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want it to carry the provider's message %q", err, tt.want)
			}
		})
	}
}

// TestRateLimitResponseCarriesTheStatedWait: a 429's Retry-After reaches the
// worker as a number, after a single request.
func TestRateLimitResponseCarriesTheStatedWait(t *testing.T) {
	requests := 0
	c := failureClient(t, "gpt-4o", &requests, func(r *http.Request) *http.Response {
		return jsonStatus(r, 429, http.Header{"Retry-After": {"7"}}, `{"error":{"message":"slow down","type":"rate_limit_error"}}`)
	})
	err := streamFailure(c)
	var limited *provider.RateLimitedError
	if !errors.As(err, &limited) || limited.RetryAfter != 7*time.Second {
		t.Fatalf("error = %v, want a RateLimitedError waiting 7s", err)
	}
	if requests != 1 {
		t.Fatalf("the SDK made %d requests, want 1", requests)
	}
}
