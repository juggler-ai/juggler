//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"context"
	"reflect"
	"testing"

	"juggler/cmd/juggler/providers/modelsdev"
)

// execute runs one operation the way the ops route does, with params carrying
// the untyped shapes a JSON body decodes to.
func execute(t *testing.T, operation string, params map[string]any) (map[string]any, error) {
	t.Helper()
	result, err := (&operations{}).Execute(context.Background(), operation, params)
	if err != nil {
		return nil, err
	}
	out, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("%s returned %T, want a map", operation, result)
	}
	return out, nil
}

// TestOpsCatalogListsKnownProviders: the add form offers the providers the
// models.dev catalogue knows, by name, with the base URL each one fills in.
func TestOpsCatalogListsKnownProviders(t *testing.T) {
	useCatalog(t, modelsdev.Snapshot{Providers: map[string]modelsdev.Provider{
		"chutes":  {Name: "Chutes", API: "https://llm.chutes.ai/v1", Models: map[string]modelsdev.Model{"m": {Context: 1}}},
		"baseten": {Name: "Baseten", API: "https://inference.baseten.co/v1", Doc: "https://docs.baseten.co"},
	}})
	out, err := execute(t, "catalog", nil)
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	want := []modelsdev.ProviderEntry{
		{ID: "baseten", Name: "Baseten", API: "https://inference.baseten.co/v1", Doc: "https://docs.baseten.co"},
		{ID: "chutes", Name: "Chutes", API: "https://llm.chutes.ai/v1"},
	}
	if got, ok := out["providers"].([]modelsdev.ProviderEntry); !ok || !reflect.DeepEqual(got, want) {
		t.Errorf("catalog providers = %#v, want %#v", out["providers"], want)
	}
}
