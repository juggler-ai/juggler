//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/workspace"
)

// Which tree a git endpoint reports on. All three are one conversation's view of
// its own working tree, so all three resolve the workspace the same way and make
// the same refusals the ops API makes — a status that quietly fell back to the
// project would count one tree while the conversation edited another.

// gitAPIOver builds the git API over a project path and a table of workspaces.
func gitAPIOver(projectPath string, table map[string]core.Workspace) *GitStatusAPI {
	return NewGitStatusAPI(workspace.NewResolver(
		func() string { return projectPath },
		func(id string) (core.Workspace, bool) {
			ws, ok := table[id]
			return ws, ok
		},
		nil,
	).Resolve)
}

// askStatus calls the status endpoint for a workspace id ("" for the project).
func askStatus(t *testing.T, api *GitStatusAPI, workspaceID string) (*httptest.ResponseRecorder, gitStatusResponse) {
	t.Helper()
	target := "/api/git/status"
	if workspaceID != "" {
		target += "?workspace=" + workspaceID
	}
	req := httptest.NewRequest(http.MethodGet, target, nil).WithContext(t.Context())
	rec := httptest.NewRecorder()
	api.HandleGitStatus(rec, req)

	var resp gitStatusResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decoding the response: %v\n%s", err, rec.Body.String())
		}
	}
	return rec, resp
}

// TestGitStatusReportsTheWorkspaceItIsAskedFor pins the whole point of the
// parameter: a second tree, with a change that exists nowhere else, reported
// because the request named it.
func TestGitStatusReportsTheWorkspaceItIsAskedFor(t *testing.T) {
	project := newGitProject(t)
	project.write("in-the-project.txt", "committed")
	project.commit("initial")

	worktree := newGitProject(t)
	worktree.write("only-in-the-worktree.txt", "uncommitted")

	api := gitAPIOver(project.root, map[string]core.Workspace{
		"ws_tree": {
			ID: "ws_tree", Kind: core.WorkspaceKindLocal,
			Root: worktree.root, State: core.WorkspaceStateReady,
		},
	})

	_, bound := askStatus(t, api, "ws_tree")
	if bound.Root != worktree.root {
		t.Fatalf("root = %q, want the workspace %q", bound.Root, worktree.root)
	}
	if len(bound.Repos) != 1 || bound.Repos[0].Changed != 1 {
		t.Fatalf("workspace status = %+v, want the one uncommitted file in that tree", bound.Repos)
	}

	// The project is clean, which is what makes the count above mean something:
	// a scan that had quietly run in the project would have reported zero.
	_, unbound := askStatus(t, api, "")
	if unbound.Root != project.root {
		t.Fatalf("root = %q, want the project %q", unbound.Root, project.root)
	}
	if len(unbound.Repos) != 1 || unbound.Repos[0].Changed != 0 {
		t.Fatalf("project status = %+v, want a clean tree", unbound.Repos)
	}
}

// TestGitAnswersNameTheTreeTheyDescribe: a worktree's status and review carry
// the workspace's name beside its root, so a surface can say which tree it is
// showing from the answer itself rather than from a guess made somewhere else.
// The project is unnamed, and so is a workspace that works in the project (a
// group) — naming one there would claim a separate tree that does not exist.
func TestGitAnswersNameTheTreeTheyDescribe(t *testing.T) {
	project := newGitProject(t)
	project.write("a.txt", "committed")
	project.commit("initial")
	worktree := newGitProject(t)
	worktree.write("b.txt", "uncommitted")

	api := gitAPIOver(project.root, map[string]core.Workspace{
		"ws_tree": {
			ID: "ws_tree", Kind: core.WorkspaceKindLocal, Label: "feat/tunnels",
			Root: worktree.root, State: core.WorkspaceStateReady,
		},
		"ws_group": {
			ID: "ws_group", Kind: core.WorkspaceKindLocal, Label: "Billing",
			Root: project.root + string(filepath.Separator), State: core.WorkspaceStateReady,
		},
	})

	for _, tc := range []struct{ id, want string }{
		{"ws_tree", "feat/tunnels"},
		{"ws_group", ""},
		{"", ""},
	} {
		_, status := askStatus(t, api, tc.id)
		if status.Workspace != tc.want {
			t.Errorf("status for %q names %q, want %q", tc.id, status.Workspace, tc.want)
		}

		target := "/api/git/review"
		if tc.id != "" {
			target += "?workspace=" + tc.id
		}
		rec := httptest.NewRecorder()
		api.HandleGitReview(rec, httptest.NewRequest(http.MethodGet, target, nil).WithContext(t.Context()))
		var review gitReviewResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &review); err != nil {
			t.Fatalf("decoding the review: %v\n%s", err, rec.Body.String())
		}
		if review.Workspace != tc.want {
			t.Errorf("review for %q names %q, want %q", tc.id, review.Workspace, tc.want)
		}
	}
}

// TestGitStatusRefusesAWorkspaceItCannotResolve covers four of the refusals
// (the kind one is the resolver's own test). The
// dangerous answer is not an error but a success: reporting the project for a
// binding that cannot be honoured shows a clean tree for a conversation whose
// own tree is missing, and nothing on screen would say so.
func TestGitStatusRefusesAWorkspaceItCannotResolve(t *testing.T) {
	project := newGitProject(t)
	gone := t.TempDir()

	api := gitAPIOver(project.root, map[string]core.Workspace{
		"ws_building": {ID: "ws_building", Kind: core.WorkspaceKindLocal, Root: gone, State: core.WorkspaceStateProvisioning},
		"ws_closed":   {ID: "ws_closed", Kind: core.WorkspaceKindLocal, Root: gone, State: core.WorkspaceStateClosed},
		"ws_gone":     {ID: "ws_gone", Kind: core.WorkspaceKindLocal, Root: gone + "-removed", State: core.WorkspaceStateReady},
	})

	for _, tc := range []struct {
		id   string
		want string
	}{
		{"ws_building", "still being created"},
		{"ws_closed", "was closed"},
		{"ws_gone", "missing its root"},
		{"ws_never_registered", "unknown workspace"},
	} {
		rec, _ := askStatus(t, api, tc.id)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("GET status?workspace=%s = %d, want 400\n%s", tc.id, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("GET status?workspace=%s said %q, want it to mention %q",
				tc.id, rec.Body.String(), tc.want)
		}
	}
}

// TestGitReviewAndDiffFollowTheSameWorkspace keeps the three endpoints together.
// The pin shows a review's file list and a diff of whichever file is picked, and
// the card's counts sit above them: if the counts followed the conversation and
// the contents did not, the pin would show the name of one tree and the bytes of
// another.
func TestGitReviewAndDiffFollowTheSameWorkspace(t *testing.T) {
	project := newGitProject(t)
	project.write("shared-name.txt", "the project's copy\n")
	project.commit("initial")

	worktree := newGitProject(t)
	worktree.write("shared-name.txt", "the project's copy\n")
	worktree.commit("initial")
	worktree.write("shared-name.txt", "the worktree's edit\n")

	api := gitAPIOver(project.root, map[string]core.Workspace{
		"ws_tree": {
			ID: "ws_tree", Kind: core.WorkspaceKindLocal,
			Root: worktree.root, State: core.WorkspaceStateReady,
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/git/review?workspace=ws_tree", nil).
		WithContext(t.Context())
	rec := httptest.NewRecorder()
	api.HandleGitReview(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET review = %d, want 200\n%s", rec.Code, rec.Body.String())
	}
	var review gitReviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &review); err != nil {
		t.Fatalf("decoding the review: %v\n%s", err, rec.Body.String())
	}
	if review.Root != worktree.root {
		t.Fatalf("review root = %q, want the workspace %q", review.Root, worktree.root)
	}
	if len(review.Repos) != 1 || len(review.Repos[0].Files) != 1 {
		t.Fatalf("review = %+v, want the one edited file in the workspace", review.Repos)
	}

	req = httptest.NewRequest(http.MethodGet,
		"/api/git/diff?workspace=ws_tree&repo=&path=shared-name.txt", nil).WithContext(t.Context())
	rec = httptest.NewRecorder()
	api.HandleGitDiff(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET diff = %d, want 200\n%s", rec.Code, rec.Body.String())
	}
	// The file is committed and unmodified in the project, so a diff that
	// resolved there would be empty. The name exists in both trees on purpose.
	if !strings.Contains(rec.Body.String(), "the worktree's edit") {
		t.Fatalf("diff did not read the workspace's copy of the file:\n%s", rec.Body.String())
	}
}
