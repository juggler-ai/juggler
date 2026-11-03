//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// projectKeyPattern is the shape of every key: a slug, a dash, eight hex digits.
var projectKeyPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$`)

// TestProjectKeyIsStableReadableAndPrivate: a project's key is the same every
// time it is asked for — the point of a link a person bookmarks — and reads as
// the folder's name, but names nothing above that folder, and two folders of
// one name still get different keys.
func TestProjectKeyIsStableReadableAndPrivate(t *testing.T) {
	a := "/Users/someone/clients/acme/myapp"
	b := "/Users/someone/scratch/myapp"
	if k1, k2 := projectKey(a), projectKey(a); k1 != k2 {
		t.Fatalf("projectKey(%q) = %q then %q, want one key", a, k1, k2)
	}
	ka, kb := projectKey(a), projectKey(b)
	if ka == kb {
		t.Fatalf("two folders named myapp share the key %q", ka)
	}
	for _, k := range []string{ka, kb} {
		if !strings.HasPrefix(k, "myapp-") || !projectKeyPattern.MatchString(k) {
			t.Errorf("key %q: want myapp-<8 hex>", k)
		}
		for _, part := range []string{"someone", "clients", "acme", "scratch", "Users"} {
			if strings.Contains(k, strings.ToLower(part)) {
				t.Errorf("key %q names the parent folder %q", k, part)
			}
		}
	}
	if got, want := projectLink(a), "/p/"+ka+"/"; got != want {
		t.Errorf("projectLink(%q) = %q, want %q", a, got, want)
	}
}

// TestProjectKeySlugIsURLSafe: whatever the folder is called, its key is plain
// lowercase letters, digits and single dashes, short enough to read, and never
// empty.
func TestProjectKeySlugIsURLSafe(t *testing.T) {
	for _, c := range []struct{ path, slug string }{
		{"/home/u/My Project", "my-project"},
		{"/home/u/site.example.com", "site-example-com"},
		{"/home/u/--weird__name--", "weird-name"},
		{"/home/u/café", "caf"},
		{"/home/u/日本語", "project"},
		{"/", "project"},
		{"/home/u/" + strings.Repeat("a", 100), strings.Repeat("a", 40)},
	} {
		k := projectKey(c.path)
		if !projectKeyPattern.MatchString(k) {
			t.Errorf("projectKey(%q) = %q, not a clean key", c.path, k)
			continue
		}
		if got := k[:len(k)-len("-12345678")]; got != c.slug {
			t.Errorf("projectKey(%q) slug = %q, want %q", c.path, got, c.slug)
		}
	}
}

// TestRecentForKeyFindsRecentProjects: a key resolves to a project in the
// machine's recents whose folder is still there — what a link opens when the
// project has no session (a project that has one is the registry's to find,
// routeKey) — and to nothing otherwise.
func TestRecentForKeyFindsRecentProjects(t *testing.T) {
	home := userpathstest.Isolate(t)
	store, err := core.NewRecentsStore()
	if err != nil {
		t.Fatal(err)
	}
	recent, gone := filepath.Join(home, "recent"), filepath.Join(home, "gone")
	for _, p := range []string{recent, gone} {
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := store.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), recents: store}

	if got, ok := s.recentForKey(projectKey(recent)); !ok || got != recent {
		t.Errorf("recentForKey(key of %s) = %q, %v; want it", recent, got, ok)
	}
	for _, k := range []string{projectKey(gone), projectKey(filepath.Join(home, "elsewhere")), "", "recent", "../recent"} {
		if got, ok := s.recentForKey(k); ok {
			t.Errorf("recentForKey(%q) = %q, want no project", k, got)
		}
	}
	if got, ok := (&Server{reg: newRegistry()}).recentForKey(projectKey(recent)); ok {
		t.Errorf("a server keeping no recents found %q", got)
	}
}
