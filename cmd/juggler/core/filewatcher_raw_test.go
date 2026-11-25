//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"

	"github.com/fsnotify/fsnotify"
)

// git's status covers tracked files the viewers' stream never mentions — a
// workflow under .github, a dotfile at the root, .gitignore itself — so the raw
// feed carries them, and only it does: the viewers' stream and the "@" index stay
// exactly as hidden-blind as they were. git's own directory and Juggler's state
// are on neither.
//
// handleEvent emits synchronously, so "nothing was reported" is read without
// waiting: whatever an event produced is already in the channel when it returns.

// rawFeedWatcher builds a watcher with the raw feed on, over a tree holding rels.
func rawFeedWatcher(t *testing.T, opts FileWatcherOptions, rels ...string) (*FileWatcher, string) {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{".juggler", ".git"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeTree(t, root, rels)
	opts.RawFeed = true
	w, err := NewFileWatcherWith(root, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Stop)
	return w, root
}

// drainRaw returns every absolute path the raw feed holds right now.
func drainRaw(w *FileWatcher) []string {
	var paths []string
	for {
		select {
		case c := <-w.RawChanges():
			paths = append(paths, c.Path)
		default:
			return paths
		}
	}
}

// drainViewers returns every path the viewers' stream holds right now.
func drainViewers(w *FileWatcher) []string {
	var paths []string
	for {
		select {
		case n := <-w.Changes():
			for _, c := range n.Changes {
				paths = append(paths, filepath.ToSlash(c.Path))
			}
		default:
			return paths
		}
	}
}

func TestFileWatcher_RawFeedCarriesWhatGitStatusCovers(t *testing.T) {
	w, root := rawFeedWatcher(t, FileWatcherOptions{}, ".github/workflows/ci.yml", ".eslintrc", "src/a.go")

	cases := []struct {
		rel         string
		toRaw       bool
		toViewers   bool
		description string
	}{
		{".github/workflows/ci.yml", true, false, "a tracked file in a dot-directory"},
		{".eslintrc", true, false, "a dotfile at the root"},
		{".gitignore", true, false, "the ignore file itself"},
		{"src/a.go", true, true, "an ordinary file"},
		{".juggler/MEMORY.md", true, true, "the allowlisted memory file"},
		{".juggler/session.json", false, false, "Juggler's own state"},
		{".git/index", false, false, "git's own directory"},
		{"src/.git", false, false, "a nested repository's .git file"},
	}
	for _, tc := range cases {
		feed(w, root, tc.rel, fsnotify.Write)
		raw, viewers := drainRaw(w), drainViewers(w)
		abs := filepath.Join(root, filepath.FromSlash(tc.rel))
		if got := slices.Contains(raw, abs); got != tc.toRaw {
			t.Errorf("%s (%s): on the raw feed = %v, want %v (feed held %v)", tc.description, tc.rel, got, tc.toRaw, raw)
		}
		if got := slices.Contains(viewers, tc.rel); got != tc.toViewers {
			t.Errorf("%s (%s): on the viewers' stream = %v, want %v (stream held %v)", tc.description, tc.rel, got, tc.toViewers, viewers)
		}
	}
}

// A dot-directory has to be watched for its files' events to arrive at all;
// git's directory and Juggler's state never are, and nothing hidden is indexed.
func TestFileWatcher_RawFeedWatchesDotDirectoriesWithoutIndexingThem(t *testing.T) {
	w, root := rawFeedWatcher(t, FileWatcherOptions{}, ".github/workflows/ci.yml", ".git/HEAD", "src/a.go")

	watched := w.watcher.WatchList()
	if !slices.Contains(watched, filepath.Join(root, ".github", "workflows")) {
		t.Errorf("the dot-directory .github/workflows is not watched; watching %v", watched)
	}
	if slices.Contains(watched, filepath.Join(root, ".git")) {
		t.Error("git's own directory is watched")
	}
	if got := searchPaths(w.Index(), "ci.yml", 20); len(got) != 0 {
		t.Errorf("a hidden file was indexed: %v", got)
	}
}

// A directory made inside a dot-directory is watched as it appears, so the
// file written into it next is heard.
func TestFileWatcher_RawFeedFollowsNewDotDirectories(t *testing.T) {
	w, root := rawFeedWatcher(t, FileWatcherOptions{}, ".github/ci.yml")
	dir := filepath.Join(root, ".github", "actions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	feed(w, root, ".github/actions", fsnotify.Create)

	if !slices.Contains(w.watcher.WatchList(), dir) {
		t.Error("a directory created under .github is not watched")
	}
	if viewers := drainViewers(w); len(viewers) != 0 {
		t.Errorf("the viewers' stream heard of a hidden directory: %v", viewers)
	}
}

// A file git ignores changes nothing git reports, so a build writing its
// output is not a stream of status reads.
func TestFileWatcher_RawFeedSkipsIgnoredFiles(t *testing.T) {
	w, root := rawFeedWatcher(t, FileWatcherOptions{}, "src/a.go")
	writeGitignore(t, root, "*.o\n")
	w.rebuild("a test")

	feed(w, root, "src/a.o", fsnotify.Write)
	if raw := drainRaw(w); len(raw) != 0 {
		t.Errorf("an ignored file reached the raw feed: %v", raw)
	}
}

// An fsnotify error means events may be missing, so the watcher recovers: a
// directory whose create went unheard is watched and indexed, and the raw feed
// says EventsLost. The directory is made while nothing takes events (watchLoop
// is not started), so the walk is the only way it can be found.
//
// The error goes in through noteError, as pumpEvents hands it on: never sent
// on fsnotify's Errors channel, which its backend goroutine closes on Stop with
// nothing ordering an outside send before that close.
func TestFileWatcher_AnErrorRecoversWhatItMayHaveCost(t *testing.T) {
	w, root := rawFeedWatcher(t, FileWatcherOptions{}, "src/a.go")
	dir := filepath.Join(root, "unheard")
	writeTree(t, root, []string{"unheard/lost-widget.go"})

	w.noteError(fsnotify.ErrEventOverflow)
	<-w.lostC
	w.recoverLost()

	if !slices.Contains(w.watcher.WatchList(), dir) {
		t.Error("a directory made while events were lost is not watched")
	}
	if got := searchPaths(w.Index(), "lost-widget", 20); !contains(got, "unheard/lost-widget.go") {
		t.Errorf("a file made while events were lost is not indexed: %v", got)
	}
	var lost bool
	for {
		select {
		case c := <-w.RawChanges():
			lost = lost || (c.Event == EventsLost && c.Path == root)
			continue
		default:
		}
		break
	}
	if !lost {
		t.Error("the raw feed did not say events were lost")
	}
}

// Without the raw feed nothing changes: no channel, no dot-directories watched.
func TestFileWatcher_NoRawFeedByDefault(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, []string{".github/workflows/ci.yml"})
	w, err := newFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Stop)

	if w.RawChanges() != nil {
		t.Error("a watcher without the raw feed has a raw channel")
	}
	if slices.Contains(w.watcher.WatchList(), filepath.Join(root, ".github", "workflows")) {
		t.Error("a watcher without the raw feed watches dot-directories")
	}
}

// A tree that is not the project's is watched for its raw feed alone, and builds no
// index nobody will search.
func TestFileWatcher_NoIndexBuildsNone(t *testing.T) {
	w, root := rawFeedWatcher(t, FileWatcherOptions{NoIndex: true}, "src/main.go", "docs/readme.md")

	if got := searchPaths(w.Index(), "main", 20); len(got) != 0 {
		t.Errorf("an unindexed watcher indexed %v", got)
	}
	writeTree(t, root, []string{"src/new.go"})
	feed(w, root, "src/new.go", fsnotify.Create)
	if got := searchPaths(w.Index(), "new", 20); len(got) != 0 {
		t.Errorf("an unindexed watcher indexed a created file: %v", got)
	}
	if raw := drainRaw(w); !slices.Contains(raw, filepath.Join(root, "src", "new.go")) {
		t.Errorf("the created file never reached the raw feed: %v", raw)
	}
}

// A tree too big to watch whole says so, because events from the part left
// unwatched never arrive and something else has to cover it.
func TestFileWatcher_SaysWhenTheWatchWasCapped(t *testing.T) {
	small, _ := rawFeedWatcher(t, FileWatcherOptions{NoIndex: true}, "a/x.go")
	if small.WatchCapped() {
		t.Error("a two-directory tree reports a capped watch")
	}

	rels := make([]string, 0, maxWatchedDirs+1)
	for i := 0; i <= maxWatchedDirs; i++ {
		rels = append(rels, "d/n"+strconv.Itoa(i)+"/f")
	}
	big, _ := rawFeedWatcher(t, FileWatcherOptions{NoIndex: true}, rels...)
	if !big.WatchCapped() {
		t.Error("a tree past the directory cap does not report a capped watch")
	}
}
