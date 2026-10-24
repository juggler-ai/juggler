//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// The project memory file lives at .juggler/MEMORY.md — inside a dot-directory
// the watcher skips wholesale, three times in the walk and once more per event.
// So the one file in there a user edits by hand was the one file the UI could
// never be told about.
//
// The fix is an allowlist, not an un-skip: .juggler/ is written continuously by
// Juggler itself, so un-skipping it would trade a dead notification for a flood.
// These tests pin both halves — the one file reported, and everything else in
// that directory still silent.
//
// They drive handleEvent directly rather than waiting on fsnotify delivery,
// which is what makes them deterministic; the existing suite takes the same
// approach.

// watcherForEvents builds a watcher over a project that already has a .juggler
// directory, ready to be handed synthetic events.
func watcherForEvents(t *testing.T, rels ...string) (*FileWatcher, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".juggler"), 0o755); err != nil {
		t.Fatal(err)
	}
	if len(rels) > 0 {
		writeTree(t, root, rels)
	}
	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Stop)
	return w, root
}

// feed hands the watcher one synthetic event for a project-relative path.
func feed(w *FileWatcher, root, rel string, op fsnotify.Op) {
	w.handleEvent(fsnotify.Event{Name: filepath.Join(root, filepath.FromSlash(rel)), Op: op})
}

// nextChange returns the one change the watcher reported, or fails if it
// reported none.
func nextChange(t *testing.T, w *FileWatcher) FileChange {
	t.Helper()
	select {
	case n := <-w.Changes():
		if len(n.Changes) != 1 {
			t.Fatalf("expected one change, got %d", len(n.Changes))
		}
		return n.Changes[0]
	case <-time.After(time.Second):
		t.Fatal("the watcher reported nothing")
		return FileChange{}
	}
}

// assertSilent fails if the watcher reported anything at all.
func assertSilent(t *testing.T, w *FileWatcher, what string) {
	t.Helper()
	select {
	case n := <-w.Changes():
		t.Fatalf("%s: expected silence, got %+v", what, n.Changes)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestFileWatcher_MemoryFileIsReported(t *testing.T) {
	w, root := watcherForEvents(t)

	feed(w, root, ".juggler/MEMORY.md", fsnotify.Write)

	change := nextChange(t, w)
	if filepath.ToSlash(change.Path) != ".juggler/MEMORY.md" {
		t.Errorf("path = %q", change.Path)
	}
	if change.Event != "write" {
		t.Errorf("event = %q, want write", change.Event)
	}
}

// The two project env files are edited by hand too, and the env pin redraws
// from these events; the approval store and the user's own env.json live in the
// config dir, outside any project.
func TestFileWatcher_ProjectEnvFilesAreReported(t *testing.T) {
	for _, rel := range []string{".juggler/env.json", ".juggler/env.local.json"} {
		t.Run(rel, func(t *testing.T) {
			w, root := watcherForEvents(t)
			feed(w, root, rel, fsnotify.Write)
			if got := filepath.ToSlash(nextChange(t, w).Path); got != rel {
				t.Errorf("path = %q, want %q", got, rel)
			}
		})
	}
}

// A hand edit is a write, but the file can also be replaced wholesale by an
// editor that writes a temporary file and renames it over the top.
func TestFileWatcher_MemoryFileIsReportedForEveryKindOfChange(t *testing.T) {
	for _, tc := range []struct {
		op   fsnotify.Op
		want string
	}{
		{fsnotify.Write, "write"},
		{fsnotify.Create, "create"},
		{fsnotify.Remove, "remove"},
		{fsnotify.Rename, "rename"},
	} {
		t.Run(tc.want, func(t *testing.T) {
			w, root := watcherForEvents(t)
			feed(w, root, ".juggler/MEMORY.md", tc.op)
			if got := nextChange(t, w).Event; got != tc.want {
				t.Errorf("event = %q, want %q", got, tc.want)
			}
		})
	}
}

// Everything else Juggler writes into .juggler/ stays silent. This is the half
// that makes the allowlist worth having rather than un-skipping the directory:
// each of these is written many times per turn.
func TestFileWatcher_TheRestOfJugglersOwnDirectoryStaysSilent(t *testing.T) {
	for _, rel := range []string{
		".juggler/session.json",
		".juggler/config.json",
		".juggler/instance.json",
		".juggler/juggler.lock",
		".juggler/My conversation--conv_abc/doc.bin",
		".juggler/My conversation--conv_abc/txns/txn_1.json",
		".juggler/trash/old--conv_def/doc.bin",
	} {
		t.Run(rel, func(t *testing.T) {
			w, root := watcherForEvents(t)
			feed(w, root, rel, fsnotify.Write)
			assertSilent(t, w, rel)
		})
	}
}

// The allowlist is one exact path, not a filename. A MEMORY.md somewhere else
// under a dot-directory is not the project's memory file and is not reported —
// nor is a conversation directory that happens to contain one.
func TestFileWatcher_OnlyThatExactPathIsAllowlisted(t *testing.T) {
	for _, rel := range []string{
		".config/MEMORY.md",
		".juggler/memory.md",
		".juggler/MEMORY.md.bak",
		".juggler/notes/MEMORY.md",
		".juggler/My conversation--conv_abc/MEMORY.md",
	} {
		t.Run(rel, func(t *testing.T) {
			w, root := watcherForEvents(t)
			feed(w, root, rel, fsnotify.Write)
			assertSilent(t, w, rel)
		})
	}
}

// The index is what @-mention completion searches. A hidden file has no business
// appearing there just because the UI wants to know when it changes.
//
// Two independent things keep it out: handleEvent returns after reporting an
// allowlisted path rather than falling through to the indexer, and
// gitignore.Matcher ignores `.juggler` at any depth regardless (gitignore.go:81),
// which indexCreated consults. Removing the first alone therefore changes
// nothing observable — the property is true twice over, and this case asserts
// the property rather than either guard.
func TestFileWatcher_MemoryFileNeverEntersTheIndex(t *testing.T) {
	w, root := watcherForEvents(t, "src/main.go")

	// The file has to exist on disk: the indexing path stats before it adds, so
	// without this the case would pass for the wrong reason.
	writeTree(t, root, []string{".juggler/MEMORY.md"})

	feed(w, root, ".juggler/MEMORY.md", fsnotify.Create)
	nextChange(t, w) // the report is expected; the index entry is not

	if got := searchPaths(w.Index(), "MEMORY", 20); len(got) != 0 {
		t.Fatalf("the memory file must stay out of @-completion, got %v", got)
	}
}

// fsnotify watches directories, so the allowlisted file's parent has to be
// watched explicitly — the walk that registers the rest never descends into it.
func TestFileWatcher_TheMemoryDirectoryIsWatched(t *testing.T) {
	w, root := watcherForEvents(t, "src/main.go")

	want := filepath.Join(root, ".juggler")
	for _, dir := range w.watcher.WatchList() {
		if dir == want {
			return
		}
	}
	t.Fatalf("%s is not watched, so nothing in it can ever be noticed: %v", want, w.watcher.WatchList())
}

// A project without a .juggler directory must still come up; the watch is simply
// not registered, and the walk is unaffected.
func TestFileWatcher_AMissingMemoryDirectoryIsNotAnError(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, []string{"src/main.go"})
	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatalf("a project with no .juggler directory must still be watchable: %v", err)
	}
	defer w.Stop()

	if got := searchPaths(w.Index(), "main.go", 20); len(got) != 1 {
		t.Fatalf("the ordinary walk is unaffected, got %v", got)
	}
}

// The ordinary path is unchanged: a visible file is reported and indexed, and a
// hidden one outside the allowlist is still skipped.
func TestFileWatcher_OrdinaryEventsAreUnchanged(t *testing.T) {
	w, root := watcherForEvents(t, "src/main.go")

	feed(w, root, "src/main.go", fsnotify.Write)
	if got := nextChange(t, w); filepath.ToSlash(got.Path) != "src/main.go" || got.Event != "write" {
		t.Fatalf("an ordinary write is still reported, got %+v", got)
	}

	feed(w, root, ".env", fsnotify.Write)
	assertSilent(t, w, ".env")

	feed(w, root, "src/main.go", fsnotify.Chmod)
	assertSilent(t, w, "a chmod")
}

// eventKind is the classification the allowlist branches on before deciding
// whether an event is one to index, so it has to be exactly what the switch it
// replaced reported.
func TestEventKind(t *testing.T) {
	cases := []struct {
		op   fsnotify.Op
		want string
	}{
		{fsnotify.Write, "write"},
		{fsnotify.Create, "create"},
		{fsnotify.Remove, "remove"},
		{fsnotify.Rename, "rename"},
		{fsnotify.Chmod, ""},
		{0, ""},
		// Write wins when several bits are set, as it did before.
		{fsnotify.Write | fsnotify.Chmod, "write"},
		{fsnotify.Create | fsnotify.Write, "write"},
	}
	for _, tc := range cases {
		if got := eventKind(fsnotify.Event{Op: tc.op}); got != tc.want {
			t.Errorf("eventKind(%v) = %q, want %q", tc.op, got, tc.want)
		}
	}
}

// Watching the allowlisted file's directory means events from inside a
// dot-directory reach handleEvent for the first time. A basename check would
// have passed every one of .juggler/'s own writes through, so the skip reads the
// whole path.
func TestHasHiddenSegment(t *testing.T) {
	cases := map[string]bool{
		"src/main.go":             false,
		"web/js/app.js":           false,
		".env":                    true,
		"src/.env":                true,
		".juggler/session.json":   true,
		".juggler/MEMORY.md":      true, // hidden; the allowlist is what rescues it
		".git/config":             true,
		"a/.hidden/b/c.txt":       true,
		"not.hidden/file.go":      false,
		"dir.with.dots/file.go":   false,
		"./src/main.go":           false,
		"..secret/file":           true,
		"node_modules/pkg/why.js": false,
	}
	for rel, want := range cases {
		if got := hasHiddenSegment(rel); got != want {
			t.Errorf("hasHiddenSegment(%q) = %v, want %v", rel, got, want)
		}
	}
}

func TestWatchedHiddenDirs(t *testing.T) {
	dirs := watchedHiddenDirs()
	if len(dirs) != 1 || dirs[0] != ".juggler" {
		t.Fatalf("got %v, want one entry for .juggler", dirs)
	}
	for rel := range watchedHiddenFiles {
		if filepath.ToSlash(filepath.Dir(rel)) != dirs[0] {
			t.Errorf("%s is allowlisted but its directory is never watched", rel)
		}
	}
}
