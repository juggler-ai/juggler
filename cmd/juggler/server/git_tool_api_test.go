//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/gitview/gitviewtest"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/workspace"
)

// What git says about a tree is gitview's to test. These are the git tool's
// own questions: which tree a call is about, and what an answer or a failure
// becomes.

// gitProject is a throwaway project directory holding a throwaway repository.
type gitProject struct {
	t    *testing.T
	root string
}

// newGitProject creates a project whose root is itself a repository, with git
// reading no configuration but its own and every git clock lent enough time
// that none of them is what a test measures (see gitviewtest.LendClocks).
func newGitProject(t *testing.T) *gitProject {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Cleanup(gitviewtest.LendClocks(time.Minute, 5*time.Minute))

	p := &gitProject{t: t, root: t.TempDir()}
	p.git("init", "-q")
	p.git("config", "user.email", "test@example.com")
	p.git("config", "user.name", "Juggler Test")
	p.git("config", "commit.gpgsign", "false")
	return p
}

// git runs one git command in the repository and fails the test if it could not.
func (p *gitProject) git(args ...string) {
	p.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = p.root
	if out, err := cmd.CombinedOutput(); err != nil {
		p.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

// write creates or replaces a file in the working tree.
func (p *gitProject) write(rel, content string) {
	p.t.Helper()
	abs := filepath.Join(p.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
		p.t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o600); err != nil {
		p.t.Fatal(err)
	}
}

// commit stages everything in the working tree and commits it.
func (p *gitProject) commit(message string) {
	p.t.Helper()
	p.git("add", "-A")
	p.git("commit", "-qm", message)
}

// gitAPIOn builds the git tool's API over a live project path and no session.
func gitAPIOn(project func() string) *handlers.OpsAPI {
	return gitToolAPI(workspace.NewResolver(project, nil, nil).Resolve)
}

// gitToolAPI is an ops API whose only tool of its own is the git tool, of a
// server with nothing else, over resolve.
func gitToolAPI(resolve workspace.ResolveFunc) *handlers.OpsAPI {
	table := ops.NewTable()
	(&Server{}).registerGitTool(table)
	return handlers.NewOpsAPI(resolve).WithTable(table).WithClientTrees(resolve)
}

// gitAnswer is one git tool call's answer, as these tests read it. Code sorts
// it: 200 is an answer, whose Data is Body; a failure is 502 when its message
// says the read itself could not be made ("Couldn't …") and 400 when it is a
// refusal of the request — what was asked, or the tree it was asked in — and
// Body is then the whole response.
type gitAnswer struct {
	Code int
	Body *bytes.Buffer
}

// askGit calls the git tool's operation named by target, written as the URL
// of the route it stands for (/api/git/<operation>?<params>), through the
// client's entry as the viewer would. A parameter is a string, but for the
// flags (=1) and the numbers of a log read; paths= repeats.
func askGit(t *testing.T, api *handlers.OpsAPI, ctx context.Context, target string) gitAnswer {
	t.Helper()
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	params := map[string]any{}
	for name, values := range u.Query() {
		v := values[0]
		switch name {
		case "workspace":
		case "paths":
			params[name] = values
		case "amend", "refresh", "worktree":
			params[name] = v == "1"
		case "offset", "limit":
			if n, err := strconv.Atoi(v); err == nil {
				params[name] = n
			} else {
				params[name] = v
			}
		default:
			params[name] = v
		}
	}
	body, _ := json.Marshal(handlers.OperationRequest{
		ToolID: gitToolID, Operation: path.Base(u.Path), Params: params, WorkspaceID: u.Query().Get("workspace"),
	})
	rec := httptest.NewRecorder()
	api.HandleClientCall(rec, httptest.NewRequest(http.MethodPost, "/api/ops/client", bytes.NewReader(body)).WithContext(ctx))
	var resp handlers.OperationResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("%s: %v\n%s", target, err, rec.Body.String())
	}
	switch {
	case resp.Success:
		data, _ := json.Marshal(resp.Data)
		return gitAnswer{Code: http.StatusOK, Body: bytes.NewBuffer(data)}
	case resp.Message != nil && strings.HasPrefix(resp.Message.Key, "Couldn't"):
		return gitAnswer{Code: http.StatusBadGateway, Body: bytes.NewBuffer(rec.Body.Bytes())}
	default:
		return gitAnswer{Code: http.StatusBadRequest, Body: bytes.NewBuffer(rec.Body.Bytes())}
	}
}

// The project path is read on every request, so a switch retargets the review
// rather than answering about the project that was open when the server started.
func TestGitReviewFollowsAProjectSwitch(t *testing.T) {
	first := newGitProject(t)
	first.write("first.txt", "x\n")
	second := newGitProject(t)
	second.write("second.txt", "x\n")

	open := first.root
	api := gitAPIOn(func() string { return open })
	manifest := func() gitReviewAnswer {
		t.Helper()
		rec := askGit(t, api, t.Context(), "/api/git/review")
		var resp gitReviewAnswer
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decoding the response: %v\n%s", err, rec.Body.String())
		}
		return resp
	}
	files := func(resp gitReviewAnswer) []string {
		var paths []string
		for _, repo := range resp.Repos {
			for _, file := range repo.Files {
				paths = append(paths, file.Path)
			}
		}
		return paths
	}

	before := manifest()
	if before.Root != first.root || strings.Join(files(before), ",") != "first.txt" {
		t.Errorf("review = %s %v, want %s [first.txt]", before.Root, files(before), first.root)
	}
	open = second.root
	after := manifest()
	if after.Root != second.root || strings.Join(files(after), ",") != "second.txt" {
		t.Errorf("review = %s %v, want %s [second.txt] — the review answered about the project that was closed",
			after.Root, files(after), second.root)
	}
}

// With no project open nothing runs: the dispatcher refuses every operation,
// the card's status read included, before the tool is built.
func TestGitReviewWithNoProject(t *testing.T) {
	api := gitAPIOn(func() string { return "" })
	for _, target := range []string{"/api/git/review", "/api/git/diff?path=f.txt", "/api/git/status"} {
		if rec := askGit(t, api, t.Context(), target); rec.Code != http.StatusBadRequest ||
			!strings.Contains(rec.Body.String(), "no project loaded") {
			t.Errorf("%s with no project = %d %s, want it refused saying no project is loaded", target, rec.Code, rec.Body.String())
		}
	}
}

// The scope rides the query string to both the review and the diff, comes back
// in the manifest, and a scope that cannot be read — or names a revision the
// repository lacks — is the asker's mistake.
func TestGitReviewAndDiffTakeAScope(t *testing.T) {
	p := newGitProject(t)
	p.write("staged.txt", "one\n")
	p.write("unstaged.txt", "one\n")
	p.commit("init")
	p.write("staged.txt", "two\n")
	p.git("add", "staged.txt")
	p.write("unstaged.txt", "two\n")
	api := gitAPIOn(func() string { return p.root })

	rec := askGit(t, api, t.Context(), "/api/git/review?scope=%40staged")
	var resp gitReviewAnswer
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("review in @staged = %d %s", rec.Code, rec.Body.String())
	}
	if resp.Scope.Input != "@staged" || len(resp.Repos) != 1 || len(resp.Repos[0].Files) != 1 ||
		resp.Repos[0].Files[0].Path != "staged.txt" {
		t.Errorf("review in @staged = %+v, want staged.txt alone and the scope reported", resp)
	}

	rec = askGit(t, api, t.Context(), "/api/git/diff?path=unstaged.txt&scope=%40staged")
	var diff gitview.FileDiff
	if err := json.Unmarshal(rec.Body.Bytes(), &diff); err != nil || rec.Code != http.StatusOK || diff.Status != "unchanged" {
		t.Errorf("diff of unstaged.txt in @staged = %d %s, want 200 and unchanged", rec.Code, rec.Body.String())
	}

	for _, target := range []string{
		"/api/git/review?scope=--output%3D%2Ftmp%2Fx",
		"/api/git/diff?path=staged.txt&scope=-p",
		"/api/git/diff?path=staged.txt&scope=nosuch",
	} {
		if rec := askGit(t, api, t.Context(), target); rec.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d, want 400\n%s", target, rec.Code, rec.Body.String())
		}
	}
}

// @turn takes its conversation from conv=, on the review and the diff alike.
func TestGitTurnScopeTakesItsConversation(t *testing.T) {
	p := newGitProject(t)
	p.write("f.txt", "one\n")
	p.commit("init")
	out, err := exec.Command("git", "-C", p.root, "write-tree").Output()
	if err != nil {
		t.Fatal(err)
	}
	p.git("update-ref", "refs/juggler/turns/conv-1", strings.TrimSpace(string(out)))
	p.write("f.txt", "two\n")
	api := gitAPIOn(func() string { return p.root })

	rec := askGit(t, api, t.Context(), "/api/git/review?scope=%40turn&conv=conv-1")
	var resp gitReviewAnswer
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("review in @turn = %d %s", rec.Code, rec.Body.String())
	}
	if len(resp.Repos) != 1 || resp.Repos[0].Error != "" || len(resp.Repos[0].Files) != 1 {
		t.Errorf("review in @turn = %+v, want f.txt alone", resp.Repos)
	}
	rec = askGit(t, api, t.Context(), "/api/git/diff?path=f.txt&scope=%40turn&conv=conv-1")
	var diff gitview.FileDiff
	if err := json.Unmarshal(rec.Body.Bytes(), &diff); err != nil || rec.Code != http.StatusOK || len(diff.Hunks) == 0 {
		t.Errorf("diff of f.txt in @turn = %d %s, want its edit", rec.Code, rec.Body.String())
	}
	if rec := askGit(t, api, t.Context(), "/api/git/diff?path=f.txt&scope=%40turn&conv=conv-2"); rec.Code != http.StatusBadRequest ||
		!strings.Contains(rec.Body.String(), "no turn snapshot") {
		t.Errorf("diff in @turn of a conversation with no snapshot = %d %s, want 400 saying so", rec.Code, rec.Body.String())
	}
}

// A diff refused for what it asked for is the asker's to fix, and one git could
// not produce is not: the two travel as different statuses, and the second says
// it is the diff that could not be read.
func TestGitDiffStatusSaysWhoseProblemItIs(t *testing.T) {
	p := newGitProject(t)
	p.write("f.txt", "one\n")
	p.commit("init")
	p.write("f.txt", "two\n")
	api := gitAPIOn(func() string { return p.root })

	if rec := askGit(t, api, t.Context(), "/api/git/diff?path=../secret.txt"); rec.Code != http.StatusBadRequest {
		t.Errorf("a path climbing out = %d, want 400\n%s", rec.Code, rec.Body.String())
	}

	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	rec := askGit(t, api, cancelled, "/api/git/diff?path=f.txt")
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "Couldn't read the diff.") {
		t.Errorf("a cancelled read = %d %s, want 502 saying the diff could not be read", rec.Code, rec.Body.String())
	}

	rec = askGit(t, api, t.Context(), "/api/git/diff?path=f.txt")
	var diff gitview.FileDiff
	if err := json.Unmarshal(rec.Body.Bytes(), &diff); err != nil || rec.Code != http.StatusOK || diff.Status != "modified" {
		t.Errorf("an ordinary diff = %d %s, want 200 and a modified file", rec.Code, rec.Body.String())
	}
}

// A read's parameters, as the client sends them, ask gitview the query they
// name — every read's own fields, and no other read's.
func TestGitReadParamsAskTheirQuery(t *testing.T) {
	for _, tc := range []struct {
		params map[string]any
		want   gitview.Query
	}{
		{map[string]any{"kind": "changes", "repo": "libs/inner"}, gitview.Query{Kind: gitview.QueryChanges, Repo: "libs/inner"}},
		{map[string]any{"kind": "worktrees"}, gitview.Query{Kind: gitview.QueryWorktrees}},
		{map[string]any{
			"kind": "log", "repo": "sub", "graph": "g1", "scope": "ref", "ref": "main", "message": "fix it",
			"author": "ann", "path": "a/b.go", "offset": 400, "limit": 200, "refresh": true, "find": "abc123",
		}, gitview.Query{Kind: gitview.QueryLog, Repo: "sub", Log: gitview.LogQuery{
			Graph: "g1", Scope: "ref", Ref: "main", Message: "fix it", Author: "ann", Path: "a/b.go",
			Offset: 400, Limit: 200, Refresh: true, Find: "abc123",
		}}},
		{map[string]any{"kind": "commit", "commit": "abc123"}, gitview.Query{Kind: gitview.QueryCommit, Commit: "abc123"}},
		{map[string]any{"kind": "blame", "repo": "sub", "path": "a/b.go", "rev": "@staged"},
			gitview.Query{Kind: gitview.QueryBlame, Repo: "sub", Blame: gitview.BlameQuery{Path: "a/b.go", Rev: "@staged"}}},
		{map[string]any{"kind": "attribution", "repo": "sub", "amend": true, "conv": "conv_seen"},
			gitview.Query{Kind: gitview.QueryAttribution, Repo: "sub", Attribution: gitview.AttributionQuery{Amend: true, Conv: "conv_seen"}}},
		{map[string]any{"kind": "attribution"}, gitview.Query{Kind: gitview.QueryAttribution}},
		{map[string]any{"kind": "commit-context", "repo": "sub", "amend": true},
			gitview.Query{Kind: gitview.QueryCommitContext, Repo: "sub", CommitContext: gitview.CommitContextQuery{Amend: true}}},
		{map[string]any{"kind": "stranded", "ref": "refs/heads/x", "path": "ignored"},
			gitview.Query{Kind: gitview.QueryStranded, Ref: "refs/heads/x"}},
	} {
		p, err := paramsAs[gitReadParams](tc.params)
		if err != nil {
			t.Fatalf("%v: %v", tc.params, err)
		}
		if got := p.query(); got != tc.want {
			t.Errorf("%v asked %+v, want %+v", tc.params, got, tc.want)
		}
	}
	if _, err := paramsAs[gitReadParams](map[string]any{"kind": "log", "offset": "many"}); err == nil {
		t.Error("a log read with an offset that is not a number was read")
	}
}
