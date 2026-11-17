//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/gitops"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/gitview/gitviewtest"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/workspace"
)

// gitIn runs one git command in dir and returns what it printed, failing the
// test if it could not.
func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// The whole write side, through a real tree: a line staged and then committed
// by jobs in a linked worktree lands on the worktree's branch, is what the
// Changes read reports afterwards, and leaves the main tree's HEAD where it was.
func TestGitJob_EndToEndInALinkedWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Cleanup(gitviewtest.LendClocks(time.Minute, 5*time.Minute))

	main := t.TempDir()
	gitIn(t, main, "init", "-q")
	gitIn(t, main, "config", "user.email", "test@example.com")
	gitIn(t, main, "config", "user.name", "Juggler Test")
	gitIn(t, main, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(main, "a.txt"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitIn(t, main, "add", "-A")
	gitIn(t, main, "commit", "-qm", "init")
	linked := filepath.Join(t.TempDir(), "linked")
	gitIn(t, main, "worktree", "add", "-q", "-b", "side", linked)
	mainHead := gitIn(t, main, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(linked, "a.txt"), []byte("one\ntwo\nthree\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	queue := gitops.NewQueue()
	t.Cleanup(queue.Close)
	resolver := workspace.NewResolver(func() string { return linked }, nil, nil).
		WithGitQueue(func() *gitops.Queue { return queue })
	s := newTestServerState(t)
	s.gitWatchResolve = resolver.Resolve
	t.Cleanup(s.stopGitJobs)

	patch, err := gitview.ReadPatch(t.Context(), linked, gitview.DiffRequest{Path: "a.txt", Scope: "@unstaged"})
	if err != nil {
		t.Fatal(err)
	}
	stage, _ := json.Marshal(gitops.Op{
		Kind: gitops.OpStageLines, Path: "a.txt", Revision: patch.Revision,
		Lines: []gitops.LineRef{{New: 2}},
	})
	job := startGitJob(t, s, "", string(stage))
	gitJobEnded(t, s, job.ID)
	if got := readGitJob(t, s, "", job.ID); got.State != gitJobDone {
		t.Fatalf("stage-lines = %+v, want it done", got)
	}

	job = startGitJob(t, s, "", `{"kind":"commit","message":"Add two"}`)
	gitJobEnded(t, s, job.ID)
	committed := readGitJob(t, s, "", job.ID)
	if committed.State != gitJobDone || committed.Result.Head == "" {
		t.Fatalf("commit = %+v, want it done with the new HEAD", committed)
	}

	rec := httptest.NewRecorder()
	handlers.NewGitStatusAPI(resolver.Resolve).HandleGitRead(rec, httptest.NewRequest(http.MethodGet, "/api/git/read?kind=changes", nil))
	var changes gitview.Changes
	if err := json.Unmarshal(rec.Body.Bytes(), &changes); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("changes = %d %s (%v)", rec.Code, rec.Body.String(), err)
	}
	if changes.Branch != "side" || changes.Head == nil || strings.TrimSpace(changes.Head.Message) != "Add two" || changes.Head.Sha != committed.Result.Head {
		t.Errorf("changes = %+v (head %+v), want side at the commit just made", changes, changes.Head)
	}
	if len(changes.Files) != 1 || changes.Files[0].Staged != nil || changes.Files[0].Unstaged == nil ||
		*changes.Files[0].Unstaged != (gitview.Stat{Added: 1}) {
		t.Errorf("files = %+v, want a.txt with only the unstaged third line left", changes.Files)
	}
	if got := gitIn(t, main, "show", "HEAD:a.txt"); got != "one" {
		t.Errorf("the main tree's HEAD holds %q, want it untouched", got)
	}
	if got := gitIn(t, main, "rev-parse", "HEAD"); got != mainHead {
		t.Errorf("the main tree's HEAD moved from %s to %s", mainHead, got)
	}
}

// A fetch from a remote that wants a password, answered through the job, with
// the real server binary as git's askpass — so app.Run's turn to gitaskpass is
// what answers git, as it is in the shipped server. check and test-all name
// that binary in JUGGLER_TEST_SERVER.
func TestGitJob_EndToEndAskpassThroughTheServerBinary(t *testing.T) {
	exe := os.Getenv("JUGGLER_TEST_SERVER")
	if exe == "" {
		t.Skip("JUGGLER_TEST_SERVER names no server binary: run this through make check or make test-all")
	}
	clone, want := httpRemote(t)
	s, viewer := askpassServer(t, clone)
	s.gitAskpassExe = exe
	frames := &frameRecorder{t: t, conn: viewer}

	job := startGitJob(t, s, "", `{"kind":"fetch"}`)
	ended := signIn(t, s, frames, job.ID)
	if ended.State != gitJobDone {
		t.Fatalf("fetch = %+v, want it done once signed in", ended)
	}
	if got := gitIn(t, clone, "rev-parse", "origin/main"); got != want {
		t.Errorf("origin/main = %s, want %s", got, want)
	}
	noSecret(t, s, frames, job.ID)
}
