//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// thinkingShows are /api/show bodies covering each shape a daemon reports:
// per-model metadata with named levels (with and without an off switch),
// boolean-only metadata, an always-on model, the bare "thinking" capability an
// older daemon reports without metadata, and a model that cannot think.
var thinkingShows = map[string]map[string]any{
	"qwen:latest": {
		"capabilities": []string{"completion", "tools", "thinking"},
		"thinking":     map[string]any{"values": []any{false, "low", "medium", "high", "xhigh"}, "default": "xhigh"},
	},
	"gpt-oss:latest": {
		"capabilities": []string{"completion", "tools", "thinking"},
		"thinking":     map[string]any{"values": []any{"low", "medium", "high"}, "default": "medium"},
	},
	"switch:latest": {
		"capabilities": []string{"completion", "thinking"},
		"thinking":     map[string]any{"values": []any{true, false}, "default": true},
	},
	"always:latest": {
		"capabilities": []string{"completion", "thinking"},
		"thinking":     map[string]any{"values": []any{true}, "default": true},
	},
	"legacy:latest": {
		"capabilities": []string{"completion", "thinking"},
	},
	"plain:latest": {
		"capabilities": []string{"completion", "tools"},
		"parameters":   "num_ctx 8192",
	},
}

var wantThinking = map[string]struct {
	levels []string
	def    string
}{
	"qwen:latest":    {[]string{"none", "low", "medium", "high", "xhigh"}, "xhigh"},
	"gpt-oss:latest": {[]string{"low", "medium", "high"}, "medium"},
	"switch:latest":  {[]string{"none", "medium"}, "medium"},
	"always:latest":  {nil, ""},
	"legacy:latest":  {[]string{"none", "low", "medium", "high"}, ""},
	"plain:latest":   {nil, ""},
}

// fakeThinkingDaemon serves thinkingShows and counts /api/show requests.
func fakeThinkingDaemon(t *testing.T) *atomic.Int32 {
	t.Helper()
	var shows atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/tags":
			models := make([]map[string]string, 0, len(thinkingShows))
			for name := range thinkingShows {
				models = append(models, map[string]string{"name": name})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"models": models})
		case "/api/show":
			shows.Add(1)
			var req showRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			body, ok := thinkingShows[req.Model]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(body)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("OLLAMA_HOST", server.URL)
	t.Cleanup(forgetThinkingSpecs)
	return &shows
}

func TestListModelsAdvertisesThinkingLevels(t *testing.T) {
	isolateConfig(t)
	fakeThinkingDaemon(t)

	models, err := listModels(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if len(models) != len(wantThinking) {
		t.Fatalf("models = %+v, want %d", models, len(wantThinking))
	}
	for _, m := range models {
		want := wantThinking[m.ID]
		if !slices.Equal(m.ThinkingLevels, want.levels) || m.DefaultThinkingLevel != want.def {
			t.Errorf("%s thinking = %v default %q, want %v default %q",
				m.ID, m.ThinkingLevels, m.DefaultThinkingLevel, want.levels, want.def)
		}
	}
	if plain := modelByID(models, "plain:latest"); plain.ContextWindow != 8192 {
		t.Errorf("plain window = %d, want its Modelfile num_ctx 8192 from the same /api/show", plain.ContextWindow)
	}
}

// TestThinkingSpecDrivesTheRequest pins the request half: the spec a client is
// built with — which gates reasoning_effort on the wire — is the one listModels
// advertised, and a model the list has not covered yet is probed rather than
// silently left without control.
func TestThinkingSpecDrivesTheRequest(t *testing.T) {
	isolateConfig(t)
	shows := fakeThinkingDaemon(t)

	spec := thinkingSpec("qwen:latest")
	if want := wantThinking["qwen:latest"]; !slices.Equal(spec.Levels, want.levels) || spec.Default != want.def {
		t.Fatalf("uncached qwen spec = %+v, want %v default %q", spec, want.levels, want.def)
	}
	if got := shows.Load(); got != 1 {
		t.Fatalf("uncached lookup made %d /api/show requests, want 1", got)
	}
	_ = thinkingSpec("qwen:latest")
	if got := shows.Load(); got != 1 {
		t.Fatalf("second lookup made %d /api/show requests in total, want the cached 1", got)
	}

	if _, err := listModels(context.Background(), "", nil); err != nil {
		t.Fatalf("listModels: %v", err)
	}
	before := shows.Load()
	if spec := thinkingSpec("gpt-oss:latest"); !slices.Equal(spec.Levels, wantThinking["gpt-oss:latest"].levels) {
		t.Fatalf("listed gpt-oss spec = %+v", spec)
	}
	if got := shows.Load(); got != before {
		t.Fatalf("lookup after listModels probed again (%d → %d), want it served from the list", before, got)
	}
	if spec := thinkingSpec("plain:latest"); len(spec.Levels) != 0 {
		t.Fatalf("plain spec = %+v, want none: it cannot think and would 400 on reasoning_effort", spec)
	}
}

func modelByID(models []provider.ModelInfo, id string) provider.ModelInfo {
	for _, m := range models {
		if m.ID == id {
			return m
		}
	}
	return provider.ModelInfo{}
}

func forgetThinkingSpecs() {
	thinkingSpecs.Clear()
}
