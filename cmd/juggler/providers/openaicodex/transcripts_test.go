//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// TestCodexHomesListsEveryLoginOnce pins what a transcript reader is told to
// look in: the default CODEX_HOME first, then each extra account's, then a
// further login found by convention — each once, however many ways it is
// found, and never another type's account.
func TestCodexHomesListsEveryLoginOnce(t *testing.T) {
	home := userpathstest.Isolate(t)
	t.Setenv("CODEX_HOME", "")
	mk := func(name string) string {
		dir := filepath.Join(home, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		return provider.CanonicalDir(dir)
	}
	// An account, and found by convention too.
	work := mk(".codex-work")
	// An account nothing conventional names.
	extra := mk("elsewhere")
	// Found by convention only.
	found := mk(".codex_found")
	err := core.UpdateAccounts(func(f *core.AccountsFile) error {
		f.Accounts["openaicodex-work"] = core.AccountEntry{Type: TypeName, Settings: map[string]any{codexHomeSetting: work}}
		f.Accounts["openaicodex-x"] = core.AccountEntry{Type: TypeName, Settings: map[string]any{codexHomeSetting: extra}}
		f.Accounts["other"] = core.AccountEntry{Type: "claudecode", Settings: map[string]any{codexHomeSetting: "/nope"}}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// The accounts in the order of their folders' paths.
	want := []string{provider.CanonicalDir(filepath.Join(home, ".codex")), work, extra, found}
	if got := CodexHomes(); !slices.Equal(got, want) {
		t.Fatalf("CodexHomes =\n %q\nwant\n %q", got, want)
	}
}
