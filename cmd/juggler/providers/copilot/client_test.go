//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package copilot

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestRegisterProviderInfo(t *testing.T) {
	Register()
	info, ok := provider.GetProviderInfo("copilot")
	if !ok {
		t.Fatal("copilot provider not registered")
	}
	if info.EffectiveAuthType() != provider.AuthTypeOAuthBearer {
		t.Fatalf("auth type = %q, want %q", info.EffectiveAuthType(), provider.AuthTypeOAuthBearer)
	}
	if info.AuthSource != "github_copilot" {
		t.Fatalf("auth source = %q, want github_copilot", info.AuthSource)
	}
	if info.SignInMethod != "github_device" {
		t.Fatalf("sign-in method = %q, want github_device", info.SignInMethod)
	}
	if info.ConfigKeyName != "" {
		t.Fatalf("ConfigKeyName = %q, want empty for OAuth provider", info.ConfigKeyName)
	}
}

// serveCatalog stands up an httptest /models server returning body and points
// baseURL at it for the duration of the test.
func serveCatalog(t *testing.T, body string) {
	t.Helper()
	originalBaseURL := baseURL
	t.Cleanup(func() { baseURL = originalBaseURL })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			t.Fatalf("path = %q, want /models", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	baseURL = srv.URL
}

func modelIDs(models []provider.ModelInfo) map[string]provider.ModelInfo {
	byID := map[string]provider.ModelInfo{}
	for _, m := range models {
		byID[m.ID] = m
	}
	return byID
}

// TestListModelsParsesCopilotCatalog covers the happy path: a legacy model with
// no supported_endpoints (defaults to chat completions) and one that explicitly
// lists /chat/completions both survive; limits map through correctly.
func TestListModelsParsesCopilotCatalog(t *testing.T) {
	serveCatalog(t, `{
		"data": [
			{"id":"text-embedding-ada-002","capabilities":{"type":"embeddings","supports":{}}},
			{"id":"gpt-4.1","name":"GPT-4.1","policy":{"state":"enabled"},"capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_context_window_tokens":128000,"max_output_tokens":16384}}},
			{"id":"oswe-vscode-prime","name":"Raptor mini","policy":{"state":"enabled"},"supported_endpoints":["/chat/completions","/responses"],"capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_prompt_tokens":200000}}}
		]
	}`)

	models, err := listModels(context.Background(), "bearer", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := modelIDs(models)
	if _, ok := byID["text-embedding-ada-002"]; ok {
		t.Fatal("embeddings model should be filtered out")
	}
	gpt41, ok := byID["gpt-4.1"]
	if !ok || gpt41.ContextWindow != 128000 || gpt41.MaxOutputTokens != 16384 || !gpt41.FromAPI {
		t.Fatalf("unexpected gpt-4.1: %+v", gpt41)
	}
	raptor, ok := byID["oswe-vscode-prime"]
	if !ok || raptor.ContextWindow != 200000 || raptor.MaxOutputTokens != DefaultMaxOutputTokens {
		t.Fatalf("unexpected raptor: %+v (want ctx from max_prompt_tokens, default output)", raptor)
	}
	if len(models) != 2 {
		t.Fatalf("got %d models, want 2 (gpt-4.1, raptor)", len(models))
	}
}

// Responses-API-only models (GPT-5.x) advertise tool_calls but list only
// /responses — calling them over chat completions 400s, so they must be hidden.
func TestListModelsHidesResponsesOnlyModels(t *testing.T) {
	serveCatalog(t, `{
		"data": [
			{"id":"gpt-4.1","policy":{"state":"enabled"},"capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_context_window_tokens":128000}}},
			{"id":"gpt-5.6-luna","supported_endpoints":["/responses","ws:/responses"],"capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_context_window_tokens":328000}}}
		]
	}`)

	models, err := listModels(context.Background(), "bearer", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := modelIDs(models)
	if byID["gpt-5.6-luna"].ID != "" {
		t.Fatal("responses-only model must be hidden")
	}
	if _, ok := byID["gpt-4.1"]; !ok {
		t.Fatalf("chat-completions model must be listed: %+v", models)
	}
}

// Conservative policy: a policy-gated model (Claude/Gemini not yet enabled on
// this account) is STILL listed — it supports /chat/completions + tool_calls,
// works once enabled, and works on accounts that already have it. We don't hide
// it just because this account can't call it yet.
func TestListModelsKeepsPolicyGatedModels(t *testing.T) {
	serveCatalog(t, `{
		"data": [
			{"id":"gpt-4.1","policy":{"state":"enabled"},"capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_context_window_tokens":128000}}},
			{"id":"claude-sonnet-5","policy":{"state":"disabled"},"supported_endpoints":["/chat/completions","/v1/messages"],"capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_context_window_tokens":264000}}}
		]
	}`)

	models, err := listModels(context.Background(), "bearer", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if _, ok := modelIDs(models)["claude-sonnet-5"]; !ok {
		t.Fatal("policy-gated model must still be listed (conservative filtering)")
	}
}

// Conservative policy: a preview model is STILL listed — preview models can be
// exactly the ones that work on another account, so we don't hide them.
func TestListModelsKeepsPreviewModels(t *testing.T) {
	serveCatalog(t, `{
		"data": [
			{"id":"gpt-4.1","capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_context_window_tokens":128000}}},
			{"id":"some-new-preview","preview":true,"supported_endpoints":["/chat/completions"],"capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_context_window_tokens":260000}}}
		]
	}`)

	models, err := listModels(context.Background(), "bearer", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if _, ok := modelIDs(models)["some-new-preview"]; !ok {
		t.Fatal("preview model must still be listed (conservative filtering)")
	}
	if len(models) != 2 {
		t.Fatalf("want both models listed, got %+v", models)
	}
}

// Non-tool-call models are hidden (Juggler sends tools every turn).
func TestListModelsRequiresToolCalls(t *testing.T) {
	serveCatalog(t, `{
		"data": [
			{"id":"gpt-4.1","capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_context_window_tokens":128000}}},
			{"id":"gpt-3.5-legacy","capabilities":{"type":"chat","supports":{"tool_calls":false},"limits":{"max_context_window_tokens":16384}}}
		]
	}`)

	models, err := listModels(context.Background(), "bearer", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if len(models) != 1 || models[0].ID != "gpt-4.1" {
		t.Fatalf("tool_calls filter failed, want only gpt-4.1: %+v", models)
	}
}
