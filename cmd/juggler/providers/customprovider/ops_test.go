//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"context"
	"reflect"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/modelsdev"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
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

// endpointParams builds one endpoint in the vocabulary the settings card posts.
func endpointParams(id, displayName, url string) map[string]any {
	return map[string]any{"id": id, "displayName": displayName, "url": url}
}

// endpointsByID indexes an operation's reply, which every mutation answers with
// so the card can redraw from one round trip.
func endpointsByID(t *testing.T, result map[string]any) map[string]Endpoint {
	t.Helper()
	rows, ok := result["endpoints"].([]Endpoint)
	if !ok {
		t.Fatalf("endpoints came back as %T, want []Endpoint", result["endpoints"])
	}
	out := make(map[string]Endpoint, len(rows))
	for _, row := range rows {
		out[row.ID] = row
	}
	return out
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

func TestOpsSaveAddsOneEndpointAndLeavesTheRest(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	if _, err := execute(t, "save", endpointParams("acme", "Acme Gateway", "https://gateway.acme.test/v1")); err != nil {
		t.Fatalf("save acme: %v", err)
	}
	added, err := execute(t, "save", endpointParams("lab", "Lab box", "http://127.0.0.1:8080/v1"))
	if err != nil {
		t.Fatalf("save lab: %v", err)
	}

	rows := endpointsByID(t, added)
	if len(rows) != 2 {
		t.Fatalf("list = %v, want both endpoints — saving one may not disturb another", rows)
	}
	if !rows["acme"].Registered || rows["acme"].Error != "" {
		t.Fatalf("acme = %+v, want a registered endpoint", rows["acme"])
	}
	if rows["acme"].ProviderID != "custom-acme" {
		t.Fatalf("acme providerId = %q, want the id the picker and the model stores use", rows["acme"].ProviderID)
	}
	if !rows["acme"].Enabled {
		t.Fatal("a new endpoint must come back enabled")
	}
	if rows["acme"].EnvVarName != "CUSTOM_ACME_API_KEY" {
		t.Fatalf("acme envVarName = %q — the card names the variable a key can come from instead", rows["acme"].EnvVarName)
	}
	if _, registered := provider.GetProviderInfo("custom-acme"); !registered {
		t.Fatal("a saved endpoint did not reach the registry, so it never reaches the picker")
	}
}

func TestOpsSaveEditsInPlaceAndKeepsWhatWasNotSent(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	if _, err := execute(t, "save", map[string]any{
		"id":          "acme",
		"displayName": "Acme Gateway",
		"url":         "https://gateway.acme.test/v1",
		"headers":     map[string]any{"X-Tenant": "eu"},
	}); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := execute(t, "save", endpointParams("lab", "Lab box", "http://127.0.0.1:8080/v1")); err != nil {
		t.Fatalf("save lab: %v", err)
	}

	// The card saves one field at a time, so a save that carries no headers and
	// no enabled flag is an edit of the fields it did carry — not an instruction
	// to drop the rest.
	if _, err := execute(t, "save", endpointParams("acme", "Acme EU", "https://eu.acme.test/v1")); err != nil {
		t.Fatalf("save edit: %v", err)
	}
	instances, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if instances["acme"].BaseURL != "https://eu.acme.test/v1" || instances["acme"].DisplayName != "Acme EU" {
		t.Fatalf("edited entry = %+v", instances["acme"])
	}
	if instances["acme"].Headers["X-Tenant"] != "eu" {
		t.Fatalf("editing the URL dropped the headers: %+v", instances["acme"])
	}
	if instances["lab"].BaseURL != "http://127.0.0.1:8080/v1" {
		t.Fatalf("editing one endpoint changed another: %+v", instances["lab"])
	}

	// Switching one off unregisters it, and it must still be listed — the card is
	// the only way back on.
	off, err := execute(t, "save", map[string]any{"id": "acme", "enabled": false})
	if err != nil {
		t.Fatalf("save disable: %v", err)
	}
	rows := endpointsByID(t, off)
	if rows["acme"].Enabled || rows["acme"].Registered {
		t.Fatalf("acme = %+v, want switched off and unregistered", rows["acme"])
	}
	if rows["acme"].URL != "https://eu.acme.test/v1" {
		t.Fatal("a switched-off endpoint lost its URL, so the card has nothing to switch back on")
	}
	if _, registered := provider.GetProviderInfo("custom-acme"); registered {
		t.Fatal("a switched-off endpoint is still registered")
	}
}

func TestOpsSaveRejectsAnIDOrURLTheCardWouldNeverSend(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	if _, err := execute(t, "save", endpointParams("keep", "Keeper", "https://keeper.test/v1")); err != nil {
		t.Fatalf("save: %v", err)
	}

	// The id is not usable as a provider id, a DOM element id or a CSS selector,
	// so a request that did not come from the card is refused server-side too.
	if _, err := execute(t, "save", endpointParams("Bad_ID:1", "Bad", "https://bad.test/v1")); err == nil {
		t.Fatal("save accepted an id that cannot be used as a provider id")
	}
	if _, err := execute(t, "save", endpointParams("keep", "Keeper", "not a url")); err == nil {
		t.Fatal("save accepted an endpoint with no usable base URL")
	}
	// A rejected write changes nothing.
	instances, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(instances) != 1 || instances["keep"].BaseURL != "https://keeper.test/v1" {
		t.Fatalf("instances = %v, want only the endpoint that was already there, untouched", instances)
	}
}

func TestOpsRemoveForgetsTheEndpointAndOnlyItsPreferences(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	if _, err := execute(t, "save", endpointParams("acme", "Acme Gateway", "https://gateway.acme.test/v1")); err != nil {
		t.Fatalf("save acme: %v", err)
	}
	if _, err := execute(t, "save", endpointParams("lab", "Lab box", "http://127.0.0.1:8080/v1")); err != nil {
		t.Fatalf("save lab: %v", err)
	}
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Hidden = map[string][]string{"custom-acme": {"m1"}, "custom-lab": {"m2"}}
		return true
	}); err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}

	remaining, err := execute(t, "remove", map[string]any{"id": "acme"})
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	rows := endpointsByID(t, remaining)
	if _, still := rows["acme"]; still {
		t.Fatal("a removed endpoint is still listed")
	}
	if _, kept := rows["lab"]; !kept {
		t.Fatal("removing one endpoint dropped another")
	}
	if _, registered := provider.GetProviderInfo("custom-acme"); registered {
		t.Fatal("a removed endpoint is still registered")
	}
	settings, err := core.LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if _, stale := settings.Models.Hidden["custom-acme"]; stale {
		t.Fatal("removing an endpoint left its hidden models behind, for the next endpoint given that id to inherit")
	}
	if len(settings.Models.Hidden["custom-lab"]) != 1 {
		t.Fatal("removing one endpoint dropped another's hidden models")
	}

	if _, err := execute(t, "remove", map[string]any{"id": "never-existed"}); err == nil {
		t.Fatal("remove accepted an endpoint that does not exist")
	}
}

func TestOpsSetKeyStoresAndClearsOneEndpointsKey(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	if _, err := execute(t, "save", endpointParams("acme", "Acme Gateway", "https://gateway.acme.test/v1")); err != nil {
		t.Fatalf("save: %v", err)
	}

	saved, err := execute(t, "setKey", map[string]any{"id": "acme", "apiKey": "sk-acme"})
	if err != nil {
		t.Fatalf("setKey: %v", err)
	}
	row := endpointsByID(t, saved)["acme"]
	if !row.HasKey || row.KeySource != core.KeySourceCredentials {
		t.Fatalf("acme = %+v, want a key from the credentials file", row)
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatalf("NewCredentialsStore: %v", err)
	}
	if key, err := store.GetAPIKey("custom-acme"); err != nil || key != "sk-acme" {
		t.Fatalf("GetAPIKey = (%q, %v), want sk-acme", key, err)
	}

	cleared, err := execute(t, "setKey", map[string]any{"id": "acme", "apiKey": ""})
	if err != nil {
		t.Fatalf("setKey clear: %v", err)
	}
	if row := endpointsByID(t, cleared)["acme"]; row.HasKey || row.KeySource != core.KeySourceNone {
		t.Fatalf("acme = %+v, want no key after it was cleared", row)
	}

	// A switched-off endpoint is unregistered, so nothing about its key can be
	// resolved through the provider registry. The card still shows a key row for
	// it, so both directions have to work off the id alone.
	if _, err := execute(t, "save", map[string]any{"id": "acme", "enabled": false}); err != nil {
		t.Fatalf("save disable: %v", err)
	}
	offWithKey, err := execute(t, "setKey", map[string]any{"id": "acme", "apiKey": "sk-off"})
	if err != nil {
		t.Fatalf("setKey while switched off: %v", err)
	}
	if row := endpointsByID(t, offWithKey)["acme"]; !row.HasKey {
		t.Fatalf("acme = %+v, want the key it was just given while switched off", row)
	}

	if _, err := execute(t, "setKey", map[string]any{"id": "never-existed", "apiKey": "sk"}); err == nil {
		t.Fatal("setKey accepted an endpoint that does not exist")
	}
}

func TestOpsListReportsAKeyComingFromTheEnvironment(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	if _, err := execute(t, "save", endpointParams("acme", "Acme Gateway", "https://gateway.acme.test/v1")); err != nil {
		t.Fatalf("save: %v", err)
	}
	t.Setenv("CUSTOM_ACME_API_KEY", "sk-from-env")

	listed, err := execute(t, "list", nil)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	row := endpointsByID(t, listed)["acme"]
	// The card disables its key input and says where the key came from, exactly
	// as it does for a built-in provider — otherwise typing a key there does
	// nothing the user can see.
	if !row.HasKey || row.KeySource != core.KeySourceEnvVar {
		t.Fatalf("acme = %+v, want a key sourced from the environment", row)
	}
}
