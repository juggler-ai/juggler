//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// refsFixture is a repository with a bare remote and linked worktrees outside
// its own directory, the shape the Refs place has to describe.
type refsFixture struct {
	p      *gitProject
	main   string // the main branch's name, whatever this git defaults to
	feat   string // a linked worktree on branch feat, locked
	det    string // a linked worktree at a detached HEAD
	gone   string // a linked worktree whose directory was deleted
	broken string // a linked worktree whose .git file is garbage
}

// gitIn runs git in dir and fails the test if it could not.
func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func newRefsFixture(t *testing.T) refsFixture {
	t.Helper()
	p := newGitProject(t)
	outside := t.TempDir()
	remote := filepath.Join(outside, "remote.git")
	gitIn(t, outside, "init", "-q", "--bare", remote)

	p.write("a.txt", "a\n")
	p.commit("init")
	f := refsFixture{p: p, main: p.git("symbolic-ref", "--short", "HEAD")}
	f.main = strings.TrimSpace(f.main)
	p.git("remote", "add", "origin", remote)
	p.git("push", "-q", "-u", "origin", f.main)

	// behind: the remote has a commit the local branch has not.
	p.git("branch", "behind")
	p.write("b.txt", "b\n")
	p.commit("second")
	p.git("push", "-q", "origin", "HEAD:refs/heads/behind")
	p.git("fetch", "-q", "origin")
	p.git("branch", "--set-upstream-to=origin/behind", "behind")
	// The main branch is now one ahead of its upstream.

	p.git("tag", "v1", "HEAD~1")
	p.git("tag", "-a", "v2", "-m", "Release two")

	p.write("a.txt", "stash one\n")
	p.git("stash", "push", "-q", "-m", "first")
	p.write("a.txt", "stash two\n")
	p.git("stash", "push", "-q", "-m", "second")

	f.feat = filepath.Join(outside, "wt-feat")
	f.det = filepath.Join(outside, "wt-det")
	f.gone = filepath.Join(outside, "wt-gone")
	f.broken = filepath.Join(outside, "wt-broken")
	p.git("worktree", "add", "-q", "-b", "feat", f.feat)
	p.git("worktree", "lock", "--reason", "on a stick", f.feat)
	p.git("worktree", "add", "-q", "--detach", f.det, "HEAD~1")
	p.git("worktree", "add", "-q", "-b", "gone", f.gone)
	if err := os.RemoveAll(f.gone); err != nil {
		t.Fatal(err)
	}
	p.git("worktree", "add", "-q", "-b", "broken", f.broken)
	if err := os.WriteFile(filepath.Join(f.broken, ".git"), []byte("not a gitfile\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.feat, "dirty.txt"), []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f refsFixture) refs(t *testing.T) Refs {
	t.Helper()
	r, err := Read(t.Context(), f.p.root, Query{Kind: QueryRefs})
	if err != nil {
		t.Fatal(err)
	}
	return r.(Refs)
}

func (f refsFixture) worktrees(t *testing.T, root string) Worktrees {
	t.Helper()
	w, err := Read(t.Context(), root, Query{Kind: QueryWorktrees})
	if err != nil {
		t.Fatal(err)
	}
	return w.(Worktrees)
}

func branchNamed(t *testing.T, r Refs, name string) Branch {
	t.Helper()
	for _, b := range r.Branches {
		if b.Name == name {
			return b
		}
	}
	t.Fatalf("no branch %s among %+v", name, r.Branches)
	return Branch{}
}

func treeAt(t *testing.T, w Worktrees, path string) Worktree {
	t.Helper()
	want := realish(t, path)
	for _, tree := range w.Trees {
		if realish(t, tree.Path) == want {
			return tree
		}
	}
	t.Fatalf("no worktree at %s among %+v", path, w.Trees)
	return Worktree{}
}

// The Refs read names every branch with its upstream and where it is checked
// out, every remote branch under its remote, both kinds of tag, and the stashes
// by the commit they are rather than their shifting position.
func TestReadRefs(t *testing.T) {
	t.Parallel()
	f := newRefsFixture(t)
	r := f.refs(t)

	main := branchNamed(t, r, f.main)
	if main.Upstream != "origin/"+f.main || main.Ahead != 1 || main.Behind != 0 || !main.Head {
		t.Errorf("main branch: %+v", main)
	}
	behind := branchNamed(t, r, "behind")
	if behind.Upstream != "origin/behind" || behind.Behind != 1 || behind.Ahead != 0 || behind.Head || behind.Worktree != "" {
		t.Errorf("behind branch: %+v", behind)
	}
	feat := branchNamed(t, r, "feat")
	if canonical(t, feat.Worktree) != canonical(t, f.feat) || feat.Head {
		t.Errorf("feat is checked out in %q, want %q", feat.Worktree, f.feat)
	}
	if feat.Subject != "second" || len(feat.Sha) < 40 {
		t.Errorf("feat tip: %+v", feat)
	}

	if len(r.Remotes) != 1 || r.Remotes[0].Name != "origin" {
		t.Fatalf("remotes: %+v", r.Remotes)
	}
	var names []string
	for _, b := range r.Remotes[0].Branches {
		names = append(names, b.Name)
	}
	slices.Sort(names)
	if want := []string{"behind", f.main}; !slices.Equal(names, sortedCopy(want)) {
		t.Errorf("origin's branches: %v, want %v", names, want)
	}

	if len(r.Tags) != 2 {
		t.Fatalf("tags: %+v", r.Tags)
	}
	tags := map[string]Tag{}
	for _, tag := range r.Tags {
		tags[tag.Name] = tag
	}
	head := strings.TrimSpace(f.p.git("rev-parse", "HEAD"))
	parent := strings.TrimSpace(f.p.git("rev-parse", "HEAD~1"))
	if v1 := tags["v1"]; v1.Annotated || v1.Target != parent || v1.Sha != parent {
		t.Errorf("v1: %+v", v1)
	}
	if v2 := tags["v2"]; !v2.Annotated || v2.Target != head || v2.Sha == head || v2.Subject != "Release two" {
		t.Errorf("v2: %+v", v2)
	}

	if len(r.Stashes) != 2 || !strings.Contains(r.Stashes[0].Message, "second") || !strings.Contains(r.Stashes[1].Message, "first") {
		t.Fatalf("stashes: %+v", r.Stashes)
	}
	top := strings.TrimSpace(f.p.git("rev-parse", "stash@{0}"))
	if r.Stashes[0].Sha != top || r.Stashes[0].Date == 0 {
		t.Errorf("stash@{0}: %+v, want sha %s", r.Stashes[0], top)
	}
	if r.FetchedAt == 0 {
		t.Error("FETCH_HEAD was written, but no fetch time was read")
	}
}

// The worktree read lists every tree of the repository, wherever it is, with
// what git says of it, and asks each live tree for its state. A tree git cannot
// read leaves its state unknown rather than failing the list; a tree that is
// gone is not asked at all.
func TestReadWorktrees(t *testing.T) {
	t.Parallel()
	f := newRefsFixture(t)
	w := f.worktrees(t, f.p.root)
	if len(w.Trees) != 5 {
		t.Fatalf("want 5 trees, got %+v", w.Trees)
	}

	main := w.Trees[0]
	if !main.Main || !main.Current || main.Branch != f.main || main.Path != canonical(t, f.p.root) {
		t.Errorf("main tree: %+v", main)
	}
	if main.Dirty == nil || *main.Dirty != 0 || main.Ahead != 1 || main.Upstream != "origin/"+f.main {
		t.Errorf("main tree state: %+v", main)
	}

	feat := treeAt(t, w, f.feat)
	if feat.Branch != "feat" || !feat.Locked || feat.LockReason != "on a stick" || feat.Main || feat.Current {
		t.Errorf("feat tree: %+v", feat)
	}
	if feat.Dirty == nil || *feat.Dirty != 1 {
		t.Errorf("feat tree has one untracked file: %+v", feat)
	}

	det := treeAt(t, w, f.det)
	if !det.Detached || det.Branch != "" || det.Head != strings.TrimSpace(f.p.git("rev-parse", "HEAD~1")) {
		t.Errorf("detached tree: %+v", det)
	}

	gone := treeAt(t, w, f.gone)
	if !gone.Prunable || gone.Dirty != nil || gone.Path != realish(t, f.gone) {
		t.Errorf("gone tree: %+v", gone)
	}
	broken := treeAt(t, w, f.broken)
	if broken.Prunable || broken.Dirty != nil {
		t.Errorf("unreadable tree: %+v", broken)
	}

	// Asked from a linked tree, the list is the same and that tree is current.
	fromFeat := f.worktrees(t, f.feat)
	if len(fromFeat.Trees) != 5 || !treeAt(t, fromFeat, f.feat).Current || fromFeat.Trees[0].Current {
		t.Errorf("read from the linked tree: %+v", fromFeat.Trees)
	}

	// Where for-each-ref says a branch is checked out agrees with the list.
	r := f.refs(t)
	for _, tree := range w.Trees {
		if tree.Branch == "" || tree.Prunable {
			continue
		}
		if b := branchNamed(t, r, tree.Branch); canonical(t, b.Worktree) != canonical(t, tree.Path) {
			t.Errorf("branch %s: refs say %q, the list says %q", tree.Branch, b.Worktree, tree.Path)
		}
	}
}

// realish resolves the symbolic links in a path whose last part may no longer
// exist.
func realish(t *testing.T, path string) string {
	t.Helper()
	if _, err := os.Lstat(path); err != nil {
		return filepath.Join(canonical(t, filepath.Dir(path)), filepath.Base(path))
	}
	return canonical(t, path)
}

func sortedCopy(s []string) []string {
	c := slices.Clone(s)
	slices.Sort(c)
	return c
}
