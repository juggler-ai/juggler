//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"juggler/internal/userpaths/userpathstest"
)

// newTestRecentsStore points the per-user home at a fresh temp dir so the store
// reads/writes an isolated recents.json.
func newTestRecentsStore(t *testing.T) *RecentsStore {
	t.Helper()
	userpathstest.Isolate(t)
	s, err := NewRecentsStore()
	if err != nil {
		t.Fatalf("NewRecentsStore: %v", err)
	}
	return s
}

func assertRecents(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("recents = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("recents = %v, want %v", got, want)
		}
	}
}

// TestPruneDropsMissingFolders removes a still-present folder's sibling from
// disk and confirms Prune drops exactly the vanished entry while preserving the
// most-recent ordering of the survivors, and persists the pruned list.
func TestPruneDropsMissingFolders(t *testing.T) {
	s := newTestRecentsStore(t)

	live := t.TempDir()
	gone := t.TempDir()
	// Add oldest-first so the most-recent-first list is [gone, live].
	if err := s.Add(live); err != nil {
		t.Fatalf("Add live: %v", err)
	}
	if err := s.Add(gone); err != nil {
		t.Fatalf("Add gone: %v", err)
	}
	if err := os.RemoveAll(gone); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}

	got, err := s.Prune()
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	assertRecents(t, got, []string{live})

	// The pruned list must be persisted, not just returned.
	reloaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	assertRecents(t, reloaded, []string{live})
}

// TestPruneDropsFileEntries drops an entry that now points at a regular file
// rather than a directory (it can never be a project folder).
func TestPruneDropsFileEntries(t *testing.T) {
	s := newTestRecentsStore(t)

	dir := t.TempDir()
	file := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := s.Add(dir); err != nil {
		t.Fatalf("Add dir: %v", err)
	}
	if err := s.Add(file); err != nil {
		t.Fatalf("Add file: %v", err)
	}

	got, err := s.Prune()
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	assertRecents(t, got, []string{dir})
}

// TestPruneKeepsAllLiveFolders is a no-op when every folder still exists, and
// leaves the on-disk file untouched.
func TestPruneKeepsAllLiveFolders(t *testing.T) {
	s := newTestRecentsStore(t)

	a := t.TempDir()
	b := t.TempDir()
	if err := s.Add(a); err != nil {
		t.Fatalf("Add a: %v", err)
	}
	if err := s.Add(b); err != nil {
		t.Fatalf("Add b: %v", err)
	}

	got, err := s.Prune()
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	assertRecents(t, got, []string{b, a})
}

// TestRecentsTouchMovesToFrontAndStamps: a touch puts its path first and
// records when, which the sessions page shows as the project's age; Prune
// keeps the times of the folders it keeps.
func TestRecentsTouchMovesToFrontAndStamps(t *testing.T) {
	s := newTestRecentsStore(t)
	base := t.TempDir()
	a, b := filepath.Join(base, "a"), filepath.Join(base, "b")
	for _, p := range []string{a, b} {
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t1 := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	t2 := t1.Add(time.Hour)
	for _, step := range []struct {
		path string
		at   time.Time
	}{{a, t1}, {b, t1}, {a, t2}} {
		if err := s.Touch(step.path, step.at); err != nil {
			t.Fatal(err)
		}
	}
	paths, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	assertRecents(t, paths, []string{a, b})
	check := func(when string) {
		t.Helper()
		used, err := s.Used()
		if err != nil {
			t.Fatal(err)
		}
		if !used[a].Equal(t2) || !used[b].Equal(t1) || len(used) != 2 {
			t.Fatalf("%s: used = %v, want %s at %s and %s at %s", when, used, a, t2, b, t1)
		}
	}
	check("touched")
	if _, err := s.Prune(); err != nil {
		t.Fatal(err)
	}
	check("pruned")
}
