//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"slices"
	"sync"
	"time"
	"unicode/utf8"

	"juggler/cmd/juggler/gitops"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/workspace"
)

// The git client's writes, as jobs.
//
// POST /api/git/run starts one write and answers 202 with its job at once,
// whether or not the write will succeed: how it ends is the job's state, not
// the request's status. The write runs on the server's time, under a context
// only the cancel route and shutdown end. A request that goes away, or a viewer
// that disconnects, leaves it to finish — a commit abandoned because a laptop
// lid closed would be a commit half made, and nothing the user asked for.
//
// Each change to a job — a command begun, output printed, its end — is sent as
// a git-job frame carrying the whole job to the connections whose git-watch set
// names its workspace (git_watch.go), and no others. Output is coalesced into
// at most one frame every gitJobFrameEvery while the job runs; its end is sent
// at once. The last gitJobsKept jobs to end are kept for GET /api/git/jobs, so a
// viewer that reconnects can learn how a job it missed the end of ended.
//
// POST /api/git/fetch-on-show is the one write the client makes unasked: the
// first time the pin shows a repository in this server's life, one fetch of it,
// for every tree it has. The hub remembers, by common directory, which
// repositories it has fetched this way, so another tree of the same repository,
// a second pin or a reopened one is told it was skipped.

const (
	gitJobRunning   = "running"
	gitJobDone      = "done"
	gitJobFailed    = "failed"
	gitJobCancelled = "cancelled"

	gitJobsKept      = 100                    // ended jobs kept to be read back
	gitJobOutputMax  = 256 << 10              // bytes of output a job keeps: the last of it
	gitJobFrameEvery = 100 * time.Millisecond // the least time between a running job's frames
)

// gitJob is one write as the client is told of it.
type gitJob struct {
	ID        string        `json:"id"`
	Workspace string        `json:"workspace"` // The workspace id the run named; "" is the project
	Repo      string        `json:"repo"`
	Kind      gitops.OpKind `json:"kind"`
	Commands  [][]string    `json:"commands"`       // Every git command run so far, as argv after "git"
	State     string        `json:"state"`          // "running", "done", "failed" or "cancelled"
	Output    string        `json:"output"`         // The last gitJobOutputMax bytes hooks printed
	Auto      bool          `json:"auto,omitempty"` // Started unasked (fetch-on-show): its failure is quiet

	// Progress is a network write's latest meter reading; nil before the first.
	Progress *gitops.Progress `json:"progress,omitempty"`

	// Why a failed job failed: Error in English, ErrorMessage the same for
	// the viewer to show translated when there is one, ErrorKind which of
	// gitops's refusals it was ("refused", "stale", "locked", "dirty",
	// "unmerged", "checked-out", "conflicts", "markers", "diverged",
	// "rejected", "remote", "auth" or "published"; "" for any other failure), and LockPath the lock a "locked" job
	// was stopped by.
	Error        string       `json:"error,omitempty"`
	ErrorMessage *msg.Message `json:"errorMessage,omitempty"`
	ErrorKind    string       `json:"errorKind"`
	LockPath     string       `json:"lockPath,omitempty"`

	// Branch and Worktree are the branch a refusal was about and, for one
	// checked out elsewhere, the tree that has it out — what the viewer needs
	// to offer "Go to worktree" or a forced delete.
	Branch   string `json:"branch,omitempty"`
	Worktree string `json:"worktree,omitempty"`

	// What the viewer offers instead of a failed network write: Prefer, the
	// way into a "diverged" pull the repository puts first ("merge" or
	// "rebase"); Rejected and Reason, the remote refs a "rejected" push was
	// turned down for and git's word for why; Remotes, those a "remote" publish
	// could go to.
	Prefer   string   `json:"prefer,omitempty"`
	Rejected []string `json:"rejected,omitempty"`
	Reason   string   `json:"reason,omitempty"`
	Remotes  []string `json:"remotes,omitempty"`

	// Prompt is the question git is waiting on the user to answer, while it
	// waits (git_askpass.go). Never the answer.
	Prompt *gitJobPrompt `json:"prompt,omitempty"`

	Result gitops.Result `json:"result"`
}

// gitJobAnswer is the run and cancel routes' answer, and one job's read.
type gitJobAnswer struct {
	Job gitJob `json:"job"`
}

// gitFetchOnShowAnswer is the fetch-on-show route's answer: the fetch it
// started, or Skipped when the repository has been fetched on showing before.
type gitFetchOnShowAnswer struct {
	Job     *gitJob `json:"job,omitempty"`
	Skipped bool    `json:"skipped,omitempty"`
}

// gitJobsAnswer is a workspace's jobs, newest first.
type gitJobsAnswer struct {
	Jobs []gitJob `json:"jobs"`
}

// gitJobRun is one job and what the hub keeps about it while it runs.
type gitJobRun struct {
	job    gitJob
	seq    int // the order jobs were started in
	output []byte
	cancel context.CancelFunc
	done   chan struct{} // closed when the job has ended
	token  string        // its askpass token; "" for a job that talks to no remote
	ask    *gitAsk       // the question it waits on, if any

	sentAt   time.Time // when its last frame was sent
	dirty    bool      // changed since that frame
	flushing bool      // a frame is due once gitJobFrameEvery has passed
}

// gitJobHub holds every git job. Its state belongs to one goroutine, which
// everything else reaches through cmds; it is started on first use.
type gitJobHub struct {
	once     sync.Once
	stopOnce sync.Once
	cmds     chan func()
	quit     chan struct{}

	// life is every job's parent: it ends only at shutdown.
	life context.Context
	end  context.CancelFunc

	// Owned by the hub's goroutine.
	seq      int
	running  map[string]*gitJobRun
	ended    []*gitJobRun          // oldest first, at most gitJobsKept
	fetched  map[string]bool       // common directories fetched on showing
	asks     map[string]*gitAsk    // open questions, by prompt id (git_askpass.go)
	tokens   map[string]*gitJobRun // network jobs that may ask one, by askpass token
	askpass  *gitAskpassListener   // nil until the first network job
	stopping bool
	drained  chan struct{} // closed once stopping and nothing runs
}

// gitJobsHub is the server's git job hub, started if it was not.
func (s *Server) gitJobsHub() *gitJobHub {
	h := &s.gitJobs
	h.once.Do(func() {
		// Unbuffered, so a command taken is a command that will run: do never
		// waits on one the hub stopped before reaching.
		h.cmds = make(chan func())
		h.quit = make(chan struct{})
		h.life, h.end = context.WithCancel(context.Background())
		h.running = map[string]*gitJobRun{}
		h.fetched = map[string]bool{}
		h.asks = map[string]*gitAsk{}
		h.tokens = map[string]*gitJobRun{}
		go h.run()
	})
	return h
}

func (h *gitJobHub) run() {
	for {
		select {
		case fn := <-h.cmds:
			fn()
		case <-h.quit:
			return
		}
	}
}

// post hands fn to the hub's goroutine, unless the hub has stopped.
func (h *gitJobHub) post(fn func()) bool {
	select {
	case h.cmds <- fn:
		return true
	case <-h.quit:
		return false
	}
}

// do runs fn on the hub's goroutine and waits for it; false when the hub has
// stopped and fn never ran.
func (h *gitJobHub) do(fn func()) bool {
	ran := make(chan struct{})
	if !h.post(func() { fn(); close(ran) }) {
		return false
	}
	<-ran
	return true
}

// gitResolve resolves the workspace a git watch or job names.
func (s *Server) gitResolve(id string) (workspace.Workspace, error) {
	if s.gitWatchResolve != nil {
		return s.gitWatchResolve(id)
	}
	return s.GitTrees().ResolveGit(id)
}

// handleGitRun handles POST /api/git/run?workspace=<id> with a gitops.Op body:
// it starts the write as a job and answers 202 with the job. A workspace that
// cannot be resolved, or a body that is not an op, is a 400 and starts nothing.
func (s *Server) handleGitRun(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("workspace")
	ws, err := s.gitResolve(id)
	if err != nil {
		handlers.WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	op, ok := handlers.DecodeJSON[gitops.Op](w, r)
	if !ok {
		return
	}
	job, ok := s.gitJobsHub().start(s, id, ws, op)
	if !ok {
		handlers.WriteMessageError(w, r, http.StatusServiceUnavailable, msg.New("The server is shutting down."))
		return
	}
	handlers.WriteJSON(w, r, http.StatusAccepted, gitJobAnswer{Job: job})
}

// handleGitFetchOnShow handles POST /api/git/fetch-on-show?workspace=<id>&repo=<rel>:
// the fetch the pin asks for the first time it shows a repository. The
// repository is told by its common directory, read through the workspace, so
// every tree of it shares the one fetch; the first ask starts it, as an auto
// job, and every later one in this server's life answers skipped.
func (s *Server) handleGitFetchOnShow(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("workspace")
	ws, err := s.gitResolve(id)
	if err != nil {
		handlers.WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	read, err := ws.GitRead(r.Context(), gitview.Query{Kind: gitview.QueryRepository, Repo: q.Get("repo")})
	if err != nil {
		handlers.WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	repo, ok := read.(gitview.Repository)
	if !ok || repo.CommonDir == "" {
		handlers.WriteMessageError(w, r, http.StatusBadGateway, msg.New("The workspace did not say where its repository is."))
		return
	}
	h := s.gitJobsHub()
	var answer gitFetchOnShowAnswer
	stopping := true
	h.do(func() {
		if h.stopping {
			return
		}
		stopping = false
		if h.fetched[repo.CommonDir] {
			answer.Skipped = true
			return
		}
		h.fetched[repo.CommonDir] = true
		job := h.begin(s, id, ws, gitops.Op{Kind: gitops.OpFetch, Repo: q.Get("repo"), Auto: true})
		answer.Job = &job
	})
	if stopping {
		handlers.WriteMessageError(w, r, http.StatusServiceUnavailable, msg.New("The server is shutting down."))
		return
	}
	handlers.WriteJSON(w, r, 0, answer)
}

// handleGitJobs handles GET /api/git/jobs?workspace=<id>[&id=<job>]: the one job
// named, or 404; or every job of the workspace still running or among the last
// to end, newest first.
//
// Neither this route nor the cancel route resolves the workspace: a job belongs
// to the id it was started under, and stays readable after that workspace
// closes.
func (s *Server) handleGitJobs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	h := s.gitJobsHub()
	if id := q.Get("id"); id != "" {
		var job gitJob
		var found bool
		h.do(func() {
			if run := h.find(q.Get("workspace"), id); run != nil {
				job, found = run.snapshot(), true
			}
		})
		writeGitJob(w, r, job, found, id)
		return
	}
	jobs := []gitJob{}
	h.do(func() { jobs = h.list(q.Get("workspace")) })
	handlers.WriteJSON(w, r, 0, gitJobsAnswer{Jobs: jobs})
}

// handleGitJobCancel handles POST /api/git/jobs/cancel?workspace=<id>&id=<job>:
// it cancels the job if it is still running and answers with the job as it
// stands; its end follows as a frame. A job that has already ended is answered
// as it ended.
func (s *Server) handleGitJobCancel(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("id")
	h := s.gitJobsHub()
	var job gitJob
	var found bool
	h.do(func() {
		run := h.find(q.Get("workspace"), id)
		if run == nil {
			return
		}
		if run.job.State == gitJobRunning {
			run.cancel()
			if run.ask != nil {
				h.forgetAskpass(run, false)
				h.publish(s, run)
			}
		}
		job, found = run.snapshot(), true
	})
	writeGitJob(w, r, job, found, id)
}

func writeGitJob(w http.ResponseWriter, r *http.Request, job gitJob, found bool, id string) {
	if !found {
		handlers.WriteMessageError(w, r, http.StatusNotFound, msg.New("No such git job: {id}", "id", id))
		return
	}
	handlers.WriteJSON(w, r, 0, gitJobAnswer{Job: job})
}

// stopGitJobs cancels every running job and waits for each to end, for
// shutdown; a run asked for afterwards is refused. Safe to call twice.
func (s *Server) stopGitJobs() {
	h := s.gitJobsHub()
	h.stopOnce.Do(func() {
		var drained chan struct{}
		h.do(func() {
			h.stopping = true
			h.end()
			h.drained = make(chan struct{})
			if len(h.running) == 0 {
				close(h.drained)
			}
			drained = h.drained
		})
		if drained != nil {
			<-drained
		}
		h.do(h.stopAskpass)
		close(h.quit)
	})
}

// start begins a job on the hub's goroutine and returns it as it begins; false
// when the hub is stopping or stopped.
func (h *gitJobHub) start(s *Server, wsID string, ws workspace.Workspace, op gitops.Op) (gitJob, bool) {
	var job gitJob
	started := false
	h.do(func() {
		if h.stopping {
			return
		}
		job, started = h.begin(s, wsID, ws, op), true
	})
	return job, started
}

// begin starts a job, on the hub's goroutine, and returns it as it begins.
func (h *gitJobHub) begin(s *Server, wsID string, ws workspace.Workspace, op gitops.Op) gitJob {
	ctx, cancel := context.WithCancel(h.life)
	h.seq++
	run := &gitJobRun{
		job: gitJob{
			ID: "gitjob_" + rand.Text(), Workspace: wsID, Repo: op.Repo, Kind: op.Kind,
			Commands: [][]string{}, State: gitJobRunning, Auto: op.Auto,
		},
		seq: h.seq, cancel: cancel, done: make(chan struct{}),
	}
	h.running[run.job.ID] = run
	var env []string
	if gitops.IsNetwork(op.Kind) {
		env = h.askpassEnv(s, run)
	}
	h.publish(s, run)
	go h.execute(ctx, s, ws, op, run, env)
	return run.snapshot()
}

// execute runs a job's write, on a goroutine of its own, and hands everything
// the write reports to the hub in the order it reports it. Env is what its
// commands that talk to a remote are run with (askpassEnv).
func (h *gitJobHub) execute(ctx context.Context, s *Server, ws workspace.Workspace, op gitops.Op, run *gitJobRun, env []string) {
	hooks := gitops.Hooks{
		Command: func(args []string) {
			args = slices.Clone(args)
			h.post(func() {
				run.job.Commands = append(run.job.Commands, args)
				h.changed(s, run)
			})
		},
		Output: func(b []byte) {
			b = slices.Clone(b)
			h.post(func() {
				run.output = appendTail(run.output, b, gitJobOutputMax)
				h.changed(s, run)
			})
		},
		Progress: func(p gitops.Progress) {
			h.post(func() {
				run.job.Progress = &p
				h.changed(s, run)
			})
		},
		Env: env,
	}
	res, err := ws.GitRun(ctx, op, hooks)
	cancelled := ctx.Err() != nil
	h.post(func() { h.finish(s, run, res, err, cancelled) })
}

// changed sends a running job's frame now, or once gitJobFrameEvery has passed
// since its last, carrying everything that changed in between.
func (h *gitJobHub) changed(s *Server, run *gitJobRun) {
	run.dirty = true
	if run.flushing {
		return
	}
	wait := gitJobFrameEvery - time.Since(run.sentAt)
	if wait <= 0 {
		h.publish(s, run)
		return
	}
	run.flushing = true
	time.AfterFunc(wait, func() {
		h.post(func() {
			run.flushing = false
			if run.dirty && run.job.State == gitJobRunning {
				h.publish(s, run)
			}
		})
	})
}

// finish ends a job: its state from how the write ended, its frame sent at
// once, and the job kept among those that can be read back.
func (h *gitJobHub) finish(s *Server, run *gitJobRun, res gitops.Result, err error, cancelled bool) {
	run.cancel()
	h.forgetAskpass(run, true)
	j := &run.job
	j.Result = res
	switch {
	case err == nil:
		j.State = gitJobDone
	case cancelled:
		j.State = gitJobCancelled
	default:
		j.State = gitJobFailed
		describeGitJobError(j, err)
	}
	delete(h.running, j.ID)
	h.ended = append(h.ended, run)
	if len(h.ended) > gitJobsKept {
		h.ended = slices.Delete(h.ended, 0, len(h.ended)-gitJobsKept)
	}
	h.publish(s, run)
	close(run.done)
	if h.stopping && len(h.running) == 0 {
		close(h.drained)
	}
}

// describeGitJobError says why a job failed, and which of gitops's refusals
// it was, if any.
func describeGitJobError(j *gitJob, err error) {
	j.Error = gitops.FailureText(err)
	j.ErrorMessage = handlers.ErrorMessage(err)
	var refused *gitops.RefusedError
	var stale *gitops.StaleError
	var locked *gitops.LockedError
	var dirty *gitops.DirtyError
	var unmerged *gitops.UnmergedError
	var checkedOut *gitops.CheckedOutError
	var conflicts *gitops.ConflictsError
	var markers *gitops.MarkersError
	var diverged *gitops.DivergedError
	var rejected *gitops.RejectedError
	var remote *gitops.RemoteNeededError
	var auth *gitops.AuthError
	var published *gitops.PublishedError
	switch {
	case errors.As(err, &refused):
		j.ErrorKind = "refused"
	case errors.As(err, &stale):
		j.ErrorKind = "stale"
	case errors.As(err, &locked):
		j.ErrorKind = "locked"
		j.LockPath = locked.Path
	case errors.As(err, &dirty):
		j.ErrorKind = "dirty"
	case errors.As(err, &unmerged):
		j.ErrorKind = "unmerged"
		j.Branch = unmerged.Branch
	case errors.As(err, &checkedOut):
		j.ErrorKind = "checked-out"
		j.Branch, j.Worktree = checkedOut.Branch, checkedOut.Worktree
	case errors.As(err, &conflicts):
		j.ErrorKind = "conflicts"
	case errors.As(err, &markers):
		j.ErrorKind = "markers"
	case errors.As(err, &diverged):
		j.ErrorKind = "diverged"
		j.Prefer = diverged.Prefer
	case errors.As(err, &rejected):
		j.ErrorKind = "rejected"
		j.Rejected, j.Reason = slices.Clone(rejected.Refs), rejected.Reason
	case errors.As(err, &remote):
		j.ErrorKind = "remote"
		j.Remotes = slices.Clone(remote.Remotes)
	case errors.As(err, &auth):
		j.ErrorKind = "auth"
	case errors.As(err, &published):
		j.ErrorKind = "published"
	}
}

// publish sends a job's frame to the connections watching its workspace.
func (h *gitJobHub) publish(s *Server, run *gitJobRun) {
	run.dirty = false
	run.sentAt = time.Now()
	s.sendToGitWatchers(run.job.Workspace, gitJobFrame{Type: frameGitJob, Workspace: run.job.Workspace, Job: run.snapshot()})
}

// find is the job of a workspace named id, running or kept; nil when there is
// none.
func (h *gitJobHub) find(wsID, id string) *gitJobRun {
	if run := h.running[id]; run != nil && run.job.Workspace == wsID {
		return run
	}
	for _, run := range h.ended {
		if run.job.ID == id && run.job.Workspace == wsID {
			return run
		}
	}
	return nil
}

// list is a workspace's jobs, running or kept, newest first.
func (h *gitJobHub) list(wsID string) []gitJob {
	var runs []*gitJobRun
	for _, run := range h.running {
		if run.job.Workspace == wsID {
			runs = append(runs, run)
		}
	}
	for _, run := range h.ended {
		if run.job.Workspace == wsID {
			runs = append(runs, run)
		}
	}
	slices.SortFunc(runs, func(a, b *gitJobRun) int { return b.seq - a.seq })
	jobs := make([]gitJob, 0, len(runs))
	for _, run := range runs {
		jobs = append(jobs, run.snapshot())
	}
	return jobs
}

// snapshot is the job as it stands, sharing nothing the hub goes on to change.
func (run *gitJobRun) snapshot() gitJob {
	j := run.job
	j.Commands = slices.Clone(run.job.Commands)
	if p := run.job.Prompt; p != nil {
		copied := *p
		j.Prompt = &copied
	}
	if p := run.job.Progress; p != nil {
		copied := *p
		j.Progress = &copied
	}
	j.Output = string(run.output)
	return j
}

// appendTail appends b to buf and keeps no more than the last limit bytes,
// starting at a whole character.
func appendTail(buf, b []byte, limit int) []byte {
	buf = append(buf, b...)
	if len(buf) <= limit {
		return buf
	}
	cut := len(buf) - limit
	for cut < len(buf) && !utf8.RuneStart(buf[cut]) {
		cut++
	}
	return append(buf[:0], buf[cut:]...)
}
