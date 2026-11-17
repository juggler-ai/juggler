//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A watcher keys every tree of a repository by the directory they share, so two
// trees of one repository have to name it identically however each was reached:
// git spells a main tree's directory relative to it and a linked tree's common
// directory absolutely, through whatever symbolic links lie in between (macOS
// keeps its temporary directories under one).
func TestGitDirsOfAMainTreeAndItsLinkedWorktree(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "one\n")
	p.commit("init")
	linked := filepath.Join(t.TempDir(), "linked")
	p.git("worktree", "add", "-q", "-b", "side", linked)

	mainGit, mainCommon, err := GitDirs(t.Context(), p.dir)
	if err != nil {
		t.Fatalf("GitDirs(main): %v", err)
	}
	linkedGit, linkedCommon, err := GitDirs(t.Context(), linked)
	if err != nil {
		t.Fatalf("GitDirs(linked): %v", err)
	}

	wantCommon := canonical(t, filepath.Join(p.dir, ".git"))
	if mainGit != wantCommon || mainCommon != wantCommon {
		t.Errorf("main tree: git dir %q, common dir %q; want both %q", mainGit, mainCommon, wantCommon)
	}
	if linkedCommon != mainCommon {
		t.Errorf("linked tree's common dir %q differs from the main tree's %q", linkedCommon, mainCommon)
	}
	if want := filepath.Join(wantCommon, "worktrees", "linked"); linkedGit != want {
		t.Errorf("linked tree's git dir = %q, want %q", linkedGit, want)
	}
}

// A directory that is no repository is said to be one, not answered with the
// repository above it or with nothing.
func TestGitDirsOutsideARepository(t *testing.T) {
	t.Parallel()
	if _, _, err := GitDirs(t.Context(), t.TempDir()); err == nil {
		t.Error("GitDirs succeeded in a directory that is no repository")
	}
}

// The watcher re-reads status whenever the index changes, so a status read that
// rewrote the index — even byte for byte, which still moves its timestamp and
// still fires the event — would have the watcher chasing its own tail. This is
// the one guarantee the watcher's loop rests on.
func TestGitStatusLeavesTheIndexAlone(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("kept.txt", "one\ntwo\n")
	p.write("edited.txt", "one\n")
	p.commit("init")
	p.write("edited.txt", "one\nEDITED\n")
	p.write("untracked.txt", "new\n")
	// The same temptation TestGitReviewChangesNothingOnDisk sets up: stale stat
	// information git would like to refresh and write back.
	p.write("kept.txt", "one\ntwo\n")
	p.backdate("kept.txt")

	index := filepath.Join(p.dir, ".git", "index")
	// Backdating the index makes a rewrite visible at any filesystem timestamp
	// resolution: whatever git writes is stamped now.
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(index, old, old); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}

	if repos := p.card(); len(repos) != 1 || repos[0].Changed == 0 {
		t.Fatalf("the status read saw nothing to report: %+v", repos)
	}

	after, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) || after.Size() != before.Size() {
		t.Errorf("the status read rewrote the index (%v, %d bytes → %v, %d bytes)",
			before.ModTime(), before.Size(), after.ModTime(), after.Size())
	}
}

// Repos is the card's own search, so the repositories a watcher reports changes
// in are named exactly as the card names them.
func TestReposNamesWhatTheCardNames(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "x\n")
	p.commit("init")
	p.nested("libs/inner").write("b.txt", "y\n")

	var fromCard []string
	for _, repo := range p.card() {
		fromCard = append(fromCard, repo.Path)
	}
	var fromRepos []string
	for _, dir := range Repos(t.Context(), p.root) {
		fromRepos = append(fromRepos, RepoPath(p.root, dir))
	}
	if len(fromRepos) != 2 || len(fromCard) != 2 {
		t.Fatalf("Repos named %v, the card %v; want two each", fromRepos, fromCard)
	}
	for i := range fromCard {
		if fromCard[i] != fromRepos[i] {
			t.Errorf("Repos named %v, the card %v", fromRepos, fromCard)
			break
		}
	}
}

// canonical resolves every symbolic link in an absolute path.
func canonical(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}
