//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/modelsdev"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// TestCustomProviderDiscoversEndpointLimits covers the case a compiled-in
// catalog can never help with: an endpoint nobody but this user has configured.
//
// A custom endpoint is whatever the user pointed it at — vLLM, llama.cpp, LM
// Studio, LiteLLM, a company gateway — and there is no vendor documentation to
// consult about it. But most of those servers state their own limits on the
// model list, and that number is authoritative in a way no table could be: it
// is the machine that will serve the request. The flat default is what remains
// for a server that says nothing, and it is a guess, which is why FromAPI has
// to distinguish the two.
func TestCustomProviderDiscoversEndpointLimits(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[
			{"id":"served-by-vllm","object":"model","owned_by":"vllm","max_model_len":131072},
			{"id":"silent-gateway-model","object":"model","owned_by":"someone"}
		]}`))
	}))
	defer srv.Close()

	if _, err := execute(t, "save", endpointParams("lab", "Lab box", srv.URL)); err != nil {
		t.Fatalf("save lab: %v", err)
	}

	built, err := provider.InitializeProvider(RegisteredName("lab"), provider.Config{Model: "served-by-vllm"})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	infos, err := built.ListModelsWithInfo(ctx)
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}

	byID := map[string]provider.ModelInfo{}
	for _, info := range infos {
		byID[info.ID] = info
	}

	served, ok := byID["served-by-vllm"]
	if !ok {
		t.Fatal("served-by-vllm missing from the listing")
	}
	if served.ContextWindow != 131072 {
		t.Errorf("served-by-vllm ContextWindow = %d, want the endpoint's own 131072 rather than the %d assumption",
			served.ContextWindow, defaultContextWindow)
	}
	if !served.FromAPI {
		t.Error("served-by-vllm FromAPI = false, but its window was read off the endpoint")
	}

	silent, ok := byID["silent-gateway-model"]
	if !ok {
		t.Fatal("silent-gateway-model missing from the listing")
	}
	// The test server is on loopback, so the assumption is the local one.
	if silent.ContextWindow != localDefaultContextWindow {
		t.Errorf("silent-gateway-model ContextWindow = %d, want the local %d assumption", silent.ContextWindow, localDefaultContextWindow)
	}
	if silent.FromAPI {
		t.Error("silent-gateway-model FromAPI = true, but nothing was reported about it — the number is an assumption")
	}
	if !silent.WindowAssumed {
		t.Error("silent-gateway-model WindowAssumed = false, but its window is the provider-wide default")
	}
	if served.WindowAssumed {
		t.Error("served-by-vllm WindowAssumed = true, but the endpoint reported its window")
	}
}

// useCatalog swaps the models.dev catalogue endpoints are sized from for the
// length of a test.
func useCatalog(t *testing.T, snap modelsdev.Snapshot) {
	t.Helper()
	prev := catalog
	cat := modelsdev.New(snap)
	catalog = func() *modelsdev.Catalog { return cat }
	t.Cleanup(func() { catalog = prev })
}

// TestCustomProviderSizesCatalogedModels: an endpoint that is a provider
// models.dev catalogues — the user pasted Baseten's or Chutes' base URL — gets
// that catalogue's figures for the bare ids it lists, and they are statements
// about the model, not assumptions. What the endpoint says about itself still
// wins, and a model the catalogue does not list stays on the flagged default.
func TestCustomProviderSizesCatalogedModels(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[
			{"id":"org/Catalogued-Bare","object":"model"},
			{"id":"catalogued-self-sized","object":"model","max_model_len":65536},
			{"id":"uncatalogued","object":"model"}
		]}`))
	}))
	defer srv.Close()

	useCatalog(t, modelsdev.Snapshot{Providers: map[string]modelsdev.Provider{
		"fixture": {Name: "Fixture", API: srv.URL + "/v1", Models: map[string]modelsdev.Model{
			"org/Catalogued-Bare":   {Context: 200000, Output: 32000},
			"catalogued-self-sized": {Context: 1000000, Output: 64000},
		}},
	}})

	if _, err := execute(t, "save", endpointParams("hosted", "Hosted", srv.URL+"/v1/")); err != nil {
		t.Fatalf("save: %v", err)
	}
	name := RegisteredName("hosted")
	built, err := provider.InitializeProvider(name, provider.Config{Model: "org/Catalogued-Bare"})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	infos, err := built.ListModelsWithInfo(ctx)
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	byID := map[string]provider.ModelInfo{}
	for _, info := range infos {
		byID[info.ID] = info
	}

	bare := byID["org/Catalogued-Bare"]
	if bare.ContextWindow != 200000 || bare.MaxOutputTokens != 32000 {
		t.Errorf("catalogued bare id = %d/%d, want the catalogue's 200000/32000", bare.ContextWindow, bare.MaxOutputTokens)
	}
	if bare.WindowAssumed || bare.FromAPI {
		t.Errorf("catalogued bare id WindowAssumed=%v FromAPI=%v, want false/false: a catalogued figure, not a guess and not the endpoint's", bare.WindowAssumed, bare.FromAPI)
	}

	self := byID["catalogued-self-sized"]
	if self.ContextWindow != 65536 || !self.FromAPI {
		t.Errorf("self-sized model = %d (FromAPI %v), want the endpoint's own 65536 over the catalogue's 1000000", self.ContextWindow, self.FromAPI)
	}

	unknown := byID["uncatalogued"]
	if unknown.ContextWindow != localDefaultContextWindow || !unknown.WindowAssumed {
		t.Errorf("uncatalogued model = %d (assumed %v), want the flagged %d default", unknown.ContextWindow, unknown.WindowAssumed, localDefaultContextWindow)
	}

	// Admission before any listing has landed vouches for a catalogued model,
	// and still fails closed for one nothing knows.
	info, ok := provider.GetProviderInfo(name)
	if !ok || info.ResolveModelCapabilities == nil {
		t.Fatalf("%s has no static resolver", name)
	}
	if caps, found := info.ResolveModelCapabilities("org/Catalogued-Bare"); !found || caps.ContextWindowTokens != 200000 {
		t.Errorf("static resolve of the catalogued model = %+v, %v; want a 200000 window", caps, found)
	}
	if _, found := info.ResolveModelCapabilities("uncatalogued"); found {
		t.Error("static resolve vouched for a model nothing catalogues")
	}
}

// TestLocalCustomProviderAssumesSmallWindow: an endpoint on the user's own
// machine or network is a local server — LM Studio, llama-server, anything
// hosting a model it loaded itself — and its window is whatever it was loaded
// with, usually far below 128k. Assuming 128k there is the harmful direction:
// LM Studio drops the middle of an over-long conversation without a word. A
// hosted gateway serves full-size models, so 128k stays its guess.
func TestLocalCustomProviderAssumesSmallWindow(t *testing.T) {
	for url, want := range map[string]int{
		"http://127.0.0.1:1234/v1":       localDefaultContextWindow,
		"http://localhost:8000/v1":       localDefaultContextWindow,
		"http://[::1]:1234/v1":           localDefaultContextWindow,
		"http://192.168.1.20:1234/v1":    localDefaultContextWindow,
		"http://10.0.0.5/v1":             localDefaultContextWindow,
		"https://gateway.example.com/v1": defaultContextWindow,
		"https://8.8.8.8/v1":             defaultContextWindow,
		"not a url":                      defaultContextWindow,
	} {
		if got := defaultContextWindowFor(url); got != want {
			t.Errorf("defaultContextWindowFor(%q) = %d, want %d", url, got, want)
		}
	}
}

// A LocalAI reached as a custom endpoint, which is how a user finds it before
// there is a provider named after it. Its /v1/models rows are bare ids, so the
// flat 128000 default used to stand for every model on the box — four times
// what a default LocalAI will serve, and sixteen times what a model configured
// down to 2048 will. The capabilities route is the one place the real number is
// published, and reading it is what turns the guess into the server's own
// answer.
func TestCustomProviderReadsLocalAICapabilities(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(`{"object":"list","data":[
				{"id":"top-level-big","object":"model"},
				{"id":"top-level-small","object":"model"}
			]}`))
		case "/v1/models/capabilities":
			_, _ = w.Write([]byte(`{"object":"list","data":[
				{"id":"top-level-big","object":"model","capabilities":["chat"],"context_size":32768},
				{"id":"top-level-small","object":"model","capabilities":["chat"],"context_size":2048}
			]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	if _, err := execute(t, "save", endpointParams("localai", "LocalAI box", srv.URL+"/v1")); err != nil {
		t.Fatalf("save localai: %v", err)
	}

	built, err := provider.InitializeProvider(RegisteredName("localai"), provider.Config{Model: "top-level-big"})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	infos, err := built.ListModelsWithInfo(ctx)
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}

	want := map[string]int{"top-level-big": 32768, "top-level-small": 2048}
	for _, info := range infos {
		if want[info.ID] != info.ContextWindow {
			t.Errorf("%s ContextWindow = %d, want the server's own %d rather than the %d assumption",
				info.ID, info.ContextWindow, want[info.ID], defaultContextWindow)
		}
		if !info.FromAPI {
			t.Errorf("%s FromAPI = false, but its window came off the endpoint", info.ID)
		}
	}
}
