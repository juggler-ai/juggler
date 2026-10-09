//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package workspace

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/ops"
)

// trees is a project and one local workspace beside it, resolved the way the
// server resolves them.
type trees struct {
	project, tree string
	index         ops.PathSearcher
}

func newTrees(t *testing.T) *trees {
	t.Helper()
	return &trees{project: t.TempDir(), tree: t.TempDir()}
}

func (tr *trees) resolve(t *testing.T, id string) Workspace {
	t.Helper()
	ws, err := NewResolver(func() string { return tr.project },
		lookupOver(ready("ws_tree", core.WorkspaceKindLocal, "feat/tunnels", tr.tree)),
		func() ops.PathSearcher { return tr.index }).Resolve(id)
	if err != nil {
		t.Fatalf("Resolve(%q): %v", id, err)
	}
	return ws
}

func write(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// probeTool answers with the boundary it was built under, which is the whole of
// what Operations decides.
const probeTool = "workspace-test-probe"

type probe struct{ scope ops.PathScope }

type probed struct {
	root, projectRoot string
	reads             func(string) bool
}

func (p probe) Execute(context.Context, string, map[string]any) (any, error) {
	return probed{
		root: p.scope.Root(), projectRoot: p.scope.ProjectRoot(),
		reads: func(path string) bool {
			result, err := p.scope.Resolve(path)
			return err == nil && result != nil && result.IsValid
		},
	}, nil
}

func probeOf(t *testing.T, ws Workspace, allowed []string) probed {
	t.Helper()
	ops.Register(probeTool, func(scope ops.PathScope) ops.Operations { return probe{scope} })
	handler, err := ws.Operations(probeTool, allowed)
	if err != nil {
		t.Fatalf("Operations(%s): %v", probeTool, err)
	}
	out, err := handler.Execute(t.Context(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	return out.(probed)
}

// A workspace's tools are rooted at the workspace — a shell's cwd is confined
// there — and may still READ the project it branched from, to diff against it or
// read a doc only the main tree has. The project's own tools are rooted at the
// project and reach nothing else beyond the user's grant.
func TestLocalWorkspaceOperationsAreConfinedToTheirTree(t *testing.T) {
	tr := newTrees(t)
	inProject := write(t, filepath.Join(tr.project, "p.txt"), "p")
	inTree := write(t, filepath.Join(tr.tree, "w.txt"), "w")
	granted := t.TempDir()
	inGrant := write(t, filepath.Join(granted, "a.txt"), "a")
	elsewhere := write(t, filepath.Join(t.TempDir(), "x.txt"), "x")

	got := probeOf(t, tr.resolve(t, "ws_tree"), []string{granted})
	if got.root != tr.tree || got.projectRoot != tr.project {
		t.Errorf("workspace scope root=%q project=%q, want root %q project %q", got.root, got.projectRoot, tr.tree, tr.project)
	}
	for path, want := range map[string]bool{inTree: true, inProject: true, inGrant: true, elsewhere: false} {
		if got.reads(path) != want {
			t.Errorf("workspace scope reads %s = %v, want %v", path, !want, want)
		}
	}

	got = probeOf(t, tr.resolve(t, ""), nil)
	if got.root != tr.project || got.projectRoot != tr.project {
		t.Errorf("project scope root=%q project=%q, want both %q", got.root, got.projectRoot, tr.project)
	}
	if got.reads(inTree) {
		t.Errorf("the project's scope reaches into a workspace it was never granted: %s", inTree)
	}

	if _, err := tr.resolve(t, "").Operations("workspace-test-no-such-tool", nil); err == nil {
		t.Error("Operations for an unregistered tool succeeded")
	}
}

// A streaming command runs in the workspace, and a cwd outside it is refused in
// the shape the engine waits for: a done chunk carrying the reason.
func TestLocalWorkspaceStreamShellRunsInItsTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("pwd is a POSIX shell builtin")
	}
	tr := newTrees(t)
	ws := tr.resolve(t, "ws_tree")

	run := func(cwd string) (output string, last ops.ShellStreamChunk) {
		out := make(chan ops.ShellStreamChunk, 16)
		go ws.StreamShell(t.Context(), ShellRequest{ShellID: "shell-1", Command: "pwd", Cwd: cwd, TimeoutMs: 30000}, out)
		for chunk := range out {
			output += chunk.Data
			last = chunk
		}
		return output, last
	}

	output, last := run("")
	want, _ := filepath.EvalSymlinks(tr.tree)
	if got, _ := filepath.EvalSymlinks(strings.TrimSpace(output)); got != want || !last.Done {
		t.Errorf("pwd printed %q (done=%v), want the workspace %q", output, last.Done, want)
	}

	_, last = run(tr.project)
	if !last.Done || last.Error == "" {
		t.Errorf("a cwd outside the workspace ended %+v, want a done chunk carrying the refusal", last)
	}
}

type cannedIndex []ops.FileMatch

func (c cannedIndex) Search(string, int) []ops.FileMatch { return c }

// The project answers "@" from its path index; a workspace has none and is
// walked, under the same rules.
func TestLocalWorkspaceSearchFilesSearchesItsOwnTree(t *testing.T) {
	tr := newTrees(t)
	tr.index = cannedIndex{{Path: "deep/from-the-index.go"}}
	write(t, filepath.Join(tr.tree, "deep", "er", "needle.txt"), "x")

	matches, err := tr.resolve(t, "").SearchFiles(t.Context(), "index", 20)
	if err != nil || !hasPath(matches, "deep/from-the-index.go") {
		t.Errorf("project search = %v (err %v), want the index's answer", matches, err)
	}
	matches, err = tr.resolve(t, "ws_tree").SearchFiles(t.Context(), "needle", 20)
	if err != nil || !hasPath(matches, "deep/er/needle.txt") {
		t.Errorf("workspace search = %v (err %v), want the file walked in that tree", matches, err)
	}
}

// A workspace that works in the project itself (a group) is the project's tree,
// so it answers "@" as the project does — from the project's index — rather than
// walking the same tree again.
func TestLocalWorkspaceInTheProjectSearchesAsTheProject(t *testing.T) {
	project := t.TempDir()
	index := cannedIndex{{Path: "deep/from-the-index.go"}}
	ws, err := NewResolver(func() string { return project },
		lookupOver(ready("ws_group", core.WorkspaceKindLocal, "Billing", project+string(filepath.Separator))),
		func() ops.PathSearcher { return index }).Resolve("ws_group")
	if err != nil {
		t.Fatalf("Resolve(ws_group): %v", err)
	}
	matches, err := ws.SearchFiles(t.Context(), "index", 20)
	if err != nil || !hasPath(matches, "deep/from-the-index.go") {
		t.Errorf("group search = %v (err %v), want the project index's answer", matches, err)
	}
	if got := probeOf(t, ws, nil); got.root != project || got.projectRoot != project {
		t.Errorf("group scope root=%q project=%q, want both %q", got.root, got.projectRoot, project)
	}
}

func hasPath(matches []ops.FileMatch, path string) bool {
	for _, m := range matches {
		if m.Path == path {
			return true
		}
	}
	return false
}

// "./" is anchored at the tree the question is about.
func TestLocalWorkspaceCompletePathIsAnchoredAtItsRoot(t *testing.T) {
	tr := newTrees(t)
	write(t, filepath.Join(tr.tree, "alpha-in-the-tree.txt"), "x")
	write(t, filepath.Join(tr.project, "alpha-in-the-project.txt"), "x")

	matches, err := tr.resolve(t, "ws_tree").CompletePath(t.Context(), "./alpha", 20)
	if err != nil || len(matches) != 1 || !strings.Contains(matches[0].Path, "alpha-in-the-tree.txt") {
		t.Errorf("CompletePath(./alpha) = %v (err %v), want the workspace's file alone", matches, err)
	}
}

// Stat reads paths as a typed "@" mention writes them: relative to the tree,
// absolute, or under the user's home.
func TestLocalWorkspaceStatReadsAMentionsPaths(t *testing.T) {
	tr := newTrees(t)
	write(t, filepath.Join(tr.tree, "rel.txt"), "x")
	abs := write(t, filepath.Join(tr.project, "abs.txt"), "x")
	ws := tr.resolve(t, "ws_tree")

	for _, path := range []string{"rel.txt", abs, "~"} {
		if _, err := ws.Stat(path); err != nil {
			t.Errorf("Stat(%q): %v", path, err)
		}
	}
	if _, err := ws.Stat("abs.txt"); err == nil {
		t.Error("Stat(abs.txt) found the project's file: a relative path read against the wrong tree")
	}
}

// Open serves a file in the tree and nothing outside it, by any spelling.
func TestLocalWorkspaceOpenStaysInItsTree(t *testing.T) {
	tr := newTrees(t)
	write(t, filepath.Join(tr.tree, "lib", "mod.js"), "export {}")
	outside := write(t, filepath.Join(filepath.Dir(tr.tree), "outside.js"), "secret")
	ws := tr.resolve(t, "ws_tree")

	f, err := ws.Open("lib/mod.js")
	if err != nil {
		t.Fatalf("Open(lib/mod.js): %v", err)
	}
	data, _ := io.ReadAll(f)
	_ = f.Close()
	if string(data) != "export {}" {
		t.Errorf("Open(lib/mod.js) read %q", data)
	}

	for _, rel := range []string{"../" + filepath.Base(outside), "lib/../../" + filepath.Base(outside), outside, "lib", ""} {
		if f, err := ws.Open(rel); err == nil {
			_ = f.Close()
			t.Errorf("Open(%q) succeeded, want it refused", rel)
		}
	}
}

// The git views answer about the tree they belong to, never the project.
func TestLocalWorkspaceGitAnswersAboutItsOwnTree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Cleanup(gitview.LendClocks(time.Minute, 5*time.Minute))

	tr := newTrees(t)
	cmd := exec.Command("git", "init", "-q")
	cmd.Dir = tr.tree
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	write(t, filepath.Join(tr.tree, "only-here.txt"), "new\n")
	ws, project := tr.resolve(t, "ws_tree"), tr.resolve(t, "")

	status, err := ws.GitStatus(t.Context())
	if err != nil || len(status) != 1 || status[0].Changed != 1 {
		t.Errorf("workspace status = %+v (err %v), want its one repository with one change", status, err)
	}
	review, err := ws.GitReview(t.Context())
	if err != nil || len(review.Repos) != 1 || len(review.Repos[0].Files) != 1 {
		t.Errorf("workspace review = %+v (err %v), want its one changed file", review, err)
	}
	if review, err := project.GitReview(t.Context()); err != nil || len(review.Repos) != 0 {
		t.Errorf("project review = %+v (err %v), want nothing: the project holds no repository", review, err)
	}
	diff, err := ws.GitDiff(t.Context(), gitview.DiffRequest{Path: "only-here.txt"})
	if err != nil || diff.Status != "untracked" {
		t.Errorf("workspace diff = %+v (err %v), want the untracked file", diff, err)
	}
	var refused *gitview.RequestError
	if _, err := ws.GitDiff(t.Context(), gitview.DiffRequest{Path: "../x"}); !errors.As(err, &refused) {
		t.Errorf("a diff climbing out err = %v, want a *gitview.RequestError", err)
	}
}
