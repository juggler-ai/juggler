//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func (p *gitProject) changes() Changes {
	p.t.Helper()
	c, err := ReadChanges(p.t.Context(), p.root, p.rel)
	if err != nil {
		p.t.Fatal(err)
	}
	return c
}

// gitMayFail runs a git command whose failure is the point, such as a merge
// meant to stop on a conflict.
func (p *gitProject) gitMayFail(args ...string) {
	cmd := exec.Command("git", args...)
	cmd.Dir = p.dir
	_ = cmd.Run()
}

func fileNamed(t *testing.T, c Changes, path string) ChangedFile {
	t.Helper()
	for _, f := range c.Files {
		if f.Path == path {
			return f
		}
	}
	t.Fatalf("%s is not listed among %+v", path, c.Files)
	return ChangedFile{}
}

// A file staged and then changed again has a count for each side, and every
// kind of entry says what it is.
func TestChangesSidesAndKinds(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\nb\nc\n")
	p.write(".gitattributes", "*.bin filter=lfs\n")
	p.commit("init")

	p.write("a.txt", "a\nB\nc\n")
	p.git("add", "a.txt")
	p.write("a.txt", "a\nB\nC\nd\n")
	p.write("new.txt", "new\n")
	p.write("pic.dat", "\x00\x01\x02")
	p.git("add", "pic.dat")
	p.write("big.bin", "version https://git-lfs.github.com/spec/v1\n")
	sub := p.nested("sub")
	sub.write("s.txt", "s\n")
	sub.commit("sub init")
	p.git("add", "sub")

	c := p.changes()
	a := fileNamed(t, c, "a.txt")
	if a.Index != "M" || a.Worktree != "M" {
		t.Errorf("a.txt letters = %q%q", a.Index, a.Worktree)
	}
	if a.Staged == nil || *a.Staged != (Stat{Added: 1, Removed: 1}) {
		t.Errorf("a.txt staged = %+v, want +1 -1", a.Staged)
	}
	if a.Unstaged == nil || *a.Unstaged != (Stat{Added: 2, Removed: 1}) {
		t.Errorf("a.txt unstaged = %+v, want +2 -1", a.Unstaged)
	}
	if n := fileNamed(t, c, "new.txt"); n.Worktree != "?" || n.Staged != nil {
		t.Errorf("new.txt = %+v", n)
	}
	if d := fileNamed(t, c, "pic.dat"); !d.Binary || d.Staged != nil {
		t.Errorf("pic.dat = %+v, want binary with no line count", d)
	}
	if b := fileNamed(t, c, "big.bin"); !b.LFS {
		t.Errorf("big.bin = %+v, want an LFS file", b)
	}
	if s := fileNamed(t, c, "sub"); !s.Submodule {
		t.Errorf("sub = %+v, want a submodule", s)
	}
	// Edited inside after its commit was staged: changed on both sides, but
	// the worktree side is content inside it, not a commit to stage.
	sub.write("s.txt", "S\n")
	if s := fileNamed(t, p.changes(), "sub"); s.Index != "A" || s.Worktree != "M" ||
		!s.SubmoduleModified || s.SubmoduleCommit || s.SubmoduleUntracked {
		t.Errorf("sub edited inside = %+v, want staged with modified content and no new commit", s)
	}
	if c.Branch == "" || c.Detached || c.Operation != "" {
		t.Errorf("branch %q detached %v operation %q", c.Branch, c.Detached, c.Operation)
	}
}

func TestChangesHead(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("Wrapped\n\nA body that keeps to seventy-two columns, as\nbodies here always do.")
	c := p.changes()
	if c.Head == nil || c.Head.Message != "Wrapped\n\nA body that keeps to seventy-two columns, as\nbodies here always do.\n" {
		t.Fatalf("head = %+v", c.Head)
	}
	if c.Head.Pushed || !c.WrapsBody {
		t.Errorf("pushed %v wrapsBody %v", c.Head.Pushed, c.WrapsBody)
	}
	if sha := strings.TrimSpace(p.git("rev-parse", "HEAD")); c.Head.Sha != sha {
		t.Errorf("head sha %q, want %q", c.Head.Sha, sha)
	}

	if c.Remotes != 0 {
		t.Errorf("remotes = %d before there are any", c.Remotes)
	}
	p.git("remote", "add", "origin", "https://example.invalid/r.git")
	p.git("remote", "add", "fork", "https://example.invalid/f.git")
	p.git("update-ref", "refs/remotes/origin/main", "HEAD")
	if c := p.changes(); !c.Head.Pushed || c.Remotes != 2 {
		t.Errorf("pushed %v remotes %d: want a commit on a remote-tracking branch pushed, and both remotes counted", c.Head.Pushed, c.Remotes)
	}

	p.write("a.txt", "b\n")
	p.commit("Unwrapped\n\nThis repository writes each paragraph of a body on one long line and lets the reader's window wrap it, which is a choice.")
	if c := p.changes(); c.WrapsBody {
		t.Error("a history with unwrapped bodies says it wraps them")
	}
}

func TestChangesBeforeTheFirstCommit(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.git("add", "a.txt")
	c := p.changes()
	if c.Head != nil || !c.Initial {
		t.Errorf("head %+v initial %v", c.Head, c.Initial)
	}
	if a := fileNamed(t, c, "a.txt"); a.Index != "A" || a.Staged == nil || a.Staged.Added != 1 {
		t.Errorf("a.txt = %+v", a)
	}
}

// An operation in progress is read from the tree's own git directory; a
// sequencer directory with no todo list in it is not one.
func TestChangesOperation(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	if err := os.MkdirAll(filepath.Join(p.dir, ".git", "sequencer"), 0o750); err != nil {
		t.Fatal(err)
	}
	p.write("a.txt", "a\n")
	p.commit("init")
	if c := p.changes(); c.Operation != "" {
		t.Errorf("a leftover sequencer reads as %q in progress", c.Operation)
	}

	p.git("switch", "-q", "-c", "other")
	p.write("a.txt", "other\n")
	p.commit("other")
	p.git("switch", "-q", "-")
	p.write("a.txt", "mine\n")
	p.commit("mine")
	p.gitMayFail("merge", "other")
	c := p.changes()
	if c.Operation != "merge" {
		t.Errorf("operation = %q, want merge", c.Operation)
	}
	if a := fileNamed(t, c, "a.txt"); !a.Conflicted {
		t.Errorf("a.txt = %+v, want conflicted", a)
	}
}

// A pick of several commits is in progress, as git has it, until its sequence
// ends — between commits too, once the one it stopped on is committed by hand,
// when git still refuses to switch branch.
func TestChangesPickStoppedBetweenCommits(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("init")
	p.git("switch", "-q", "-c", "other")
	p.write("a.txt", "other\n")
	p.commit("other one")
	p.write("b.txt", "b\n")
	p.git("add", "b.txt")
	p.commit("other two")
	p.git("switch", "-q", "-")
	p.write("a.txt", "mine\n")
	p.commit("mine")

	p.gitMayFail("cherry-pick", "other~1", "other")
	c := p.changes()
	if c.Operation != "cherry-pick" || c.Stopped == nil || c.Stopped.Between || c.Stopped.Left != 1 || c.Stopped.Commit == nil {
		t.Fatalf("stopped on the first pick: operation %q, stopped %+v", c.Operation, c.Stopped)
	}

	p.write("a.txt", "both\n")
	p.git("add", "a.txt")
	p.git("commit", "-q", "--no-edit")
	c = p.changes()
	if c.Operation != "cherry-pick" || c.Stopped == nil || !c.Stopped.Between || c.Stopped.Left != 1 || c.Stopped.Commit != nil {
		t.Errorf("committed by hand, the rest still waiting: operation %q, stopped %+v", c.Operation, c.Stopped)
	}
}

// A linked worktree's changes are its own: its index, its HEAD.
func TestChangesLinkedWorktree(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("init")
	linked := filepath.Join(t.TempDir(), "linked")
	p.git("worktree", "add", "-q", "-b", "side", linked)
	tree := &gitProject{t: t, root: linked, dir: linked}
	tree.write("a.txt", "linked\n")
	tree.git("add", "a.txt")
	tree.commit("In the linked tree")
	tree.write("b.txt", "b\n")
	tree.git("add", "b.txt")

	c := tree.changes()
	if c.Branch != "side" || c.Head == nil || !strings.HasPrefix(c.Head.Message, "In the linked tree") {
		t.Errorf("linked branch %q head %+v", c.Branch, c.Head)
	}
	if b := fileNamed(t, c, "b.txt"); b.Index != "A" {
		t.Errorf("b.txt in the linked tree = %+v", b)
	}
	if mine := p.changes(); len(mine.Files) != 0 {
		t.Errorf("the main tree lists the linked tree's changes: %+v", mine.Files)
	}
}
