//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"juggler/cmd/juggler/msg"
)

// The job itself — how it ends, what it keeps, who hears of it, and where an
// answer may go — with work the test scripts. What any kind's work does is
// that kind's business.

// recorder is a hub's publish function, every job it was handed kept, in a
// channel so a test can wait for the next.
type recorder struct {
	jobs chan Job
}

func newHub(t *testing.T) (*Hub, *recorder) {
	t.Helper()
	rec := &recorder{jobs: make(chan Job, 4096)}
	h := New(func(j Job) { rec.jobs <- j })
	t.Cleanup(h.Stop)
	return h, rec
}

// next is the next job published that satisfies ok.
func (r *recorder) next(t *testing.T, what string, ok func(Job) bool) Job {
	t.Helper()
	timeout := time.After(time.Minute)
	for {
		select {
		case j := <-r.jobs:
			if ok(j) {
				return j
			}
		case <-timeout:
			t.Fatalf("no job published %s", what)
		}
	}
}

// ended waits for job id to end and returns it as read back.
func ended(t *testing.T, h *Hub, ws, id string) Job {
	t.Helper()
	select {
	case <-h.Ended(id):
	case <-time.After(time.Minute):
		t.Fatalf("job %s did not end", id)
	}
	j, ok := h.Get(ws, id)
	if !ok {
		t.Fatalf("job %s is not kept", id)
	}
	return j
}

// waitForCtx is work that runs until its context ends.
func waitForCtx(started chan<- struct{}) func(context.Context, Hooks) (any, error) {
	return func(ctx context.Context, _ Hooks) (any, error) {
		close(started)
		<-ctx.Done()
		return "partial", ctx.Err()
	}
}

// Only Cancel ends a running job early, and a job it ends is "cancelled", not
// failed, keeping what its work returned.
func TestCancelEndsARunningJob(t *testing.T) {
	h, _ := newHub(t)
	started := make(chan struct{})
	job, err := h.Start(Spec{Kind: "test", Workspace: "ws", Run: waitForCtx(started)})
	if err != nil || job.State != Running || job.Kind != "test" || job.Workspace != "ws" || job.StartedAt == 0 {
		t.Fatalf("Start = %+v, %v: want a running job of ws", job, err)
	}
	<-started
	if _, err := h.Cancel("other", job.ID); !errors.Is(err, ErrNoJob) {
		t.Errorf("cancel from another workspace = %v, want ErrNoJob", err)
	}
	if _, err := h.Cancel("ws", job.ID); err != nil {
		t.Fatalf("cancel = %v", err)
	}
	got := ended(t, h, "ws", job.ID)
	if got.State != Cancelled || got.Error != nil || got.Result != "partial" || got.EndedAt == 0 {
		t.Errorf("cancelled job = %+v, want cancelled, no error, its result kept", got)
	}
	if _, err := h.Cancel("ws", "nope"); !errors.Is(err, ErrNoJob) {
		t.Errorf("cancelling an unknown job = %v, want ErrNoJob", err)
	}
}

// A failure says which refusal it was when its work says, and carries a
// message's translatable text when the error is one.
func TestFailureIsDescribed(t *testing.T) {
	h, _ := newHub(t)
	refusal := msg.NewError("No files were named.")
	for _, c := range []struct {
		err  error
		want Error
		text bool
	}{
		{&Failure{Kind: "refused", Err: refusal}, Error{Kind: "refused", Message: "No files were named."}, true},
		{&Failure{Kind: "auth", Message: "said at length", Err: errors.New("short")}, Error{Kind: "auth", Message: "said at length"}, false},
		{errors.New("it broke"), Error{Message: "it broke"}, false},
	} {
		job, _ := h.Start(Spec{Kind: "test", Run: func(context.Context, Hooks) (any, error) { return nil, c.err }})
		got := ended(t, h, "", job.ID)
		if got.State != Failed || got.Error == nil || got.Error.Kind != c.want.Kind || got.Error.Message != c.want.Message || (got.Error.Text != nil) != c.text {
			t.Errorf("%v: job = %+v error %+v, want failed with %+v (text %v)", c.err, got, got.Error, c.want, c.text)
		}
	}
}

// An answer goes to the work that asked and nowhere else: not on any job
// published, read back or listed, of any kind. The first answer is the one
// taken.
func TestAskAnswerGoesOnlyToTheAsker(t *testing.T) {
	const secret = "Sentinel-Pa55word-9d1f"
	h, rec := newHub(t)
	heard := make(chan Answer, 1)
	job, _ := h.Start(Spec{Kind: "any-kind", Workspace: "ws", Run: func(ctx context.Context, k Hooks) (any, error) {
		a, err := k.Ask(ctx, Question{Text: "Password for x:", Kind: "secret"})
		heard <- a
		return nil, err
	}})
	asked := rec.next(t, "with a question", func(j Job) bool { return j.ID == job.ID && j.Prompt != nil })
	if asked.Prompt.ID == "" || asked.Prompt.Kind != "secret" || asked.Prompt.Text != "Password for x:" {
		t.Fatalf("prompt = %+v", asked.Prompt)
	}
	if _, err := h.Answer("ws", job.ID, "ask_other", Answer{Text: "x"}); !errors.Is(err, ErrNotAsked) {
		t.Errorf("an answer to a question never asked = %v, want ErrNotAsked", err)
	}
	if _, err := h.Answer("ws", job.ID, asked.Prompt.ID, Answer{Text: secret}); err != nil {
		t.Fatalf("answer = %v", err)
	}
	if _, err := h.Answer("ws", job.ID, asked.Prompt.ID, Answer{Text: "someone else"}); !errors.Is(err, ErrNotAsked) {
		t.Errorf("a second answer = %v, want ErrNotAsked: the first wins", err)
	}
	if a := <-heard; a.Text != secret || a.Declined {
		t.Errorf("the asker heard %+v", a)
	}
	got := ended(t, h, "ws", job.ID)
	if got.State != Done || got.Prompt != nil {
		t.Errorf("job = %+v, want done with no question", got)
	}

	var seen []Job
	for len(rec.jobs) > 0 {
		seen = append(seen, <-rec.jobs)
	}
	seen = append(seen, asked, got)
	seen = append(seen, h.List("ws")...)
	for _, j := range seen {
		if b, _ := json.Marshal(j); strings.Contains(string(b), secret) {
			t.Errorf("the answer is on a job: %s", b)
		}
	}
}

// A question still open is declined when its job is cancelled, and when the
// asker stops waiting; either way the hub holds nothing for it after.
func TestAskDeclinedWhenCancelledOrAbandoned(t *testing.T) {
	h, rec := newHub(t)
	heard := make(chan Answer, 1)
	job, _ := h.Start(Spec{Kind: "test", Run: func(ctx context.Context, k Hooks) (any, error) {
		a, _ := k.Ask(ctx, Question{Text: "Username:", Kind: "text"})
		heard <- a
		<-ctx.Done()
		return nil, ctx.Err()
	}})
	rec.next(t, "with a question", func(j Job) bool { return j.ID == job.ID && j.Prompt != nil })
	if _, err := h.Cancel("", job.ID); err != nil {
		t.Fatal(err)
	}
	if a := <-heard; !a.Declined {
		t.Errorf("the asker heard %+v, want declined", a)
	}
	if got := ended(t, h, "", job.ID); got.State != Cancelled || got.Prompt != nil {
		t.Errorf("job = %+v, want cancelled with no question", got)
	}

	asking, stopAsking := context.WithCancel(t.Context())
	errs := make(chan error, 1)
	job, _ = h.Start(Spec{Kind: "test", Run: func(_ context.Context, k Hooks) (any, error) {
		a, err := k.Ask(asking, Question{Text: "Username:", Kind: "text"})
		if !a.Declined {
			err = errors.New("not declined")
		}
		errs <- err
		return nil, nil
	}})
	rec.next(t, "with the second question", func(j Job) bool { return j.ID == job.ID && j.Prompt != nil })
	stopAsking()
	if err := <-errs; !errors.Is(err, context.Canceled) {
		t.Errorf("an abandoned question = %v, want declined with the context's error", err)
	}
	ended(t, h, "", job.ID)
	held := -1
	h.do(func() { held = len(h.asks) })
	if held != 0 {
		t.Errorf("the hub still holds %d questions", held)
	}
}

// A job keeps the last OutputMax bytes of its output, starting at a whole
// character.
func TestOutputKeepsItsTail(t *testing.T) {
	h, _ := newHub(t)
	job, _ := h.Start(Spec{Kind: "test", Run: func(_ context.Context, k Hooks) (any, error) {
		k.Output([]byte(strings.Repeat("é", OutputMax/2+1)))
		k.Output([]byte("end"))
		return nil, nil
	}})
	got := ended(t, h, "", job.ID)
	if len(got.Output) > OutputMax || !utf8.ValidString(got.Output) || !strings.HasSuffix(got.Output, "éend") {
		t.Errorf("output of %d bytes, valid %v, ends %q: want at most %d, whole characters, the tail",
			len(got.Output), utf8.ValidString(got.Output), got.Output[max(0, len(got.Output)-8):], OutputMax)
	}
}

// The last Kept jobs to end are kept, newest first; older ones are gone.
func TestRetentionKeepsTheLast(t *testing.T) {
	h, _ := newHub(t)
	var ids []string
	for range Kept + 3 {
		job, _ := h.Start(Spec{Kind: "test", Workspace: "ws", Run: func(context.Context, Hooks) (any, error) { return nil, nil }})
		<-h.Ended(job.ID)
		ids = append(ids, job.ID)
	}
	list := h.List("ws")
	if len(list) != Kept || list[0].ID != ids[len(ids)-1] || list[Kept-1].ID != ids[3] {
		t.Errorf("list of %d, newest %s: want %d, newest %s, oldest %s", len(list), list[0].ID, Kept, ids[len(ids)-1], ids[3])
	}
	if _, ok := h.Get("ws", ids[0]); ok {
		t.Error("the oldest job is still kept")
	}
	if got := h.List("elsewhere"); len(got) != 0 {
		t.Errorf("another workspace lists %d jobs", len(got))
	}
}

// Changes coming faster than FrameEvery are published together, once it has
// passed, carrying all of them.
func TestChangesAreCoalesced(t *testing.T) {
	h, rec := newHub(t)
	release := make(chan struct{})
	job, _ := h.Start(Spec{Kind: "test", Run: func(ctx context.Context, _ Hooks) (any, error) {
		<-release
		return nil, nil
	}})
	rec.next(t, "as it started", func(j Job) bool { return j.ID == job.ID })
	before := len(rec.jobs)
	h.do(func() {
		r := h.running[job.ID]
		r.sentAt = time.Now()
		for _, s := range []string{"a", "b", "c"} {
			r.output = append(r.output, s...)
			h.changed(r)
		}
	})
	if n := len(rec.jobs) - before; n != 0 {
		t.Errorf("%d publishes within FrameEvery of the last, want none yet", n)
	}
	got := rec.next(t, "once FrameEvery passed", func(j Job) bool { return j.ID == job.ID })
	if got.Output != "abc" {
		t.Errorf("the coalesced publish carried %q, want every change", got.Output)
	}
	close(release)
	ended(t, h, "", job.ID)
}

// Detail is the kind's to change while the job runs, each change published.
func TestDetailChangesArePublished(t *testing.T) {
	h, rec := newHub(t)
	job, _ := h.Start(Spec{Kind: "test", Detail: []string{}, Run: func(_ context.Context, k Hooks) (any, error) {
		k.Detail(func(old any) any { return append(append([]string{}, old.([]string)...), "one") })
		return nil, nil
	}})
	if d, ok := job.Detail.([]string); !ok || len(d) != 0 {
		t.Errorf("started detail = %#v", job.Detail)
	}
	got := ended(t, h, "", job.ID)
	if d, ok := got.Detail.([]string); !ok || len(d) != 1 || d[0] != "one" {
		t.Errorf("ended detail = %#v", got.Detail)
	}
	rec.next(t, "with its detail changed", func(j Job) bool { d, _ := j.Detail.([]string); return len(d) == 1 })
}

// A Once key starts one job in a hub's life; Stop cancels what runs, waits for
// it, and refuses what comes after.
func TestOnceAndStop(t *testing.T) {
	h, _ := newHub(t)
	started := make(chan struct{})
	job, err := h.Start(Spec{Kind: "test", Once: "repo-1", Run: waitForCtx(started)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Start(Spec{Kind: "test", Once: "repo-1", Run: waitForCtx(make(chan struct{}))}); !errors.Is(err, ErrStartedBefore) {
		t.Errorf("a second Once = %v, want ErrStartedBefore", err)
	}
	<-started
	h.Stop()
	select {
	case <-h.Ended(job.ID):
	default:
		t.Error("Stop returned with a job still running")
	}
	if _, err := h.Start(Spec{Kind: "test", Run: waitForCtx(make(chan struct{}))}); !errors.Is(err, ErrStopped) {
		t.Errorf("Start after Stop = %v, want ErrStopped", err)
	}
}
