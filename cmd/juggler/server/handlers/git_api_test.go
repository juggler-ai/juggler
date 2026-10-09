//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/workspace"
)

// What git says about a tree is gitview's to test. These are the API's own
// questions: which tree a request is about, and what HTTP an answer or a
// failure becomes.

// gitProject is a throwaway project directory holding a throwaway repository.
type gitProject struct {
	t    *testing.T
	root string
}

// newGitProject creates a project whose root is itself a repository, with git
// reading no configuration but its own and every git clock lent enough time
// that none of them is what a test measures (see gitview.LendClocks).
func newGitProject(t *testing.T) *gitProject {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Cleanup(gitview.LendClocks(time.Minute, 5*time.Minute))

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

// gitAPIOn builds the git API over a live project path and no session.
func gitAPIOn(project func() string) *GitStatusAPI {
	return NewGitStatusAPI(workspace.NewResolver(project, nil, nil).Resolve)
}

// askGit calls one of the three endpoints the way the router would.
func askGit(t *testing.T, api *GitStatusAPI, ctx context.Context, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, target, nil).WithContext(ctx)
	switch {
	case strings.HasPrefix(target, "/api/git/status"):
		api.HandleGitStatus(rec, req)
	case strings.HasPrefix(target, "/api/git/review"):
		api.HandleGitReview(rec, req)
	case strings.HasPrefix(target, "/api/git/diff"):
		api.HandleGitDiff(rec, req)
	default:
		t.Fatalf("not a git endpoint: %s", target)
	}
	return rec
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
	manifest := func() gitReviewResponse {
		t.Helper()
		rec := askGit(t, api, t.Context(), "/api/git/review")
		var resp gitReviewResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decoding the response: %v\n%s", err, rec.Body.String())
		}
		return resp
	}
	files := func(resp gitReviewResponse) []string {
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

// A project nobody opened is not an empty review of one, nor a diff of nothing.
// The card is polled, so it answers with no repositories instead.
func TestGitReviewWithNoProject(t *testing.T) {
	api := gitAPIOn(func() string { return "" })
	for target, want := range map[string]int{
		"/api/git/review":          http.StatusBadRequest,
		"/api/git/diff?path=f.txt": http.StatusBadRequest,
		"/api/git/status":          http.StatusOK,
	} {
		rec := askGit(t, api, t.Context(), target)
		if rec.Code != want {
			t.Errorf("GET %s = %d, want %d\n%s", target, rec.Code, want, rec.Body.String())
			continue
		}
		if want == http.StatusBadRequest && !strings.Contains(rec.Body.String(), "No project is open") {
			t.Errorf("GET %s refused with %s, want it to say no project is open", target, rec.Body.String())
		}
	}

	// About nothing: a scan of whatever directory the server runs in would
	// answer 200 too.
	var status gitStatusResponse
	if err := json.Unmarshal(askGit(t, api, t.Context(), "/api/git/status").Body.Bytes(), &status); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if status.Root != "" || len(status.Repos) != 0 {
		t.Errorf("status with no project = root %q, %d repos, want no root and no repositories", status.Root, len(status.Repos))
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
