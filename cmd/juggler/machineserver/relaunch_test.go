//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"slices"
	"testing"
	"time"

	"juggler/cmd/juggler/tunnel"
	"juggler/internal/userpaths/userpathstest"
)

// TestARelaunchIfCoveredStopsOnlyWhatTheUserWasShown: a relaunch, which stops
// every session as a shutdown does, is held to what the caller was shown, and
// begins once that covers what the server holds.
func TestARelaunchIfCoveredStopsOnlyWhatTheUserWasShown(t *testing.T) {
	s, c := occupiedServer(t)
	shown, err := c.Occupancy()
	if err != nil {
		t.Fatal(err)
	}
	a, _ := s.reg.reserve("/work/alpha")
	var occupied *OccupiedError
	if err := c.RelaunchIf(shown); !errors.As(err, &occupied) || len(occupied.Now.Sessions) != 1 {
		t.Fatalf("relaunch with a session the user was not shown: %v; want refused, with what it holds now", err)
	}
	if s.ending.relaunching() || len(s.shutdownReq) != 0 {
		t.Fatal("a refused relaunch began")
	}
	if _, ok := s.reg.get(a.ID); !ok {
		t.Fatal("a refused relaunch stopped a session")
	}
	if err := c.RelaunchIf(occupied.Now); err != nil || len(s.shutdownReq) != 1 || !s.ending.relaunching() {
		t.Fatalf("relaunch covering what it holds: %v, signalled %v, relaunching %v; want it begun", err, len(s.shutdownReq) == 1, s.ending.relaunching())
	}
}

// TestAStopIsFinalOverARelaunch: once a stop is decided on, a relaunch asked
// for after it is refused, conditional or not, and nothing reopens attaching;
// and a stop — a signal during the drain (stopDuringRelaunch) among them —
// overrides a relaunch decided on before it.
func TestAStopIsFinalOverARelaunch(t *testing.T) {
	s, c := occupiedServer(t)
	now, err := c.Occupancy()
	if err != nil {
		t.Fatal(err)
	}
	if err := c.ShutdownIf(now); err != nil {
		t.Fatal(err)
	}
	if err := c.RelaunchIf(now); err != nil && !ServerGoing(err) {
		t.Fatalf("conditional relaunch after a stop: %v", err)
	}
	if s.ending.relaunching() || !s.ending.stopping() {
		t.Fatal("a conditional relaunch asked for after a stop turned the stop into a relaunch")
	}
	s.lan.Store(true) // more than the caller was shown: refused
	if _, ok := s.endIf(Occupancy{}, true); ok || !s.closing.Load() {
		t.Fatal("a refused relaunch after a stop began, or opened attaching again")
	}

	var e ending
	if !e.relaunch() || !e.relaunching() {
		t.Fatal("a relaunch with nothing decided was refused")
	}
	sig := make(chan os.Signal, 1)
	sig <- os.Interrupt
	drained := make(chan struct{})
	s.stopDuringRelaunch(sig, nil, nil, drained) // returns on the signal
	if !s.ending.stopping() {
		t.Fatal("a signal during a relaunch's drain did not make it a stop")
	}
	e.stop()
	if e.relaunch() || e.relaunching() || e.settle() {
		t.Fatal("a relaunch was decided on after a stop")
	}
}

// TestAnUnconditionalRelaunchAfterAStopIsRefused: the control API refuses a
// relaunch once the server is stopping, rather than relaunching a server the
// user asked to stop — with whatever it had open by then handed on as nothing.
func TestAnUnconditionalRelaunchAfterAStopIsRefused(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1)}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	if code, body := lanCall(t, "POST", front.URL+"/api/server/shutdown", ""); code != http.StatusAccepted {
		t.Fatalf("shutdown: %d %s", code, body)
	}
	if code, body := lanCall(t, "POST", front.URL+"/api/server/relaunch", ""); code != http.StatusServiceUnavailable || s.ending.relaunching() {
		t.Fatalf("relaunch after a stop: %d %s; want 503, still stopping", code, body)
	}
}

// TestARelaunchWaitsForAnInstallToFinish: a relaunch is refused, and stops
// nothing, while the binary at the server's path is not a complete build — one
// still being written — since the server could not start again from it.
func TestARelaunchWaitsForAnInstallToFinish(t *testing.T) {
	saved := relaunchable
	relaunchable = func() error { return errors.New("still being written") }
	t.Cleanup(func() { relaunchable = saved })
	s, c := occupiedServer(t)
	now, err := c.Occupancy()
	if err != nil {
		t.Fatal(err)
	}
	if err := c.RelaunchIf(now); err == nil || s.ending.decided() || len(s.shutdownReq) != 0 || s.closing.Load() {
		t.Fatalf("relaunch onto a binary being installed: %v; want refused, nothing begun", err)
	}
}

// TestARelaunchTellsItsAttachmentsSo: a client attached to a server that
// relaunches learns, as its attachment ends, that the server is coming back,
// where one attached to a server that stops does not.
func TestARelaunchTellsItsAttachmentsSo(t *testing.T) {
	for _, relaunch := range []bool{false, true} {
		s, c := occupiedServer(t)
		att, err := c.Attach()
		if err != nil {
			t.Fatal(err)
		}
		now, err := c.Occupancy()
		if err != nil {
			t.Fatal(err)
		}
		if relaunch {
			err = c.RelaunchIf(now)
		} else {
			err = c.ShutdownIf(now)
		}
		if err != nil {
			t.Fatal(err)
		}
		// What serve does next: a relaunch ends the lifetime once it has
		// handed on what it holds.
		if relaunch {
			s.stopToRelaunch()
		}
		<-att.Done() // the test's own deadline bounds this
		if att.Relaunching() != relaunch {
			t.Errorf("relaunch %v: attachment says relaunching %v", relaunch, att.Relaunching())
		}
	}
}

// TestARelaunchEndsTheEventsStreamSaying: a page following the events stream
// learns, as it ends, that the server is relaunching, so it waits for the
// server to come back rather than taking it for lost.
func TestARelaunchEndsTheEventsStreamSaying(t *testing.T) {
	for _, relaunch := range []bool{false, true} {
		s := &Server{reg: newRegistry(), token: testToken}
		front := httptest.NewServer(s.routes())
		req, _ := http.NewRequest(http.MethodGet, front.URL+"/api/server/events", nil)
		req.Header.Set(TokenHeader, testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		events := readEvents(resp.Body)
		eventSessions(t, nextEvent(t, events))
		if relaunch {
			s.ending.relaunch()
		}
		s.endLifetime()
		ev := nextEvent(t, events)
		if got := ev.err == nil && ev.name == "relaunching"; got != relaunch {
			t.Errorf("relaunch %v: the stream ended with %+v", relaunch, ev)
		}
		resp.Body.Close()
		front.Close()
	}
}

// TestARelaunchOpensWhatWasOpen: a relaunched server opens what the server it
// replaced had open as it stopped — LAN access, a tunnel — over what its flags
// and the saved settings say, which were true of that server's start, not of
// its end. What the replaced server hands on is taken from the environment,
// so no session child inherits it.
func TestARelaunchOpensWhatWasOpen(t *testing.T) {
	userpathstest.Isolate(t)
	saveLaunchExposure(t, true, "")
	for _, tc := range []struct {
		name     string
		opts     ServeOptions
		carried  string
		wantLAN  bool
		wantMode tunnel.Mode
	}{
		{"nothing handed on: flags and settings", ServeOptions{}, "", true, ""},
		{"LAN switched off while it ran", ServeOptions{LAN: true}, `{"lan":false}`, false, ""},
		{"a tunnel opened while it ran", ServeOptions{}, `{"lan":true,"tunnel":"` + string(fwdMode) + `"}`, true, fwdMode},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.carried != "" {
				t.Setenv(relaunchHandoffEnv, tc.carried)
			}
			tc.opts.handoff = takeRelaunchHandoff()
			lan, mode := launchExposure(tc.opts)
			if lan != tc.wantLAN || mode != tc.wantMode {
				t.Errorf("launchExposure = LAN %v, tunnel %q; want %v, %q", lan, mode, tc.wantLAN, tc.wantMode)
			}
			if v, ok := os.LookupEnv(relaunchHandoffEnv); ok {
				t.Errorf("%s is still in the environment (%q), for a child to inherit", relaunchHandoffEnv, v)
			}
		})
	}
}

// TestARelaunchedServerIsHeldForTheClientsItTookOver: an implicit server
// stops once nothing holds it, at its next check. One that replaced a server
// in a relaunch has no client yet, and the clients of the server it replaced —
// which it is handed — reach it only once they have seen that server go, so it
// holds itself up for each of them until it has attached or exited, as it does
// for a starter.
func TestARelaunchedServerIsHeldForTheClientsItTookOver(t *testing.T) {
	old, c := occupiedServer(t)
	if _, err := c.Attach(); err != nil {
		t.Fatal(err)
	}
	if h := old.handoff(); !slices.Contains(h.Holders, os.Getpid()) {
		t.Fatalf("handoff = %+v; want it to name the client attached (pid %d)", h, os.Getpid())
	}

	s, next := occupiedServer(t)
	gone := exitedPID(t)
	s.holdFor([]int{os.Getpid(), gone})
	s.check()
	if len(s.shutdownReq) != 0 {
		t.Fatal("stopped while a client of the server it replaced lives and has not attached")
	}
	att, err := next.Attach()
	if err != nil {
		t.Fatal(err)
	}
	att.Close()
	waitAttached(t, s, 0)
	s.check()
	if len(s.shutdownReq) != 1 {
		t.Fatal("still held once that client attached and left, and the other had exited")
	}
}

// TestAServerHoldsItselfUpForTheLaunchItIsAskedTo: a client that relaunches
// itself along with its server asks the server, before it exits, to hold
// itself up for its next launch (HoldFor) — which then holds an implicit
// server up as a client of the server it replaced does, until it attaches or
// exits. A process that has exited already holds nothing.
func TestAServerHoldsItselfUpForTheLaunchItIsAskedTo(t *testing.T) {
	s, c := occupiedServer(t)
	if err := c.HoldFor(exitedPID(t)); err == nil {
		t.Fatal("held for a process that has exited")
	}
	if err := c.HoldFor(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	s.check()
	if len(s.shutdownReq) != 0 {
		t.Fatal("stopped while the launch it was asked to hold for lives and has not attached")
	}
	att, err := c.Attach()
	if err != nil {
		t.Fatal(err)
	}
	att.Close()
	waitAttached(t, s, 0)
	s.check()
	if len(s.shutdownReq) != 1 {
		t.Fatal("still held once that launch attached and left")
	}
}

// TestARelaunchKeepsTheTunnelsLink: a server relaunching with a tunnel open
// hands on what serves its link (tunnel.Resumable.Resume) and releases the
// tunnel, rather than merely stopping it, so the link is free for the next
// process — which opens the tunnel from it, under the same link, so a remote
// caller holding the link finds the server again.
func TestARelaunchKeepsTheTunnelsLink(t *testing.T) {
	old := &Server{reg: newRegistry(), token: testToken}
	t.Cleanup(old.endLifetime)
	before, err := old.startTunnel(resumeMode)
	if err != nil {
		t.Fatal(err)
	}
	released := lastResumable.Load()
	h := old.handOff()
	if h.Tunnel != resumeMode || h.TunnelResume != "fresh-token" {
		t.Fatalf("handoff = %+v; want the tunnel's mode and what serves its link", h)
	}
	if !released.released.Load() || old.tunnel.Load() != nil {
		t.Fatal("the relaunching server left its tunnel open, or stopped it without releasing its link")
	}

	next := &Server{reg: newRegistry(), token: testToken}
	t.Cleanup(next.endLifetime)
	t.Cleanup(next.stopTunnel)
	after, err := next.startTunnelFrom(h.Tunnel, h.TunnelResume)
	if err != nil {
		t.Fatal(err)
	}
	if got := lastResumable.Load().startedFrom; got != "fresh-token" || after.URL != before.URL {
		t.Fatalf("the next server's tunnel started from %q at %s; want the token handed on, and the link %s", got, after.URL, before.URL)
	}
}

// TestAConditionalRelaunchHandsOnWhatItHolds: a relaunch the user agreed to
// (RelaunchIf) stops anything new opening or attaching at once, but keeps what
// is open — the clients' attachments, the tunnel — until the server hands it
// on (stopToRelaunch), so the handoff names every client, and the tunnel's
// link is released rather than closed under it.
func TestAConditionalRelaunchHandsOnWhatItHolds(t *testing.T) {
	s, c := occupiedServer(t)
	if _, err := s.startTunnel(resumeMode); err != nil {
		t.Fatal(err)
	}
	tun := lastResumable.Load()
	att, err := c.Attach()
	if err != nil {
		t.Fatal(err)
	}
	now, err := c.Occupancy()
	if err != nil {
		t.Fatal(err)
	}
	if err := c.RelaunchIf(now); err != nil {
		t.Fatal(err)
	}
	if res := s.openSession(t.Context(), t.TempDir(), false); res.status != http.StatusServiceUnavailable {
		t.Fatalf("open after a relaunch began: %d, want 503", res.status)
	}
	if _, err := c.Attach(); !ServerGoing(err) {
		t.Fatalf("attach after a relaunch began: %v, want the server going", err)
	}
	if s.lifetime().Err() != nil {
		t.Fatal("the lifetime ended as the relaunch was agreed, before the server handed on its attachments and tunnel")
	}

	h := s.stopToRelaunch()
	if !slices.Contains(h.Holders, os.Getpid()) || h.Tunnel != resumeMode || h.TunnelResume != "fresh-token" || !tun.released.Load() {
		t.Fatalf("handoff = %+v, tunnel released %v; want the attached client (pid %d) and the released tunnel's link", h, tun.released.Load(), os.Getpid())
	}
	<-att.Done() // the test's own deadline bounds this
	if !att.Relaunching() {
		t.Fatal("the attachment ended without saying the server is relaunching")
	}
}

// exitedPID is the pid of a process that has exited.
func exitedPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

// quietServer is occupiedServer running one session whose child is sc, with
// a binary at its path that a relaunch can start (relaunchable, startable),
// and the session's child.
func quietServer(t *testing.T, sc *stubChild) (*Server, *Client, string, *child) {
	t.Helper()
	savedRelaunchable, savedStartable := relaunchable, startable
	relaunchable = func() error { return nil }
	startable = func(context.Context) error { return nil }
	t.Cleanup(func() { relaunchable, startable = savedRelaunchable, savedStartable })
	s, c := occupiedServer(t)
	sess, _ := s.reg.reserve("/work/alpha")
	ch := &child{addr: sc.srv.Listener.Addr().String(), apiToken: stubChildToken, exited: make(chan struct{})}
	s.reg.setRunning(sess.ID, ch, 1)
	return s, c, sess.ID, ch
}

// autoRelaunchLooks makes each look autoRelaunch takes at the server wait
// until the test has taken it from the channel returned.
func autoRelaunchLooks(t *testing.T, s *Server) <-chan struct{} {
	t.Helper()
	looks := make(chan struct{})
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	s.autoRelaunchLooked = func() {
		select {
		case looks <- struct{}{}:
		case <-done:
		}
	}
	return looks
}

// nextLook waits for autoRelaunch's next look.
func nextLook(t *testing.T, looks <-chan struct{}) {
	t.Helper()
	select {
	case <-looks:
	case <-time.After(5 * time.Second):
		t.Fatal("autoRelaunch took no look within 5s")
	}
}

// TestARelaunchIfQuietWaitsForTurnsAndTasks: a relaunch that is to stop no
// work begins only while no session runs a turn or a background task — as the
// children say when asked then, not as the last poll found them — and a client
// attached to the server, which follows it, holds nothing up.
func TestARelaunchIfQuietWaitsForTurnsAndTasks(t *testing.T) {
	sc := newStubChild(t)
	s, _, _, _ := quietServer(t, sc)
	s.attached.Add(1)
	sc.busy.Store(true) // and no poll has seen it
	if busy, ok := s.relaunchIfQuiet(false); ok || busy.Conversations != 1 || s.ending.decided() || len(s.shutdownReq) != 0 || s.closing.Load() {
		t.Fatalf("relaunch under a turn: began %v, busy %+v; want refused with the turn counted, attaching still open", ok, busy)
	}
	sc.busy.Store(false)
	sc.backgroundTasks.Store(2)
	if busy, ok := s.relaunchIfQuiet(false); ok || busy.Tasks != 2 || s.ending.decided() {
		t.Fatalf("relaunch under background tasks: began %v, busy %+v; want refused with the tasks counted", ok, busy)
	}
	sc.backgroundTasks.Store(0)
	if _, ok := s.relaunchIfQuiet(false); !ok || !s.ending.relaunching() || len(s.shutdownReq) != 1 {
		t.Fatal("a quiet server with an idle client attached did not relaunch")
	}
}

// TestTheServerTakesUpABuildInstalledOnceItIsQuiet: once another build is
// installed at the server's path, the server relaunches into it by itself —
// waiting while a turn runs, and going once it has ended.
func TestTheServerTakesUpABuildInstalledOnceItIsQuiet(t *testing.T) {
	sc := newStubChild(t)
	sc.busy.Store(true)
	s, _, id, ch := quietServer(t, sc)
	looks := autoRelaunchLooks(t, s)
	go s.autoRelaunch()
	nextLook(t, looks)
	build := "v9.9.9"
	s.installed.Store(&build)
	s.reg.touch()
	nextLook(t, looks)
	if s.ending.decided() || len(s.shutdownReq) != 0 {
		t.Fatal("relaunched into the build installed while a turn ran")
	}
	go func() {
		for range looks {
		}
	}()
	sc.busy.Store(false)
	s.reg.setActivity(id, ch, childActivityResponse{}, time.Now()) // the next poll's news
	select {
	case <-s.shutdownReq:
	case <-time.After(5 * time.Second):
		t.Fatal("did not relaunch into the build installed once the turn had ended")
	}
	if !s.ending.relaunching() {
		t.Fatal("the shutdown begun is no relaunch")
	}
}

// TestAnAppStartedServerLeavesTheRelaunchToTheApp: a server the desktop app
// started never relaunches into a build installed under it by itself, quiet
// or not: the app offers the relaunch, and relaunches itself with it, when
// the user asks; a server gone ahead alone leaves the app on the old build.
func TestAnAppStartedServerLeavesTheRelaunchToTheApp(t *testing.T) {
	sc := newStubChild(t)
	s, _, _, _ := quietServer(t, sc)
	s.appStarted = true
	build := "v9.9.9"
	s.installed.Store(&build)
	looks := autoRelaunchLooks(t, s)
	done := make(chan struct{})
	go func() {
		s.autoRelaunch()
		close(done)
	}()
	select {
	case <-done:
	case <-looks:
		t.Fatal("an app-started server looked to relaunch by itself")
	case <-time.After(5 * time.Second):
		t.Fatal("autoRelaunch neither returned nor looked within 5s")
	}
	if s.ending.decided() || len(s.shutdownReq) != 0 {
		t.Fatal("an app-started server relaunched by itself")
	}
}

// TestABuildThatCannotRelaunchIsTriedOnce: a build the server could not start
// from is not tried again until another is installed, so a broken install
// never stops the server's sessions, nor has it ask over and over; and nothing
// is tried once a stop is decided.
func TestABuildThatCannotRelaunchIsTriedOnce(t *testing.T) {
	sc := newStubChild(t)
	s, _, _, _ := quietServer(t, sc)
	// Each try is sent before the look that made it, which the test waits for.
	tries := make(chan string, 16)
	startable = func(context.Context) error {
		tries <- s.installedBuild()
		return errors.New("it does not start")
	}
	var tried []string
	triedNow := func() []string {
		for {
			select {
			case b := <-tries:
				tried = append(tried, b)
			default:
				return tried
			}
		}
	}
	looks := autoRelaunchLooks(t, s)
	go s.autoRelaunch()
	nextLook(t, looks)
	for _, b := range []string{"v2", "v2", "v3"} {
		s.installed.Store(&b)
		s.reg.touch()
		nextLook(t, looks)
	}
	if got := triedNow(); !slices.Equal(got, []string{"v2", "v3"}) {
		t.Fatalf("builds tried = %q; want each tried once", got)
	}
	s.ending.stop()
	v4 := "v4"
	s.installed.Store(&v4)
	s.reg.touch()
	nextLook(t, looks)
	if got := triedNow(); len(got) != 2 || len(s.shutdownReq) != 0 || s.ending.relaunching() {
		t.Fatalf("after a stop: tried %q, relaunching %v; want nothing more tried", got, s.ending.relaunching())
	}
}

// TestAQuietRelaunchSaysWhatItWouldStop: a client may ask for a relaunch only
// if it stops no work, and is told what it would stop otherwise, to ask the
// user about.
func TestAQuietRelaunchSaysWhatItWouldStop(t *testing.T) {
	sc := newStubChild(t)
	sc.busy.Store(true)
	sc.backgroundTasks.Store(1)
	s, c, _, _ := quietServer(t, sc)
	relaunched, busy, err := c.RelaunchIfQuiet()
	if err != nil || relaunched || busy.Conversations != 1 || busy.Tasks != 1 || s.ending.decided() {
		t.Fatalf("quiet relaunch of a busy server: relaunched %v, busy %+v, %v; want refused, saying what runs", relaunched, busy, err)
	}
	sc.busy.Store(false)
	sc.backgroundTasks.Store(0)
	if relaunched, _, err := c.RelaunchIfQuiet(); err != nil || !relaunched || !s.ending.relaunching() {
		t.Fatalf("quiet relaunch of a quiet server: relaunched %v, %v", relaunched, err)
	}
}

// TestARelaunchedServerKeepsItsArgsButItsStarter: the process that replaces a
// server runs as it did, except for --started-by: a starter still to attach
// is handed on among the holders (handoff), not by the flag.
func TestARelaunchedServerKeepsItsArgsButItsStarter(t *testing.T) {
	for _, tc := range []struct{ args, want []string }{
		{[]string{"serve", "--implicit", "--started-by", "42", "--port", "0"}, []string{"serve", "--implicit", "--port", "0"}},
		{[]string{"serve", "--started-by=42", "--lan"}, []string{"serve", "--lan"}},
		{[]string{"--project", "/work/alpha"}, []string{"--project", "/work/alpha"}},
	} {
		if got := relaunchArgs(tc.args); !slices.Equal(got, tc.want) {
			t.Errorf("relaunchArgs(%q) = %q, want %q", tc.args, got, tc.want)
		}
	}
}
