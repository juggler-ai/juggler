//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/gitops"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/workspace"

	"github.com/gorilla/websocket"
)

// A git write is a job: started by one request, answered at once, and run to
// its end on the server's time rather than the request's. What git does is
// gitops's business; these are about the job — who hears of it, how it ends,
// and what can be read back about it afterwards. The trees are scripted.

// jobTree is a workspace whose writes the test drives. Each GitRun names one
// command, prints output if any, announces itself on started with its context,
// and then waits for release (when there is one) or for its context to end.
type jobTree struct {
	workspace.Workspace
	output  string
	err     error
	release chan struct{}
	started chan context.Context
}

func newJobTree() *jobTree {
	return &jobTree{started: make(chan context.Context, 4)}
}

func (j *jobTree) GitWatch(context.Context) (<-chan []gitops.Change, error) {
	return nil, errors.New("this tree is not watched")
}

func (j *jobTree) GitRun(ctx context.Context, op gitops.Op, hooks gitops.Hooks) (gitops.Result, error) {
	hooks.Command([]string{"add", "--", op.Path})
	if j.output != "" {
		hooks.Output([]byte(j.output))
	}
	j.started <- ctx
	if j.release != nil {
		select {
		case <-j.release:
		case <-ctx.Done():
			return gitops.Result{}, ctx.Err()
		}
	}
	if j.err != nil {
		return gitops.Result{}, j.err
	}
	return gitops.Result{Head: "abc123"}, nil
}

// resolveTrees resolves each id to its tree, and nothing else.
func resolveTrees(trees map[string]workspace.Workspace) workspace.ResolveFunc {
	return func(id string) (workspace.Workspace, error) {
		if ws, ok := trees[id]; ok {
			return ws, nil
		}
		return nil, errors.New("unknown workspace: " + id)
	}
}

// runGitJob posts an op to the run route as the router would, and returns the
// recorded answer.
func runGitJob(t *testing.T, s *Server, ctx context.Context, workspaceID, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/git/run?workspace="+workspaceID, strings.NewReader(body)).WithContext(ctx)
	s.handleGitRun(rec, req)
	return rec
}

// startGitJob runs an op that must be accepted, and returns the job it started.
func startGitJob(t *testing.T, s *Server, workspaceID, body string) gitJob {
	t.Helper()
	rec := runGitJob(t, s, t.Context(), workspaceID, body)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("run = %d %s, want 202", rec.Code, rec.Body.String())
	}
	var resp struct{ Job gitJob }
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("run answer: %v\n%s", err, rec.Body.String())
	}
	if resp.Job.ID == "" || resp.Job.State != gitJobRunning || resp.Job.Workspace != workspaceID {
		t.Fatalf("run answered %+v, want a running job in %q", resp.Job, workspaceID)
	}
	return resp.Job
}

// gitJobsRequest asks the jobs routes as the router would.
func gitJobsRequest(t *testing.T, s *Server, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, nil)
	switch {
	case strings.HasPrefix(target, "/api/git/jobs/cancel"):
		s.handleGitJobCancel(rec, req)
	case strings.HasPrefix(target, "/api/git/jobs"):
		s.handleGitJobs(rec, req)
	default:
		t.Fatalf("not a git jobs route: %s", target)
	}
	return rec
}

// readGitJob reads one job back from the jobs route.
func readGitJob(t *testing.T, s *Server, workspaceID, id string) gitJob {
	t.Helper()
	rec := gitJobsRequest(t, s, http.MethodGet, "/api/git/jobs?workspace="+workspaceID+"&id="+id)
	if rec.Code != http.StatusOK {
		t.Fatalf("jobs?id=%s = %d %s, want 200", id, rec.Code, rec.Body.String())
	}
	var resp struct{ Job gitJob }
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("jobs answer: %v\n%s", err, rec.Body.String())
	}
	return resp.Job
}

// gitJobEnded waits for a job to end, as the hub sees it.
func gitJobEnded(t *testing.T, s *Server, id string) {
	t.Helper()
	var done <-chan struct{}
	s.gitJobsHub().do(func() {
		if run := s.gitJobs.running[id]; run != nil {
			done = run.done
		}
	})
	if done != nil {
		within(t, done, "job "+id+" ending")
	}
}

// watchersNaming is how many connections name a workspace in their git-watch
// set, read on the watch hub's own goroutine.
func watchersNaming(s *Server, id string) int {
	n := 0
	s.gitHub().do(func() {
		for _, ids := range s.gitWatches.clients {
			if ids[id] {
				n++
			}
		}
	})
	return n
}

// nextGitJob reads frames until a git-job arrives, and returns it.
func nextGitJob(t *testing.T, conn *websocket.Conn) gitJobFrame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(time.Minute))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no git-job reached the viewer: %v", err)
		}
		var frame gitJobFrame
		if json.Unmarshal(data, &frame) == nil && frame.Type == frameGitJob {
			return frame
		}
	}
}

// gitJobFramesUntilEnd reads a connection's git-job frames until the job named ends, and
// returns every frame it read on the way.
func gitJobFramesUntilEnd(t *testing.T, conn *websocket.Conn, id string) []gitJobFrame {
	t.Helper()
	var frames []gitJobFrame
	for {
		f := nextGitJob(t, conn)
		frames = append(frames, f)
		if f.Job.ID == id && f.Job.State != gitJobRunning {
			return frames
		}
	}
}

func newGitJobServer(t *testing.T, trees map[string]workspace.Workspace) (*Server, *httptest.Server) {
	t.Helper()
	s, ts := newViewerSocketServer(t)
	s.gitWatchResolve = resolveTrees(trees)
	t.Cleanup(s.stopGitJobs)
	return s, ts
}

// A job's frames go to the connections that named its workspace in their
// git-watch set, and to no others.
func TestGitJob_FramesReachOnlyWatchers(t *testing.T) {
	tree, other := newJobTree(), newJobTree()
	tree.output = "hook says hello\n"
	s, ts := newGitJobServer(t, map[string]workspace.Workspace{"ws_tree": tree, "ws_other": other})
	watcher, _ := dialViewerAs(t, ts, "")
	bystander, _ := dialViewerAs(t, ts, "")
	askToWatch(t, watcher, "ws_tree")
	askToWatch(t, bystander, "ws_other")
	eventually(t, "both viewers' watch sets taken in", func() bool {
		return watchersNaming(s, "ws_tree") == 1 && watchersNaming(s, "ws_other") == 1
	})

	job := startGitJob(t, s, "ws_tree", `{"kind":"stage","path":"a.txt","repo":"libs/inner"}`)
	frames := gitJobFramesUntilEnd(t, watcher, job.ID)
	end := frames[len(frames)-1]
	if end.Workspace != "ws_tree" || end.Job.State != gitJobDone || end.Job.Repo != "libs/inner" || end.Job.Kind != gitops.OpStage {
		t.Errorf("last frame = %+v, want the job done in ws_tree", end)
	}
	if !slices.EqualFunc(end.Job.Commands, [][]string{{"add", "--", "a.txt"}}, slices.Equal) {
		t.Errorf("commands = %v, want the one the tree ran", end.Job.Commands)
	}
	if end.Job.Output != "hook says hello\n" || end.Job.Result.Head != "abc123" {
		t.Errorf("output %q, result %+v: want the tree's", end.Job.Output, end.Job.Result)
	}
	for _, f := range frames {
		if f.Job.ID != job.ID {
			t.Errorf("the watcher heard of job %s, not its own", f.Job.ID)
		}
	}

	// Frames reach a connection in the order they were sent, so everything
	// sent about the first job reached the bystander before anything about
	// its own.
	own := startGitJob(t, s, "ws_other", `{"kind":"stage","path":"b.txt"}`)
	for _, f := range gitJobFramesUntilEnd(t, bystander, own.ID) {
		if f.Workspace != "ws_other" {
			t.Errorf("the bystander heard of a job in %q", f.Workspace)
		}
	}
}

// A job that has ended can be read back — by id, or newest first in its
// workspace's list — so a viewer that missed its end can recover it.
func TestGitJob_FinishedJobReadBack(t *testing.T) {
	tree := newJobTree()
	s, _ := newGitJobServer(t, map[string]workspace.Workspace{"ws_tree": tree, "": newJobTree()})

	first := startGitJob(t, s, "ws_tree", `{"kind":"stage","path":"a.txt"}`)
	gitJobEnded(t, s, first.ID)
	second := startGitJob(t, s, "ws_tree", `{"kind":"stage","path":"b.txt"}`)
	gitJobEnded(t, s, second.ID)

	got := readGitJob(t, s, "ws_tree", first.ID)
	if got.State != gitJobDone || got.Result.Head != "abc123" || len(got.Commands) != 1 {
		t.Errorf("read back %+v, want it done with its result and command", got)
	}

	rec := gitJobsRequest(t, s, http.MethodGet, "/api/git/jobs?workspace=ws_tree")
	var list struct{ Jobs []gitJob }
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("jobs = %d %s (%v)", rec.Code, rec.Body.String(), err)
	}
	if len(list.Jobs) != 2 || list.Jobs[0].ID != second.ID || list.Jobs[1].ID != first.ID {
		t.Errorf("jobs = %+v, want the second then the first", list.Jobs)
	}

	rec = gitJobsRequest(t, s, http.MethodGet, "/api/git/jobs")
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list.Jobs) != 0 {
		t.Errorf("the project's jobs = %s, want none: the jobs were another workspace's", rec.Body.String())
	}
	if rec := gitJobsRequest(t, s, http.MethodGet, "/api/git/jobs?workspace=ws_tree&id=nope"); rec.Code != http.StatusNotFound {
		t.Errorf("an unknown job = %d, want 404", rec.Code)
	}
	if rec := gitJobsRequest(t, s, http.MethodGet, "/api/git/jobs?id="+first.ID); rec.Code != http.StatusNotFound {
		t.Errorf("a job asked of the wrong workspace = %d, want 404", rec.Code)
	}
}

// Only the cancel route ends a running job early, and a job it ends is
// "cancelled", not failed.
func TestGitJob_CancelEndsARunningJob(t *testing.T) {
	tree := newJobTree()
	tree.release = make(chan struct{})
	s, _ := newGitJobServer(t, map[string]workspace.Workspace{"ws_tree": tree})

	job := startGitJob(t, s, "ws_tree", `{"kind":"commit","message":"m"}`)
	ctx := within(t, tree.started, "the write starting")

	rec := gitJobsRequest(t, s, http.MethodPost, "/api/git/jobs/cancel?workspace=ws_tree&id="+job.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d %s, want 200", rec.Code, rec.Body.String())
	}
	within(t, ctx.Done(), "the write's context ending")
	gitJobEnded(t, s, job.ID)
	if got := readGitJob(t, s, "ws_tree", job.ID); got.State != gitJobCancelled || got.ErrorKind != "" {
		t.Errorf("cancelled job = %+v, want state cancelled", got)
	}
	if rec := gitJobsRequest(t, s, http.MethodPost, "/api/git/jobs/cancel?workspace=ws_tree&id=nope"); rec.Code != http.StatusNotFound {
		t.Errorf("cancelling an unknown job = %d, want 404", rec.Code)
	}
}

// Neither the request that started a job nor the viewer watching it is what
// keeps it alive: a dropped connection leaves the write to finish.
func TestGitJob_DisconnectDoesNotCancel(t *testing.T) {
	tree := newJobTree()
	tree.release = make(chan struct{})
	s, ts := newGitJobServer(t, map[string]workspace.Workspace{"ws_tree": tree})
	conn, _ := dialViewerAs(t, ts, "")
	askToWatch(t, conn, "ws_tree")
	eventually(t, "the viewer's watch set taken in", func() bool { return watchersNaming(s, "ws_tree") == 1 })

	reqCtx, endRequest := context.WithCancel(t.Context())
	rec := runGitJob(t, s, reqCtx, "ws_tree", `{"kind":"commit","message":"m"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("run = %d %s", rec.Code, rec.Body.String())
	}
	var resp struct{ Job gitJob }
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	ctx := within(t, tree.started, "the write starting")

	endRequest()
	_ = conn.Close()
	eventually(t, "the viewer's departure taken in", func() bool { return watchersNaming(s, "ws_tree") == 0 })
	if ctx.Err() != nil {
		t.Fatal("the write was cancelled when its request and viewer went")
	}
	close(tree.release)
	gitJobEnded(t, s, resp.Job.ID)
	if got := readGitJob(t, s, "ws_tree", resp.Job.ID); got.State != gitJobDone {
		t.Errorf("job = %+v, want it done", got)
	}
}

// A write the workspace refuses ends the job "failed", saying how it was
// refused, in English and as a message the viewer can translate; the HTTP
// answer is 202 all the same.
func TestGitJob_RefusedOpFails(t *testing.T) {
	tree := newJobTree()
	tree.err = &gitops.RefusedError{Err: msg.NewError("No files were named.")}
	s, _ := newGitJobServer(t, map[string]workspace.Workspace{"ws_tree": tree})

	job := startGitJob(t, s, "ws_tree", `{"kind":"stage"}`)
	gitJobEnded(t, s, job.ID)
	got := readGitJob(t, s, "ws_tree", job.ID)
	if got.State != gitJobFailed || got.ErrorKind != "refused" || got.Error != "No files were named." {
		t.Errorf("refused job = %+v, want failed, refused, with the English", got)
	}
	if got.ErrorMessage == nil || got.ErrorMessage.Key != "No files were named." {
		t.Errorf("errorMessage = %+v, want the refusal's message", got.ErrorMessage)
	}
}

// Each of gitops's refusals reaches the viewer as the kind that says what it
// can offer instead, with what it needs to offer it: the tree to go to for a
// branch checked out elsewhere, the branch an unmerged delete was about.
func TestGitJobErrorKinds(t *testing.T) {
	m := msg.NewError("x")
	for _, c := range []struct {
		err      error
		kind     string
		worktree string
		branch   string
	}{
		{&gitops.RefusedError{Err: m}, "refused", "", ""},
		{&gitops.StaleError{Err: m}, "stale", "", ""},
		{&gitops.LockedError{Path: "/r/.git/index.lock", Err: m}, "locked", "", ""},
		{&gitops.DirtyError{Err: m}, "dirty", "", ""},
		{&gitops.UnmergedError{Branch: "wip", Err: m}, "unmerged", "", "wip"},
		{&gitops.CheckedOutError{Branch: "side", Worktree: "/elsewhere/side", Err: m}, "checked-out", "/elsewhere/side", "side"},
		{&gitops.ConflictsError{Err: m}, "conflicts", "", ""},
		{&gitops.DivergedError{Err: m}, "diverged", "", ""},
		{&gitops.RejectedError{Err: m}, "rejected", "", ""},
		{&gitops.RemoteNeededError{Err: m}, "remote", "", ""},
		{&gitops.AuthError{Err: m}, "auth", "", ""},
		{&gitops.PublishedError{Err: m}, "published", "", ""},
		{errors.New("git said no"), "", "", ""},
	} {
		var j gitJob
		describeGitJobError(&j, c.err)
		if j.ErrorKind != c.kind || j.Worktree != c.worktree || j.Branch != c.branch {
			t.Errorf("%T: kind %q worktree %q branch %q, want %q %q %q", c.err, j.ErrorKind, j.Worktree, j.Branch, c.kind, c.worktree, c.branch)
		}
	}

	// What the viewer offers instead of a failed network write needs: the pull's
	// preferred way in first, the refs a push was turned down for and why, the
	// remotes to choose a publish's from.
	var j gitJob
	describeGitJobError(&j, &gitops.DivergedError{Prefer: "rebase", Err: m})
	if j.Prefer != "rebase" {
		t.Errorf("diverged prefer = %q", j.Prefer)
	}
	j = gitJob{}
	describeGitJobError(&j, &gitops.RejectedError{Refs: []string{"refs/heads/main"}, Reason: "fetch first", Err: m})
	if !slices.Equal(j.Rejected, []string{"refs/heads/main"}) || j.Reason != "fetch first" {
		t.Errorf("rejected = %q, reason %q", j.Rejected, j.Reason)
	}
	j = gitJob{}
	describeGitJobError(&j, &gitops.RemoteNeededError{Remotes: []string{"fork", "upstream"}, Err: m})
	if !slices.Equal(j.Remotes, []string{"fork", "upstream"}) {
		t.Errorf("remotes = %q", j.Remotes)
	}
}

// A request that names no usable workspace, or carries no op, is refused before
// any job exists.
func TestGitJob_RunRefusesABadRequest(t *testing.T) {
	s, _ := newGitJobServer(t, map[string]workspace.Workspace{"ws_tree": newJobTree()})
	if rec := runGitJob(t, s, t.Context(), "ws_tree", `{"kind":`); rec.Code != http.StatusBadRequest {
		t.Errorf("a malformed body = %d, want 400", rec.Code)
	}
	if rec := runGitJob(t, s, t.Context(), "ws_gone", `{"kind":"stage"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("an unknown workspace = %d, want 400", rec.Code)
	}
	rec := gitJobsRequest(t, s, http.MethodGet, "/api/git/jobs?workspace=ws_tree")
	if !strings.Contains(rec.Body.String(), `"jobs":[]`) {
		t.Errorf("jobs = %s, want none", rec.Body.String())
	}
}
