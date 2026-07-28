//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/core"
	provider "juggler/cmd/juggler/providers/registry"
)

// isolateConfig points the credentials store at a throwaway dir and clears
// the override env vars so tests never see the developer's real daemon
// configuration.
func isolateConfig(t *testing.T) {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	t.Setenv("OLLAMA_NUM_CTX", "")
	t.Setenv("OLLAMA_CONTEXT_LENGTH", "")
}

func TestOllamaPublishesSilentTruncationGuard(t *testing.T) {
	Register()
	info, found := provider.GetProviderInfo("ollama")
	if !found {
		t.Fatal("Ollama provider was not registered")
	}
	if info.ContextAdmission != provider.ContextAdmissionSilentTruncationGuard {
		t.Fatalf("context admission = %q, want silent-truncation guard", info.ContextAdmission)
	}
}

func TestOllamaRoutesCompactionToPlainTextFinal(t *testing.T) {
	Register()
	info, found := provider.GetProviderInfo("ollama")
	if !found {
		t.Fatal("Ollama provider was not registered")
	}
	if !info.ForcedToolChoiceUnsupported {
		t.Fatal("Ollama should be marked ForcedToolChoiceUnsupported so bounded compaction uses the tool-free final call")
	}
}

func TestParseNumCtx(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"empty", "", 0},
		{"present among other parameters", "temperature 0.7\nnum_ctx 32768\nstop <|end|>", 32768},
		{"first line", "num_ctx 8192\ntemperature 0.7", 8192},
		{"extra whitespace", "  num_ctx   16384  ", 16384},
		{"missing", "temperature 0.7\nstop end", 0},
		{"non-numeric", "num_ctx lots", 0},
		{"zero", "num_ctx 0", 0},
		{"negative", "num_ctx -4096", 0},
		{"trailing junk on line", "num_ctx 8192 # comment", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseNumCtx(tc.in); got != tc.want {
				t.Errorf("parseNumCtx(%q) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

func TestServingContextWindowPrecedence(t *testing.T) {
	isolateConfig(t)

	if got := servingContextWindow(0, userNumCtxOverride()); got != defaultServingContextWindow {
		t.Fatalf("no modelfile, no override = %d, want conservative %d", got, defaultServingContextWindow)
	}

	t.Setenv("OLLAMA_NUM_CTX", "32768")
	if got := servingContextWindow(0, userNumCtxOverride()); got != 32768 {
		t.Fatalf("env override = %d, want 32768", got)
	}
	// A per-model Modelfile parameter is the deliberate per-model
	// configuration; it beats the global user declaration.
	if got := servingContextWindow(8192, userNumCtxOverride()); got != 8192 {
		t.Fatalf("modelfile over override = %d, want 8192", got)
	}
}

// TestUserNumCtxOverridePrecedence pins N1: OLLAMA_NUM_CTX wins over
// OLLAMA_CONTEXT_LENGTH, and OLLAMA_CONTEXT_LENGTH is honored when NUM_CTX is
// unset (the credentials store still beats both — covered separately).
func TestUserNumCtxOverridePrecedence(t *testing.T) {
	isolateConfig(t)

	if got := userNumCtxOverride(); got != 0 {
		t.Fatalf("no env = %d, want 0", got)
	}

	t.Setenv("OLLAMA_CONTEXT_LENGTH", "24576")
	if got := userNumCtxOverride(); got != 24576 {
		t.Fatalf("OLLAMA_CONTEXT_LENGTH only = %d, want 24576", got)
	}

	t.Setenv("OLLAMA_NUM_CTX", "32768")
	if got := userNumCtxOverride(); got != 32768 {
		t.Fatalf("OLLAMA_NUM_CTX = %d, want it to win over OLLAMA_CONTEXT_LENGTH", got)
	}
}

func TestUserNumCtxOverrideFromStore(t *testing.T) {
	isolateConfig(t)

	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatalf("credentials store: %v", err)
	}
	if err := store.SetRawKey(NumCtxCredKey, "16384"); err != nil {
		t.Fatalf("set raw key: %v", err)
	}
	if got := userNumCtxOverride(); got != 16384 {
		t.Fatalf("store override = %d, want 16384", got)
	}

	if err := store.SetRawKey(NumCtxCredKey, "not-a-number"); err != nil {
		t.Fatalf("set raw key: %v", err)
	}
	if got := userNumCtxOverride(); got != 0 {
		t.Fatalf("garbage override = %d, want 0 (undeclared)", got)
	}
}

func TestGetContextWindowInfoIsConservativeAndCoherent(t *testing.T) {
	isolateConfig(t)

	window, maxOutput := getContextWindowInfo("llama3.2:latest")
	if window != defaultServingContextWindow {
		t.Fatalf("static window = %d, want conservative %d", window, defaultServingContextWindow)
	}
	// The wire value and the admission reserve are the same number, and the
	// reserve always leaves room for input: output must be strictly smaller
	// than the window or admission rejects with InvalidOutputReserveError.
	if maxOutput <= 0 || maxOutput >= window {
		t.Fatalf("static maxOutput = %d, want 0 < %d < window %d", maxOutput, maxOutput, window)
	}
	if got := int64(maxOutput); got != min(int64(DefaultMaxOutputTokens), provider.ContextSafetyReserve(int64(window))) {
		t.Fatalf("static maxOutput = %d, want min(generation cap, safety reserve)", got)
	}
}

func TestListModelsProbesRealServingWindows(t *testing.T) {
	isolateConfig(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/tags":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"models": []map[string]string{
					{"name": "alpha:latest"},
					{"name": "beta:latest"},
					{"name": "gamma:latest"},
				},
			})
		case "/api/show":
			var req struct {
				Model string `json:"model"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			switch req.Model {
			case "alpha:latest":
				_ = json.NewEncoder(w).Encode(map[string]any{"parameters": "num_ctx 32768\nstop end"})
			case "beta:latest":
				_ = json.NewEncoder(w).Encode(map[string]any{"parameters": "temperature 0.7"})
			default:
				// Unprobeable model degrades to the conservative window.
				http.Error(w, fmt.Sprintf("model %q not found", req.Model), http.StatusNotFound)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("OLLAMA_HOST", server.URL)

	models, err := listModels(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if len(models) != 3 {
		t.Fatalf("models = %+v, want 3", models)
	}

	byID := make(map[string]provider.ModelInfo, len(models))
	for _, m := range models {
		if !m.FromAPI {
			t.Errorf("model %q not marked FromAPI", m.ID)
		}
		byID[m.ID] = m
	}

	alpha := byID["alpha:latest"]
	if alpha.ContextWindow != 32768 || alpha.MaxOutputTokens != DefaultMaxOutputTokens {
		t.Errorf("alpha = window %d / output %d, want probed 32768 / capped %d",
			alpha.ContextWindow, alpha.MaxOutputTokens, DefaultMaxOutputTokens)
	}
	for _, id := range []string{"beta:latest", "gamma:latest"} {
		m := byID[id]
		if m.ContextWindow != defaultServingContextWindow {
			t.Errorf("%s window = %d, want conservative %d", id, m.ContextWindow, defaultServingContextWindow)
		}
		if m.MaxOutputTokens <= 0 || m.MaxOutputTokens >= m.ContextWindow {
			t.Errorf("%s output = %d, want 0 < output < window %d", id, m.MaxOutputTokens, m.ContextWindow)
		}
	}
}

func TestListModelsPropagatesTagsFailure(t *testing.T) {
	isolateConfig(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "daemon unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	t.Setenv("OLLAMA_HOST", server.URL)

	if _, err := listModels(context.Background(), "", nil); err == nil {
		t.Fatal("listModels succeeded against a failing daemon, want error")
	}
}
