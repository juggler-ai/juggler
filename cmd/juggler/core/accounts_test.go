//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

// TestAccountsFileRoundTrip: what UpdateAccounts writes is what LoadAccounts
// reads back, owner-only, and a missing file reads as empty rather than as an
// error — an install that never added an account has no file at all.
func TestAccountsFileRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)

	if AccountsFileExists() {
		t.Fatalf("accounts.json exists before anything wrote it")
	}
	empty, err := LoadAccounts()
	if err != nil || len(empty.Accounts) != 0 {
		t.Fatalf("LoadAccounts with no file = %+v, %v; want empty, nil", empty, err)
	}

	want := AccountEntry{
		Type:        "openai-compatible",
		DisplayName: "Acme gateway",
		Settings:    map[string]any{"baseURL": "https://llm.acme.dev/v1"},
	}
	if err := UpdateAccounts(func(f *AccountsFile) error {
		f.Accounts["custom-acme"] = want
		f.Defaults["claudecode"] = DefaultAccountOverride{DisplayName: "Claude Code (personal)"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	got, err := LoadAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != AccountsFileVersion {
		t.Errorf("version = %d; want %d", got.Version, AccountsFileVersion)
	}
	if !reflect.DeepEqual(got.Accounts["custom-acme"], want) {
		t.Errorf("account = %+v; want %+v", got.Accounts["custom-acme"], want)
	}
	if got.Defaults["claudecode"].DisplayName != "Claude Code (personal)" {
		t.Errorf("defaults did not round-trip: %+v", got)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(AccountsPath())
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Errorf("accounts.json mode = %o; want 600", mode)
		}
	}
}

// TestCorruptAccountsFileIsQuarantinedOnce: an unparseable accounts.json is
// moved aside with its bytes intact and replaced by an empty one, so the
// migration that the file's existence records does not run again and
// resurrect endpoints the user had since removed.
func TestCorruptAccountsFileIsQuarantinedOnce(t *testing.T) {
	userpathstest.Isolate(t)
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	garbage := []byte(`{"version": 1, "accounts": nope`)
	if err := os.WriteFile(AccountsPath(), garbage, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadAccounts(); err == nil {
		t.Fatalf("LoadAccounts of a corrupt file returned no error")
	}
	quarantined, err := QuarantineCorruptAccounts()
	if err != nil || !quarantined {
		t.Fatalf("QuarantineCorruptAccounts = %v, %v; want true, nil", quarantined, err)
	}
	kept, err := os.ReadFile(filepath.Join(userpaths.ConfigDir(), "accounts.json.corrupt"))
	if err != nil || string(kept) != string(garbage) {
		t.Fatalf("quarantined bytes = %q, %v; want the original", kept, err)
	}
	if !AccountsFileExists() {
		t.Fatalf("no accounts.json after quarantine; the migration would run again")
	}
	if f, err := LoadAccounts(); err != nil || len(f.Accounts) != 0 {
		t.Fatalf("after quarantine LoadAccounts = %+v, %v; want empty, nil", f, err)
	}
	if again, err := QuarantineCorruptAccounts(); err != nil || again {
		t.Fatalf("a second QuarantineCorruptAccounts = %v, %v; want false, nil", again, err)
	}
}

// TestForgetProviderReferences: deleting an account forgets every stored
// preference and selection naming its id, so an id handed to a different
// account later inherits none of it. Preferences naming other providers stay.
func TestForgetProviderReferences(t *testing.T) {
	userpathstest.Isolate(t)
	const gone, kept = "custom-acme", "anthropic"

	if _, err := UpdateGlobalSettings(func(gs *GlobalSettings) bool {
		gs.Models.Hidden = map[string][]string{gone: {"a"}, kept: {"b"}}
		gs.Models.Limits = map[string]map[string]ModelLimits{gone: {"a": {ContextWindow: 1000}}, kept: {"b": {ContextWindow: 2000}}}
		return true
	}); err != nil {
		t.Fatal(err)
	}
	defaults, _ := NewDefaultModelStore()
	cheap, _ := NewCheapModelStore()
	decision, _ := NewDecisionModelStore()
	recents, _ := NewRecentModelsStore()
	mustSave := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	mustSave(defaults.Save(ModelRef{Provider: gone, Model: "a"}))
	mustSave(cheap.Save(CheapModelSetting{ModelRef: ModelRef{Provider: gone, Model: "a"}}))
	mustSave(decision.Save(ModelRef{Provider: gone, Model: "a"}))
	mustSave(recents.Add(ModelRef{Provider: kept, Model: "b"}))
	mustSave(recents.Add(ModelRef{Provider: gone, Model: "a"}))

	ForgetProviderReferences(gone)

	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := gs.Models.Hidden[gone]; ok {
		t.Errorf("hidden models of %s survived", gone)
	}
	if _, ok := gs.Models.Limits[gone]; ok {
		t.Errorf("model limits of %s survived", gone)
	}
	if len(gs.Models.Hidden[kept]) != 1 || len(gs.Models.Limits[kept]) != 1 {
		t.Errorf("preferences of %s were dropped too: %+v", kept, gs.Models)
	}
	if ref, _ := defaults.Load(); ref.Provider == gone {
		t.Errorf("default model still names %s", gone)
	}
	if setting, _ := cheap.Load(); setting.Provider == gone {
		t.Errorf("cheap model still names %s", gone)
	}
	if ref, _ := decision.Load(); ref.Provider == gone {
		t.Errorf("decision model still names %s", gone)
	}
	list, _ := recents.Load()
	if len(list) != 1 || list[0].Provider != kept {
		t.Errorf("recent models = %+v; want only the %s entry", list, kept)
	}
}
