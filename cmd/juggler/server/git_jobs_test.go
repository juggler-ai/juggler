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
	"juggler/cmd/juggler/jobs"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/workspace"

	"github.com/gorilla/websocket"
)

// A git write is a job of kind "git": started by one request, answered at
// once, and run to its end on the server's time rather than the request's.
// What git does is gitops's business; these are about the job as git's kind —
// who hears of it, how it ends, what its detail says, and what can be read back
// about it afterwards. The trees are scripted.

// testGitJob is a git job as a client reads it: its detail and result in git's
// shapes.
type testGitJob struct {
	jobs.Job
	Detail gitJobDetail  `json:"detail"`
	Result gitops.Result `json:"result"`
}

// testJobEvent is a jobs topic event about a git job.
type testJobEvent struct {
	Type      string     `json:"type"`
	Workspace string     `json:"workspace"`
	Job       testGitJob `json:"job"`
}

// askForJobs subscribes a connection to the jobs of the workspaces named.
func askForJobs(t *testing.T, conn *websocket.Conn, ids ...string) {
	t.Helper()
	if ids == nil {
		ids = []string{}
	}
	if err := conn.WriteJSON(map[string]any{"type": "subscriptions", "topic": jobsTopicName, "keys": ids}); err != nil {
		t.Fatal(err)
	}
}

// jobSubscribersOf is how many connections are subscribed to a workspace's jobs.
func jobSubscribersOf(s *Server, id string) int {
	n := 0
	h := s.topicHub()
	h.do(func() { n = len(h.subscribers[topicKey{jobsTopicName, id}]) })
	return n
}

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

// runGitJob starts an op through the git tool's run, and records its answer as
// the run route this stands for would have: 202 with the job, or 400 with why
// nothing started.
func runGitJob(t *testing.T, s *Server, ctx context.Context, workspaceID, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ops/client", nil)
	var op any
	if err := json.Unmarshal([]byte(body), &op); err != nil {
		handlers.WriteErr(rec, req, http.StatusBadRequest, err)
		return rec
	}
	job, err := callGitTool(s, ctx, workspaceID, "run", map[string]any{"op": op})
	if err != nil {
		handlers.WriteErr(rec, req, http.StatusBadRequest, err)
		return rec
	}
	handlers.WriteJSON(rec, req, http.StatusAccepted, jobAnswer{Job: job.(jobs.Job)})
	return rec
}

// startGitJob runs an op that must be accepted, and returns the job it started.
func startGitJob(t *testing.T, s *Server, workspaceID, body string) testGitJob {
	t.Helper()
	rec := runGitJob(t, s, t.Context(), workspaceID, body)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("run = %d %s, want 202", rec.Code, rec.Body.String())
	}
	var resp struct{ Job testGitJob }
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("run answer: %v\n%s", err, rec.Body.String())
	}
	if resp.Job.ID == "" || resp.Job.Kind != gitJobKind || resp.Job.State != jobs.Running || resp.Job.Workspace != workspaceID {
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
	case strings.HasPrefix(target, "/api/jobs/cancel"):
		s.handleJobCancel(rec, req)
	case strings.HasPrefix(target, "/api/jobs"):
		s.handleJobs(rec, req)
	default:
		t.Fatalf("not a jobs route: %s", target)
	}
	return rec
}

// readGitJob reads one job back from the jobs route.
func readGitJob(t *testing.T, s *Server, workspaceID, id string) testGitJob {
	t.Helper()
	rec := gitJobsRequest(t, s, http.MethodGet, "/api/jobs?workspace="+workspaceID+"&id="+id)
	if rec.Code != http.StatusOK {
		t.Fatalf("jobs?id=%s = %d %s, want 200", id, rec.Code, rec.Body.String())
	}
	var resp struct{ Job testGitJob }
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("jobs answer: %v\n%s", err, rec.Body.String())
	}
	return resp.Job
}

// gitJobEnded waits for a job to end, as the hub sees it.
func gitJobEnded(t *testing.T, s *Server, id string) {
	t.Helper()
	within(t, s.jobHub().Ended(id), "job "+id+" ending")
}

// nextGitJob reads frames until a jobs topic event arrives, and returns the
// event.
func nextGitJob(t *testing.T, conn *websocket.Conn) testJobEvent {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(time.Minute))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no job event reached the viewer: %v", err)
		}
		var frame struct {
			Type  frameType    `json:"type"`
			Topic string       `json:"topic"`
			Key   string       `json:"key"`
			Event testJobEvent `json:"event"`
		}
		if json.Unmarshal(data, &frame) == nil && frame.Type == frameTopicEvent && frame.Topic == jobsTopicName && frame.Event.Type == jobEventType {
			if frame.Key != frame.Event.Workspace || frame.Key != frame.Event.Job.Workspace {
				t.Errorf("a job event keyed %q is about %q", frame.Key, frame.Event.Workspace)
			}
			return frame.Event
		}
	}
}

// gitJobFramesUntilEnd reads a connection's job events until the job named
// ends, and returns every event it read on the way.
func gitJobFramesUntilEnd(t *testing.T, conn *websocket.Conn, id string) []testJobEvent {
	t.Helper()
	var frames []testJobEvent
	for {
		f := nextGitJob(t, conn)
		frames = append(frames, f)
		if f.Job.ID == id && f.Job.State != jobs.Running {
			return frames
		}
	}
}

func newGitJobServer(t *testing.T, trees map[string]workspace.Workspace) (*Server, *httptest.Server) {
	t.Helper()
	s, ts := newViewerSocketServer(t)
	scriptGit(t, s, resolveTrees(trees))
	t.Cleanup(s.stopJobs)
	return s, ts
}

// A job's events go to the connections subscribed to its workspace in the jobs
// topic, and to no others.
func TestGitJob_FramesReachOnlyWatchers(t *testing.T) {
	tree, other := newJobTree(), newJobTree()
	tree.output = "hook says hello\n"
	s, ts := newGitJobServer(t, map[string]workspace.Workspace{"ws_tree": tree, "ws_other": other})
	watcher, _ := dialViewerAs(t, ts, "")
	bystander, _ := dialViewerAs(t, ts, "")
	askForJobs(t, watcher, "ws_tree")
	askForJobs(t, bystander, "ws_other")
	eventually(t, "both viewers' subscriptions taken in", func() bool {
		return jobSubscribersOf(s, "ws_tree") == 1 && jobSubscribersOf(s, "ws_other") == 1
	})

	job := startGitJob(t, s, "ws_tree", `{"kind":"stage","path":"a.txt","repo":"libs/inner"}`)
	frames := gitJobFramesUntilEnd(t, watcher, job.ID)
	end := frames[len(frames)-1]
	if end.Workspace != "ws_tree" || end.Job.State != jobs.Done || end.Job.Kind != gitJobKind || end.Job.Detail.Repo != "libs/inner" || end.Job.Detail.Op != gitops.OpStage {
		t.Errorf("last frame = %+v, want the job done in ws_tree", end)
	}
	if !slices.EqualFunc(end.Job.Detail.Commands, [][]string{{"add", "--", "a.txt"}}, slices.Equal) {
		t.Errorf("commands = %v, want the one the tree ran", end.Job.Detail.Commands)
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
	if got.State != jobs.Done || got.Result.Head != "abc123" || len(got.Detail.Commands) != 1 {
		t.Errorf("read back %+v, want it done with its result and command", got)
	}

	rec := gitJobsRequest(t, s, http.MethodGet, "/api/jobs?workspace=ws_tree")
	var list struct{ Jobs []testGitJob }
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("jobs = %d %s (%v)", rec.Code, rec.Body.String(), err)
	}
	if len(list.Jobs) != 2 || list.Jobs[0].ID != second.ID || list.Jobs[1].ID != first.ID {
		t.Errorf("jobs = %+v, want the second then the first", list.Jobs)
	}

	rec = gitJobsRequest(t, s, http.MethodGet, "/api/jobs")
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list.Jobs) != 0 {
		t.Errorf("the project's jobs = %s, want none: the jobs were another workspace's", rec.Body.String())
	}
	if rec := gitJobsRequest(t, s, http.MethodGet, "/api/jobs?workspace=ws_tree&id=nope"); rec.Code != http.StatusNotFound {
		t.Errorf("an unknown job = %d, want 404", rec.Code)
	}
	if rec := gitJobsRequest(t, s, http.MethodGet, "/api/jobs?id="+first.ID); rec.Code != http.StatusNotFound {
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

	rec := gitJobsRequest(t, s, http.MethodPost, "/api/jobs/cancel?workspace=ws_tree&id="+job.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d %s, want 200", rec.Code, rec.Body.String())
	}
	within(t, ctx.Done(), "the write's context ending")
	gitJobEnded(t, s, job.ID)
	if got := readGitJob(t, s, "ws_tree", job.ID); got.State != jobs.Cancelled || got.Error != nil {
		t.Errorf("cancelled job = %+v, want state cancelled", got)
	}
	if rec := gitJobsRequest(t, s, http.MethodPost, "/api/jobs/cancel?workspace=ws_tree&id=nope"); rec.Code != http.StatusNotFound {
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
	askForJobs(t, conn, "ws_tree")
	eventually(t, "the viewer's subscription taken in", func() bool { return jobSubscribersOf(s, "ws_tree") == 1 })

	reqCtx, endRequest := context.WithCancel(t.Context())
	rec := runGitJob(t, s, reqCtx, "ws_tree", `{"kind":"commit","message":"m"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("run = %d %s", rec.Code, rec.Body.String())
	}
	var resp struct{ Job testGitJob }
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	ctx := within(t, tree.started, "the write starting")

	endRequest()
	_ = conn.Close()
	eventually(t, "the viewer's departure taken in", func() bool { return jobSubscribersOf(s, "ws_tree") == 0 })
	if ctx.Err() != nil {
		t.Fatal("the write was cancelled when its request and viewer went")
	}
	close(tree.release)
	gitJobEnded(t, s, resp.Job.ID)
	if got := readGitJob(t, s, "ws_tree", resp.Job.ID); got.State != jobs.Done {
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
	if got.State != jobs.Failed || got.Error == nil || got.Error.Kind != "refused" || got.Error.Message != "No files were named." {
		t.Errorf("refused job = %+v (error %+v), want failed, refused, with the English", got, got.Error)
	}
	if got.Error == nil || got.Error.Text == nil || got.Error.Text.Key != "No files were named." {
		t.Errorf("error = %+v, want the refusal's message", got.Error)
	}

	// What a refusal needs said with it is on the job's detail.
	tree.err = &gitops.LockedError{Path: "/r/.git/index.lock", Err: msg.NewError("Another git holds the lock.")}
	job = startGitJob(t, s, "ws_tree", `{"kind":"commit","message":"m"}`)
	gitJobEnded(t, s, job.ID)
	if got := readGitJob(t, s, "ws_tree", job.ID); got.Error == nil || got.Error.Kind != "locked" || got.Detail.LockPath != "/r/.git/index.lock" {
		t.Errorf("locked job = %+v (error %+v), want locked with its lock on the detail", got, got.Error)
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
		var j gitJobDetail
		kind := describeGitJobError(&j, c.err)
		if kind != c.kind || j.Worktree != c.worktree || j.Branch != c.branch {
			t.Errorf("%T: kind %q worktree %q branch %q, want %q %q %q", c.err, kind, j.Worktree, j.Branch, c.kind, c.worktree, c.branch)
		}
	}

	// What the viewer offers instead of a failed network write needs: the pull's
	// preferred way in first, the refs a push was turned down for and why, the
	// remotes to choose a publish's from.
	var j gitJobDetail
	describeGitJobError(&j, &gitops.DivergedError{Prefer: "rebase", Err: m})
	if j.Prefer != "rebase" {
		t.Errorf("diverged prefer = %q", j.Prefer)
	}
	j = gitJobDetail{}
	describeGitJobError(&j, &gitops.RejectedError{Refs: []string{"refs/heads/main"}, Reason: "fetch first", Err: m})
	if !slices.Equal(j.Rejected, []string{"refs/heads/main"}) || j.Reason != "fetch first" {
		t.Errorf("rejected = %q, reason %q", j.Rejected, j.Reason)
	}
	j = gitJobDetail{}
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
	rec := gitJobsRequest(t, s, http.MethodGet, "/api/jobs?workspace=ws_tree")
	if !strings.Contains(rec.Body.String(), `"jobs":[]`) {
		t.Errorf("jobs = %s, want none", rec.Body.String())
	}
}
