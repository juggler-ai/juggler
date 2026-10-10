//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"slices"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
)

// Every handler that acts on a conversation's tree asks the Workspace it was
// resolved to, and never reads its Root as a directory on this machine. The
// workspace here is rooted at a path that does not exist and answers every
// question from a script, so a handler that went to the disk instead would find
// nothing — and a handler that asked would return the script.

const nowhere = "/nowhere/this/tree/does/not/exist"

// scripted is a Workspace whose every answer is canned.
type scripted struct {
	id, name string
	root     string

	toolID     string   // the tool Operations was last asked for
	allowed    []string // the grant it was given
	statable   string   // the one path Stat says exists
	diffErr    error    // what GitDiff fails with, if anything
	reviewWarn string
}

func (s *scripted) ID() string               { return s.id }
func (s *scripted) Root() string             { return s.root }
func (s *scripted) Name() string             { return s.name }
func (s *scripted) LocalDir() (string, bool) { return "", false }

func (s *scripted) Operations(toolID string, allowed []string) (ops.Operations, error) {
	s.toolID, s.allowed = toolID, allowed
	return scriptedOps{}, nil
}

func (s *scripted) StreamShell(_ context.Context, req workspace.ShellRequest, out chan<- ops.ShellStreamChunk) {
	out <- ops.ShellStreamChunk{ShellID: req.ShellID, Data: "from the script", Done: true}
	close(out)
}

func (s *scripted) SearchFiles(context.Context, string, int) ([]ops.FileMatch, error) {
	return []ops.FileMatch{{Path: "scripted/searched.go"}}, nil
}

func (s *scripted) CompletePath(context.Context, string, int) ([]ops.FileMatch, error) {
	return []ops.FileMatch{{Path: "scripted/completed/"}}, nil
}

func (s *scripted) GitStatus(context.Context) ([]gitview.RepoStatus, error) {
	return []gitview.RepoStatus{{Path: "scripted-repo", Changed: 7}}, nil
}

func (s *scripted) GitReview(context.Context, gitview.Scope) (gitview.Manifest, error) {
	return gitview.Manifest{Warnings: []string{s.reviewWarn}}, nil
}

func (s *scripted) GitDiff(context.Context, gitview.DiffRequest) (gitview.FileDiff, error) {
	if s.diffErr != nil {
		return gitview.FileDiff{}, s.diffErr
	}
	return gitview.FileDiff{Path: "scripted.txt", Status: "scripted"}, nil
}

func (s *scripted) Stat(path string) (fs.FileInfo, error) {
	if path == s.statable {
		return scriptedInfo{}, nil
	}
	return nil, fs.ErrNotExist
}

func (s *scripted) Open(string) (workspace.File, error) { return nil, fs.ErrNotExist }

type scriptedOps struct{}

func (scriptedOps) Execute(context.Context, string, map[string]any) (any, error) {
	return "from the script", nil
}

type scriptedInfo struct{ fs.FileInfo }

// resolveTo answers "" with a scripted project and "ws_far" with far; anything
// else is unknown.
func resolveTo(far *scripted) workspace.ResolveFunc {
	project := &scripted{root: nowhere + "/project"}
	return func(id string) (workspace.Workspace, error) {
		switch id {
		case "":
			return project, nil
		case far.id:
			return far, nil
		}
		return nil, errors.New("unknown workspace: " + id)
	}
}

func TestOpsAPIAsksTheWorkspace(t *testing.T) {
	far := &scripted{id: "ws_far", root: nowhere}
	api := NewOpsAPI(resolveTo(far))

	got, err := api.routeOperation(t.Context(), OperationRequest{
		ToolID: "read-file", Operation: "loadFile", WorkspaceID: "ws_far",
		AllowedPaths: []string{"/granted"},
	})
	if err != nil || got != "from the script" {
		t.Fatalf("routeOperation = %v, %v, want the workspace's own answer", got, err)
	}
	if far.toolID != "read-file" || !slices.Equal(far.allowed, []string{"/granted"}) {
		t.Errorf("the workspace was asked for %q with grant %v, want read-file with [/granted]", far.toolID, far.allowed)
	}
}

func TestCompletionsAskTheWorkspace(t *testing.T) {
	far := &scripted{id: "ws_far", root: nowhere, statable: "THERE"}
	api := NewCompletionsAPI(resolveTo(far))

	for _, tc := range []struct {
		handler http.HandlerFunc
		target  string
		want    []string
	}{
		{api.HandleFileCompletions, "/api/completions/files?q=x&workspace=ws_far", []string{"scripted/searched.go"}},
		{api.HandlePathCompletions, "/api/completions/path?q=./x&workspace=ws_far", []string{"scripted/completed/"}},
		{api.HandlePathExists, "/api/completions/exists?paths=THERE&paths=GONE&workspace=ws_far", []string{"THERE"}},
	} {
		if _, got := askCompletions(t, tc.handler, tc.target); !slices.Equal(got, tc.want) {
			t.Errorf("%s = %v, want %v", tc.target, got, tc.want)
		}
	}
}

func TestGitAPIAsksTheWorkspace(t *testing.T) {
	far := &scripted{id: "ws_far", name: "far away", root: nowhere, reviewWarn: "scripted warning"}
	api := NewGitStatusAPI(resolveTo(far))

	var status gitStatusResponse
	rec := askGit(t, api, t.Context(), "/api/git/status?workspace=ws_far")
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("status: %v\n%s", err, rec.Body.String())
	}
	if status.Root != nowhere || status.Workspace != "far away" || len(status.Repos) != 1 || status.Repos[0].Path != "scripted-repo" {
		t.Errorf("status = %+v, want the workspace's root, name and repositories", status)
	}

	var review gitReviewResponse
	rec = askGit(t, api, t.Context(), "/api/git/review?workspace=ws_far")
	if err := json.Unmarshal(rec.Body.Bytes(), &review); err != nil {
		t.Fatalf("review: %v\n%s", err, rec.Body.String())
	}
	if review.Root != nowhere || review.Workspace != "far away" || !slices.Equal(review.Warnings, []string{"scripted warning"}) {
		t.Errorf("review = %+v, want the workspace's manifest", review)
	}

	rec = askGit(t, api, t.Context(), "/api/git/diff?workspace=ws_far&path=scripted.txt")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"scripted"`) {
		t.Errorf("diff = %d %s, want the workspace's diff", rec.Code, rec.Body.String())
	}

	far.diffErr = errors.New("the far side went away")
	if rec := askGit(t, api, t.Context(), "/api/git/diff?workspace=ws_far&path=x"); rec.Code != http.StatusBadGateway {
		t.Errorf("a diff the workspace could not read = %d, want 502", rec.Code)
	}
	far.diffErr = &gitview.RequestError{}
	if rec := askGit(t, api, t.Context(), "/api/git/diff?workspace=ws_far&path=x"); rec.Code != http.StatusBadRequest {
		t.Errorf("a diff the workspace refused = %d, want 400", rec.Code)
	}
}
