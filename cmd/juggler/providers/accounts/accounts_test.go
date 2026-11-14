//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package accounts

import (
	"context"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// fakeType is an API-key provider type registered by the test, so these tests
// hold to the account mechanism rather than to any one vendor.
const (
	fakeType   = "fakekey"
	fakeCred   = "fakekey_api_key"
	fakeEnvVar = "FAKEKEY_API_KEY"
)

// registerFakeType registers fakeType's default account and type, and removes
// every provider the test registered when it ends.
func registerFakeType(t *testing.T) {
	t.Helper()
	provider.RegisterProvider(provider.ProviderInfo{
		Name:          fakeType,
		DisplayName:   "Fake",
		AuthType:      provider.AuthTypeAPIKey,
		ConfigKeyName: fakeCred,
		EnvVarName:    fakeEnvVar,
	}, func(cfg provider.Config) (provider.Provider, error) { return nil, nil })
	provider.RegisterType(provider.TypeInfo{
		Name:              fakeType,
		DisplayName:       "Fake",
		Category:          provider.CategoryAPIKey,
		HasDefaultAccount: true,
		Instantiate:       provider.InstantiateAPIKeyAccount,
		KeySlot:           provider.AccountKeySlot,
	})
	t.Cleanup(func() {
		for _, info := range provider.ListProviderInfos() {
			if info.Type == fakeType {
				provider.UnregisterProvider(info.Name)
			}
		}
		resetRegistered()
	})
}

// resetRegistered forgets the accounts Sync registered, as a restart would.
func resetRegistered() {
	syncLock <- struct{}{}
	registered = map[string]bool{}
	<-syncLock
}

func call(t *testing.T, operation string, params map[string]any) any {
	t.Helper()
	out, err := (&operations{}).Execute(context.Background(), operation, params)
	if err != nil {
		t.Fatalf("accounts.%s(%v): %v", operation, params, err)
	}
	return out
}

func savedID(t *testing.T, out any) string {
	t.Helper()
	res, ok := out.(SaveResult)
	if !ok {
		t.Fatalf("save returned %T, want SaveResult", out)
	}
	return res.ID
}

func credential(t *testing.T, name string) (core.ProviderCredential, error) {
	t.Helper()
	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	return store.GetProviderCredential(name)
}

func listed(t *testing.T) List {
	t.Helper()
	l, err := buildList()
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func hasAccount(l List, id string) bool {
	for _, a := range l.Accounts {
		if a.ID == id {
			return true
		}
	}
	return false
}

func hasCandidate(l List, accountID, reason string) bool {
	for _, c := range l.Candidates {
		if c.AccountID == accountID && c.Reason == reason {
			return true
		}
	}
	return false
}

// TestAPIKeyAccountsKeepTheirOwnKeys: an extra account of an API-key type
// uses the key it was given and nothing else — never the default account's
// stored key, never the type's environment variable. Getting this wrong is
// silent: every turn on "Anthropic (team)" would bill the personal key.
func TestAPIKeyAccountsKeepTheirOwnKeys(t *testing.T) {
	userpathstest.Isolate(t)
	registerFakeType(t)
	t.Setenv(fakeEnvVar, "env-key")
	store, _ := core.NewCredentialsStore()
	if err := store.SetRawKey(fakeCred, "default-key"); err != nil {
		t.Fatal(err)
	}

	team := savedID(t, call(t, "save", map[string]any{"type": fakeType, "displayName": "Fake (team)", "apiKey": "team-key"}))
	if team != "fakekey-team" {
		t.Fatalf("the second account got id %q; want fakekey-team", team)
	}
	bare := savedID(t, call(t, "save", map[string]any{"type": fakeType, "displayName": "Fake (bare)"}))

	if cred, err := credential(t, team); err != nil || cred.APIKey != "team-key" {
		t.Fatalf("%s resolves to %q, %v; want its own key", team, cred.APIKey, err)
	}
	if cred, err := credential(t, bare); err == nil {
		t.Fatalf("%s has no key of its own but resolved %q (source %s); it must not borrow one", bare, cred.APIKey, cred.KeySource)
	}
	if cred, err := credential(t, fakeType); err != nil || cred.APIKey != "default-key" {
		t.Fatalf("the default account resolves to %q, %v; want its own stored key", cred.APIKey, err)
	}
	info, _ := provider.GetProviderInfo(team)
	if info.EnvVarName != "" || info.Type != fakeType || info.DisplayName != "Fake (team)" {
		t.Fatalf("%s registered as %+v; want type %s, its own name, and no env var", team, info, fakeType)
	}

	// After a restart the accounts come back from accounts.json alone.
	provider.UnregisterProvider(team)
	provider.UnregisterProvider(bare)
	resetRegistered()
	RegisterAll()
	if cred, err := credential(t, team); err != nil || cred.APIKey != "team-key" {
		t.Fatalf("after a restart %s resolves to %q, %v; want its own key", team, cred.APIKey, err)
	}
}

// TestRemoveAndRestore holds the lifecycle table: removing an extra account
// deletes it and everything keyed to it; removing a default account only marks
// it removed, so that adding it back from Found restores it, its id and
// everything that names it.
func TestRemoveAndRestore(t *testing.T) {
	userpathstest.Isolate(t)
	registerFakeType(t)
	t.Setenv(fakeEnvVar, "env-key")
	store, _ := core.NewCredentialsStore()
	if err := store.SetRawKey(fakeCred, "default-key"); err != nil {
		t.Fatal(err)
	}
	defaults, _ := core.NewDefaultModelStore()

	t.Run("extra account", func(t *testing.T) {
		team := savedID(t, call(t, "save", map[string]any{"type": fakeType, "displayName": "Fake (team)", "apiKey": "team-key"}))
		if err := defaults.Save(core.ModelRef{Provider: team, Model: "m"}); err != nil {
			t.Fatal(err)
		}
		call(t, "remove", map[string]any{"id": team})

		if _, ok := provider.GetProviderInfo(team); ok {
			t.Errorf("%s is still registered", team)
		}
		if store.GetRawKey("fakekey_team_api_key") != "" {
			t.Errorf("%s's key was left in the credentials store", team)
		}
		if ref, _ := defaults.Load(); ref.Provider == team {
			t.Errorf("the default model still names the removed %s", team)
		}
		if l := listed(t); hasAccount(l, team) || hasCandidate(l, team, provider.CandidateRemoved) {
			t.Errorf("a removed extra account is still listed: %+v", l)
		}
	})

	t.Run("default account with a typed key and an env var", func(t *testing.T) {
		if err := defaults.Save(core.ModelRef{Provider: fakeType, Model: "m"}); err != nil {
			t.Fatal(err)
		}
		call(t, "remove", map[string]any{"id": fakeType})

		if store.GetRawKey(fakeCred) != "" {
			t.Errorf("the typed key survived removing the default account")
		}
		if !store.IsProviderSwitchedOff(fakeType) {
			t.Errorf("enabled_%s is not false, so the env var still serves the removed account", fakeType)
		}
		if _, err := credential(t, fakeType); err == nil {
			t.Errorf("the removed default account still resolves a credential")
		}
		l := listed(t)
		if hasAccount(l, fakeType) || !hasCandidate(l, fakeType, provider.CandidateRemoved) {
			t.Errorf("the removed default is not offered under Found: %+v", l)
		}
		if ref, _ := defaults.Load(); ref.Provider != fakeType {
			t.Errorf("removing a default account forgot the default model naming it")
		}

		call(t, "addCandidate", map[string]any{"key": fakeType})
		if store.HasProviderFlag(fakeType) {
			t.Errorf("adding it back left enabled_%s set", fakeType)
		}
		if cred, err := credential(t, fakeType); err != nil || cred.APIKey != "env-key" {
			t.Errorf("restored default resolves %q, %v; want the env var's key", cred.APIKey, err)
		}
		if !hasAccount(listed(t), fakeType) {
			t.Errorf("the restored default is not an account")
		}
	})
}

// TestAccountIDs: the first account of a type takes the bare id whenever it is
// free; every further one is <type>-<slug>, unique, and shaped to be a DOM id.
func TestAccountIDs(t *testing.T) {
	userpathstest.Isolate(t)
	registerFakeType(t)
	t.Setenv(fakeEnvVar, "")

	first := savedID(t, call(t, "save", map[string]any{"type": fakeType, "displayName": "Fake", "apiKey": "k1"}))
	if first != fakeType {
		t.Fatalf("the first account took %q; want the bare %q", first, fakeType)
	}
	store, _ := core.NewCredentialsStore()
	if store.GetRawKey(fakeCred) != "k1" {
		t.Fatalf("the first account's key is not under %s, where an older build looks for it", fakeCred)
	}
	if core.AccountsFileExists() {
		t.Fatalf("adding a type's default account wrote accounts.json; it needs no entry")
	}

	for _, tc := range []struct{ name, want string }{
		{"Fake (Team!)", "fakekey-team"},
		{"Fake (team)", "fakekey-team-2"},
		{"Fake", "fakekey-2"},
		{"Fake (2nd place)", "fakekey-2nd-place"},
		{"Fake (Équipe)", "fakekey-equipe"},
	} {
		if got := savedID(t, call(t, "save", map[string]any{"type": fakeType, "displayName": tc.name, "apiKey": "k"})); got != tc.want {
			t.Errorf("save %q took id %q; want %q", tc.name, got, tc.want)
		}
	}
}
