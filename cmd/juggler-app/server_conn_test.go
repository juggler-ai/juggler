//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"cmp"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
	"juggler/internal/userpaths/userpathstest"
)

// stubMachineServer stands in for this machine's Juggler server: it answers the
// control API the app uses, records what it was asked, and publishes itself in
// server.json under dir, where Connect looks.
type stubMachineServer struct {
	t       *testing.T
	dir     string
	version string
	// build is what the stand-in reports as its build (machineserver.BuildOf).
	build string
	srv   *httptest.Server

	attaches atomic.Int32
	// holding counts the attachments it is holding now, which its status
	// counts among its clients, as a server counts the app attached to it.
	holding   atomic.Int32
	shutdowns atomic.Int32
	// drop closes to end every held attachment while the server stays up
	// (dropAttachments); stopped closes when the server goes.
	drop     atomic.Pointer[chan struct{}]
	stopped  chan struct{}
	stopOnce sync.Once
	// list is what GET /sessions answers; opened records each POST /sessions.
	list   atomic.Pointer[[]machineserver.Session]
	opened chan string
	// refuseOpen, set, refuses every open with it, with refuseStatus (zero is
	// 400).
	refuseOpen   atomic.Pointer[string]
	refuseStatus atomic.Int32
	// shutdownAsked is told of each shutdown asked for; linger, set, holds the
	// stand-in up after one until it closes, as a server slow to drain is.
	shutdownAsked chan struct{}
	linger        atomic.Pointer[chan struct{}]
	// attaching is told of each attach as it arrives; holdAttach, set, holds
	// its answer until it closes, as a busy server does.
	attaching  chan struct{}
	holdAttach atomic.Pointer[chan struct{}]
	// refuseAttach, set, refuses every attach with that status, as a server
	// that is up but will not take the attachment does.
	refuseAttach atomic.Int32
	// What its status reports beyond its sessions: started by hand, other
	// clients attached, LAN access on, a running tunnel's mode.
	handStarted atomic.Bool
	// appStarted is a server the desktop app started (serve --started-by).
	appStarted atomic.Bool
	attached   atomic.Int32
	lan        atomic.Bool
	tunnel     atomic.Pointer[string]
	// refusals counts the conditional shutdowns it refused (409).
	refusals atomic.Int32
}

// occupancy is what stopping the stand-in would end.
func (s *stubMachineServer) occupancy() machineserver.Occupancy {
	o := machineserver.Occupancy{Sessions: *s.list.Load(), Clients: int(s.attached.Load() + s.holding.Load()), LAN: s.lan.Load(), HandStarted: s.handStarted.Load()}
	if t := s.tunnel.Load(); t != nil {
		o.Tunnel = *t
	}
	return o
}

const stubToken = "stub-token"

// newStubMachineServer starts a stand-in of version where a looks for its
// server, and publishes it. The app lets it go before it stops, as an app that
// quits does, so its going is not taken for the server's.
func newStubMachineServer(t *testing.T, a *appState, version string) *stubMachineServer {
	t.Helper()
	return newStubMachineServerBuild(t, a, version, version)
}

// newStubMachineServerBuild is newStubMachineServer for a stand-in that
// reports build as its build: one build from source of version among others.
func newStubMachineServerBuild(t *testing.T, a *appState, version, build string) *stubMachineServer {
	t.Helper()
	s := &stubMachineServer{t: t, dir: a.connectOpts.ConfigDir, version: version, build: build, stopped: make(chan struct{}), opened: make(chan string, 16), shutdownAsked: make(chan struct{}, 16), attaching: make(chan struct{}, 16)}
	d := make(chan struct{})
	s.drop.Store(&d)
	empty := []machineserver.Session{}
	s.list.Store(&empty)
	s.srv = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.gone)
	t.Cleanup(a.detachServer)
	s.publish()
	return s
}

// addr is the stand-in's host:port.
func (s *stubMachineServer) addr() string { return s.srv.Listener.Addr().String() }

// publish writes server.json naming the stand-in.
func (s *stubMachineServer) publish() {
	s.t.Helper()
	data, _ := json.Marshal(machineserver.ServerInfo{PID: os.Getpid(), Addr: s.addr(), Version: s.version, Token: stubToken})
	if err := os.WriteFile(filepath.Join(s.dir, "server.json"), data, 0o600); err != nil {
		s.t.Fatal(err)
	}
}

// gone stops the stand-in and removes server.json, as a server that exits does.
func (s *stubMachineServer) gone() {
	s.stopOnce.Do(func() {
		close(s.stopped)
		s.srv.Close()
		_ = os.Remove(filepath.Join(s.dir, "server.json"))
	})
}

// dropAttachments ends every attachment held now, as a server does with one
// that stopped beating, and stays up.
func (s *stubMachineServer) dropAttachments() {
	d := make(chan struct{})
	close(*s.drop.Swap(&d))
}

func (s *stubMachineServer) status() map[string]any {
	o := s.occupancy()
	return map[string]any{"status": "ok", "pid": os.Getpid(), "addr": s.addr(), "version": s.version, "build": s.build, "sessions": len(o.Sessions),
		"implicit": !o.HandStarted, "appStarted": s.appStarted.Load(), "attached": o.Clients, "lan": o.LAN, "tunnel": o.Tunnel}
}

func (s *stubMachineServer) serve(w http.ResponseWriter, r *http.Request) {
	// Read the body to its end first, so the server notices a caller going.
	body, _ := io.ReadAll(r.Body)
	if r.Header.Get(machineserver.TokenHeader) != stubToken {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/server")
	switch {
	case r.Method == http.MethodGet && path == "/status":
		writeJSON(w, http.StatusOK, s.status())
	case r.Method == http.MethodPost && path == "/attach":
		s.attaches.Add(1)
		s.attaching <- struct{}{}
		if status := s.refuseAttach.Load(); status != 0 {
			writeJSON(w, int(status), map[string]string{"error": "not now"})
			return
		}
		if hold := s.holdAttach.Load(); hold != nil {
			select {
			case <-*hold:
			case <-r.Context().Done():
				return
			case <-s.stopped:
				return
			}
		}
		drop := *s.drop.Load()
		s.holding.Add(1)
		defer s.holding.Add(-1)
		st := s.status()
		st["attachment"] = "att"
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(st)
		_ = http.NewResponseController(w).Flush()
		select {
		case <-r.Context().Done():
		case <-drop:
		case <-s.stopped:
		}
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/beat"):
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodGet && path == "/sessions":
		writeJSON(w, http.StatusOK, *s.list.Load())
	case r.Method == http.MethodPost && path == "/sessions":
		var req struct{ Project string }
		_ = json.Unmarshal(body, &req)
		s.opened <- req.Project
		if msg := s.refuseOpen.Load(); msg != nil {
			writeJSON(w, cmp.Or(int(s.refuseStatus.Load()), http.StatusBadRequest), map[string]string{"error": *msg})
			return
		}
		writeJSON(w, http.StatusCreated, machineserver.Session{ID: "s1", Project: req.Project, State: machineserver.SessionRunning})
	case r.Method == http.MethodPost && path == "/shutdown":
		var req struct {
			Expect *machineserver.Occupancy `json:"expect"`
		}
		_ = json.Unmarshal(body, &req)
		if now := s.occupancy(); req.Expect != nil && !req.Expect.Covers(now) {
			s.refusals.Add(1)
			writeJSON(w, http.StatusConflict, map[string]any{"error": "in use", "occupancy": now})
			return
		}
		s.shutdowns.Add(1)
		s.shutdownAsked <- struct{}{}
		w.WriteHeader(http.StatusAccepted)
		if linger := s.linger.Load(); linger != nil {
			go func() {
				select {
				case <-*linger:
				case <-s.stopped:
				}
				s.gone()
			}()
			return
		}
		go s.gone()
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// lostWindows replaces openLostServerStandIn for the test, reporting each window
// a lost server's stand-in was opened in place of.
func lostWindows(t *testing.T) <-chan string {
	t.Helper()
	got := make(chan string, 16)
	orig := openLostServerStandIn
	openLostServerStandIn = func(_ *appState, _ windowSpec, _ *standIn, opts windowOpts) { got <- opts.replaces }
	t.Cleanup(func() { openLostServerStandIn = orig })
	return got
}

// TestTheAppAttachesOnceAndAgainWhenItsAttachmentIsDropped: the app attaches
// to its server once, however many windows ask for it, and when the server
// drops that attachment while staying up, the app attaches again — its windows
// carry on as they were.
func TestTheAppAttachesOnceAndAgainWhenItsAttachmentIsDropped(t *testing.T) {
	a := newTestAppState(t)
	lost := lostWindows(t)
	srv := newStubMachineServer(t, a, core.Version)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: "http://" + srv.addr() + "/s/s1"})

	for range 3 {
		c, err := a.serverClient(true)
		if err != nil || c.Addr() != srv.addr() {
			t.Fatalf("serverClient: %v, %v; want the stand-in", c, err)
		}
	}
	if n := srv.attaches.Load(); n != 1 {
		t.Fatalf("%d attachments, want 1", n)
	}

	reattached := make(chan struct{}, 1)
	a.withConn(func(*connState) { a.onAttached = func() { reattached <- struct{}{} } })
	srv.dropAttachments()
	<-reattached
	if n := srv.attaches.Load(); n != 2 {
		t.Fatalf("after the drop: %d attachments, want 2", n)
	}
	select {
	case id := <-lost:
		t.Fatalf("window %s was replaced after a dropped attachment; the server is still up", id)
	default:
	}
}

// TestTheAppsLocalWindowsStandInAtOnceWhenItsServerGoes: the moment the app's
// attachment ends with its server gone, every main window onto that server is
// replaced by its stand-in. A window onto a server by URL is not, nor is a board
// (which goes with the window that opened it), nor a window already standing in.
func TestTheAppsLocalWindowsStandInAtOnceWhenItsServerGoes(t *testing.T) {
	a := newTestAppState(t)
	lost := lostWindows(t)
	srv := newStubMachineServer(t, a, core.Version)
	base := "http://" + srv.addr()
	c, err := a.serverClient(true)
	if err != nil {
		t.Fatal(err)
	}
	on := procOf(c)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: base + "/s/s1", server: on})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{}, serverURL: base, server: on})
	registerWindow(a, &winEntry{id: "w3", role: roleMain, spec: windowSpec{url: "http://devbox:8080", connected: true}, serverURL: "http://devbox:8080"})
	registerWindow(a, &winEntry{id: "w4", role: rolePinboardFor("b"), board: "b", openedBy: "w1", spec: windowSpec{project: "/p"}, serverURL: base + "/s/s1", server: on})
	registerWindow(a, &winEntry{id: "w5", role: roleMain, spec: windowSpec{project: "/q"}, standIn: &standIn{kind: standInFailed}, server: on})

	srv.gone()
	got := map[string]bool{<-lost: true, <-lost: true}
	if !got["w1"] || !got["w2"] {
		t.Fatalf("stand-ins opened for %v, want w1 and w2", got)
	}
	select {
	case id := <-lost:
		t.Fatalf("a stand-in was also opened for %s", id)
	default:
	}
}

// TestALostServerTakesOnlyTheWindowsOpenedOnIt: a server that has gone takes
// the windows opened on that process with it, and none opened on the server
// started after it at the same address — however late the loss is acted on.
func TestALostServerTakesOnlyTheWindowsOpenedOnIt(t *testing.T) {
	a := newTestAppState(t)
	lost := lostWindows(t)
	base := "http://127.0.0.1:3939"
	old, fresh := serverProc{addr: "127.0.0.1:3939", pid: 101}, serverProc{addr: "127.0.0.1:3939", pid: 202}
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: base + "/s/s1", server: old})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{project: "/q"}, serverURL: base + "/s/s1", server: fresh})

	a.serverLost(old)
	if id := <-lost; id != "w1" {
		t.Fatalf("stand-in opened for %s, want w1", id)
	}
	select {
	case id := <-lost:
		t.Fatalf("a stand-in was also opened for %s, which is on the server started after", id)
	default:
	}
}

// standInActions is the control actions si's page offers, in order.
func standInActions(si *standIn) []string {
	var actions []string
	for _, b := range si.buttons {
		actions = append(actions, b.action)
	}
	return actions
}

// TestALostServerTheAppDidNotStartIsLookedForNotStarted: a server run outside
// the app — in a terminal — that goes takes its windows with it as any does,
// but their stand-in's Try again only looks for it, and Start a server is
// offered beside it. A server the app started is started again, as ever.
func TestALostServerTheAppDidNotStartIsLookedForNotStarted(t *testing.T) {
	a := newTestAppState(t)
	got := make(chan *standIn, 16)
	orig := openLostServerStandIn
	openLostServerStandIn = func(_ *appState, _ windowSpec, si *standIn, _ windowOpts) { got <- si }
	t.Cleanup(func() { openLostServerStandIn = orig })

	ours := serverProc{addr: "127.0.0.1:3939", pid: 101, appStarted: true}
	terminals := serverProc{addr: "127.0.0.1:3939", pid: 202}
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: "http://127.0.0.1:3939/s/s1", server: ours})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{project: "/q"}, serverURL: "http://127.0.0.1:3939/s/s2", server: terminals})

	a.serverLost(ours)
	if si := <-got; si.startedElsewhere || strings.Join(standInActions(si), ",") != "retry-server" {
		t.Fatalf("stand-in for the app's own server: elsewhere %v, %v; want the app's, offering retry-server", si.startedElsewhere, standInActions(si))
	}
	a.serverLost(terminals)
	if si := <-got; !si.startedElsewhere || strings.Join(standInActions(si), ",") != "retry-server,start-server" {
		t.Fatalf("stand-in for a terminal's server: elsewhere %v, %v; want elsewhere, offering retry-server and start-server", si.startedElsewhere, standInActions(si))
	}

	// Try again on it, with no server there: none is started, and the stand-in
	// comes back.
	starts := 0
	a.connectOpts.Start = func() (int, <-chan struct{}, error) {
		starts++
		return 0, nil, errors.New("this test starts no server")
	}
	p := a.planWindow(windowSpec{}, windowOpts{noStart: true})
	if starts != 0 || p.standIn == nil || !p.standIn.startedElsewhere {
		t.Fatalf("looking again with no server: %d started, stand-in %+v; want none started and the stand-in again", starts, p.standIn)
	}
	// With the terminal's server back, the window opens on it.
	srv := newStubMachineServer(t, a, core.Version)
	p = a.planWindow(windowSpec{}, windowOpts{noStart: true})
	if starts != 0 || p.standIn != nil || p.serverURL != "http://"+srv.addr() || p.server.appStarted {
		t.Fatalf("looking again with a server there: %d started, stand-in %+v, %s on %+v; want the terminal's server", starts, p.standIn, p.serverURL, p.server)
	}
}

// TestAWindowIsReplacedOnceWhenItsServerGoes: the app's attachment ending with
// its server gone, and the window's page reporting the same loss, replace the
// window once between them.
func TestAWindowIsReplacedOnceWhenItsServerGoes(t *testing.T) {
	a := newTestAppState(t)
	lost := lostWindows(t)
	srv := newStubMachineServer(t, a, core.Version)
	c, err := a.serverClient(true)
	if err != nil {
		t.Fatal(err)
	}
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: "http://" + srv.addr() + "/s/s1", server: procOf(c)})

	srv.gone()
	if id := <-lost; id != "w1" {
		t.Fatalf("stand-in opened for %s, want w1", id)
	}
	if rec := controlRequest(a, http.MethodPost, "/win/w1/server-lost"); rec.Code == http.StatusOK && replaced(t, rec) {
		t.Fatal("the page's report replaced a window already being replaced")
	}
	select {
	case id := <-lost:
		t.Fatalf("a second stand-in was opened for %s", id)
	default:
	}
}

// TestAServerThatIsThereButRefusesTheAttachmentLeavesItsWindows: a server
// that dropped the app's attachment and will not take it again is still
// there, running its sessions, so no window onto it stands in. Only a server
// gone or on its way out (machineserver.ServerGoing) takes its windows' pages
// with it.
func TestAServerThatIsThereButRefusesTheAttachmentLeavesItsWindows(t *testing.T) {
	a := newTestAppState(t)
	lost := lostWindows(t)
	srv := newStubMachineServer(t, a, core.Version)
	c, err := a.serverClient(true)
	if err != nil {
		t.Fatal(err)
	}
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: "http://" + srv.addr() + "/s/s1", server: procOf(c)})
	var att *machineserver.Attachment
	a.withConn(func(st *connState) { att = st.att })

	srv.refuseAttach.Store(http.StatusInternalServerError)
	srv.dropAttachments()
	<-att.Done()
	// Waits for the flight settling the ended attachment, then tries again.
	if _, err := a.serverClient(true); err == nil {
		t.Fatal("serverClient attached to a server refusing attachments")
	}
	select {
	case id := <-lost:
		t.Fatalf("window %s stood in for a server that is still there", id)
	default:
	}
}

// TestAServerOfAnotherVersionWithNoSessionsIsRestartedSilently: the app never
// attaches to a server of another version. One running no sessions is asked to
// shut down, and once it has gone the app starts one of its own.
func TestAServerOfAnotherVersionWithNoSessionsIsRestartedSilently(t *testing.T) {
	a := newTestAppState(t)
	old := newStubMachineServer(t, a, "v0.0.1-old")
	var fresh *stubMachineServer
	a.connectOpts.Start = func() (int, <-chan struct{}, error) {
		fresh = newStubMachineServer(t, a, core.Version)
		return os.Getpid(), make(chan struct{}), nil
	}
	c, err := a.serverClient(true)
	if err != nil {
		t.Fatalf("serverClient: %v", err)
	}
	if old.shutdowns.Load() != 1 || old.attaches.Load() != 0 {
		t.Fatalf("old server: %d shutdowns, %d attachments; want 1, none", old.shutdowns.Load(), old.attaches.Load())
	}
	if fresh == nil || c.Addr() != fresh.addr() || fresh.attaches.Load() != 1 {
		t.Fatalf("attached to %s; want the server the app started", c.Addr())
	}
}

// TestARebuiltServerIsAnotherVersion: every build from source of one tree
// reports the same version, so the app tells its own server from a stale one
// by its build. A server left running by an earlier build, with no sessions,
// is restarted as one of another version is, and the app attaches to the
// server of its own build.
func TestARebuiltServerIsAnotherVersion(t *testing.T) {
	a := newTestAppState(t)
	a.serverBuild = core.Version + " (built 2026-10-29 13:04:12)"
	stale := newStubMachineServerBuild(t, a, core.Version, core.Version+" (built 2026-10-29 12:11:30)")
	var fresh *stubMachineServer
	a.connectOpts.Start = func() (int, <-chan struct{}, error) {
		fresh = newStubMachineServerBuild(t, a, core.Version, a.serverBuild)
		return os.Getpid(), make(chan struct{}), nil
	}
	c, err := a.serverClient(true)
	if err != nil {
		t.Fatalf("serverClient: %v", err)
	}
	if stale.shutdowns.Load() != 1 || stale.attaches.Load() != 0 {
		t.Fatalf("stale server: %d shutdowns, %d attachments; want 1, none", stale.shutdowns.Load(), stale.attaches.Load())
	}
	if fresh == nil || c.Addr() != fresh.addr() || fresh.attaches.Load() != 1 {
		t.Fatalf("attached to %s; want the server the app started", c.Addr())
	}
}

// TestAServerOfAnotherVersionWithSessionsIsLeftForTheUser: a server of another
// version that runs sessions is neither attached to nor stopped: the app says
// so, with both versions and the sessions a restart would stop.
func TestAServerOfAnotherVersionWithSessionsIsLeftForTheUser(t *testing.T) {
	a := newTestAppState(t)
	old := newStubMachineServer(t, a, "v0.0.1-old")
	old.list.Store(&[]machineserver.Session{{ID: "s1", Project: "/work/alpha", State: machineserver.SessionRunning}})
	_, err := a.serverClient(true)
	var mismatch *versionMismatchError
	if !errors.As(err, &mismatch) {
		t.Fatalf("serverClient: %v, want a version mismatch", err)
	}
	if mismatch.server != "v0.0.1-old" || len(mismatch.occ.Sessions) != 1 || mismatch.occ.Sessions[0].Project != "/work/alpha" {
		t.Fatalf("mismatch %+v", mismatch)
	}
	if old.shutdowns.Load() != 0 || old.attaches.Load() != 0 {
		t.Fatalf("old server: %d shutdowns, %d attachments; want neither", old.shutdowns.Load(), old.attaches.Load())
	}

	page := mismatchStandIn(mismatch)
	text := (&appState{}).trParagraphs(page.message)
	for _, want := range []string{"v0.0.1-old", core.Version, "/work/alpha"} {
		if !strings.Contains(text, want) {
			t.Errorf("mismatch page %q does not say %q", text, want)
		}
	}
	actions := map[string]bool{}
	for _, b := range page.buttons {
		actions[b.action] = true
	}
	if !actions["restart-server"] || !actions["quit"] || len(actions) != 2 {
		t.Errorf("mismatch page offers %v, want restart-server and quit", actions)
	}
}

// TestAServerOfAnotherVersionInUseIsLeftForTheUser: a server of another
// version with no sessions is still not restarted without asking when someone
// started it by hand, another client is attached to it, or it has LAN access
// or a tunnel open. The app says so, naming what a restart would stop.
func TestAServerOfAnotherVersionInUseIsLeftForTheUser(t *testing.T) {
	for _, c := range []struct {
		name   string
		occupy func(*stubMachineServer)
		says   string
	}{
		{"started by hand", func(s *stubMachineServer) { s.handStarted.Store(true) }, "juggler serve"},
		{"another client attached", func(s *stubMachineServer) { s.attached.Store(1) }, "1 other app or terminal"},
		{"LAN on", func(s *stubMachineServer) { s.lan.Store(true) }, "LAN access"},
		{"a tunnel", func(s *stubMachineServer) { mode := "p2p"; s.tunnel.Store(&mode) }, "p2p"},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := newTestAppState(t)
			old := newStubMachineServer(t, a, "v0.0.1-old")
			c.occupy(old)
			_, err := a.serverClient(true)
			mismatch, ok := asVersionMismatch(err)
			if !ok {
				t.Fatalf("serverClient: %v, want a version mismatch", err)
			}
			if old.shutdowns.Load() != 0 || old.attaches.Load() != 0 {
				t.Fatalf("old server: %d shutdowns, %d attachments; want neither", old.shutdowns.Load(), old.attaches.Load())
			}
			if text := (&appState{}).trParagraphs(mismatchStandIn(mismatch).message); !strings.Contains(text, c.says) {
				t.Errorf("mismatch page %q does not say %q", text, c.says)
			}
		})
	}
}

// TestARestartStopsOnlyWhatTheUserWasShown: Restart server stops the server of
// another version only while it holds no more than its stand-in said it would
// stop. One that has gained a session since is left running, and the restart
// says what it holds now, for the stand-in to be drawn again.
func TestARestartStopsOnlyWhatTheUserWasShown(t *testing.T) {
	a := newTestAppState(t)
	old := newStubMachineServer(t, a, "v0.0.1-old")
	old.list.Store(&[]machineserver.Session{{ID: "s1", Project: "/work/alpha", State: machineserver.SessionRunning}})
	_, err := a.serverClient(true)
	mismatch, ok := asVersionMismatch(err)
	if !ok {
		t.Fatalf("serverClient: %v, want a version mismatch", err)
	}
	old.list.Store(&[]machineserver.Session{
		{ID: "s1", Project: "/work/alpha", State: machineserver.SessionRunning},
		{ID: "s2", Project: "/work/late", State: machineserver.SessionRunning},
	})
	err = a.restartServer(mismatch)
	again, ok := asVersionMismatch(err)
	if !ok || len(again.occ.Sessions) != 2 {
		t.Fatalf("restart after a session opened: %v; want the mismatch again, with both sessions", err)
	}
	if old.shutdowns.Load() != 0 || old.refusals.Load() != 1 {
		t.Fatalf("old server: %d shutdowns, %d refused; want it asked once, and refusing", old.shutdowns.Load(), old.refusals.Load())
	}
	if text := (&appState{}).trParagraphs(mismatchStandIn(again).message); !strings.Contains(text, "/work/late") {
		t.Errorf("the redrawn page %q does not name the session that opened", text)
	}
	if err := a.restartServer(again); err != nil || old.shutdowns.Load() != 1 {
		t.Fatalf("restart as shown: %v, %d shutdowns; want the server stopped", err, old.shutdowns.Load())
	}
}

// TestAWindowResolvesToItsProjectsSessionOrTheServersPage: a project's window
// loads that project's session on the server, and an empty one the server's
// own page. A project the server will not open is the server's page instead,
// with the reason.
func TestAWindowResolvesToItsProjectsSessionOrTheServersPage(t *testing.T) {
	a := newTestAppState(t)
	srv := newStubMachineServer(t, a, core.Version)
	base := "http://" + srv.addr()
	proj := t.TempDir()

	got, server, err := a.resolveWindow(windowSpec{project: proj}, true)
	on := serverProc{addr: srv.addr(), pid: os.Getpid()}
	if err != nil || got != base+"/s/s1" || server != on {
		t.Fatalf("resolve a project: %q on %+v, %v; want %s/s/s1 on %+v", got, server, err, base, on)
	}
	if p := <-srv.opened; p != proj {
		t.Fatalf("opened %q, want %q", p, proj)
	}
	if got, server, err := a.resolveWindow(windowSpec{}, true); err != nil || got != base || server != on {
		t.Fatalf("resolve an empty window: %q on %+v, %v; want %s on %+v", got, server, err, base, on)
	}

	refusal := "project /gone: no such file or directory"
	srv.refuseOpen.Store(&refusal)
	_, _, err = a.resolveWindow(windowSpec{project: "/gone"}, true)
	var failed *openFailedError
	if !errors.As(err, &failed) || failed.serverURL != base || failed.server != on || !strings.Contains(failed.Error(), "no such file") {
		t.Fatalf("resolve a project the server refuses: %v; want the server's page with why", err)
	}
}

// TestAttachShowsAChosenSessionInTheEmptyWindow: a session chosen on the
// server's page in an empty window opens in that same window, which from then
// on is that project's window. Only a window showing the server's page may ask,
// and only for a session the server is running.
func TestAttachShowsAChosenSessionInTheEmptyWindow(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	srv := newStubMachineServer(t, a, core.Version)
	base := "http://" + srv.addr()
	srv.list.Store(&[]machineserver.Session{{ID: "s7", Project: "/work/alpha", State: machineserver.SessionRunning}})
	empty := registerWindow(a, &winEntry{id: "w1", role: roleMain, serverURL: base})
	showing := registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{project: "/work/beta"}, serverURL: base + "/s/s2"})
	if _, err := a.serverClient(true); err != nil {
		t.Fatal(err)
	}

	post := func(e *winEntry, session string) int {
		rec := httptest.NewRecorder()
		a.controlAttach(rec, httptest.NewRequest(http.MethodPost, "/win/"+e.id+"/attach?session="+session, nil), e)
		return rec.Code
	}
	if code := post(showing, "s7"); code != http.StatusConflict {
		t.Fatalf("attach from a window showing a session: %d, want 409", code)
	}
	if code := post(empty, "nope"); code != http.StatusNotFound {
		t.Fatalf("attach to a session the server is not running: %d, want 404", code)
	}
	if code := post(empty, "s7"); code != http.StatusNoContent {
		t.Fatalf("attach: %d, want 204", code)
	}
	var spec windowSpec
	var url string
	a.reg(func(*regState) { spec, url = empty.spec, empty.serverURL })
	if spec != (windowSpec{project: "/work/alpha"}) || url != base+"/s/s7" {
		t.Fatalf("after attach the window is %+v on %s; want /work/alpha on %s/s/s7", spec, url, base)
	}
	// Let the workspace save land before the test's directory goes.
	a.workspace.flush(nil)
}

// TestQuitTalliesBusySessionsFromOneList: what a quit or an update restart
// would stop, on a server only this app holds up, is every busy session on
// it, read from one sessions list.
func TestQuitTalliesBusySessionsFromOneList(t *testing.T) {
	a := newTestAppState(t)
	srv := newStubMachineServer(t, a, core.Version)
	srv.list.Store(&[]machineserver.Session{
		{ID: "a", Project: "/a", State: machineserver.SessionRunning, Busy: true},
		{ID: "b", Project: "/b", State: machineserver.SessionRunning},
		{ID: "c", Project: "/c", State: machineserver.SessionRunning, Busy: true},
	})
	if _, err := a.serverClient(true); err != nil {
		t.Fatal(err)
	}
	if n := a.sessionsAQuitStops(); n != 2 {
		t.Fatalf("sessionsAQuitStops = %d, want 2", n)
	}
	rec := httptest.NewRecorder()
	a.handleUpdaterRestart(rec, httptest.NewRequest(http.MethodPost, "/win/w1/updater?op=restart", nil))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"busy":2`) {
		t.Fatalf("update restart with two busy sessions: %d %s; want 409 with busy 2", rec.Code, rec.Body.String())
	}
}

// TestQuitStopsNothingOnAServerThatOutlivesTheApp: a server started by hand,
// or one another local client holds up — a terminal's juggler, another app —
// goes on when this app lets it go, and its sessions run their turns to the
// end with no viewer. A quit stops none of them, so there is nothing to warn
// of.
func TestQuitStopsNothingOnAServerThatOutlivesTheApp(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(*stubMachineServer)
	}{
		{"started by hand", func(s *stubMachineServer) { s.handStarted.Store(true) }},
		{"another client attached", func(s *stubMachineServer) { s.attached.Store(1) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := newTestAppState(t)
			srv := newStubMachineServer(t, a, core.Version)
			srv.list.Store(&[]machineserver.Session{{ID: "a", Project: "/a", State: machineserver.SessionRunning, Busy: true}})
			tc.setup(srv)
			if _, err := a.serverClient(true); err != nil {
				t.Fatal(err)
			}
			if n := a.sessionsAQuitStops(); n != 0 {
				t.Fatalf("sessionsAQuitStops = %d, want 0", n)
			}
			saved := updaterRestart
			updaterRestart = func() error { return errors.New("nothing staged") }
			t.Cleanup(func() { updaterRestart = saved })
			rec := httptest.NewRecorder()
			a.handleUpdaterRestart(rec, httptest.NewRequest(http.MethodPost, "/win/w1/updater?op=restart", nil))
			if rec.Code == http.StatusConflict {
				t.Fatalf("update restart: %d %s; want no busy refusal", rec.Code, rec.Body.String())
			}
		})
	}
}

// returnsPromptly runs fn, which waits only on its own work, and fails the test
// unless it returns while a slow call on the app's connection is still held
// by the test. The test's deadline is the only clock, there so a hang fails
// with a message rather than the binary's timeout.
func returnsPromptly(t *testing.T, name string, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	var deadline <-chan time.Time
	if d, ok := t.Deadline(); ok {
		timer := time.NewTimer(time.Until(d) - 10*time.Second)
		defer timer.Stop()
		deadline = timer.C
	}
	select {
	case <-done:
	case <-deadline:
		t.Fatalf("%s did not return while a slow call on the server connection was still running: it waited for that call", name)
	}
}

// TestARestartWaitingOnTheServerHoldsUpNoQuickCall: a restart waits for the
// old server to go, for as long as its drain takes. Meanwhile what Cmd+Q
// reads (sessionsAQuitStops) and what a quit does (detachServer) still return,
// bounded by their own work.
func TestARestartWaitingOnTheServerHoldsUpNoQuickCall(t *testing.T) {
	a := newTestAppState(t)
	old := newStubMachineServer(t, a, "v0.0.1-old")
	release := make(chan struct{})
	letGo := sync.OnceFunc(func() { close(release) })
	t.Cleanup(letGo)
	old.linger.Store(&release)
	restarted := make(chan error, 1)
	go func() { restarted <- a.restartServer(&versionMismatchError{app: a.wantBuild(), server: "v0.0.1-old"}) }()
	<-old.shutdownAsked

	returnsPromptly(t, "sessionsAQuitStops", func() { a.sessionsAQuitStops() })
	returnsPromptly(t, "detachServer", a.detachServer)
	select {
	case err := <-restarted:
		t.Fatalf("the restart ended (%v) before the old server went", err)
	default:
	}
	letGo()
	if err := <-restarted; err != nil {
		t.Fatalf("restartServer: %v", err)
	}
}

// TestAWindowWaitingForItsServerToGoHoldsUpNoQuickCall: a window whose open
// caught the server on its way out (503) waits for that server to end the
// app's attachment. Meanwhile sessionsAQuitStops still reads the server's list, and
// detachServer still lets the server go — which ends the wait.
func TestAWindowWaitingForItsServerToGoHoldsUpNoQuickCall(t *testing.T) {
	a := newTestAppState(t)
	srv := newStubMachineServer(t, a, core.Version)
	srv.list.Store(&[]machineserver.Session{{ID: "a", Project: "/a", State: machineserver.SessionRunning, Busy: true}})
	if _, err := a.serverClient(true); err != nil {
		t.Fatal(err)
	}
	going := "the machine server is shutting down"
	srv.refuseOpen.Store(&going)
	srv.refuseStatus.Store(http.StatusServiceUnavailable)
	resolved := make(chan error, 1)
	go func() {
		_, _, err := a.resolveWindow(windowSpec{project: t.TempDir()}, true)
		resolved <- err
	}()
	<-srv.opened

	returnsPromptly(t, "sessionsAQuitStops", func() {
		if n := a.sessionsAQuitStops(); n != 1 {
			t.Errorf("sessionsAQuitStops = %d, want 1", n)
		}
	})
	returnsPromptly(t, "detachServer", a.detachServer)
	<-resolved
}

// TestConcurrentCallersShareOneAttach: two windows asking for the server at
// once share one Connect and one attachment — the second waits for the
// first's, held here mid-attach, rather than starting its own.
func TestConcurrentCallersShareOneAttach(t *testing.T) {
	a := newTestAppState(t)
	srv := newStubMachineServer(t, a, core.Version)
	release := make(chan struct{})
	letGo := sync.OnceFunc(func() { close(release) })
	t.Cleanup(letGo)
	srv.holdAttach.Store(&release)

	got := make(chan error, 2)
	for range 2 {
		go func() {
			c, err := a.serverClient(true)
			if err == nil && c.Addr() != srv.addr() {
				err = errors.New("a client of " + c.Addr() + ", not the stand-in")
			}
			got <- err
		}()
	}
	<-srv.attaching
	letGo()
	for range 2 {
		if err := <-got; err != nil {
			t.Fatalf("serverClient: %v", err)
		}
	}
	if n := srv.attaches.Load(); n != 1 {
		t.Fatalf("%d attachments for two concurrent callers, want 1", n)
	}
}

// registerWindow adds e to a's registry, with a secret of its own.
func registerWindow(a *appState, e *winEntry) *winEntry {
	withSecret(e)
	a.reg(func(st *regState) { st.windows[e.id] = e })
	return e
}
