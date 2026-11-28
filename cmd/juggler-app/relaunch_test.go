//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"errors"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// TestRelaunchWaitsForTheLaunchBeforeIt: a launch given --after does not go on
// to take the single-instance lock until the process it names has exited, and
// goes straight on when that process is already gone.
func TestRelaunchWaitsForTheLaunchBeforeIt(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), stayUntilStdinClosesEnv+"=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	reaped := make(chan struct{})

	// released is set just before the process is let go, so a wait that
	// returns before then — at whatever moment it runs — is caught.
	var released, early atomic.Bool
	waited := make(chan struct{})
	go func() {
		waitForExit(pid)
		early.Store(!released.Load())
		close(waited)
	}()

	released.Store(true)
	_ = stdin.Close()
	go func() {
		_ = cmd.Wait()
		close(reaped)
	}()
	<-reaped
	<-waited // the test's own deadline bounds this
	if early.Load() {
		t.Fatal("waitForExit returned while the process it waits for was running")
	}

	// Gone already: nothing to wait for.
	waitForExit(pid)
}

// TestRelaunchKeepsOnlyTheDevFlags: the launch that replaces this one keeps
// how it was run (dev mode, verbose logging) but not which window to open
// first, since the windows that were open come back on their own, and names
// this process as the one to wait for.
func TestRelaunchKeepsOnlyTheDevFlags(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want []string
	}{
		{nil, []string{"--after", "42"}},
		{[]string{"--dev"}, []string{"--dev", "--after", "42"}},
		{[]string{"-verbose", "--url", "http://devbox:3939"}, []string{"-verbose", "--after", "42"}},
		{[]string{"--project=/p", "--dev=true", "--after", "7"}, []string{"--dev=true", "--after", "42"}},
		{[]string{"--after=7", "--project", "/p", "--verbose"}, []string{"--verbose", "--after", "42"}},
	} {
		if got := relaunchArgs(tc.args, 42); !slices.Equal(got, tc.want) {
			t.Errorf("relaunchArgs(%q) = %q, want %q", tc.args, got, tc.want)
		}
	}
}

// TestWindowControlRelaunchIsGuardedLikeAnUpdateRestart: op=relaunch asks,
// natively, about what the quit would stop and does nothing while the user
// keeps working; agreed to, it authorises the quit before it relaunches, and
// withdraws it when the relaunch could not start.
func TestWindowControlRelaunchIsGuardedLikeAnUpdateRestart(t *testing.T) {
	saved := relaunchApp
	t.Cleanup(func() { relaunchApp = saved })
	var calls int
	var quittingWhenCalled bool
	fail := false
	relaunchApp = func(a *appState) error {
		calls++
		a.reg(func(st *regState) { quittingWhenCalled = st.quitting })
		if fail {
			return errors.New("could not start the new launch")
		}
		return nil
	}

	a := newTestAppState(t)
	registerTestWindow(a, "w1")
	srv := newStubMachineServer(t, a, core.Version)
	srv.list.Store(&[]machineserver.Session{{ID: "a", Project: "/a", State: machineserver.SessionRunning, Busy: true}})
	if _, err := a.serverClient(true); err != nil {
		t.Fatal(err)
	}
	var asked []machineserver.BusyWork
	agree := false
	orig := confirmStopsDiscard
	confirmStopsDiscard = func(_ *appState, _ application.Window, action stoppingAction, stops machineserver.BusyWork) bool {
		if action.kind != relaunchAction.kind {
			t.Errorf("a relaunch asked in the words of %v", action.kind)
		}
		asked = append(asked, stops)
		return agree
	}
	t.Cleanup(func() { confirmStopsDiscard = orig })

	rec := controlRequest(a, http.MethodPost, "/win/w1/relaunch")
	if rec.Code != http.StatusConflict || len(asked) != 1 || asked[0].Conversations != 1 {
		t.Fatalf("relaunch with a busy session kept working through: %d %s, asked %+v; want 409 after asking once about 1 conversation", rec.Code, rec.Body.String(), asked)
	}
	if calls != 0 {
		t.Fatal("a relaunch the user kept working through started the new launch")
	}

	agree, fail = true, true
	rec = controlRequest(a, http.MethodPost, "/win/w1/relaunch")
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "could not start") {
		t.Fatalf("failed relaunch: %d %s; want 500 with the reason", rec.Code, rec.Body.String())
	}
	var quitting bool
	a.reg(func(st *regState) { quitting = st.quitting })
	if quitting {
		t.Fatal("a failed relaunch must withdraw the quit it authorised")
	}

	fail = false
	rec = controlRequest(a, http.MethodPost, "/win/w1/relaunch")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("agreed relaunch: %d %s; want 204", rec.Code, rec.Body.String())
	}
	if calls != 2 || !quittingWhenCalled {
		t.Fatalf("relaunch called %d times, quit authorised when called: %v; want 2, true", calls, quittingWhenCalled)
	}
	// A second click while the first relaunch is under way asks nothing — the
	// quit is agreed to — launches nothing more, and is answered as begun.
	asks := len(asked)
	rec = controlRequest(a, http.MethodPost, "/win/w1/relaunch")
	if rec.Code != http.StatusNoContent || calls != 2 || len(asked) != asks {
		t.Fatalf("relaunch while one is under way: %d, relaunch called %d times, asked %d more; want 204, still 2, none", rec.Code, calls, len(asked)-asks)
	}
	a.reg(func(st *regState) { st.quitting, st.quittingInto = false, false })
}

// TestAQuitIntoKeepsTheUsersQuit: a start that fails withdraws only the quit
// it authorised — a quit the user had begun stays authorised, so it is not
// held and asked about again — and a start the app makes on its own (follow)
// runs nothing once a quit is authorised.
func TestAQuitIntoKeepsTheUsersQuit(t *testing.T) {
	a := newTestAppState(t)
	quitting := func() (q bool) {
		a.reg(func(st *regState) { q = st.quitting })
		return q
	}
	a.reg(func(st *regState) { st.quitting = true })
	if err := a.authoriseQuitInto(func() error { return errors.New("no launch") }); err == nil || !quitting() {
		t.Fatalf("failed start during the user's quit: %v, quitting %v; want the error, still quitting", err, quitting())
	}
	ran := false
	if err := a.authoriseQuitIntoUnlessQuitting(func() error { ran = true; return nil }); !errors.Is(err, errAppQuitting) || ran {
		t.Fatalf("the app's own start during the user's quit: %v, ran %v; want errAppQuitting, not run", err, ran)
	}
	a.reg(func(st *regState) { st.quitting = false })
}
