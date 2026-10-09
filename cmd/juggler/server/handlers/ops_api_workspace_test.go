//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
)

// Where an operation runs. A request naming no workspace runs in the project,
// as every request did before workspaces existed; one naming a workspace runs
// there, reads out into the project, and is refused outright when the workspace
// is not in a state to serve it.

// opsAPIForTest builds an OpsAPI over a fixed project path and a table of
// workspaces, resolved as the server resolves them, with the real tool handlers
// registered.
func opsAPIForTest(projectPath string, table map[string]core.Workspace) *OpsAPI {
	ops.Register("read-file", func(scope ops.PathScope) ops.Operations { return ops.NewFileOperations(scope) })
	ops.Register("shell", func(scope ops.PathScope) ops.Operations { return ops.NewShellOperations(scope) })
	return NewOpsAPI(workspace.NewResolver(
		func() string { return projectPath },
		func(id string) (core.Workspace, bool) {
			ws, ok := table[id]
			return ws, ok
		},
		nil,
	).Resolve)
}

// readFile asks the read-file tool for a path, through the full resolution
// path, and returns the error (nil when the read succeeded).
func readFile(t *testing.T, api *OpsAPI, workspaceID, path string) error {
	t.Helper()
	_, err := api.routeOperation(context.Background(), OperationRequest{
		ToolID:      "read-file",
		Operation:   "loadFile",
		Params:      map[string]any{"path": path},
		WorkspaceID: workspaceID,
	})
	return err
}

// projectAndWorkspace builds a project and a sibling workspace, each with a
// file of its own, as a worktree beside its repo would be.
func projectAndWorkspace(t *testing.T) (string, string) {
	t.Helper()
	parent := t.TempDir()
	project := filepath.Join(parent, "project")
	workspace := filepath.Join(parent, "project-feat")
	for _, dir := range []string{project, workspace} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(project, "in-project.txt"), []byte("project\n"), 0o644); err != nil {
		t.Fatalf("write project file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "in-workspace.txt"), []byte("workspace\n"), 0o644); err != nil {
		t.Fatalf("write workspace file: %v", err)
	}
	return project, workspace
}

// The default: no workspace named, everything resolves in the project.
func TestRouteOperation_NoWorkspaceRunsInTheProject(t *testing.T) {
	project, workspace := projectAndWorkspace(t)
	api := opsAPIForTest(project, nil)

	if err := readFile(t, api, "", "in-project.txt"); err != nil {
		t.Fatalf("reading a project file with no workspace: %v", err)
	}
	// And the sibling is out of scope.
	if err := readFile(t, api, "", filepath.Join(workspace, "in-workspace.txt")); err == nil {
		t.Fatalf("a file outside the project was read with no workspace named")
	}
}

// A ready workspace roots the scope at itself — and still reaches the project,
// because a conversation in a worktree has to be able to read the tree it came
// from.
func TestRouteOperation_ReadyWorkspaceRootsAtItselfAndReadsTheProject(t *testing.T) {
	project, workspace := projectAndWorkspace(t)
	api := opsAPIForTest(project, map[string]core.Workspace{
		"ws_1": {ID: "ws_1", Kind: core.WorkspaceKindLocal, Root: workspace, State: core.WorkspaceStateReady},
	})

	if err := readFile(t, api, "ws_1", "in-workspace.txt"); err != nil {
		t.Fatalf("reading a workspace file relative to the workspace: %v", err)
	}
	if err := readFile(t, api, "ws_1", filepath.Join(project, "in-project.txt")); err != nil {
		t.Fatalf("reading the project from a workspace: %v — the base tree must stay readable", err)
	}
	// Somewhere that is neither is still refused.
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "elsewhere.txt"), []byte("no\n"), 0o644); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	if err := readFile(t, api, "ws_1", filepath.Join(outside, "elsewhere.txt")); err == nil {
		t.Fatalf("a file outside both the workspace and the project was read")
	}
}

// A shell's working directory is confined to the workspace, not widened to the
// project with it: the read hatch is for reading.
func TestRouteOperation_ShellCwdIsClampedToTheWorkspace(t *testing.T) {
	project, workspace := projectAndWorkspace(t)
	api := opsAPIForTest(project, map[string]core.Workspace{
		"ws_1": {ID: "ws_1", Kind: core.WorkspaceKindLocal, Root: workspace, State: core.WorkspaceStateReady},
	})

	run := func(cwd string) error {
		_, err := api.routeOperation(context.Background(), OperationRequest{
			ToolID:      "shell",
			Operation:   "execute",
			Params:      map[string]any{"command": "pwd", "cwd": cwd},
			WorkspaceID: "ws_1",
		})
		return err
	}

	if err := run(workspace); err != nil {
		t.Fatalf("a command in the workspace itself: %v", err)
	}
	if err := run(project); err == nil {
		t.Fatalf("a command ran with its cwd in the project, from a workspace-bound request")
	}
}

// The refusals, each saying something different — a workspace being built, one
// that was finished with, one whose root has gone, and an id that means nothing.
func TestRouteOperation_RefusesUnusableWorkspaces(t *testing.T) {
	project, workspace := projectAndWorkspace(t)
	api := opsAPIForTest(project, map[string]core.Workspace{
		"ws_building": {ID: "ws_building", Kind: core.WorkspaceKindLocal, Root: workspace, Label: "feat/x", State: core.WorkspaceStateProvisioning},
		"ws_closed":   {ID: "ws_closed", Kind: core.WorkspaceKindLocal, Root: workspace, Label: "feat/done", State: core.WorkspaceStateClosed},
		"ws_removed":  {ID: "ws_removed", Kind: core.WorkspaceKindLocal, Root: filepath.Join(workspace, "gone"), State: core.WorkspaceStateReady},
	})

	for _, tc := range []struct {
		id   string
		want string
	}{
		{"ws_building", "still being created"},
		{"ws_closed", "was closed"},
		{"ws_removed", "missing its root"},
		{"ws_nope", "unknown workspace"},
	} {
		err := readFile(t, api, tc.id, "in-workspace.txt")
		if err == nil {
			t.Fatalf("%s: the operation was served", tc.id)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error = %q, want it to say %q", tc.id, err, tc.want)
		}
	}
}

// The sharpest of the refusals: an id nothing knows must never quietly run in
// the project. A stale binding that silently edited the main tree would look
// exactly like working.
func TestRouteOperation_UnknownWorkspaceNeverFallsBackToTheProject(t *testing.T) {
	project, _ := projectAndWorkspace(t)
	api := opsAPIForTest(project, nil)

	err := readFile(t, api, "ws_stale", "in-project.txt")
	if err == nil {
		t.Fatalf("an unknown workspace id resolved to the project root")
	}
	if !strings.Contains(err.Error(), "unknown workspace") {
		t.Fatalf("error = %q, want it to name the unknown workspace", err)
	}
}
