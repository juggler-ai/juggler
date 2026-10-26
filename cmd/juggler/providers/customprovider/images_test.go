//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/modelsdev"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// TestCustomProviderWithholdsImagesOnlyFromCataloguedTextModels: an image sent
// to a model that cannot take one is a 400 that stays in the history and fails
// every later turn too, so a model the catalogue knows to be text-only is sent
// the "not sent" note instead. A model the catalogue does not know is sent
// what it always was — the endpoint may well serve a vision model nobody
// catalogued, and withholding on a guess would break it.
func TestCustomProviderWithholdsImagesOnlyFromCataloguedTextModels(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	bodies := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodies <- string(raw)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`+"\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()

	useCatalog(t, modelsdev.Snapshot{Providers: map[string]modelsdev.Provider{
		"fixture": {Name: "Fixture", API: srv.URL + "/v1", Models: map[string]modelsdev.Model{
			"text-model":   {Context: 128000},
			"vision-model": {Context: 128000, Input: []string{"image", "text"}},
		}},
	}})
	if _, err := execute(t, "save", endpointParams("hosted", "Hosted", srv.URL+"/v1")); err != nil {
		t.Fatalf("save: %v", err)
	}

	data := []byte{1, 2, 3, 4, 5}
	uri := "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	send := func(model string) string {
		t.Helper()
		p, err := provider.InitializeProvider(RegisteredName("hosted"), provider.Config{
			Model:             model,
			ModelCapabilities: provider.ModelCapabilities{ContextWindowTokens: 128000, MaxOutputTokens: 4096},
		})
		if err != nil {
			t.Fatalf("InitializeProvider(%s): %v", model, err)
		}
		conv, err := provider.OpenConversation(context.Background(), p, "conv")
		if err != nil {
			t.Fatalf("OpenConversation(%s): %v", model, err)
		}
		defer func() { _ = conv.Close() }()
		_, err = conv.Submit(context.Background(), provider.MessageRequest{
			Messages: []provider.Message{{Type: "user", Content: "what is this?", Parts: []provider.MediaPart{
				{Type: "image", Mime: "image/png", Data: data},
			}}},
		}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
		if err != nil {
			t.Fatalf("Submit(%s): %v", model, err)
		}
		return <-bodies
	}

	if body := send("text-model"); strings.Contains(body, uri) || !strings.Contains(body, "not sent") {
		t.Errorf("catalogued text-only model: want the image withheld with a note, got %s", body)
	}
	if body := send("vision-model"); !strings.Contains(body, uri) {
		t.Errorf("catalogued vision model lost its image: %s", body)
	}
	if body := send("uncatalogued"); !strings.Contains(body, uri) {
		t.Errorf("uncatalogued model lost its image — nothing knows it cannot take one: %s", body)
	}
}

// TestCustomProviderPublishesCataloguedModalities: the listing labels a
// catalogued vision model as one, and leaves every other model unlabelled.
func TestCustomProviderPublishesCataloguedModalities(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"vision-model"},{"id":"text-model"},{"id":"uncatalogued"}]}`))
	}))
	defer srv.Close()
	useCatalog(t, modelsdev.Snapshot{Providers: map[string]modelsdev.Provider{
		"fixture": {API: srv.URL + "/v1", Models: map[string]modelsdev.Model{
			"text-model":   {Context: 128000},
			"vision-model": {Context: 128000, Input: []string{"image", "text"}},
		}},
	}})
	if _, err := execute(t, "save", endpointParams("hosted", "Hosted", srv.URL+"/v1")); err != nil {
		t.Fatalf("save: %v", err)
	}
	p, err := provider.InitializeProvider(RegisteredName("hosted"), provider.Config{Model: "vision-model"})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	infos, err := p.ListModelsWithInfo(context.Background())
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	got := map[string]string{}
	for _, info := range infos {
		got[info.ID] = strings.Join(info.InputModalities, ",")
	}
	want := map[string]string{"vision-model": "image,text", "text-model": "", "uncatalogued": ""}
	for id, w := range want {
		if got[id] != w {
			t.Errorf("%s InputModalities = %q, want %q", id, got[id], w)
		}
	}
}
