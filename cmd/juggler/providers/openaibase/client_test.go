//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestBearerTokenClientUsesAuthorizationHeader(t *testing.T) {
	var authHeader string
	var accountHeader string
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		authHeader = r.Header.Get("Authorization")
		accountHeader = r.Header.Get("ChatGPT-Account-Id")
		var body bytes.Buffer
		_ = json.NewEncoder(&body).Encode(map[string]any{
			"object": "list",
			"data": []map[string]any{
				{"id": "gpt-5.2-codex", "object": "model", "created": 0, "owned_by": "openai"},
			},
		})
		header := make(http.Header)
		header.Set("Content-Type", "application/json")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(&body),
		}, nil
	})}

	client, err := NewClient(Config{
		BearerToken: "oauth-token",
		Headers:     map[string]string{"ChatGPT-Account-Id": "acct_123"},
		Model:       "gpt-5.2-codex",
		BaseURL:     "https://example.test",
		HTTPClient:  httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = client.ListModelsWithInfo(context.Background(), func(string) bool { return true }, func(string) (int, int) {
		return 128000, 16384
	}, nil, nil, "test")
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	if authHeader != "Bearer oauth-token" {
		t.Fatalf("Authorization header = %q, want bearer token", authHeader)
	}
	if accountHeader != "acct_123" {
		t.Fatalf("ChatGPT-Account-Id header = %q, want acct_123", accountHeader)
	}
}

// TestChatCompletionsSendsCustomHeaders proves that Config.Headers (e.g. the
// GitHub Copilot Editor-Version / X-Initiator headers) actually reach the
// POST /chat/completions request — not just /models. A missing header here is
// what makes Copilot reject every model with 400 model_not_supported.
func TestChatCompletionsSendsCustomHeaders(t *testing.T) {
	var gotEditor, gotInitiator, gotIntegration, gotModel string
	sse := "data: {\"id\":\"x\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		gotEditor = r.Header.Get("Editor-Version")
		gotInitiator = r.Header.Get("X-Initiator")
		gotIntegration = r.Header.Get("Copilot-Integration-Id")
		var reqBody struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&reqBody)
		gotModel = reqBody.Model
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{StatusCode: http.StatusOK, Header: header, Body: io.NopCloser(strings.NewReader(sse))}, nil
	})}

	client, err := NewClient(Config{
		BearerToken: "bearer",
		Headers: map[string]string{
			"Editor-Version":         "vscode/1.99.3",
			"X-Initiator":            "user",
			"Copilot-Integration-Id": "vscode-chat",
		},
		Model:      "gpt-4o",
		BaseURL:    "https://example.test",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = client.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if gotModel != "gpt-4o" {
		t.Fatalf("model on the wire = %q, want gpt-4o", gotModel)
	}
	if gotEditor != "vscode/1.99.3" {
		t.Fatalf("Editor-Version = %q, want it forwarded to /chat/completions", gotEditor)
	}
	if gotInitiator != "user" {
		t.Fatalf("X-Initiator = %q, want it forwarded to /chat/completions", gotInitiator)
	}
	if gotIntegration != "vscode-chat" {
		t.Fatalf("Copilot-Integration-Id = %q, want it forwarded", gotIntegration)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestNewClientFromProviderConfigRequiresCredential(t *testing.T) {
	_, err := NewClientFromProviderConfig(provider.Config{Model: "gpt-4o"}, "", Quirks{})
	if err == nil {
		t.Fatal("expected missing credential error")
	}
	if !strings.Contains(err.Error(), "API key or bearer token") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestModelsUseResponsesAPI(t *testing.T) {
	for _, model := range []string{"gpt-5.2-codex", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"} {
		if !IsResponsesAPIModel(model) {
			t.Fatalf("%s should use Responses API", model)
		}
	}
	if IsResponsesAPIModel("gpt-4o") {
		t.Fatal("non-codex model should not require Responses API")
	}
}

// TestCustomHeaderOverridesUserAgent verifies that a User-Agent supplied via
// Config.Headers replaces the openai-go SDK's default User-Agent on the wire.
// This is what lets the OpenAI-compatible provider satisfy gateways that
// require a specific User-Agent: the SDK sets its default first, then applies
// caller headers via WithHeader (a Set/overwrite), so ours wins.
func TestCustomHeaderOverridesUserAgent(t *testing.T) {
	var userAgent string
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		userAgent = r.Header.Get("User-Agent")
		var body bytes.Buffer
		_ = json.NewEncoder(&body).Encode(map[string]any{"object": "list", "data": []map[string]any{}})
		header := make(http.Header)
		header.Set("Content-Type", "application/json")
		return &http.Response{StatusCode: http.StatusOK, Header: header, Body: io.NopCloser(&body)}, nil
	})}

	client, err := NewClient(Config{
		APIKey:     "test-key",
		Headers:    map[string]string{"User-Agent": "my-gateway-client/1.0"},
		Model:      "gpt-4o",
		BaseURL:    "https://example.test",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if _, err := client.ListModelsWithInfo(context.Background(), func(string) bool { return true }, func(string) (int, int) {
		return 128000, 16384
	}, nil, nil, "test"); err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	if userAgent != "my-gateway-client/1.0" {
		t.Fatalf("User-Agent = %q, want custom value overriding the SDK default", userAgent)
	}
}

func TestForceResponsesAPIQuirk(t *testing.T) {
	// A Chat-Completions model name normally routes to Chat Completions...
	plain := &Client{model: "gpt-5.5"}
	if plain.usesResponsesAPI() {
		t.Fatal("non-codex model without the quirk should route to Chat Completions")
	}
	// ...but the ForceResponsesAPI quirk overrides that routing.
	forced := &Client{model: "gpt-5.5", quirks: Quirks{ForceResponsesAPI: true}}
	if !forced.usesResponsesAPI() {
		t.Fatal("forced Responses API quirk should route non-codex model names to Responses")
	}
}
