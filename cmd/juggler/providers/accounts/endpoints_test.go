//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package accounts

import (
	"context"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/customprovider"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// registerEndpointType registers the OpenAI-compatible type, and every
// endpoint the test adds is unregistered when it ends.
func registerEndpointType(t *testing.T) {
	t.Helper()
	customprovider.RegisterType()
	t.Cleanup(func() {
		for _, info := range provider.ListProviderInfos() {
			if info.Type == customprovider.TypeName {
				provider.UnregisterProvider(info.Name)
			}
		}
		resetRegistered()
	})
}

func addEndpoint(t *testing.T, name, baseURL string, extra map[string]any) string {
	t.Helper()
	settings := map[string]any{"baseURL": baseURL}
	for k, v := range extra {
		settings[k] = v
	}
	return savedID(t, call(t, "save", map[string]any{"type": customprovider.TypeName, "displayName": name, "settings": settings}))
}

func accountOf(t *testing.T, id string) Account {
	t.Helper()
	for _, a := range listed(t).Accounts {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("%s is not listed", id)
	return Account{}
}

// TestEndpointAccounts holds a custom endpoint to what every account does:
// added under its own id with a key slot and variable of its own, edited a
// field at a time, and removed with everything keyed to it and nothing else.
func TestEndpointAccounts(t *testing.T) {
	userpathstest.Isolate(t)
	registerEndpointType(t)
	store, _ := core.NewCredentialsStore()

	acme := addEndpoint(t, "Acme", "https://gateway.acme.test/v1", map[string]any{"headers": map[string]any{"X-Tenant": "eu"}})
	lab := addEndpoint(t, "", "http://127.0.0.1:8080/v1", nil)
	if acme != "custom-acme" || lab != "custom-2" {
		t.Fatalf("endpoints took ids %q and %q; want custom-acme and custom-2", acme, lab)
	}
	if a := accountOf(t, acme); !a.Registered || a.EnvVarName != "CUSTOM_ACME_API_KEY" {
		t.Fatalf("%s = %+v; want registered, naming the variable a key can come from", acme, a)
	}
	// An endpoint given no name has an id with no word in it, and is an
	// endpoint all the same.
	if a := accountOf(t, lab); !a.Registered {
		t.Fatalf("%s = %+v; want registered", lab, a)
	}

	// The card saves one field at a time: an edit of the URL keeps the headers.
	call(t, "save", map[string]any{"id": acme, "settings": map[string]any{"baseURL": "https://eu.acme.test/v1"}})
	if s := accountOf(t, acme).Settings; s["baseURL"] != "https://eu.acme.test/v1" || s["headers"] == nil {
		t.Fatalf("after editing the URL %s holds %v; want the new URL and the headers it had", acme, s)
	}
	if _, err := (&operations{}).Execute(context.Background(), "save", map[string]any{"id": acme, "settings": map[string]any{"baseURL": "not a url"}}); err == nil {
		t.Fatal("an endpoint was saved with no usable base URL")
	}
	if s := accountOf(t, acme).Settings; s["baseURL"] != "https://eu.acme.test/v1" {
		t.Fatalf("a refused edit changed %s to %v", acme, s)
	}

	// Its key: stored, cleared, or supplied by its own variable.
	call(t, "setKey", map[string]any{"id": acme, "apiKey": "sk-acme"})
	if key, err := store.GetAPIKey(acme); err != nil || key != "sk-acme" || accountOf(t, acme).KeySource != core.KeySourceCredentials {
		t.Fatalf("after setKey %s's key is %q, %v", acme, key, err)
	}
	call(t, "setKey", map[string]any{"id": acme, "apiKey": ""})
	t.Setenv("CUSTOM_ACME_API_KEY", "sk-env")
	if src := accountOf(t, acme).KeySource; src != core.KeySourceEnvVar {
		t.Fatalf("a key in CUSTOM_ACME_API_KEY reads as %q", src)
	}
	t.Setenv("CUSTOM_ACME_API_KEY", "")

	// Remove takes its key and what was curated for it, and nothing of
	// another's.
	call(t, "setKey", map[string]any{"id": acme, "apiKey": "sk-acme"})
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Hidden = map[string][]string{acme: {"m1"}, lab: {"m2"}}
		return true
	}); err != nil {
		t.Fatal(err)
	}
	call(t, "remove", map[string]any{"id": acme})
	if _, ok := provider.GetProviderInfo(acme); ok {
		t.Error("a removed endpoint is still registered")
	}
	if store.GetRawKey("custom_acme_api_key") != "" {
		t.Error("a removed endpoint's key was left behind")
	}
	settings, _ := core.LoadGlobalSettings()
	if _, stale := settings.Models.Hidden[acme]; stale || len(settings.Models.Hidden[lab]) != 1 {
		t.Errorf("hidden models after removing %s: %v; want only %s's", acme, settings.Models.Hidden, lab)
	}
}

// TestAnEndpointThatCannotRegisterStillHasACard: an entry edited by hand into
// one that could never serve is not registered, and its card says why — it is
// the endpoint the user has come to settings to fix.
func TestAnEndpointThatCannotRegisterStillHasACard(t *testing.T) {
	userpathstest.Isolate(t)
	registerEndpointType(t)
	if err := core.UpdateAccounts(func(f *core.AccountsFile) error {
		f.Accounts["custom-broken"] = core.AccountEntry{Type: customprovider.TypeName, DisplayName: "Broken", Settings: map[string]any{"baseURL": "not a url"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := Sync(); err != nil {
		t.Fatal(err)
	}
	a := accountOf(t, "custom-broken")
	if a.Registered || a.Problem == "" || a.EnvVarName != "CUSTOM_BROKEN_API_KEY" {
		t.Fatalf("custom-broken = %+v; want unregistered, saying why, with its key row", a)
	}
}

// TestASwitchedOffEndpointIsOfferedBack: an endpoint that was switched off in
// custom-providers.json is not an account but a candidate, and adding it makes
// it one under the id it always had.
func TestASwitchedOffEndpointIsOfferedBack(t *testing.T) {
	userpathstest.Isolate(t)
	registerEndpointType(t)
	if err := core.UpdateAccounts(func(f *core.AccountsFile) error {
		f.SwitchedOff["custom-lab"] = core.AccountEntry{Type: customprovider.TypeName, DisplayName: "Lab", Settings: map[string]any{"baseURL": "http://127.0.0.1:8080/v1"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if l := listed(t); hasAccount(l, "custom-lab") || !hasCandidate(l, "custom-lab", provider.CandidateSwitchedOff) {
		t.Fatalf("a switched-off endpoint is not offered back: %+v", l)
	}
	if id := savedID(t, call(t, "addCandidate", map[string]any{"key": "custom-lab"})); id != "custom-lab" {
		t.Fatalf("adding it back made %q", id)
	}
	if _, ok := provider.GetProviderInfo("custom-lab"); !ok {
		t.Fatal("the endpoint added back was not registered")
	}
	if l := listed(t); !hasAccount(l, "custom-lab") || hasCandidate(l, "custom-lab", provider.CandidateSwitchedOff) {
		t.Fatalf("the endpoint added back is still a candidate: %+v", l)
	}
}
