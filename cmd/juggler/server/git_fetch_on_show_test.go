//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"juggler/cmd/juggler/gitops"
	"juggler/cmd/juggler/gitview/gitviewtest"
	"juggler/cmd/juggler/workspace"
)

// fetchOnShow asks the route as the router would, and returns its answer.
func fetchOnShow(t *testing.T, s *Server, workspaceID, repo string) gitFetchOnShowAnswer {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/git/fetch-on-show?workspace="+workspaceID+"&repo="+repo, nil).WithContext(t.Context())
	s.handleGitFetchOnShow(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("fetch-on-show %q = %d %s, want 200", workspaceID, rec.Code, rec.Body.String())
	}
	var answer gitFetchOnShowAnswer
	if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
		t.Fatalf("fetch-on-show answer: %v\n%s", err, rec.Body.String())
	}
	if (answer.Job == nil) == !answer.Skipped {
		t.Fatalf("fetch-on-show answered %s: want a job or skipped, not both or neither", rec.Body.String())
	}
	return answer
}

// The first time the pin shows a repository in a server session it fetches it,
// once, for every tree of it: the project, the same main tree by another id and
// a linked worktree all share one fetch. Another repository gets its own, and a
// fresh server (a new session) fetches again.
func TestFetchOnShowOncePerRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Cleanup(gitviewtest.LendClocks(time.Minute, 5*time.Minute))

	newRepo := func() string {
		dir := t.TempDir()
		gitIn(t, dir, "init", "-q")
		gitIn(t, dir, "config", "user.email", "test@example.com")
		gitIn(t, dir, "config", "user.name", "Juggler Test")
		gitIn(t, dir, "commit", "-q", "--allow-empty", "-m", "init")
		bare := filepath.Join(t.TempDir(), "origin.git")
		gitIn(t, dir, "init", "-q", "--bare", bare)
		gitIn(t, dir, "remote", "add", "origin", bare)
		gitIn(t, dir, "push", "-q", "origin", "HEAD:refs/heads/main")
		return dir
	}
	main := newRepo()
	linked := filepath.Join(t.TempDir(), "linked")
	gitIn(t, main, "worktree", "add", "-q", "-b", "side", linked)
	elsewhere := newRepo()

	queue := gitops.NewQueue()
	t.Cleanup(queue.Close)
	tree := func(root string) workspace.Workspace {
		ws, err := workspace.NewResolver(func() string { return root }, nil, nil).
			WithGitQueue(func() *gitops.Queue { return queue }).Resolve("")
		if err != nil {
			t.Fatal(err)
		}
		return ws
	}
	trees := map[string]workspace.Workspace{"": tree(main), "wt_main": tree(main), "ws_linked": tree(linked), "ws_elsewhere": tree(elsewhere)}

	s := newTestServerState(t)
	s.gitWatchResolve = resolveTrees(trees)
	t.Cleanup(s.stopGitJobs)

	first := fetchOnShow(t, s, "ws_linked", "")
	if first.Job == nil || !first.Job.Auto || first.Job.Kind != gitops.OpFetch {
		t.Fatalf("the first showing = %+v, want an auto fetch", first)
	}
	for _, id := range []string{"", "wt_main", "ws_linked"} {
		if again := fetchOnShow(t, s, id, ""); !again.Skipped {
			t.Errorf("showing %q after its repository was fetched started another fetch: %+v", id, again.Job)
		}
	}
	gitJobEnded(t, s, first.Job.ID)
	done := readGitJob(t, s, "ws_linked", first.Job.ID)
	if done.State != gitJobDone || !slices.EqualFunc(done.Commands, [][]string{{"fetch", "--all", "--prune", "--progress"}}, slices.Equal) {
		t.Errorf("the fetch = %+v, want it done, fetching every remote", done)
	}

	other := fetchOnShow(t, s, "ws_elsewhere", "")
	if other.Job == nil {
		t.Error("another repository was not fetched on its first showing")
	} else {
		gitJobEnded(t, s, other.Job.ID)
	}

	fresh := newTestServerState(t)
	fresh.gitWatchResolve = resolveTrees(trees)
	t.Cleanup(fresh.stopGitJobs)
	if again := fetchOnShow(t, fresh, "", ""); again.Job == nil {
		t.Error("a new server session did not fetch on first showing")
	} else {
		gitJobEnded(t, fresh, again.Job.ID)
	}
}
