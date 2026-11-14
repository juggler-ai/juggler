//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"context"
	"os"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// writeLegacyCredentials seeds the three raw keys the single OpenAI-compatible
// provider used to be configured through.
func writeLegacyCredentials(t *testing.T, baseURL, headers, apiKey string) *core.CredentialsStore {
	t.Helper()
	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatalf("NewCredentialsStore: %v", err)
	}
	for key, value := range map[string]string{
		legacyBaseURLCredKey: baseURL,
		legacyHeadersCredKey: headers,
		legacyAPIKeyCredKey:  apiKey,
	} {
		if value == "" {
			continue
		}
		if err := store.SetRawKey(key, value); err != nil {
			t.Fatalf("SetRawKey(%s): %v", key, err)
		}
	}
	return store
}

func TestRegisterMigratesTheLegacySingleton(t *testing.T) {
	userpathstest.Isolate(t)
	srv, gotPath, gotHeader := modelListServer(t)
	store := writeLegacyCredentials(t, srv.URL, `{"X-Tenant":"acme"}`, "sk-legacy")

	RegisterType()
	registerAccounts(t)

	// The migrated endpoint keeps its historic id. Every stored reference to it
	// — default-model.json, recent models, models.hidden, models.limits, and
	// every conversation document — names that id and nothing else.
	if _, found := provider.GetProviderInfo(LegacyID); !found {
		t.Fatal("the migrated endpoint is not registered under openai-compatible; every stored reference to it is now dangling")
	}
	if _, found := provider.GetProviderInfo(idPrefix + LegacyID); found {
		t.Fatal("the migrated endpoint took the prefixed id, which no stored reference names")
	}

	migrated, ok := lookup(LegacyID)
	if !ok {
		t.Fatalf("accounts.json holds no endpoint under %q", LegacyID)
	}
	if migrated.BaseURL != srv.URL {
		t.Fatalf("migrated base URL = %q, want %q", migrated.BaseURL, srv.URL)
	}
	if migrated.Headers["X-Tenant"] != "acme" {
		t.Fatalf("migrated headers = %v, want the legacy X-Tenant", migrated.Headers)
	}

	// The existing key is found where it already sits, unmoved.
	key, err := store.GetAPIKey(LegacyID)
	if err != nil {
		t.Fatalf("GetAPIKey: %v", err)
	}
	if key != "sk-legacy" {
		t.Fatalf("GetAPIKey(%s) = %q, want the key the user already had", LegacyID, key)
	}

	// And it works end to end through the generic path.
	p, err := provider.InitializeProvider(LegacyID, provider.Config{Model: "m", APIKey: key})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	if _, err := p.ListModelsWithInfo(context.Background()); err != nil {
		t.Fatalf("the migrated endpoint did not reach its gateway: %v", err)
	}
	if *gotPath != "/models" || *gotHeader != "acme" {
		t.Fatalf("gateway was asked for %q with X-Tenant %q, want /models with acme", *gotPath, *gotHeader)
	}
}

func TestRegisterLeavesAnEditedFileAlone(t *testing.T) {
	userpathstest.Isolate(t)
	writeLegacyCredentials(t, "https://gateway.legacy.test/v1", "", "sk-legacy")
	// The user has been here already and removed the migrated endpoint. The
	// legacy credentials still sit in the store, so only the file's existence
	// can tell the second run from the first.
	writeInstances(t, map[string]Instance{
		"acme": {DisplayName: "Acme Gateway", BaseURL: "https://gateway.acme.test/v1"},
	})

	RegisterType()
	registerAccounts(t)

	f, err := core.LoadAccounts()
	if err != nil {
		t.Fatalf("LoadAccounts: %v", err)
	}
	if _, resurrected := f.Accounts[LegacyID]; resurrected {
		t.Fatal("a second run re-migrated an endpoint the user had deleted")
	}
	if acme, ok := lookup(RegisteredName("acme")); len(f.Accounts) != 1 || !ok || acme.BaseURL != "https://gateway.acme.test/v1" {
		t.Fatalf("accounts = %v, want the user's own entry untouched", f.Accounts)
	}
	if _, found := provider.GetProviderInfo(LegacyID); found {
		t.Fatal("the deleted endpoint was registered anyway")
	}
	if _, found := provider.GetProviderInfo(RegisteredName("acme")); !found {
		t.Fatal("the user's own entry was not registered")
	}
}

func TestRegisterWithNoLegacyEndpointWritesNothing(t *testing.T) {
	userpathstest.Isolate(t)

	RegisterType()
	registerAccounts(t)

	for _, path := range []string{configPath(), core.AccountsPath()} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("os.Stat(%s) = %v, want the file never created for a user who had no custom endpoint", path, err)
		}
	}
	if _, found := provider.GetProviderInfo(LegacyID); found {
		t.Fatal("an endpoint was registered for a user who had never configured one")
	}
}

func TestParseHeaderJSON(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want map[string]string
	}{
		{"empty", "", nil},
		{"whitespace", "   ", nil},
		{"empty object", "{}", nil},
		{"invalid json", "{not json", nil},
		{"array not object", `["a","b"]`, nil},
		{"valid single", `{"User-Agent":"app/1.0"}`, map[string]string{"User-Agent": "app/1.0"}},
		{"valid multi", `{"User-Agent":"app/1.0","X-Key":"v"}`, map[string]string{"User-Agent": "app/1.0", "X-Key": "v"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseHeaderJSON(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("parseHeaderJSON(%q) = %v, want %v", tc.in, got, tc.want)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Fatalf("parseHeaderJSON(%q)[%q] = %q, want %q", tc.in, k, got[k], v)
				}
			}
		})
	}
}
