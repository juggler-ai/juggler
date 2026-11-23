//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/ops"
)

// linkedFixture is a project that is a repository, and a worktree of it made
// with the CLI somewhere outside the project: no workspace row names it.
type linkedFixture struct {
	project, linked string
	resolver        *Resolver
	trees           GitTrees
}

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func newLinkedFixture(t *testing.T, rows ...core.Workspace) linkedFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := linkedFixture{project: t.TempDir(), linked: filepath.Join(t.TempDir(), "side-tree")}
	gitRun(t, f.project, "init", "-q")
	gitRun(t, f.project, "config", "user.email", "t@example.com")
	gitRun(t, f.project, "config", "user.name", "T")
	write(t, filepath.Join(f.project, "a.txt"), "a\n")
	gitRun(t, f.project, "add", "-A")
	gitRun(t, f.project, "commit", "-qm", "init")
	gitRun(t, f.project, "worktree", "add", "-q", "-b", "side", f.linked)

	f.resolver = NewResolver(func() string { return f.project }, lookupOver(rows...), nil)
	f.trees = GitTrees{Resolve: f.resolver.Resolve, Rows: func() []core.Workspace { return rows }}
	return f
}

func realPath(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// A worktree no workspace names is reached through the tree it was found
// from, and is the git surface's alone: a tool registered to run in any tree
// (the git tool, whose reads and writes there the server tests) is built
// there, and every other tool is refused.
func TestGitTreesResolveALinkedWorktree(t *testing.T) {
	f := newLinkedFixture(t)
	id := WorktreeID("", "", f.linked)
	if !strings.HasPrefix(id, "wt:") {
		t.Fatalf("WorktreeID = %q", id)
	}
	ws, err := f.trees.ResolveGit(id)
	if err != nil {
		t.Fatalf("Resolve(%q): %v", id, err)
	}
	if ws.ID() != id || ws.Root() != realPath(t, f.linked) || ws.Name() != "side-tree" {
		t.Errorf("tree = id %q root %q name %q", ws.ID(), ws.Root(), ws.Name())
	}
	ordinary := ops.Registration{Factory: func(ops.PathScope) ops.Operations { return nil }}
	if _, err := ws.Operations(ordinary, nil); err == nil {
		t.Error("the agent's tools were given a worktree only the git client may reach")
	}
	anyTree := ordinary
	anyTree.ClientOnly, anyTree.AnyTree = true, true
	if _, err := ws.Operations(anyTree, nil); err != nil {
		t.Errorf("a tool registered to run in any tree was refused a git-only tree: %v", err)
	}
	if _, ok := ws.LocalDir(); ok {
		t.Error("a provider could be spawned in a git-only tree")
	}
	out := make(chan ops.ShellStreamChunk, 4)
	ws.StreamShell(t.Context(), ShellRequest{ShellID: "s1", Command: "echo hi"}, out)
	chunk, open := <-out
	if !open || !chunk.Blocked || !chunk.Done || chunk.Error == "" {
		t.Errorf("shell in a git-only tree = %+v, want it refused", chunk)
	}
	if _, more := <-out; more {
		t.Error("the refused shell's stream was left open")
	}
	if _, err := ws.Open("a.txt"); err == nil {
		t.Error("a git-only tree opened a file for the agent")
	}
	if _, err := ws.SearchFiles(t.Context(), "a", 5); err == nil {
		t.Error("a git-only tree answered @ completion")
	}

	// The resolver every other caller uses does not know the id at all.
	if _, err := f.resolver.Resolve(id); err == nil {
		t.Error("the agent's resolver opened a git-only tree")
	}
	// Any other id is resolved as it always was.
	if project, err := f.trees.ResolveGit(""); err != nil || project.Root() != f.project {
		t.Errorf(`Resolve("") = %v, %v; want the project`, project, err)
	}
}

// An id names a worktree only if git lists it among the anchor's trees: a
// directory that is not one, an anchor nobody registered, or an id that is not
// one of ours are all refused.
func TestGitTreesRefuseWhatIsNotAWorktree(t *testing.T) {
	f := newLinkedFixture(t)
	elsewhere := t.TempDir()
	gitRun(t, elsewhere, "init", "-q")
	for name, id := range map[string]string{
		"a directory":           WorktreeID("", "", t.TempDir()),
		"another repository":    WorktreeID("", "", elsewhere),
		"an unregistered tree":  WorktreeID("ws_nobody", "", f.linked),
		"a repo that isn't one": WorktreeID("", "nope", f.linked),
		"garbage":               "wt:%%%",
		"an empty one":          "wt:",
	} {
		if _, err := f.trees.ResolveGit(id); err == nil {
			t.Errorf("%s resolved", name)
		}
	}
	if err := os.RemoveAll(f.linked); err != nil {
		t.Fatal(err)
	}
	if _, err := f.trees.ResolveGit(WorktreeID("", "", f.linked)); err == nil {
		t.Error("a worktree whose directory is gone resolved")
	}
}

// The worktree read names each tree by the id that views it — the anchor's own
// id for the anchor's tree, a git-only id for any other — and lists the open
// workspace rows rooted there, whatever path spelling they were registered
// under. Read from a git-only tree, the ids it mints are the same ones.
func TestGitTreesAnnotateTheWorktreeRead(t *testing.T) {
	f := newLinkedFixture(t)
	// A row registered through a symbolic link to the tree, and a closed one.
	link := filepath.Join(t.TempDir(), "via-link")
	if err := os.Symlink(f.linked, link); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	rows := []core.Workspace{
		ready("ws_side", core.WorkspaceKindLocal, "side", link),
		{ID: "ws_old", Kind: core.WorkspaceKindLocal, Root: f.linked, State: core.WorkspaceStateClosed},
	}
	f.trees.Rows = func() []core.Workspace { return rows }

	for _, anchor := range []string{"", WorktreeID("", "", f.linked)} {
		tree, err := f.trees.ResolveGit(anchor)
		if err != nil {
			t.Fatal(err)
		}
		read, err := gitview.Read(t.Context(), tree.Root(), gitview.Query{Kind: gitview.QueryWorktrees})
		if err != nil {
			t.Fatal(err)
		}
		w := read.(gitview.Worktrees)
		f.trees.Annotate(anchor, &w)
		if len(w.Trees) != 2 {
			t.Fatalf("trees: %+v", w.Trees)
		}
		if treeID(w.Trees[0]) != "" || len(w.Trees[0].Rows) != 0 {
			t.Errorf("from %q, the main tree = %+v, want the project's id and no rows", anchor, w.Trees[0])
		}
		side := w.Trees[1]
		if treeID(side) != WorktreeID("", "", f.linked) {
			t.Errorf("from %q, the linked tree's id = %q", anchor, treeID(side))
		}
		if len(side.Rows) != 1 || side.Rows[0] != "ws_side" {
			t.Errorf("from %q, the linked tree's rows = %v, want [ws_side]", anchor, side.Rows)
		}
		if _, err := f.trees.ResolveGit(treeID(side)); err != nil {
			t.Errorf("the id the read minted does not resolve: %v", err)
		}
	}
}

// A repository nested in the project is viewed at itself: its own checkout is
// named by the project's id, with the nested repository's path to open at,
// whether the read was made there or in a worktree of it; its linked tree is
// a git-only id, viewed at that tree's root.
func TestGitTreesAnnotateANestedRepository(t *testing.T) {
	f := newLinkedFixture(t)
	sub := filepath.Join(f.project, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	gitRun(t, sub, "init", "-q")
	gitRun(t, sub, "config", "user.email", "t@example.com")
	gitRun(t, sub, "config", "user.name", "T")
	write(t, filepath.Join(sub, "s.txt"), "s\n")
	gitRun(t, sub, "add", "-A")
	gitRun(t, sub, "commit", "-qm", "init")
	subLinked := filepath.Join(t.TempDir(), "sub-side")
	gitRun(t, sub, "worktree", "add", "-q", "-b", "sub-side", subLinked)
	linkedID := WorktreeID("", "sub", subLinked)

	for _, read := range []struct{ anchor, root, repo string }{
		{"", f.project, "sub"},
		{linkedID, subLinked, ""},
	} {
		w, err := gitview.ListWorktrees(t.Context(), read.root, read.repo)
		if err != nil {
			t.Fatal(err)
		}
		f.trees.Annotate(read.anchor, &w)
		if len(w.Trees) != 2 {
			t.Fatalf("trees: %+v", w.Trees)
		}
		if main := w.Trees[0]; treeID(main) != "" || main.TreeRepo != "sub" {
			t.Errorf("from %q, the nested repository's checkout = id %q at %q, want the project's id at sub", read.anchor, treeID(main), main.TreeRepo)
		}
		if side := w.Trees[1]; treeID(side) != linkedID || side.TreeRepo != "" {
			t.Errorf("from %q, its linked tree = id %q at %q, want %q at its root", read.anchor, treeID(side), side.TreeRepo, linkedID)
		}
	}
}

// treeID is a tree's id, or "<none>" when it has none.
func treeID(t gitview.Worktree) string {
	if t.Tree == nil {
		return "<none>"
	}
	return *t.Tree
}
