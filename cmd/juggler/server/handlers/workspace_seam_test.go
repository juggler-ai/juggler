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

	"juggler/cmd/juggler/gitops"
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

	read    gitview.Query // the query GitRead was last asked
	readErr error         // what GitRead fails with, if anything
	ran     *gitops.Op    // the op GitRun was last asked to run
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

func (s *scripted) GitWatch(context.Context) (<-chan []gitops.Change, error) {
	return nil, errors.New("the script watches nothing")
}

func (s *scripted) GitRead(_ context.Context, q gitview.Query) (any, error) {
	s.read = q
	if s.readErr != nil {
		return nil, s.readErr
	}
	return gitview.Changes{Repo: q.Repo, Branch: "scripted-branch", Files: []gitview.ChangedFile{}}, nil
}

func (s *scripted) GitRun(_ context.Context, op gitops.Op, _ gitops.Hooks) (gitops.Result, error) {
	s.ran = &op
	return gitops.Result{Head: "scripted-head"}, nil
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

// Every read of the git client is the workspace's answer to the query the
// request names, and fails as a diff does: an unusable tree or a refused
// request is the asker's (400), a read that failed is not (502).
func TestGitReadAsksTheWorkspace(t *testing.T) {
	far := &scripted{id: "ws_far", root: nowhere}
	api := NewGitStatusAPI(resolveTo(far))

	rec := askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=changes&repo=libs/inner")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"branch":"scripted-branch"`) {
		t.Errorf("changes = %d %s, want the workspace's answer", rec.Code, rec.Body.String())
	}
	if want := (gitview.Query{Kind: gitview.QueryChanges, Repo: "libs/inner"}); far.read != want {
		t.Errorf("the workspace was asked %+v, want %+v", far.read, want)
	}
	askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=worktrees")
	if want := (gitview.Query{Kind: gitview.QueryWorktrees}); far.read != want {
		t.Errorf("the workspace was asked %+v, want %+v", far.read, want)
	}
	askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=log&repo=sub&graph=g1&scope=ref&ref=main"+
		"&message=fix+it&author=ann&path=a%2Fb.go&offset=400&limit=200&refresh=1&find=abc123")
	if want := (gitview.Query{Kind: gitview.QueryLog, Repo: "sub", Log: gitview.LogQuery{
		Graph: "g1", Scope: "ref", Ref: "main", Message: "fix it", Author: "ann", Path: "a/b.go",
		Offset: 400, Limit: 200, Refresh: true, Find: "abc123",
	}}); far.read != want {
		t.Errorf("the workspace was asked %+v, want %+v", far.read, want)
	}
	askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=commit&commit=abc123")
	if want := (gitview.Query{Kind: gitview.QueryCommit, Commit: "abc123"}); far.read != want {
		t.Errorf("the workspace was asked %+v, want %+v", far.read, want)
	}
	askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=blame&repo=sub&path=a%2Fb.go&rev=%40staged")
	if want := (gitview.Query{Kind: gitview.QueryBlame, Repo: "sub", Blame: gitview.BlameQuery{Path: "a/b.go", Rev: "@staged"}}); far.read != want {
		t.Errorf("the workspace was asked %+v, want %+v", far.read, want)
	}
	askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=attribution&repo=sub&amend=1&conv=conv_seen")
	if want := (gitview.Query{Kind: gitview.QueryAttribution, Repo: "sub", Attribution: gitview.AttributionQuery{Amend: true, Conv: "conv_seen"}}); far.read != want {
		t.Errorf("the workspace was asked %+v, want %+v", far.read, want)
	}
	askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=attribution")
	if want := (gitview.Query{Kind: gitview.QueryAttribution}); far.read != want {
		t.Errorf("the workspace was asked %+v, want %+v", far.read, want)
	}
	askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=commit-context&repo=sub&amend=1")
	if want := (gitview.Query{Kind: gitview.QueryCommitContext, Repo: "sub", CommitContext: gitview.CommitContextQuery{Amend: true}}); far.read != want {
		t.Errorf("the workspace was asked %+v, want %+v", far.read, want)
	}
	if rec := askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=log&offset=many"); rec.Code != http.StatusBadRequest {
		t.Errorf("a log read with an offset that is not a number = %d, want 400", rec.Code)
	}

	far.readErr = errors.New("the far side went away")
	if rec := askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=refs"); rec.Code != http.StatusBadGateway ||
		!strings.Contains(rec.Body.String(), `"key":"Couldn't read the repository. {detail}"`) {
		t.Errorf("a read the workspace could not make = %d %s, want 502 with the message", rec.Code, rec.Body.String())
	}
	far.readErr = &gitview.RequestError{}
	if rec := askGit(t, api, t.Context(), "/api/git/read?workspace=ws_far&kind=changes"); rec.Code != http.StatusBadRequest {
		t.Errorf("a read the workspace refused = %d, want 400", rec.Code)
	}
	if rec := askGit(t, api, t.Context(), "/api/git/read?workspace=ws_gone&kind=changes"); rec.Code != http.StatusBadRequest {
		t.Errorf("a read of an unknown workspace = %d, want 400", rec.Code)
	}
	unopened := NewGitStatusAPI(func(string) (workspace.Workspace, error) { return &scripted{}, nil })
	if rec := askGit(t, unopened, t.Context(), "/api/git/read?kind=changes"); rec.Code != http.StatusBadRequest ||
		!strings.Contains(rec.Body.String(), "No project is open") {
		t.Errorf("a read with no project open = %d %s, want 400 No project is open", rec.Code, rec.Body.String())
	}
}
