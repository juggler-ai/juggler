//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// clashing is a repository whose current branch, main, and topic each change
// a.txt in two commits after init, so that merging, rebasing or picking one
// onto the other stops on a conflict. HEAD is on main.
func clashing(t *testing.T) *gitProject {
	t.Helper()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("init")
	p.git("branch", "-M", "main")
	p.git("switch", "-q", "-c", "topic")
	p.write("a.txt", "topic 1\n")
	p.commit("topic one")
	p.write("a.txt", "topic 2\n")
	p.commit("topic two")
	p.git("switch", "-q", "main")
	p.write("a.txt", "main\n")
	p.commit("main moves on")
	return p
}

// What is in progress is read in full: the branch it changes, the other side
// by name, the commit being applied, and how far a rebase has got.
func TestReadChangesStopped(t *testing.T) {
	t.Parallel()

	t.Run("none", func(t *testing.T) {
		t.Parallel()
		p := clashing(t)
		if c := p.changes(); c.Stopped != nil {
			t.Errorf("a tree with nothing in progress reads %+v", c.Stopped)
		}
	})

	t.Run("merge", func(t *testing.T) {
		t.Parallel()
		p := clashing(t)
		p.gitMayFail("merge", "topic")
		s := p.changes().Stopped
		if s == nil || s.Kind != "merge" || s.Branch != "main" || s.Other != "topic" || s.OtherSha != strings.TrimSpace(p.git("rev-parse", "topic")) {
			t.Fatalf("merge reads %+v", s)
		}
		if s.Commit != nil || s.Steps != 0 {
			t.Errorf("a merge has no commit being applied or steps: %+v", s)
		}
	})

	t.Run("rebase", func(t *testing.T) {
		t.Parallel()
		p := clashing(t)
		p.git("switch", "-q", "topic")
		first := strings.TrimSpace(p.git("rev-parse", "topic~1"))
		tip := strings.TrimSpace(p.git("rev-parse", "topic"))
		p.gitMayFail("rebase", "main")
		c := p.changes()
		s := c.Stopped
		if s == nil || s.Kind != "rebase" || s.Branch != "topic" || s.Other != "main" {
			t.Fatalf("rebase reads %+v", s)
		}
		if s.Step != 1 || s.Steps != 2 {
			t.Errorf("rebase step %d of %d, want 1 of 2", s.Step, s.Steps)
		}
		if s.Commit == nil || s.Commit.Sha != first || s.Commit.Subject != "topic one" {
			t.Errorf("rebase commit = %+v, want %s “topic one”", s.Commit, first)
		}
		if s.From != tip {
			t.Errorf("rebase from = %q, want topic's tip before it, %s", s.From, tip)
		}
	})

	t.Run("cherry-pick", func(t *testing.T) {
		t.Parallel()
		p := clashing(t)
		pick := strings.TrimSpace(p.git("rev-parse", "topic"))
		p.gitMayFail("cherry-pick", "topic")
		s := p.changes().Stopped
		if s == nil || s.Kind != "cherry-pick" || s.Branch != "main" || s.Commit == nil || s.Commit.Sha != pick || s.Commit.Subject != "topic two" {
			t.Fatalf("cherry-pick reads %+v", s)
		}
	})

	t.Run("revert", func(t *testing.T) {
		t.Parallel()
		p := clashing(t)
		p.git("switch", "-q", "topic")
		undo := strings.TrimSpace(p.git("rev-parse", "topic~1"))
		p.gitMayFail("revert", "--no-edit", "topic~1")
		s := p.changes().Stopped
		if s == nil || s.Kind != "revert" || s.Branch != "topic" || s.Commit == nil || s.Commit.Sha != undo || s.Commit.Subject != "topic one" {
			t.Fatalf("revert reads %+v", s)
		}
	})

	// The changes a write set aside before it stopped are named while that
	// stash is still on the list, and not once it has gone.
	t.Run("set aside", func(t *testing.T) {
		t.Parallel()
		p := clashing(t)
		p.write("loose.txt", "loose\n")
		p.git("stash", "push", "-q", "-u", "-m", "Juggler: set aside to merge topic")
		stash := strings.TrimSpace(p.git("rev-parse", "refs/stash"))
		p.gitMayFail("merge", "topic")
		if err := os.WriteFile(filepath.Join(p.dir, ".git", SetAsideFile), []byte(stash+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if s := p.changes().Stopped; s == nil || s.SetAside != stash {
			t.Fatalf("set aside reads %+v, want %s", s, stash)
		}
		p.git("stash", "drop", "-q")
		if s := p.changes().Stopped; s == nil || s.SetAside != "" {
			t.Fatalf("a dropped stash still reads as set aside: %+v", s)
		}
	})
}
