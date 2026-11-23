//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package jobs runs work a client asked for on the server's time, and tells
// the clients watching how it goes.
//
// A job is started by one request and answered at once; how it ends is the
// job's state, not the request's status. It runs under a context only Cancel
// and Stop end: a request that goes away, or a viewer that disconnects, leaves
// it to finish — a write abandoned because a laptop lid closed would be a write
// half made, and nothing the user asked for.
//
// What a job is doing is its kind's business, carried in its Detail and Result;
// what every job has — its state, the tail of its output, its progress meter,
// the question it is waiting on and why it failed — is this package's. Each
// change to a job is handed to the hub's publish function with the whole job,
// coalesced into at most one every FrameEvery while it runs; its end is handed
// over at once. The last Kept jobs to end are kept, so a client that missed an
// end can read it back.
//
// A running job may ask the user something (Hooks.Ask). The question is put on
// the job as Prompt; the answer comes back through Answer and goes from there
// to the job's own code only. It is never on the job, so no publish, read or
// log can hold it.
//
// All of a hub's state belongs to one goroutine, which everything else reaches
// through cmds.
package jobs

import (
	"context"
	"crypto/rand"
	"errors"
	"slices"
	"sync"
	"time"
	"unicode/utf8"

	"juggler/cmd/juggler/msg"
)

// State is where a job is in its life.
type State string

// A job's states. Every state but Running is final.
const (
	Running   State = "running"
	Done      State = "done"
	Failed    State = "failed"
	Cancelled State = "cancelled"
)

const (
	Kept       = 100                    // ended jobs kept to be read back
	OutputMax  = 256 << 10              // bytes of output a job keeps: the last of it
	FrameEvery = 100 * time.Millisecond // the least time between a running job's publishes
)

// Errors Start, Cancel and Answer report.
var (
	// ErrStopped: the hub is stopping, and starts nothing more.
	ErrStopped = errors.New("jobs: stopped")
	// ErrStartedBefore: a job with the same Once key was started in this hub's
	// life.
	ErrStartedBefore = errors.New("jobs: started before")
	// ErrNoJob: no job of that workspace has that id, running or kept.
	ErrNoJob = errors.New("jobs: no such job")
	// ErrNotAsked: the question is not open — answered already, or no longer
	// asked.
	ErrNotAsked = errors.New("jobs: question not asked")
)

// Progress is one reading of a job's meter: the phase it is in, said by the far
// end it talks to when Source is "remote", and how far through that phase.
type Progress struct {
	Phase    string `json:"phase"`
	Source   string `json:"source,omitempty"` // "" the job itself, "remote" the far end
	Percent  int    `json:"percent"`          // -1 when only a count is known
	Done     int64  `json:"done"`             // units so far
	Total    int64  `json:"total,omitempty"`  // of how many; 0 when not known
	Rate     string `json:"rate,omitempty"`   // e.g. "2.00 MiB/s", when known
	Finished bool   `json:"finished,omitempty"`
}

// Question is what a job is waiting on the user to answer. Kind says how to
// ask it: "text" typed in the open, "secret" typed masked, "confirm" a yes or no.
type Question struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Kind string `json:"kind"`
}

// Answer is the user's reply to a Question: Text, or Declined. A confirm is
// answered "yes".
type Answer struct {
	Text     string
	Declined bool
}

// Error is why a failed job failed: Message in English, Text the same for a
// client to show translated when there is one, and Kind which of its kind's
// refusals it was ("" for any other failure).
type Error struct {
	Kind    string       `json:"kind"`
	Message string       `json:"message"`
	Text    *msg.Message `json:"text,omitempty"`
}

// Failure is an error a job's Run returns to say which refusal it was and how
// to say so; any other error fails the job with no kind, said as err.Error().
type Failure struct {
	Kind    string // Error.Kind
	Message string // Error.Message; "" for Err's own
	Err     error
}

func (f *Failure) Error() string { return f.Err.Error() }
func (f *Failure) Unwrap() error { return f.Err }

// Job is one job as clients are told of it.
type Job struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`      // Whose job it is: "git"
	Workspace string `json:"workspace"` // The workspace id it was started under; "" is the project
	State     State  `json:"state"`
	Output    string `json:"output"` // The last OutputMax bytes it printed

	// Progress is its meter's latest reading; nil before the first.
	Progress *Progress `json:"progress,omitempty"`
	// Prompt is the question it is waiting on, while it waits. Never the answer.
	Prompt *Question `json:"prompt,omitempty"`
	// Error is why it failed; nil unless State is Failed.
	Error *Error `json:"error,omitempty"`

	// Detail is what its kind says of it while it runs; Result what it left,
	// once ended. Each is its kind's own shape.
	Detail any `json:"detail,omitempty"`
	Result any `json:"result,omitempty"`

	StartedAt int64 `json:"startedAt"`         // Unix milliseconds
	EndedAt   int64 `json:"endedAt,omitempty"` // Unix milliseconds; 0 while it runs
}

// Spec is a job to start.
type Spec struct {
	Kind      string
	Workspace string
	// Detail is the job's Detail as it starts; Hooks.Detail changes it.
	Detail any
	// Once, when set, starts the job only if no job with the same Once was
	// started in this hub's life; Start reports ErrStartedBefore otherwise.
	Once string
	// Run is the work, on a goroutine of its own, under a context that ends
	// with Cancel or Stop. Its result is kept whether or not it failed.
	Run func(ctx context.Context, h Hooks) (result any, err error)
}

// Hub holds every job. Its methods may be called from any goroutine.
type Hub struct {
	publish func(Job)

	stopOnce sync.Once
	cmds     chan func()
	quit     chan struct{}

	// life is every job's parent: it ends only with Stop.
	life context.Context
	end  context.CancelFunc

	// Owned by the hub's goroutine.
	seq      int
	running  map[string]*run
	ended    []*run          // oldest first, at most Kept
	once     map[string]bool // the Once keys started
	asks     map[string]*ask // open questions, by question id
	stopping bool
	drained  chan struct{} // closed once stopping and nothing runs
}

// run is one job and what the hub keeps about it while it runs.
type run struct {
	job    Job
	seq    int // the order jobs were started in
	output []byte
	cancel context.CancelFunc
	done   chan struct{} // closed when the job has ended
	ask    *ask          // the question it waits on, if any

	sentAt   time.Time // when it was last published
	dirty    bool      // changed since
	flushing bool      // a publish is due once FrameEvery has passed
}

// ask is one question while it waits. Reply is sent to once, by settle.
type ask struct {
	run   *run
	q     Question
	reply chan Answer
}

// New is a hub that hands every change to a job to publish, on the hub's
// goroutine, in the order the changes were made.
func New(publish func(Job)) *Hub {
	h := &Hub{
		publish: publish,
		// Unbuffered, so a command taken is a command that will run: do never
		// waits on one the hub stopped before reaching.
		cmds:    make(chan func()),
		quit:    make(chan struct{}),
		running: map[string]*run{},
		once:    map[string]bool{},
		asks:    map[string]*ask{},
	}
	h.life, h.end = context.WithCancel(context.Background())
	go h.loop()
	return h
}

func (h *Hub) loop() {
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
func (h *Hub) post(fn func()) bool {
	select {
	case h.cmds <- fn:
		return true
	case <-h.quit:
		return false
	}
}

// do runs fn on the hub's goroutine and waits for it; false when the hub has
// stopped and fn never ran.
func (h *Hub) do(fn func()) bool {
	ran := make(chan struct{})
	if !h.post(func() { fn(); close(ran) }) {
		return false
	}
	<-ran
	return true
}

// Start begins a job and returns it as it begins.
func (h *Hub) Start(spec Spec) (Job, error) {
	var job Job
	err := ErrStopped
	h.do(func() {
		switch {
		case h.stopping:
			return
		case spec.Once != "" && h.once[spec.Once]:
			err = ErrStartedBefore
			return
		}
		if spec.Once != "" {
			h.once[spec.Once] = true
		}
		job, err = h.begin(spec), nil
	})
	return job, err
}

// begin starts a job, on the hub's goroutine.
func (h *Hub) begin(spec Spec) Job {
	ctx, cancel := context.WithCancel(h.life)
	h.seq++
	r := &run{
		job: Job{
			ID: "job_" + rand.Text(), Kind: spec.Kind, Workspace: spec.Workspace,
			State: Running, Detail: spec.Detail, StartedAt: time.Now().UnixMilli(),
		},
		seq: h.seq, cancel: cancel, done: make(chan struct{}),
	}
	h.running[r.job.ID] = r
	h.send(r)
	go h.execute(ctx, spec, r)
	return r.snapshot()
}

// execute runs a job's work, on a goroutine of its own.
func (h *Hub) execute(ctx context.Context, spec Spec, r *run) {
	res, err := spec.Run(ctx, Hooks{hub: h, run: r})
	cancelled := ctx.Err() != nil
	h.post(func() { h.finish(r, res, err, cancelled) })
}

// finish ends a job: its state from how its work ended, published at once, and
// the job kept among those that can be read back.
func (h *Hub) finish(r *run, res any, err error, cancelled bool) {
	r.cancel()
	if r.ask != nil {
		h.settle(r.ask, Answer{Declined: true})
	}
	j := &r.job
	j.Result = res
	j.EndedAt = time.Now().UnixMilli()
	switch {
	case err == nil:
		j.State = Done
	case cancelled:
		j.State = Cancelled
	default:
		j.State = Failed
		j.Error = describe(err)
	}
	delete(h.running, j.ID)
	h.ended = append(h.ended, r)
	if len(h.ended) > Kept {
		h.ended = slices.Delete(h.ended, 0, len(h.ended)-Kept)
	}
	h.send(r)
	close(r.done)
	if h.stopping && len(h.running) == 0 {
		close(h.drained)
	}
}

// describe says why a job failed.
func describe(err error) *Error {
	e := &Error{Message: err.Error()}
	var f *Failure
	if errors.As(err, &f) {
		e.Kind = f.Kind
		if f.Message != "" {
			e.Message = f.Message
		}
	}
	var me *msg.Error
	if errors.As(err, &me) && me.Error() == err.Error() {
		m := me.Message
		e.Text = &m
	}
	return e
}

// changed publishes a running job now, or once FrameEvery has passed since it
// was last, carrying everything that changed in between.
func (h *Hub) changed(r *run) {
	r.dirty = true
	if r.flushing {
		return
	}
	wait := FrameEvery - time.Since(r.sentAt)
	if wait <= 0 {
		h.send(r)
		return
	}
	r.flushing = true
	time.AfterFunc(wait, func() {
		h.post(func() {
			r.flushing = false
			if r.dirty && r.job.State == Running {
				h.send(r)
			}
		})
	})
}

// send publishes a job as it stands.
func (h *Hub) send(r *run) {
	r.dirty = false
	r.sentAt = time.Now()
	if h.publish != nil {
		h.publish(r.snapshot())
	}
}

// settle ends a question with answer, if it is still open, and reports whether
// it was. Publishing the job is the caller's to do.
func (h *Hub) settle(a *ask, answer Answer) bool {
	if h.asks[a.q.ID] != a {
		return false
	}
	delete(h.asks, a.q.ID)
	if a.run.ask == a {
		a.run.ask = nil
		a.run.job.Prompt = nil
	}
	a.reply <- answer
	return true
}

// find is the job of a workspace named id, running or kept; nil when there is
// none.
func (h *Hub) find(workspace, id string) *run {
	if r := h.running[id]; r != nil && r.job.Workspace == workspace {
		return r
	}
	for _, r := range h.ended {
		if r.job.ID == id && r.job.Workspace == workspace {
			return r
		}
	}
	return nil
}

// Get is the job of a workspace named id, running or among the last to end.
// A job belongs to the workspace it was started under, and stays readable
// after that workspace closes.
func (h *Hub) Get(workspace, id string) (Job, bool) {
	var job Job
	found := false
	h.do(func() {
		if r := h.find(workspace, id); r != nil {
			job, found = r.snapshot(), true
		}
	})
	return job, found
}

// List is every job of a workspace still running or among the last to end,
// newest first.
func (h *Hub) List(workspace string) []Job {
	jobs := []Job{}
	h.do(func() {
		var runs []*run
		for _, r := range h.running {
			if r.job.Workspace == workspace {
				runs = append(runs, r)
			}
		}
		for _, r := range h.ended {
			if r.job.Workspace == workspace {
				runs = append(runs, r)
			}
		}
		slices.SortFunc(runs, func(a, b *run) int { return b.seq - a.seq })
		for _, r := range runs {
			jobs = append(jobs, r.snapshot())
		}
	})
	return jobs
}

// Cancel ends a running job's context and declines the question it waits on,
// and returns the job as it stands; its end is published once its work has
// returned. A job that has ended already is returned as it ended.
func (h *Hub) Cancel(workspace, id string) (Job, error) {
	var job Job
	err := ErrNoJob
	h.do(func() {
		r := h.find(workspace, id)
		if r == nil {
			return
		}
		if r.job.State == Running {
			r.cancel()
			if r.ask != nil {
				h.settle(r.ask, Answer{Declined: true})
				h.send(r)
			}
		}
		job, err = r.snapshot(), nil
	})
	return job, err
}

// Answer answers, or declines, question prompt of a job, and returns the job as
// it then stands. The first answer to arrive is the one taken: a later one, or
// one to a question no longer asked, is ErrNotAsked and goes nowhere.
func (h *Hub) Answer(workspace, id, prompt string, answer Answer) (Job, error) {
	var job Job
	err := ErrNoJob
	h.do(func() {
		r := h.find(workspace, id)
		if r == nil {
			return
		}
		err = ErrNotAsked
		if a := h.asks[prompt]; a != nil && a.run == r && h.settle(a, answer) {
			err = nil
			h.send(r)
		}
		job = r.snapshot()
	})
	return job, err
}

// Ended is closed once job id has ended; already closed for one that has, and
// for one the hub does not have.
func (h *Hub) Ended(id string) <-chan struct{} {
	done := make(chan struct{})
	close(done)
	var ch <-chan struct{} = done
	h.do(func() {
		if r := h.running[id]; r != nil {
			ch = r.done
		}
	})
	return ch
}

// Stop cancels every running job and waits for each to end, for shutdown; a
// job asked for afterwards is refused. Safe to call twice.
func (h *Hub) Stop() {
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
		close(h.quit)
	})
}

// snapshot is the job as it stands, sharing nothing the hub goes on to change.
// Detail and Result are shared: a kind replaces them, never changes them in
// place (Hooks.Detail).
func (r *run) snapshot() Job {
	j := r.job
	if p := r.job.Prompt; p != nil {
		copied := *p
		j.Prompt = &copied
	}
	if p := r.job.Progress; p != nil {
		copied := *p
		j.Progress = &copied
	}
	if e := r.job.Error; e != nil {
		copied := *e
		j.Error = &copied
	}
	j.Output = string(r.output)
	return j
}

// Hooks is how a job's work reports to its job. Every method may be called from
// any goroutine; what each reports is taken in the order it was called.
type Hooks struct {
	hub *Hub
	run *run
}

// Output adds b to the job's output, of which the last OutputMax bytes are kept.
func (k Hooks) Output(b []byte) {
	b = slices.Clone(b)
	k.hub.post(func() {
		k.run.output = appendTail(k.run.output, b, OutputMax)
		k.hub.changed(k.run)
	})
}

// Progress makes p the job's latest meter reading.
func (k Hooks) Progress(p Progress) {
	k.hub.post(func() {
		k.run.job.Progress = &p
		k.hub.changed(k.run)
	})
}

// Detail replaces the job's Detail with what update makes of it. Update runs on
// the hub's goroutine and must return a new value, not change the old one in
// place: published jobs share it.
func (k Hooks) Detail(update func(old any) any) {
	k.hub.post(func() {
		k.run.job.Detail = update(k.run.job.Detail)
		k.hub.changed(k.run)
	})
}

// Ask puts q to the user on the job and waits for the answer. It is declined —
// without asking, for a job no longer running — when the job is cancelled or
// ends, when another question replaces it, and when ctx ends, which is also
// reported as ctx's error. Q's ID is the hub's to give.
func (k Hooks) Ask(ctx context.Context, q Question) (Answer, error) {
	a := &ask{run: k.run, reply: make(chan Answer, 1)}
	q.ID = "ask_" + rand.Text()
	a.q = q
	asked := false
	k.hub.do(func() {
		r := k.run
		if r.job.State != Running {
			return
		}
		if r.ask != nil {
			// One question at a time; an older one still open is one its
			// asker has given up on.
			k.hub.settle(r.ask, Answer{Declined: true})
		}
		r.ask = a
		k.hub.asks[q.ID] = a
		p := q
		r.job.Prompt = &p
		k.hub.send(r)
		asked = true
	})
	if !asked {
		return Answer{Declined: true}, nil
	}
	select {
	case answer := <-a.reply:
		return answer, nil
	case <-ctx.Done():
		k.hub.do(func() {
			if k.hub.settle(a, Answer{Declined: true}) && k.run.job.State == Running {
				k.hub.send(k.run)
			}
		})
		return Answer{Declined: true}, ctx.Err()
	}
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
