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

// writeGitignore writes root/.gitignore with the given content.
func writeGitignore(t *testing.T, root, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeTree(t *testing.T, root string, rels []string) {
	t.Helper()
	for _, rel := range rels {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// TestFileWatcher_IndexBuildsFromTree checks the construction-time BFS walk
// populates the index across the whole tree (deep files included) while
// honoring the skip-list. No file events are involved — this is deterministic.
func TestFileWatcher_IndexBuildsFromTree(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, []string{
		"web/js/components/git/git-status-card.js",
		"node_modules/pkg/junk-widget.js", // skipped subtree
		"src/main.go",
	})

	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Stop()

	// Deep file is found and ranks first for a near-unique substring.
	got := searchPaths(w.Index(), "git-status", 20)
	if len(got) == 0 || got[0] != "web/js/components/git/git-status-card.js" {
		t.Fatalf("expected deep file ranked first, got %v", got)
	}

	// node_modules contents are excluded by the skip-list.
	if got := searchPaths(w.Index(), "junk-widget", 20); len(got) != 0 {
		t.Errorf("skip-listed subtree should not be indexed, got %v", got)
	}
}

// TestFileWatcher_StopReclaimsIndexWithoutStart guards against an index
// goroutine leak: the index goroutine starts at construction, so Stop() must
// reclaim it even when Start() (hence watchLoop) was never called.
func TestFileWatcher_StopReclaimsIndexWithoutStart(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, []string{"a.go"})

	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately do NOT call Start().
	w.Stop()

	select {
	case <-w.index.stopped:
		// Owner goroutine exited — reclaimed, no leak.
	case <-time.After(2 * time.Second):
		t.Fatal("index goroutine not reclaimed after Stop() without Start()")
	}
}

// TestFileWatcher_GitignoredNotIndexed checks the construction-time walk skips
// gitignored files and directories (they must not appear in @-completion).
func TestFileWatcher_GitignoredNotIndexed(t *testing.T) {
	root := t.TempDir()
	writeGitignore(t, root, "secret/\n*.log\n")
	writeTree(t, root, []string{
		"secret/hidden-widget.go", // in an ignored dir
		"app-debug.log",           // ignored by *.log
		"visible-widget.go",       // tracked
	})

	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Stop()

	if got := searchPaths(w.Index(), "hidden-widget", 20); len(got) != 0 {
		t.Errorf("gitignored dir should not be indexed, got %v", got)
	}
	if got := searchPaths(w.Index(), "app-debug", 20); len(got) != 0 {
		t.Errorf("gitignored *.log should not be indexed, got %v", got)
	}
	if got := searchPaths(w.Index(), "visible-widget", 20); !contains(got, "visible-widget.go") {
		t.Errorf("tracked file should be indexed, got %v", got)
	}
}

// TestFileWatcher_RebuildPicksUpGitignoreChange verifies that rebuilding with a
// fresh matcher (the .gitignore-change code path) re-evaluates the tree.
func TestFileWatcher_RebuildPicksUpGitignoreChange(t *testing.T) {
	root := t.TempDir()
	writeGitignore(t, root, "secret/\n")
	writeTree(t, root, []string{"secret/hidden-widget.go", "visible-widget.go"})

	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Stop()

	if got := searchPaths(w.Index(), "hidden-widget", 20); len(got) != 0 {
		t.Fatalf("precondition: secret/ should be ignored, got %v", got)
	}

	// Un-ignore secret/ (empty .gitignore; different size busts the parse cache)
	// and rebuild — the previously ignored file should now be indexed.
	writeGitignore(t, root, "")
	w.rebuild()
	if got := searchPaths(w.Index(), "hidden-widget", 20); !contains(got, "secret/hidden-widget.go") {
		t.Errorf("after un-ignoring, secret/hidden-widget.go should be indexed, got %v", got)
	}

	// Now ignore visible/ instead — the rebuild should drop it.
	writeGitignore(t, root, "visible-widget.go\n")
	w.rebuild()
	if got := searchPaths(w.Index(), "visible-widget", 20); len(got) != 0 {
		t.Errorf("after ignoring, visible-widget.go should be dropped, got %v", got)
	}
}

// TestFileWatcher_CreatedIgnoredFileNotAdded checks the incremental create path
// consults the matcher so a newly created ignored file never enters the index.
func TestFileWatcher_CreatedIgnoredFileNotAdded(t *testing.T) {
	root := t.TempDir()
	writeGitignore(t, root, "*.log\n")
	writeTree(t, root, []string{"seed.go"})

	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Stop()

	// Simulate the create-event index path for both an ignored and a tracked file.
	writeTree(t, root, []string{"fresh-debug.log", "fresh-widget.go"})
	w.indexCreated(filepath.Join(root, "fresh-debug.log"))
	w.indexCreated(filepath.Join(root, "fresh-widget.go"))

	if got := searchPaths(w.Index(), "fresh-debug", 20); len(got) != 0 {
		t.Errorf("created gitignored file should not be indexed, got %v", got)
	}
	if got := searchPaths(w.Index(), "fresh-widget", 20); !contains(got, "fresh-widget.go") {
		t.Errorf("created tracked file should be indexed, got %v", got)
	}
}

// TestFileWatcher_FileInNewDirectoryIsReported covers `mkdir -p dir && write
// dir/file`: the file lands before the new directory is watched, so its own
// create event never fires, and the only event there is is the directory's.
// That one event has to report the file too, or a viewer waiting on it — a pin
// on a file the agent is about to write — never hears that it arrived.
func TestFileWatcher_FileInNewDirectoryIsReported(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, []string{"seed.go"})

	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Stop()

	writeTree(t, root, []string{"reports/q3/chart.html", "reports/.draft.html"})
	w.handleEvent(fsnotify.Event{Name: filepath.Join(root, "reports"), Op: fsnotify.Create})

	got := map[string]string{}
	for len(w.changeChan) > 0 {
		for _, change := range (<-w.changeChan).Changes {
			got[filepath.ToSlash(change.Path)] = change.Event
		}
	}
	for _, want := range []string{"reports", "reports/q3", "reports/q3/chart.html"} {
		if got[want] != "create" {
			t.Errorf("expected a create for %s, got %v", want, got)
		}
	}
	if _, ok := got["reports/.draft.html"]; ok {
		t.Errorf("a hidden file in a new directory should not be reported, got %v", got)
	}
}

// TestFileWatcher_ScheduleRebuildSignals checks the debounce timer eventually
// signals watchLoop to rebuild (without depending on fsnotify delivery).
func TestFileWatcher_ScheduleRebuildSignals(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, []string{"a.go"})
	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Stop()

	w.scheduleRebuild()
	select {
	case <-w.rebuildC:
		// Debounce fired and signalled a rebuild.
	case <-time.After(3 * time.Second):
		t.Fatal("scheduleRebuild did not signal within the debounce window")
	}
}

// TestIsIgnoreFile checks the ignore-file detector.
func TestIsIgnoreFile(t *testing.T) {
	cases := map[string]bool{
		"/proj/.gitignore":        true,
		"/proj/sub/.gitignore":    true,
		"/proj/.git/info/exclude": true,
		"/proj/src/main.go":       false,
		"/proj/gitignore":         false,
		"/proj/.gitignore.bak":    false,
	}
	for p, want := range cases {
		if got := isIgnoreFile(p); got != want {
			t.Errorf("isIgnoreFile(%q) = %v, want %v", p, got, want)
		}
	}
}
