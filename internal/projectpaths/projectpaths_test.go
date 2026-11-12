//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package projectpaths

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveStateBasePerPlatform(t *testing.T) {
	const home = "/home/u"
	noenv := func(string) string { return "" }
	env := func(pairs map[string]string) func(string) string {
		return func(k string) string { return pairs[k] }
	}
	cases := []struct {
		name   string
		goos   string
		home   string
		getenv func(string) string
		want   string
	}{
		{"macOS", "darwin", home, noenv,
			filepath.Join(home, "Library", "Application Support", "Juggler", "projects")},
		{"linux default (XDG state)", "linux", home, noenv,
			filepath.Join(home, ".local", "state", "juggler", "projects")},
		{"linux honours XDG_STATE_HOME", "linux", home,
			env(map[string]string{"XDG_STATE_HOME": "/xdg/state"}),
			filepath.Join("/xdg/state", "juggler", "projects")},
		{"windows LOCALAPPDATA", "windows", home,
			env(map[string]string{"LOCALAPPDATA": `C:\Users\u\AppData\Local`}),
			filepath.Join(`C:\Users\u\AppData\Local`, "Juggler", "projects")},
		{"windows without LOCALAPPDATA", "windows", home, noenv,
			filepath.Join(home, "AppData", "Local", "Juggler", "projects")},
		{"homeless falls back to temp", "darwin", "", noenv,
			filepath.Join(os.TempDir(), "juggler-projects")},
		{"override wins everywhere", "linux", home,
			env(map[string]string{StateDirEnv: "/elsewhere", "XDG_STATE_HOME": "/xdg/state"}),
			"/elsewhere"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveStateBase(c.goos, c.home, c.getenv); got != c.want {
				t.Errorf("resolveStateBase(%q) = %q, want %q", c.goos, got, c.want)
			}
		})
	}
}

// The outside folder decides placement by existing: every process resolving a
// project must agree on one folder without reading settings, so state is never
// split between the project and the outside folder.
func TestForResolvesByExistenceOfOutsideFolder(t *testing.T) {
	base := t.TempDir()
	t.Setenv(StateDirEnv, base)
	project := t.TempDir()

	d := For(project)
	if d.Outside() || d.State != filepath.Join(project, ".juggler") {
		t.Fatalf("no outside folder: For = %+v, want state in the project", d)
	}

	outside := filepath.Join(base, Slug(project))
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	d = For(project)
	if !d.Outside() || d.State != outside || d.Shared != filepath.Join(project, ".juggler") {
		t.Fatalf("outside folder exists: For = %+v, want State %q", d, outside)
	}

	// A file squatting on the name is not a state folder.
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(base, Slug(other)), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if For(other).Outside() {
		t.Fatal("a plain file at the outside path must not count as the state folder")
	}
}

func TestSlugStableAndCollisionResistant(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "one", "app")
	b := filepath.Join(root, "two", "app")
	if Slug(a) != Slug(a+string(filepath.Separator)+".") {
		t.Errorf("Slug must ignore an un-cleaned spelling of the same path")
	}
	if Slug(a) == Slug(b) {
		t.Errorf("projects sharing a basename must not share a slug: %q", Slug(a))
	}
}
