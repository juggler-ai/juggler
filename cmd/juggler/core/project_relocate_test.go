//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"juggler/internal/projectpaths"
)

// relocateGit runs git in dir, failing the test on error.
func relocateGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v: %s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

// writeWorkspaceRows writes a session.json holding rows and one other field,
// which must come back untouched.
func writeWorkspaceRows(t *testing.T, sessionPath string, rows []map[string]any) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"version": 4, "workspaces": rows})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(sessionPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sessionPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readWorkspaceRows(t *testing.T, sessionPath string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(sessionPath)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Version    int              `json:"version"`
		Workspaces []map[string]any `json:"workspaces"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Version != 4 {
		t.Errorf("version = %d, want the document's other fields kept", doc.Version)
	}
	return doc.Workspaces
}

// A project that is a repository moves with its conversations, its workspace
// rows follow it, and its worktrees — one beside it, one inside it — are
// still worktrees of it afterwards.
func TestRelocateProjectMovesRepositoryAndWorktrees(t *testing.T) {
	t.Setenv(projectpaths.StateDirEnv, "")
	parent := t.TempDir()
	project := filepath.Join(parent, "old")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	relocateGit(t, project, "init", "-q")
	if err := os.WriteFile(filepath.Join(project, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	relocateGit(t, project, "add", ".")
	relocateGit(t, project, "commit", "-qm", "a")
	beside := filepath.Join(parent, "old-feature")
	inside := filepath.Join(project, "trees", "inner")
	relocateGit(t, project, "worktree", "add", "-q", "-b", "feature", beside)
	relocateGit(t, project, "worktree", "add", "-q", "-b", "inner", inside)

	state := projectpaths.SharedDir(project)
	if err := os.MkdirAll(filepath.Join(state, "Chat--conv_abc123"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeWorkspaceRows(t, filepath.Join(state, "session.json"), []map[string]any{
		{"id": "w1", "kind": "local", "root": beside, "providerId": "git-worktree", "state": "ready",
			"meta": map[string]any{"repoDir": project, "dir": beside, "branch": "feature"}},
		{"id": "w2", "kind": "local", "root": inside, "providerId": "git-worktree", "state": "ready",
			"meta": map[string]any{"repoDir": project, "dir": inside, "branch": "inner"}},
		{"id": "w3", "kind": "local", "root": filepath.Join(project, "sub"), "providerId": "project-folder", "state": "ready",
			"meta": map[string]any{"folder": "sub"}},
		{"id": "w4", "kind": "local", "root": parent + "/older", "state": "ready"},
	})

	dest := filepath.Join(parent, "new")
	if err := RelocateProject(project, dest); err != nil {
		t.Fatalf("RelocateProject: %v", err)
	}

	mustNotExist(t, project)
	mustExist(t, filepath.Join(dest, ".juggler", "Chat--conv_abc123"), filepath.Join(dest, "a.txt"))
	movedInside := filepath.Join(dest, "trees", "inner")
	rows := readWorkspaceRows(t, filepath.Join(dest, ".juggler", "session.json"))
	want := []struct{ root, repoDir, dir string }{
		{beside, dest, beside},
		{movedInside, dest, movedInside},
		{filepath.Join(dest, "sub"), "", ""},
		{parent + "/older", "", ""},
	}
	for i, w := range want {
		if rows[i]["root"] != w.root {
			t.Errorf("row %d root = %v, want %s", i, rows[i]["root"], w.root)
		}
		meta, _ := rows[i]["meta"].(map[string]any)
		if w.repoDir != "" && (meta["repoDir"] != w.repoDir || meta["dir"] != w.dir) {
			t.Errorf("row %d meta = %v, want repoDir %s dir %s", i, meta, w.repoDir, w.dir)
		}
	}

	for _, tree := range []string{beside, movedInside} {
		common := relocateGit(t, tree, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if got, _ := filepath.EvalSymlinks(common); got != mustEval(t, filepath.Join(dest, ".git")) {
			t.Errorf("worktree %s's repository = %s, want %s", tree, common, filepath.Join(dest, ".git"))
		}
	}
	list := relocateGit(t, dest, "worktree", "list", "--porcelain")
	if strings.Contains(list, "prunable") {
		t.Errorf("git still has a worktree it cannot find:\n%s", list)
	}
}

func mustEval(t *testing.T, p string) string {
	t.Helper()
	got, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// State kept outside the project moves to the folder the new path's state is
// looked for in, with the sandboxes in it.
func TestRelocateProjectMovesOutsideState(t *testing.T) {
	t.Setenv(projectpaths.StateDirEnv, t.TempDir())
	parent := t.TempDir()
	project := filepath.Join(parent, "old")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	oldState := projectpaths.OutsideDir(project)
	sandbox := filepath.Join(oldState, "sandboxes", "s1", "work")
	if err := os.MkdirAll(sandbox, 0o755); err != nil {
		t.Fatal(err)
	}
	writeWorkspaceRows(t, filepath.Join(oldState, "session.json"), []map[string]any{
		{"id": "w1", "kind": "local", "root": sandbox, "providerId": "scratch-copy", "state": "ready",
			"meta": map[string]any{"baseDir": project, "work": sandbox}},
	})

	dest := filepath.Join(parent, "new")
	if err := RelocateProject(project, dest); err != nil {
		t.Fatalf("RelocateProject: %v", err)
	}

	newState := projectpaths.OutsideDir(dest)
	if got := projectpaths.StateDir(dest); got != newState {
		t.Fatalf("state for the new path = %s, want %s", got, newState)
	}
	mustNotExist(t, oldState, project)
	newSandbox := filepath.Join(newState, "sandboxes", "s1", "work")
	mustExist(t, newSandbox)
	rows := readWorkspaceRows(t, filepath.Join(newState, "session.json"))
	meta, _ := rows[0]["meta"].(map[string]any)
	if rows[0]["root"] != newSandbox || meta["work"] != newSandbox || meta["baseDir"] != dest {
		t.Errorf("row = %v, want root and work %s, baseDir %s", rows[0], newSandbox, dest)
	}
}

// Nothing moves while a session holds the project, or onto something that is
// already there.
func TestRelocateProjectRefuses(t *testing.T) {
	t.Setenv(projectpaths.StateDirEnv, "")
	parent := t.TempDir()
	project := filepath.Join(parent, "old")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}

	lock := NewInstanceLock(project)
	if res, err := lock.TryAcquire(); err != nil || !res.Acquired {
		t.Fatalf("TryAcquire: %v %v", res, err)
	}
	if err := RelocateProject(project, filepath.Join(parent, "new")); err == nil {
		t.Error("moved a project a session holds")
	}
	_ = lock.Release()
	mustExist(t, project)

	taken := filepath.Join(parent, "taken")
	if err := os.MkdirAll(taken, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, dest := range []string{taken, filepath.Join(project, "sub"), "relative"} {
		if err := RelocateProject(project, dest); err == nil {
			t.Errorf("moved the project to %s", dest)
		}
	}
	mustExist(t, project)
}
