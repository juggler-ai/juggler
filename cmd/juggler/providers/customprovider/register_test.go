//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// modelListServer answers the OpenAI /models call, recording the path and the
// custom header it was asked with. Reaching it at all is the assertion: an
// instance whose base URL never made it to the client fails to connect instead
// of quietly succeeding.
//
// Only the FIRST request is recorded, which is the model list. A listing whose
// rows publish no limits goes on to ask the same endpoint for its model
// capabilities, and that second path would otherwise overwrite the one under
// test.
func modelListServer(t *testing.T) (*httptest.Server, *string, *string) {
	t.Helper()
	var gotPath, gotHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gotPath == "" {
			gotPath = r.URL.Path
			gotHeader = r.Header.Get("X-Tenant")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"object":"list","data":[{"id":"m","object":"model"}]}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &gotPath, &gotHeader
}

// writeInstances writes the endpoints into accounts.json, in place of every
// endpoint it held, as an add or an edit through the accounts ops would.
func writeInstances(t *testing.T, instances map[string]Instance) {
	t.Helper()
	if err := core.UpdateAccounts(func(f *core.AccountsFile) error {
		for id, entry := range f.Accounts {
			if entry.Type == TypeName {
				delete(f.Accounts, id)
			}
		}
		for id, inst := range instances {
			f.Accounts[RegisteredName(id)] = entryFromInstance(inst)
		}
		return nil
	}); err != nil {
		t.Fatalf("UpdateAccounts: %v", err)
	}
}

// syncInstances writes the endpoints and registers each through the type's
// Instantiate, as the accounts package does, unregistering them when the test
// ends: the registry is process-global, so a leaked entry would be visible to
// every later test.
func syncInstances(t *testing.T, instances map[string]Instance) {
	t.Helper()
	writeInstances(t, instances)
	for id, inst := range instances {
		entry := entryFromInstance(inst)
		info, initializer, err := instantiate(provider.Account{ID: RegisteredName(id), Type: TypeName, DisplayName: entry.DisplayName, Settings: entry.Settings})
		if err != nil {
			t.Fatalf("instantiate %s: %v", id, err)
		}
		provider.RegisterProvider(info, initializer)
		t.Cleanup(func() { provider.UnregisterProvider(info.Name) })
	}
}

// registerAccounts registers every endpoint accounts.json holds, as the
// accounts package does at startup, and unregisters them when the test ends.
func registerAccounts(t *testing.T) {
	t.Helper()
	f, err := core.LoadAccounts()
	if err != nil {
		t.Fatalf("LoadAccounts: %v", err)
	}
	for id, entry := range f.Accounts {
		if entry.Type != TypeName {
			continue
		}
		info, initializer, err := instantiate(provider.Account{ID: id, Type: TypeName, DisplayName: entry.DisplayName, Settings: entry.Settings})
		if err != nil {
			continue
		}
		provider.RegisterProvider(info, initializer)
		t.Cleanup(func() { provider.UnregisterProvider(info.Name) })
	}
}

func registeredNames(t *testing.T) map[string]bool {
	t.Helper()
	names := map[string]bool{}
	for _, info := range provider.ListProviderInfos() {
		names[info.Name] = true
	}
	return names
}

func TestEndpointRegistersAsAProviderOfItsOwn(t *testing.T) {
	userpathstest.Isolate(t)
	syncInstances(t, map[string]Instance{
		"acme": {DisplayName: "Acme Gateway", BaseURL: "https://gateway.acme.test/v1"},
	})

	if !registeredNames(t)["custom-acme"] {
		t.Fatal("an endpoint did not reach the provider list, so it can never reach the model picker")
	}
	info, found := provider.GetProviderInfo("custom-acme")
	if !found {
		t.Fatal("custom-acme has no provider info")
	}
	if info.DisplayName != "Acme Gateway" {
		t.Fatalf("DisplayName = %q, want the endpoint's own label", info.DisplayName)
	}
	if info.Type != TypeName {
		t.Fatalf("Type = %q, want %q", info.Type, TypeName)
	}
	if !info.APIKeyOptional {
		t.Fatal("APIKeyOptional = false; a gateway with a public model list needs no key")
	}
	// A configured endpoint is available before any key is entered — that pair
	// (optional key + detected) is what lights the provider up in the picker.
	if !provider.CheckAutoDetect("custom-acme") {
		t.Fatal("a configured endpoint is not auto-detected, so it stays greyed out")
	}
}

// TestEndpointsThatCouldNeverHaveBeenSavedAreRefused: an entry edited by hand
// into one the add form would refuse is not registered, so it never puts a
// provider in the picker that errors on first use.
func TestEndpointsThatCouldNeverHaveBeenSavedAreRefused(t *testing.T) {
	for _, tc := range []struct {
		id       string
		settings map[string]any
	}{
		{"custom-acme", map[string]any{"baseURL": "not a url"}},
		{"custom-acme", map[string]any{}},
		{"custom-Bad", map[string]any{"baseURL": "https://gateway.test/v1"}},
		{"acme", map[string]any{"baseURL": "https://gateway.test/v1"}},
	} {
		if _, _, err := instantiate(provider.Account{ID: tc.id, Type: TypeName, Settings: tc.settings}); err == nil {
			t.Errorf("instantiate(%q, %v) accepted it", tc.id, tc.settings)
		}
	}
}

func TestSyncedInstanceKeysAreIndependent(t *testing.T) {
	userpathstest.Isolate(t)
	syncInstances(t, map[string]Instance{
		"acme-eu": {DisplayName: "Acme EU", BaseURL: "https://eu.acme.test/v1"},
		"lab":     {DisplayName: "Lab box", BaseURL: "http://127.0.0.1:8080/v1"},
	})

	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatalf("NewCredentialsStore: %v", err)
	}
	if err := store.SetAPIKey("custom-acme-eu", "sk-acme"); err != nil {
		t.Fatalf("SetAPIKey: %v", err)
	}
	got, err := store.GetAPIKey("custom-acme-eu")
	if err != nil {
		t.Fatalf("GetAPIKey: %v", err)
	}
	if got != "sk-acme" {
		t.Fatalf("GetAPIKey(custom-acme-eu) = %q, want sk-acme", got)
	}
	// The key landed under this instance's own credential key, which is what
	// keeps two endpoints' secrets apart.
	if raw := store.GetRawKey("custom_acme-eu_api_key"); raw != "sk-acme" {
		t.Fatalf("credentials hold %q under custom_acme-eu_api_key, want sk-acme", raw)
	}
	if other, err := store.GetAPIKey("custom-lab"); err != nil || other != "" {
		t.Fatalf("GetAPIKey(custom-lab) = (%q, %v), want empty — one instance's key must not answer for another", other, err)
	}

	// Each instance also gets a shell-settable environment variable, with the
	// hyphens the id may carry folded to underscores.
	t.Setenv("CUSTOM_LAB_API_KEY", "env-lab")
	fromEnv, err := store.GetAPIKey("custom-lab")
	if err != nil {
		t.Fatalf("GetAPIKey: %v", err)
	}
	if fromEnv != "env-lab" {
		t.Fatalf("GetAPIKey(custom-lab) = %q, want the environment's env-lab", fromEnv)
	}
}

func TestInstanceClientReadsItsEndpointFreshOnEveryUse(t *testing.T) {
	userpathstest.Isolate(t)
	first, firstPath, firstHeader := modelListServer(t)
	second, secondPath, _ := modelListServer(t)

	syncInstances(t, map[string]Instance{
		"acme": {
			DisplayName: "Acme Gateway",
			BaseURL:     first.URL,
			Headers:     map[string]string{"X-Tenant": "acme"},
		},
	})

	list := func() {
		t.Helper()
		p, err := provider.InitializeProvider("custom-acme", provider.Config{Model: "m", APIKey: "k"})
		if err != nil {
			t.Fatalf("InitializeProvider: %v", err)
		}
		if _, err := p.ListModelsWithInfo(context.Background()); err != nil {
			t.Fatalf("ListModelsWithInfo did not reach the instance's endpoint: %v", err)
		}
	}

	list()
	if *firstPath != "/models" {
		t.Fatalf("first endpoint was asked for %q, want /models", *firstPath)
	}
	if *firstHeader != "acme" {
		t.Fatalf("first endpoint saw X-Tenant %q, want acme — the instance's headers never reached the request", *firstHeader)
	}

	// Repoint the endpoint without re-registering: the descriptor's resolvers
	// read the account per use, so an edit takes effect with no restart.
	writeInstances(t, map[string]Instance{
		"acme": {DisplayName: "Acme Gateway", BaseURL: second.URL},
	})
	*firstPath = ""
	list()
	if *secondPath != "/models" {
		t.Fatalf("second endpoint was asked for %q, want /models — the edited URL was not picked up", *secondPath)
	}
	if *firstPath != "" {
		t.Fatal("the client still went to the endpoint the instance had before the edit")
	}
}
