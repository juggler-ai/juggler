//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
)

// Which tree "@" completion offers. A mention becomes a file-content item that
// reads from the conversation's workspace, so the menu that proposed it has to
// have been listing that same tree — or it offers files the read will not find,
// and hides the ones it would.

// completionsOver builds the completions API over a project and a workspace
// table, with a project index that knows only what it is given.
func completionsOver(projectPath string, table map[string]core.Workspace, indexed ...string) *CompletionsAPI {
	return NewCompletionsAPI(
		func() string { return projectPath },
		func(id string) (core.Workspace, bool) {
			ws, ok := table[id]
			return ws, ok
		},
		func() ops.PathSearcher { return fixedSearcher(indexed) },
	)
}

// fixedSearcher stands in for the project's path index.
type fixedSearcher []string

func (s fixedSearcher) Search(query string, limit int) []ops.FileMatch {
	out := []ops.FileMatch{}
	for _, p := range s {
		if len(out) < limit && strings.Contains(strings.ToLower(path.Base(p)), strings.ToLower(query)) {
			out = append(out, ops.FileMatch{Path: p})
		}
	}
	return out
}

// writeTree creates each path (relative, forward-slashed) as a small file.
func writeTree(t *testing.T, root string, paths ...string) {
	t.Helper()
	for _, p := range paths {
		abs := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// askCompletions calls one completions endpoint and returns the paths it named.
func askCompletions(t *testing.T, handler http.HandlerFunc, target string) (*httptest.ResponseRecorder, []string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil).WithContext(t.Context())
	rec := httptest.NewRecorder()
	handler(rec, req)
	var body struct {
		Results  []ops.FileMatch `json:"results"`
		Existing []string        `json:"existing"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding %s: %v\n%s", target, err, rec.Body.String())
	}
	paths := slices.Clone(body.Existing)
	for _, m := range body.Results {
		paths = append(paths, m.Path)
	}
	return rec, paths
}

// TestFileCompletionsListTheWorkspaceTheyAreAskedFor: a file that exists only in
// the worktree is offered, deep or shallow, and one that exists only in the
// project is not — including the project index's answer, which describes the
// wrong tree.
func TestFileCompletionsListTheWorkspaceTheyAreAskedFor(t *testing.T) {
	project := t.TempDir()
	worktree := t.TempDir()
	writeTree(t, project, "project-only.go", "src/project-deep.go")
	writeTree(t, worktree, "tree-only.go", "src/nested/tree-deep.go")

	api := completionsOver(project, map[string]core.Workspace{
		"ws_tree": {ID: "ws_tree", Kind: core.WorkspaceKindLocal, Root: worktree, State: core.WorkspaceStateReady},
	}, "project-only.go", "src/project-deep.go")

	_, top := askCompletions(t, api.HandleFileCompletions, "/api/completions/files?q=&workspace=ws_tree")
	if !slices.Contains(top, "tree-only.go") || slices.Contains(top, "project-only.go") {
		t.Errorf("top level in the workspace = %v, want the worktree's files and not the project's", top)
	}

	_, deep := askCompletions(t, api.HandleFileCompletions, "/api/completions/files?q=deep&workspace=ws_tree")
	if !slices.Contains(deep, "src/nested/tree-deep.go") {
		t.Errorf("whole-tree search in the workspace = %v, want src/nested/tree-deep.go", deep)
	}
	if slices.Contains(deep, "src/project-deep.go") {
		t.Errorf("whole-tree search in the workspace = %v, offered a file from the project index", deep)
	}

	// The project is still the project: no workspace named, nothing from the tree.
	_, unbound := askCompletions(t, api.HandleFileCompletions, "/api/completions/files?q=deep")
	if !slices.Contains(unbound, "src/project-deep.go") || slices.Contains(unbound, "src/nested/tree-deep.go") {
		t.Errorf("project search = %v, want the project's index and not the worktree", unbound)
	}
}

// TestPathExistsChecksTheWorkspace: the send-time check that decides whether a
// bare "@word" is a file. Checked against the project, it drops a mention of a
// file the conversation can read and keeps one it cannot.
func TestPathExistsChecksTheWorkspace(t *testing.T) {
	project := t.TempDir()
	worktree := t.TempDir()
	writeTree(t, project, "PROJECTONLY")
	writeTree(t, worktree, "TREEONLY")

	api := completionsOver(project, map[string]core.Workspace{
		"ws_tree": {ID: "ws_tree", Kind: core.WorkspaceKindLocal, Root: worktree, State: core.WorkspaceStateReady},
	})

	_, existing := askCompletions(t, api.HandlePathExists,
		"/api/completions/exists?paths=TREEONLY&paths=PROJECTONLY&workspace=ws_tree")
	if !slices.Equal(existing, []string{"TREEONLY"}) {
		t.Errorf("exists in the workspace = %v, want [TREEONLY]", existing)
	}
}

// TestCompletionsOfferNothingForAWorkspaceTheyCannotResolve: completion is
// best-effort, so a binding that cannot be honoured answers empty rather than
// failing — but never with the project's files, which would be a menu of
// mentions that read from a tree the conversation is not in.
func TestCompletionsOfferNothingForAWorkspaceTheyCannotResolve(t *testing.T) {
	project := t.TempDir()
	writeTree(t, project, "project-only.go")
	gone := t.TempDir()

	api := completionsOver(project, map[string]core.Workspace{
		"ws_building": {ID: "ws_building", Root: gone, State: core.WorkspaceStateProvisioning},
		"ws_closed":   {ID: "ws_closed", Root: gone, State: core.WorkspaceStateClosed},
		"ws_gone":     {ID: "ws_gone", Root: gone + "-removed", State: core.WorkspaceStateReady},
	}, "project-only.go")

	for _, id := range []string{"ws_building", "ws_closed", "ws_gone", "ws_never_registered"} {
		ws := url.QueryEscape(id)
		for _, target := range []string{
			"/api/completions/files?q=&workspace=" + ws,
			"/api/completions/files?q=project&workspace=" + ws,
			"/api/completions/exists?paths=project-only.go&workspace=" + ws,
		} {
			handler := api.HandleFileCompletions
			if strings.HasPrefix(target, "/api/completions/exists") {
				handler = api.HandlePathExists
			}
			rec, got := askCompletions(t, handler, target)
			if rec.Code != http.StatusOK || len(got) != 0 {
				t.Errorf("%s = %d %v, want 200 and nothing", target, rec.Code, got)
			}
		}
	}
}
