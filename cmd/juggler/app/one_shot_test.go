//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server"
	"juggler/internal/apipaths"
	"juggler/internal/ingress"
)

// `juggler run`'s command line and its trail on disk.
//
// The command line matters because the run is unattended: a prompt lost to
// quoting, or a project silently resolved to somewhere else, produces a run that
// looks like it worked. The trail matters because a run that did NOT work is the
// one whose conversation somebody needs to open — including when it timed out,
// which is exactly when the engine never said which conversation it made.

func TestRunParsesItsCommandLine(t *testing.T) {
	dir := t.TempDir()
	opts, code := parseOneShotFlags([]string{"--project", dir, "--timeout", "90s", "--strategy", "default", "--json", "fix", "the", "bug"})
	if opts == nil {
		t.Fatalf("parse failed with code %d", code)
	}
	// The prompt is every remaining word, so an unquoted sentence still arrives
	// whole rather than as its first word.
	if opts.prompt != "fix the bug" {
		t.Errorf("prompt = %q, want %q", opts.prompt, "fix the bug")
	}
	if opts.project != dir {
		t.Errorf("project = %q, want %q", opts.project, dir)
	}
	if opts.timeout != 90*time.Second {
		t.Errorf("timeout = %v, want 90s", opts.timeout)
	}
	if opts.strategy != "default" {
		t.Errorf("strategy = %q, want %q", opts.strategy, "default")
	}
	if !opts.asJSON {
		t.Error("--json was not honoured")
	}
	if opts.name == "" {
		t.Error("the run has no name, so its conversation could not be found again")
	}
}

func TestRunDefaultsToHereAndToYolo(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	opts, code := parseOneShotFlags([]string{"do a thing"})
	if opts == nil {
		t.Fatalf("parse failed with code %d", code)
	}
	// Resolved explicitly rather than left to the ordinary startup default,
	// which asks whether a terminal is attached — and for an unattended run
	// there is not one, which would leave the run with no project at all.
	if opts.project != wd {
		t.Errorf("project = %q, want the working directory %q", opts.project, wd)
	}
	// Anything else parks on its first tool with nobody to approve it.
	if opts.strategy != "yolo" {
		t.Errorf("strategy = %q, want %q", opts.strategy, "yolo")
	}
	if opts.timeout != defaultRunTimeout {
		t.Errorf("timeout = %v, want %v", opts.timeout, defaultRunTimeout)
	}
}

func TestRunRefusesAnEmptyPrompt(t *testing.T) {
	for _, args := range [][]string{{}, {"   "}} {
		opts, code := parseOneShotFlags(args)
		if opts != nil {
			t.Errorf("parseOneShotFlags(%q) accepted a run with nothing to run", args)
		}
		if code != exitRunUsage {
			t.Errorf("parseOneShotFlags(%q) exit code = %d, want %d", args, code, exitRunUsage)
		}
	}
}

func TestRunFindsItsConversationByNameWhenTheIDIsUnknown(t *testing.T) {
	project := t.TempDir()
	jugglerDir := filepath.Join(project, ".juggler")
	want := filepath.Join(jugglerDir, "Run 2026-08-24 19-56-57--conv_abcdefghi")
	other := filepath.Join(jugglerDir, "Something else--conv_zzzzzzzzz")
	for _, dir := range []string{want, other} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	// A run that timed out never learned its conversation's id, and its
	// trajectory is the whole reason anyone looks. The name is unique per run,
	// which is what makes it answerable anyway.
	if got := conversationDir(project, "Run 2026-08-24 19-56-57", ""); got != want {
		t.Errorf("by name: got %q, want %q", got, want)
	}
	// With an id, that is the exact answer.
	if got := conversationDir(project, "Run 2026-08-24 19-56-57", "conv_zzzzzzzzz"); got != other {
		t.Errorf("by id: got %q, want %q", got, other)
	}
	if got := conversationDir(project, "Run that never happened", ""); got != "" {
		t.Errorf("invented a directory for a run with none: %q", got)
	}
}

// `juggler run` drives the session child it spawned over the child's
// POST /api/one-shot. These stand an httptest server in for that child.

// childBudget bounds each wait below for a step that should follow at once.
const childBudget = 30 * time.Second

func testRunOptions() *oneShotOptions {
	return &oneShotOptions{prompt: "fix the bug", project: "/p", strategy: "yolo", timeout: time.Minute, name: "Run X"}
}

// standInChild serves h at the one-shot route only; anything else is a 404.
func standInChild(t *testing.T, h http.HandlerFunc) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+apipaths.OneShot, h)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return strings.TrimPrefix(ts.URL, "http://")
}

// drainLikeTheChild reads the request body to its end, as the child's route
// does: net/http notices a caller going only once it has.
func drainLikeTheChild(r *http.Request) { _, _ = io.Copy(io.Discard, r.Body) }

func TestRunSendsItsPromptToTheChildWithItsToken(t *testing.T) {
	var got server.OneShotRequest
	var token string
	addr := standInChild(t, func(w http.ResponseWriter, r *http.Request) {
		token = r.Header.Get("X-Juggler-Token")
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(server.OneShotResult{Status: server.OneShotCompleted, FinalText: "done"})
	})

	opts := testRunOptions()
	code, res := runAgainstChild(context.Background(), addr, "child-token", opts)
	if code != exitRunCompleted || res.FinalText != "done" {
		t.Fatalf("code %d, result %+v; want a completed run carrying the child's answer", code, res)
	}
	if token != "child-token" {
		t.Errorf("the child was sent token %q, want the one minted for it", token)
	}
	want := server.OneShotRequest{Prompt: opts.prompt, StrategyID: opts.strategy, Name: opts.name, TimeoutMs: time.Minute.Milliseconds()}
	if got != want {
		t.Errorf("the child was asked %+v, want %+v", got, want)
	}
}

// The exit code is what an unattended caller reads, so every answer the child
// can give lands on exactly one documented code — and a status this side does
// not know is never mistaken for success. The status reported beside it is
// the one documented for that code: a caller reading --json and one reading $?
// are told the same thing. The timeout is the run's own to report; from the
// child it is a status like any unknown one.
func TestRunExitCodeFollowsTheChildsAnswer(t *testing.T) {
	for _, tc := range []struct {
		status     string
		want       int
		wantStatus string
	}{
		{server.OneShotCompleted, exitRunCompleted, server.OneShotCompleted},
		{server.OneShotParked, exitRunParked, server.OneShotParked},
		{server.OneShotFailed, exitRunFailed, server.OneShotFailed},
		{"something new", exitRunFailed, server.OneShotFailed},
		{server.OneShotTimedOut, exitRunFailed, server.OneShotFailed},
	} {
		addr := standInChild(t, func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(server.OneShotResult{Status: tc.status})
		})
		code, res := runAgainstChild(context.Background(), addr, "t", testRunOptions())
		if code != tc.want || res.Status != tc.wantStatus {
			t.Errorf("status %q: exit %d reported as %q, want %d as %q", tc.status, code, res.Status, tc.want, tc.wantStatus)
		}
		if res.Status != tc.status && !strings.Contains(res.ErrorText, tc.status) {
			t.Errorf("status %q: the report %q does not say what the child answered", tc.status, res.ErrorText)
		}
	}
}

func TestRunRefusedByTheChildFailsWithItsReason(t *testing.T) {
	addr := standInChild(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"no prompt"}`, http.StatusBadRequest)
	})
	code, res := runAgainstChild(context.Background(), addr, "t", testRunOptions())
	if code != exitRunFailed || !strings.Contains(res.ErrorText, "no prompt") {
		t.Fatalf("code %d, result %+v; want a failed run quoting the child's refusal", code, res)
	}
}

// A run that outlives its deadline exits 4 and lets go of the child's request,
// which is what tells the child the run was abandoned.
func TestRunThatOutlivesItsTimeoutExits4AndLetsGo(t *testing.T) {
	abandoned := make(chan struct{})
	addr := standInChild(t, func(_ http.ResponseWriter, r *http.Request) {
		drainLikeTheChild(r)
		<-r.Context().Done()
		close(abandoned)
	})
	opts := testRunOptions()
	opts.timeout = 50 * time.Millisecond

	code, res := runAgainstChild(context.Background(), addr, "t", opts)
	if code != exitRunTimeout || res.Status != server.OneShotTimedOut || res.ErrorText == "" {
		t.Fatalf("code %d, result %+v; want exit 4, status timeout, and the deadline it missed", code, res)
	}
	select {
	case <-abandoned:
	case <-time.After(childBudget):
		t.Fatal("the child's request was never let go")
	}
}

// Ctrl-C is a run that did not finish: exit 1, saying so, and the child's
// request let go as for a timeout.
func TestRunInterruptedExits1AndLetsGo(t *testing.T) {
	entered, abandoned := make(chan struct{}), make(chan struct{})
	addr := standInChild(t, func(_ http.ResponseWriter, r *http.Request) {
		drainLikeTheChild(r)
		close(entered)
		<-r.Context().Done()
		close(abandoned)
	})
	ctx, cancel := context.WithCancelCause(context.Background())
	go func() {
		<-entered
		cancel(errRunInterrupted)
	}()

	code, res := runAgainstChild(ctx, addr, "t", testRunOptions())
	if code != exitRunFailed || !strings.Contains(res.ErrorText, "interrupted") {
		t.Fatalf("code %d, result %+v; want exit 1 saying the run was interrupted", code, res)
	}
	select {
	case <-abandoned:
	case <-time.After(childBudget):
		t.Fatal("the child's request was never let go")
	}
}

// A session child serves an API token minted by whoever spawned it, never one
// of its own, so it cannot start without one. Every launch takes the variable
// out of its environment, so no tool shell inherits it.
func TestSessionChildNeedsTheTokenItsSpawnerMinted(t *testing.T) {
	t.Setenv(ingress.TokenEnv, "")
	if _, err := takeSpawnerEnv().keep(true); err == nil {
		t.Error("a session child started with no token")
	}

	t.Setenv(ingress.TokenEnv, "minted")
	got, err := takeSpawnerEnv().keep(true)
	if err != nil || got.apiToken != "minted" {
		t.Errorf("kept token %q, %v; want the minted token", got.apiToken, err)
	}
	if v, ok := os.LookupEnv(ingress.TokenEnv); ok {
		t.Errorf("%s still set to %q", ingress.TokenEnv, v)
	}

	t.Setenv(ingress.TokenEnv, "stray")
	if got, err := takeSpawnerEnv().keep(false); err != nil || got.apiToken != "" {
		t.Errorf("another launch kept token %q (%v), want none", got.apiToken, err)
	}
	if _, ok := os.LookupEnv(ingress.TokenEnv); ok {
		t.Error("another launch left the token in its environment")
	}
}

// A project already open in a session elsewhere holds its lock, so the child
// a run spawns for it cannot start. The run says so, rather than pointing at a
// crash log.
func TestRunExplainsAProjectOpenElsewhere(t *testing.T) {
	project := t.TempDir()
	lock := core.NewInstanceLock(project)
	if res, err := lock.TryAcquire(); err != nil || !res.Acquired {
		t.Fatalf("hold the project lock: %+v, %v", res, err)
	}
	t.Cleanup(func() { _ = lock.Release() })

	why := spawnFailure(project, errors.New("session child exited before reporting its address"))
	if !strings.Contains(why, "open in another Juggler session") {
		t.Errorf("explained a held project as %q", why)
	}

	free := t.TempDir()
	if why := spawnFailure(free, errors.New("boom")); !strings.Contains(why, "boom") {
		t.Errorf("explained another failure as %q, want its own reason", why)
	}
}
