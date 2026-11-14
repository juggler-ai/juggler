//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package accounts

import (
	"context"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// folderType is a login-folder type registered by the test — the shape of
// Claude Code and Codex accounts — recording what it was told to forget.
const folderType = "fakefolder"

func registerFolderType(t *testing.T) *[]string {
	t.Helper()
	var forgotten []string
	provider.RegisterProvider(provider.ProviderInfo{
		Name: folderType, DisplayName: "Folder", AuthType: provider.AuthTypeToggle,
	}, func(cfg provider.Config) (provider.Provider, error) { return nil, nil })
	provider.RegisterType(provider.TypeInfo{
		Name:              folderType,
		DisplayName:       "Folder",
		Category:          provider.CategorySubscription,
		HasDefaultAccount: true,
		Instantiate: func(acct provider.Account) (provider.ProviderInfo, provider.ProviderInitializer, error) {
			return provider.ProviderInfo{Name: acct.ID, Type: folderType, DisplayName: acct.DisplayName, AuthType: provider.AuthTypeToggle},
				func(cfg provider.Config) (provider.Provider, error) { return nil, nil }, nil
		},
		PrepareSettings: func(settings map[string]any) (map[string]any, error) {
			raw, _ := settings["dir"].(string)
			dir, err := provider.PrepareAccountDir(raw, "")
			return map[string]any{"dir": dir}, err
		},
		LoginKey: func(settings map[string]any) string {
			raw, _ := settings["dir"].(string)
			return provider.FolderLoginKey(raw)
		},
		Forget: func(id string) { forgotten = append(forgotten, id) },
	})
	t.Cleanup(func() {
		for _, info := range provider.ListProviderInfos() {
			if info.Type == folderType {
				provider.UnregisterProvider(info.Name)
			}
		}
		resetRegistered()
	})
	return &forgotten
}

// TestARemovedAccountsIDInheritsNothing: ids are reused once free, so removing
// an account must take with it everything its type remembers under the id —
// a login state, who it was signed in as — or the next account given the id
// shows the old one's.
func TestARemovedAccountsIDInheritsNothing(t *testing.T) {
	userpathstest.Isolate(t)
	forgotten := registerFolderType(t)
	home := t.TempDir()

	first := savedID(t, call(t, "save", map[string]any{"type": folderType, "displayName": "Folder (work)", "settings": map[string]any{"dir": filepath.Join(home, "a")}}))
	call(t, "remove", map[string]any{"id": first})
	if len(*forgotten) != 1 || (*forgotten)[0] != first {
		t.Fatalf("removing %s told the type to forget %v", first, *forgotten)
	}
	second := savedID(t, call(t, "save", map[string]any{"type": folderType, "displayName": "Folder (work)", "settings": map[string]any{"dir": filepath.Join(home, "b")}}))
	if second != first {
		t.Fatalf("the id was not reused (%s, then %s); this test no longer tests what it says", first, second)
	}
}

// TestTwoAccountsNeverShareALogin: two accounts on one folder are one login
// under two names, so a second add of it is refused — however the folder is
// spelt — and leaves nothing behind.
func TestTwoAccountsNeverShareALogin(t *testing.T) {
	userpathstest.Isolate(t)
	registerFolderType(t)
	home := t.TempDir()
	dir := filepath.Join(home, "work")

	call(t, "save", map[string]any{"type": folderType, "displayName": "Folder (work)", "settings": map[string]any{"dir": dir}})
	for _, again := range []map[string]any{
		{"dir": dir + "/"},
		{"dir": dir, "stray": "a setting the type does not have"},
	} {
		if _, err := (&operations{}).Execute(context.Background(), "save", map[string]any{"type": folderType, "displayName": "Folder (again)", "settings": again}); err == nil {
			t.Errorf("a second account on %v was added", again)
		}
	}
	file, _ := core.LoadAccounts()
	if len(file.Accounts) != 1 {
		t.Fatalf("accounts = %v, want the first alone", file.Accounts)
	}
}

// TestAddingWithSettingsIsAnotherLogin: while a type's default account is
// free, an add that names a login of its own — a folder — is that login, not
// the default account; taking the bare id would drop the folder and sign in
// the default login instead.
func TestAddingWithSettingsIsAnotherLogin(t *testing.T) {
	userpathstest.Isolate(t)
	registerFolderType(t)
	dir := filepath.Join(t.TempDir(), "work")

	id := savedID(t, call(t, "save", map[string]any{"type": folderType, "displayName": "Folder (work)", "settings": map[string]any{"dir": dir}}))
	if id == folderType {
		t.Fatalf("an add naming %s took the default account's id", dir)
	}
	file, _ := core.LoadAccounts()
	if got := file.Accounts[id].Settings["dir"]; got != provider.CanonicalDir(dir) {
		t.Fatalf("%s was saved with dir %v; want %s", id, got, dir)
	}

	prev, err := preview(folderType, "Folder (home)", nil)
	if err != nil || !prev.IsDefault || prev.ID != folderType {
		t.Fatalf("preview of an add with no folder = %+v, %v; want the free default account", prev, err)
	}
	prev, err = preview(folderType, "Folder (home)", map[string]any{"dir": filepath.Join(t.TempDir(), "home")})
	if err != nil || prev.IsDefault || prev.ID != folderType+"-home" {
		t.Fatalf("preview of an add with a folder = %+v, %v; want a further account", prev, err)
	}
}
