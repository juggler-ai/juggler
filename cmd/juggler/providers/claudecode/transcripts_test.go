//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/projectpaths"
	"juggler/internal/userpaths/userpathstest"
)

// TestDefaultConfigDirIsTheCLIs pins the default account's config dir to the
// one its CLI uses: ~/.claude, or $CLAUDE_CONFIG_DIR. Juggler's own working
// directory is never it, which is what a swapped argument once made it — so
// "Add an account" accepted ~/.claude as a second login of itself, and
// discovery skipped the wrong folder.
func TestDefaultConfigDirIsTheCLIs(t *testing.T) {
	userpathstest.Isolate(t)
	home := os.Getenv("HOME")

	t.Setenv("CLAUDE_CONFIG_DIR", "")
	if got, want := defaultConfigDir(), filepath.Join(home, ".claude"); got != want {
		t.Fatalf("defaultConfigDir = %q; want %q", got, want)
	}
	custom := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", custom)
	if got := defaultConfigDir(); got != custom {
		t.Fatalf("defaultConfigDir with CLAUDE_CONFIG_DIR = %q; want %q", got, custom)
	}
}

// TestConfigDirsListsEveryLoginOnce pins what a transcript reader is told to
// look in: the default account's dir first, then each extra account's, then a
// further login found by convention — each once, however many ways it is
// found, and a conventional folder only when it holds a .claude.json.
func TestConfigDirsListsEveryLoginOnce(t *testing.T) {
	home := userpathstest.Isolate(t)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	mk := func(name string, login bool) string {
		dir := filepath.Join(home, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if login {
			if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte("{}"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return provider.CanonicalDir(dir)
	}
	// An account, and found by convention too.
	work := mk(".claude-work", true)
	// An account nothing conventional names.
	extra := mk("elsewhere", false)
	// Found by convention only.
	found := mk(".claude_found", true)
	// Conventional, but no login in it.
	mk(".claude-empty", false)
	err := core.UpdateAccounts(func(f *core.AccountsFile) error {
		f.Accounts["claudecode-work"] = core.AccountEntry{Type: TypeName, Settings: map[string]any{configDirSetting: work}}
		f.Accounts["claudecode-x"] = core.AccountEntry{Type: TypeName, Settings: map[string]any{configDirSetting: extra}}
		f.Accounts["other"] = core.AccountEntry{Type: "openaicodex", Settings: map[string]any{configDirSetting: "/nope"}}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// The accounts in the order of their folders' paths.
	want := []string{provider.CanonicalDir(filepath.Join(home, ".claude")), work, extra, found}
	if got := ConfigDirs(); !slices.Equal(got, want) {
		t.Fatalf("ConfigDirs =\n %q\nwant\n %q", got, want)
	}
}

// TestJugglerSessionUUIDsReadsEverySidecar pins which claude sessions count as
// Juggler's own for a project: the one named by every conversation's sidecar,
// open or binned, and by a legacy flat sidecar — and nothing from a folder
// that is not a conversation's.
func TestJugglerSessionUUIDsReadsEverySidecar(t *testing.T) {
	userpathstest.Isolate(t)
	t.Setenv(projectpaths.StateDirEnv, "")
	project := t.TempDir()
	state := projectpaths.StateDir(project)
	write := func(path, uuid string) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(`{"sessionUUID":"`+uuid+`","sentCount":1}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(state, core.BuildDirName("Open", "conv_a"), "claude_session.json"), "u-open")
	write(filepath.Join(core.ConvBinDir(state), core.BuildDirName("Binned", "conv_b"), "claude_session.json"), "u-binned")
	write(filepath.Join(state, "conv_c.claudecode.json"), "u-legacy")
	write(filepath.Join(state, "plugins", "claude_session.json"), "u-stray")

	got := JugglerSessionUUIDs(project)
	want := map[string]bool{"u-open": true, "u-binned": true, "u-legacy": true}
	if len(got) != len(want) {
		t.Fatalf("JugglerSessionUUIDs = %v; want %v", got, want)
	}
	for uuid := range want {
		if !got[uuid] {
			t.Fatalf("JugglerSessionUUIDs = %v; missing %q", got, uuid)
		}
	}
	if got := JugglerSessionUUIDs(t.TempDir()); got == nil || len(got) != 0 {
		t.Fatalf("a project with no state folder: %v; want an empty set", got)
	}
}
