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

// newTierCapturingClient returns a Responses-API client whose outgoing request
// body is captured, advertising the given tiers for its model.
func newTierCapturingClient(t *testing.T, body *[]byte, tiers ...provider.ServiceTier) *Client {
	t.Helper()

	sse := sseBody(`{"type":"response.output_text.delta","delta":"ok","item_id":"m1","output_index":0,"content_index":0,"sequence_number":1}`)
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Body != nil {
			raw, err := io.ReadAll(r.Body)
			if err != nil {
				return nil, err
			}
			*body = raw
		}
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(sse)),
			Request:    r,
		}, nil
	})}

	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-5-codex", // contains "codex" → Responses API path
		BaseURL:    "https://example.test",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c.serviceTierSpec = ServiceTierSpec{Tiers: tiers}
	return c
}

// newTierReplayClient answers with a response.completed carrying the given
// served tier, so the downgrade comparison can be exercised end to end.
func newTierReplayClient(t *testing.T, servedTier string, tiers ...provider.ServiceTier) *Client {
	t.Helper()

	completed := `{"type":"response.completed","response":{"id":"resp_1","service_tier":"` + servedTier +
		`","usage":{"input_tokens":10,"output_tokens":2}},"sequence_number":2}`
	if servedTier == "" {
		completed = `{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":2}},"sequence_number":2}`
	}
	sse := sseBody(
		`{"type":"response.output_text.delta","delta":"ok","item_id":"m1","output_index":0,"content_index":0,"sequence_number":1}`,
		completed,
	)
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(sse)),
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
	c.providerName = "openaicodex"
	c.serviceTierSpec = ServiceTierSpec{Tiers: tiers}
	return c
}

// TestServiceTierDowngradeIsReported is the whole point of the feature's
// read-side. The backend answers 200 with a different tier and no error, so a
// declined tier is indistinguishable from an honoured one unless the echo is
// checked. A user paying a premium rate for speed has to be told when they
// didn't get it.
func TestServiceTierDowngradeIsReported(t *testing.T) {
	fast := provider.ServiceTier{ID: "priority", Name: "Fast", Description: "1.5x speed, increased usage"}

	cases := []struct {
		name       string
		requested  string
		served     string
		wantNotice bool
	}{
		{name: "declined tier is reported", requested: "priority", served: "default", wantNotice: true},
		{name: "auto echo is still not what was asked for", requested: "priority", served: "auto", wantNotice: true},
		{name: "honoured tier is silent", requested: "priority", served: "priority"},
		{name: "no tier requested, nothing to report", requested: "", served: "default"},
		{name: "absent echo is not evidence of a downgrade", requested: "priority", served: ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newTierReplayClient(t, tc.served, fast)

			var summary, content, source string
			if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
				Messages:    []provider.Message{{Type: "user", Content: "hello"}},
				ServiceTier: tc.requested,
			}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
				if chunk.Type == provider.ContentBlockTypeStatus {
					summary, _ = chunk.Metadata["noticeSummary"].(string)
					content, _ = chunk.Metadata["noticeContent"].(string)
					source, _ = chunk.Metadata["noticeSource"].(string)
				}
				return nil, nil
			}); err != nil {
				t.Fatalf("streamMessage: %v", err)
			}

			if !tc.wantNotice {
				if summary != "" {
					t.Fatalf("reported a downgrade that did not happen: %q / %q", summary, content)
				}
				return
			}
			if summary == "" {
				t.Fatal("no notice emitted for a tier the backend declined")
			}
			// The raw ids must survive into the body: a lead that dropped them
			// would leave nothing to diagnose an unexpected value with.
			if !strings.Contains(content, "Requested: "+tc.requested) || !strings.Contains(content, "Served: "+tc.served) {
				t.Fatalf("notice dropped the underlying values: %q", content)
			}
			// The provider's own label for the tier, not the raw id, leads the
			// sentence — the user picked "Fast", not "priority" — and it says
			// outright that the choice was declined.
			if !strings.HasPrefix(content, "Fast was declined") {
				t.Fatalf("notice did not lead with the catalog label: %q", content)
			}
			// The row shows the summary and nothing else, so it has to explain
			// itself rather than title itself: the same lead, no ids.
			if !strings.HasPrefix(summary, "Fast was declined") {
				t.Fatalf("notice summary does not explain itself: %q", summary)
			}
			if source != "openaicodex" {
				t.Fatalf("notice source = %q, want the provider that reported it", source)
			}
		})
	}
}

// TestResponsesServiceTierOnlyWhenAdvertised pins the wire contract for the
// serving class: the id goes out verbatim when the model advertises it, and the
// field is absent otherwise. Absence matters as much as presence — an
// unadvertised tier risks a hard 400, and every standard-speed turn must stay
// byte-identical to one from before the feature existed.
func TestResponsesServiceTierOnlyWhenAdvertised(t *testing.T) {
	fast := provider.ServiceTier{ID: "priority", Name: "Fast", Description: "1.5x speed, increased usage"}

	cases := []struct {
		name      string
		advertise []provider.ServiceTier
		requested string
		want      string // "" ⇒ the key must be absent entirely
	}{
		{name: "advertised tier is sent", advertise: []provider.ServiceTier{fast}, requested: "priority", want: "priority"},
		{name: "standard sends no tier", advertise: []provider.ServiceTier{fast}, requested: ""},
		{name: "unadvertised tier is dropped", advertise: []provider.ServiceTier{fast}, requested: "flex"},
		{name: "model with no tiers sends none", advertise: nil, requested: "priority"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var raw []byte
			c := newTierCapturingClient(t, &raw, tc.advertise...)

			if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
				Messages:    []provider.Message{{Type: "user", Content: "hello"}},
				ServiceTier: tc.requested,
			}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
				t.Fatalf("streamMessage: %v", err)
			}

			var sent map[string]any
			if err := json.Unmarshal(raw, &sent); err != nil {
				t.Fatalf("request body was not JSON (%v): %s", err, raw)
			}

			got, present := sent["service_tier"]
			if tc.want == "" {
				if present {
					t.Fatalf("service_tier = %v, want the key absent from the request", got)
				}
				return
			}
			if !present {
				t.Fatalf("service_tier absent, want %q — body: %s", tc.want, raw)
			}
			if got != tc.want {
				t.Fatalf("service_tier = %v, want %q", got, tc.want)
			}
		})
	}
}
