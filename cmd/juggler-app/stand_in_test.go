//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
	"juggler/cmd/juggler/msg"
	"juggler/internal/userpaths/userpathstest"
)

// A window showing a stand-in: filed under the spec it stands in for, with a
// static page and no server.
func registerStandIn(a *appState, id string, spec windowSpec, si *standIn) *winEntry {
	e := withSecret(&winEntry{id: id, role: roleMain, view: windowView{spec: spec, standIn: si}})
	a.reg(func(st *regState) { st.windows[id] = e })
	return e
}

// addressWithNoServer is the address of a server that is not there.
func addressWithNoServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return "http://" + addr
}

// replaced reads a server-lost answer.
func replaced(t *testing.T, rec *httptest.ResponseRecorder) bool {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Replaced *bool `json:"replaced"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Replaced == nil {
		t.Fatalf("want {replaced:bool}, got %q (%v)", rec.Body.String(), err)
	}
	return *body.Replaced
}

// TestAWindowOnAServerByURLIsLeftToReconnect: a window onto a server by URL
// whose page has been reconnecting for a while is left to that reconnect,
// whether the server answers the app or not. One that does not answer may yet
// — a network that comes back brings it back — and the page, still trying,
// comes back with it, where a stand-in would wait for a click. Only the user's
// Stop trying shows the stand-in (TestAWindowWhoseUserStopsReconnecting…). A
// stand-in already is one, and a board goes with its window.
func TestAWindowOnAServerByURLIsLeftToReconnect(t *testing.T) {
	a := newTestAppState(t)
	got := lostWindows(t)

	down := addressWithNoServer(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{url: down, connected: true}, serverURL: down}})
	if replaced(t, controlRequest(a, http.MethodPost, "/win/w1/server-lost")) {
		t.Fatal("a window onto a server that does not answer was given up on")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{url: srv.URL, connected: true}, serverURL: srv.URL}})
	if replaced(t, controlRequest(a, http.MethodPost, "/win/w2/server-lost")) {
		t.Fatal("a window onto a server that answers was replaced")
	}

	registerStandIn(a, "w4", windowSpec{url: down, connected: true}, unreachableStandIn(down))
	registerWindow(a, &winEntry{id: "w5", role: rolePinboard, view: windowView{spec: windowSpec{url: down, connected: true}, serverURL: down}})
	for _, id := range []string{"w4", "w5"} {
		if rec := controlRequest(a, http.MethodPost, "/win/"+id+"/server-lost"); rec.Code != http.StatusConflict {
			t.Fatalf("%s: status = %d, want 409", id, rec.Code)
		}
	}
	select {
	case id := <-got:
		t.Fatalf("a stand-in was also opened for %s", id)
	default:
	}
}

// TestAWindowOnAServerByURLWhoseSessionHasGoneReopensItsProject: a window onto
// a server by URL whose session that server has since retired — as it does one
// left with no viewer, which a sleeping Mac's window becomes — is refused at
// every reconnect while the server itself answers. Its page cannot bring the
// session back, so the app returns the window to that server's page, still
// filed with the session's project, which the page reopens there (controlReopen)
// as it would at launch. A session the server still knows of, even one that is
// not running yet, is left to the page's own reconnect.
func TestAWindowOnAServerByURLWhoseSessionHasGoneReopensItsProject(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	got := lostWindows(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/p/gone-0123abcd/"), strings.HasPrefix(r.URL.Path, "/s/gone/"):
			http.Error(w, "this project has no session", http.StatusNotFound)
		case strings.HasPrefix(r.URL.Path, "/p/starting-0123abcd/"):
			http.Error(w, "session is not running (state: restarting)", http.StatusServiceUnavailable)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	spec := windowSpec{url: srv.URL, connected: true, remoteProject: "/home/me/proj"}

	for i, mount := range []string{"/p/live-0123abcd", "/p/starting-0123abcd"} {
		id := "w-known-" + string(rune('a'+i))
		e := registerWindow(a, &winEntry{id: id, role: roleMain, view: windowView{spec: spec, serverURL: srv.URL + mount}})
		if replaced(t, controlRequest(a, http.MethodPost, "/win/"+id+"/server-lost")) {
			t.Fatalf("a window whose session at %s the server still has was replaced", mount)
		}
		var url string
		a.reg(func(*regState) { url = e.view.serverURL })
		if url != srv.URL+mount {
			t.Fatalf("a window whose session at %s the server still has was moved to %s", mount, url)
		}
	}

	// A server older than project links serves its sessions at /s/<id>/.
	for i, mount := range []string{"/p/gone-0123abcd", "/s/gone"} {
		id := "w-gone-" + string(rune('a'+i))
		gone := registerWindow(a, &winEntry{id: id, role: roleMain, view: windowView{spec: spec, serverURL: srv.URL + mount}})
		if !replaced(t, controlRequest(a, http.MethodPost, "/win/"+id+"/server-lost")) {
			t.Fatalf("a window whose session at %s the server no longer has was left reconnecting to it", mount)
		}
		var url string
		var now windowSpec
		a.reg(func(*regState) { url, now = gone.view.serverURL, gone.view.spec })
		if url != srv.URL || now != spec {
			t.Fatalf("the window at %s is %+v on %s; want %+v on the server's page %s", mount, now, url, spec, srv.URL)
		}
	}
	select {
	case id := <-got:
		t.Fatalf("a stand-in was opened for %s, whose server answers", id)
	default:
	}
	a.workspace.flush(nil)
}

// TestALocalWindowWhoseSessionIsLostBecomesItsStandIn: a local window whose
// page has given up reconnecting is replaced by its stand-in only when its
// session is no longer running on the server, or the server has gone; a
// session still running leaves the page to its own reconnect.
func TestALocalWindowWhoseSessionIsLostBecomesItsStandIn(t *testing.T) {
	a := newTestAppState(t)
	got := lostWindows(t)
	srv := newStubMachineServer(t, a, core.Version)
	base := "http://" + srv.addr()
	// The session the server runs for /p now is another than the one w1 was
	// opened on: a window shows its project's session, whichever it is.
	srv.list.Store(&[]machineserver.Session{{ID: "s9", Project: "/p", Link: stubLink("/p"), State: machineserver.SessionRunning}})
	c, err := a.serverClient(true)
	if err != nil {
		t.Fatal(err)
	}
	on := procOf(c)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{project: "/p"}, serverURL: base + strings.TrimSuffix(stubLink("/p"), "/"), server: on}})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{project: "/q"}, serverURL: base + strings.TrimSuffix(stubLink("/q"), "/"), server: on}})
	registerWindow(a, &winEntry{id: "w3", role: roleMain, view: windowView{serverURL: base, server: on}})

	if replaced(t, controlRequest(a, http.MethodPost, "/win/w1/server-lost")) {
		t.Fatal("a window whose session is running was replaced")
	}
	if replaced(t, controlRequest(a, http.MethodPost, "/win/w3/server-lost")) {
		t.Fatal("a window on the server's page was replaced with the server up")
	}
	if !replaced(t, controlRequest(a, http.MethodPost, "/win/w2/server-lost")) || <-got != "w2" {
		t.Fatal("a window whose session has stopped was not replaced")
	}
	// Opened on a server process that has gone since: the session of that id
	// running on the server there now is not its own.
	registerWindow(a, &winEntry{id: "w4", role: roleMain, view: windowView{spec: windowSpec{project: "/p"}, serverURL: base + strings.TrimSuffix(stubLink("/p"), "/"), server: serverProc{addr: on.addr, pid: on.pid + 1}}})
	if !replaced(t, controlRequest(a, http.MethodPost, "/win/w4/server-lost")) || <-got != "w4" {
		t.Fatal("a window on a server process that has gone was not replaced")
	}
}

// TestAWindowWhoseUserStopsReconnectingBecomesItsStandIn: Stop trying
// (server-lost?now) replaces the window even where the app's own check finds
// the server answering — the case that leaves a page stuck reconnecting to a
// server the app can reach — and the stand-in says only what the app found.
// A board still goes with its window.
func TestAWindowWhoseUserStopsReconnectingBecomesItsStandIn(t *testing.T) {
	a := newTestAppState(t)
	type opened struct {
		id    string
		title string
	}
	got := make(chan opened, 4)
	orig := viewShown
	viewShown = func(e *winEntry, v windowView, _ string) { got <- opened{e.id, v.standIn.title.Key} }
	t.Cleanup(func() { viewShown = orig })
	expect := func(id string, title msg.Message) {
		t.Helper()
		if !replaced(t, controlRequest(a, http.MethodPost, "/win/"+id+"/server-lost?now=1")) {
			t.Fatalf("%s: Stop trying did not replace the window", id)
		}
		if o := <-got; o.id != id || o.title != title.Key {
			t.Fatalf("stand-in for %s titled %q, want %s titled %q", o.id, o.title, id, title.Key)
		}
	}

	answering := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(answering.Close)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{url: answering.URL, connected: true}, serverURL: answering.URL}})
	expect("w1", disconnectedPageTitle)
	down := addressWithNoServer(t)
	registerWindow(a, &winEntry{id: "w1b", role: roleMain, view: windowView{spec: windowSpec{url: down, connected: true}, serverURL: down}})
	expect("w1b", unreachablePageTitle)

	srv := newStubMachineServer(t, a, core.Version)
	base := "http://" + srv.addr()
	srv.list.Store(&[]machineserver.Session{{ID: "s1", Project: "/p", Link: stubLink("/p"), State: machineserver.SessionRunning}})
	c, err := a.serverClient(true)
	if err != nil {
		t.Fatal(err)
	}
	on := procOf(c)
	registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{project: "/p"}, serverURL: base + strings.TrimSuffix(stubLink("/p"), "/"), server: on}})
	expect("w2", disconnectedPageTitle)
	registerWindow(a, &winEntry{id: "w3", role: roleMain, view: windowView{spec: windowSpec{project: "/q"}, serverURL: base + strings.TrimSuffix(stubLink("/q"), "/"), server: on}})
	expect("w3", sessionLostTitle)

	registerWindow(a, &winEntry{id: "w4", role: rolePinboard, view: windowView{spec: windowSpec{url: answering.URL, connected: true}, serverURL: answering.URL}})
	if rec := controlRequest(a, http.MethodPost, "/win/w4/server-lost?now=1"); rec.Code != http.StatusConflict {
		t.Fatalf("a board: status = %d, want 409", rec.Code)
	}
}

// TestStopTryingOnAServerByURLSaysWhatTheServerSaid: Stop trying on a window
// onto a server by URL asks that server before saying anything about it. A
// server restarted under the window has forgotten its session, so the window
// returns to the server's page, which reopens the session's project there, as
// a minute of reconnecting does. A server that answers, but not for the
// session, is not called unreachable: its stand-in says the window stopped
// reconnecting, with Cancel beside Try again. Only a server that does not
// answer, or refuses this computer, is unreachable.
func TestStopTryingOnAServerByURLSaysWhatTheServerSaid(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/p/gone-0123abcd/"):
			http.Error(w, "this project has no session", http.StatusNotFound)
		case strings.HasPrefix(r.URL.Path, "/p/starting-0123abcd/"):
			http.Error(w, "session is not running (state: starting)", http.StatusServiceUnavailable)
		case strings.HasPrefix(r.URL.Path, "/p/refused-0123abcd/"):
			http.Error(w, "Forbidden: this Juggler server accepts connections from this machine only", http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	spec := windowSpec{url: srv.URL, connected: true, remoteProject: "/home/me/proj"}

	gone := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: spec, serverURL: srv.URL + "/p/gone-0123abcd"}})
	if !replaced(t, controlRequest(a, http.MethodPost, "/win/w1/server-lost?now=1")) {
		t.Fatal("Stop trying on a session its server has forgotten did not replace the window")
	}
	if v := a.viewOf(gone); v.standIn != nil || strings.Contains(v.serverURL, "gone") || v.spec != spec {
		t.Fatalf("Stop trying on a forgotten session shows %+v; want %s's page, filed with the project to reopen (%+v)", v, srv.URL, spec)
	}

	down := addressWithNoServer(t)
	for _, c := range []struct {
		id, page string
		kind     string
		title    msg.Message
	}{
		{"w2", srv.URL + "/p/starting-0123abcd", standInLost, disconnectedPageTitle},
		{"w3", srv.URL + "/p/refused-0123abcd", standInUnreachable, unreachablePageTitle},
		{"w4", down + "/p/gone-0123abcd", standInUnreachable, unreachablePageTitle},
	} {
		e := registerWindow(a, &winEntry{id: c.id, role: roleMain, view: windowView{spec: spec, serverURL: c.page}})
		if !replaced(t, controlRequest(a, http.MethodPost, "/win/"+c.id+"/server-lost?now=1")) {
			t.Fatalf("%s: Stop trying did not replace the window", c.id)
		}
		v := a.viewOf(e)
		if v.standIn == nil || v.standIn.kind != c.kind || v.standIn.title.Key != c.title.Key || v.spec != spec {
			t.Fatalf("%s: Stop trying on %s shows %+v; want the %s stand-in titled %q", c.id, c.page, v, c.kind, c.title.Key)
		}
		labels := []string{}
		for _, b := range v.standIn.buttons {
			labels = append(labels, b.label.Key)
		}
		if want := []string{unreachableRetry.Key, cancelLabel.Key}; !slices.Equal(labels, want) {
			t.Errorf("%s: buttons %q, want %q", c.id, labels, want)
		}
	}
}

// TestStandInActionsBelongToStandIns: a working window cannot be made to
// replace itself, only a version mismatch's stand-in restarts the server, and
// only the stand-in for a server run elsewhere starts one in its place.
func TestStandInActionsBelongToStandIns(t *testing.T) {
	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{project: "/p"}, serverURL: "http://127.0.0.1:1/p/p-0123abcd"}})
	registerStandIn(a, "w2", windowSpec{project: "/p"}, lostServerStandIn())
	for _, c := range []struct{ id, action string }{
		{"w1", "retry-server"}, {"w1", "open-local"}, {"w1", "restart-server"}, {"w2", "restart-server"},
		{"w1", "start-server"}, {"w2", "start-server"},
	} {
		if rec := controlRequest(a, http.MethodPost, "/win/"+c.id+"/"+c.action); rec.Code != http.StatusConflict {
			t.Errorf("%s on %s: status = %d, want 409", c.action, c.id, rec.Code)
		}
	}
}

// TestEachStandInOffersItsWayOn: what a stand-in's page offers depends on what
// went wrong, and every button posts to this window's control endpoint.
func TestEachStandInOffersItsWayOn(t *testing.T) {
	a := newTestAppState(t)
	a.ctlPort = 5000
	for _, c := range []struct {
		si   *standIn
		want []string
	}{
		{unreachableStandIn("http://devbox:8080"), []string{"retry-server", "open-local"}},
		{failedStandIn(errors.New("could not start")), []string{"retry-server", "quit"}},
		{lostServerStandIn(), []string{"retry-server"}},
		{lostSessionStandIn("/p", true), []string{"retry-server"}},
		{lostElsewhereStandIn(false), []string{"retry-server", "start-server"}},
		{lostElsewhereStandIn(true), []string{"retry-server", "start-server"}},
		{mismatchStandIn(&versionMismatchError{server: "v0.0.1"}), []string{"restart-server", "quit"}},
	} {
		registerStandIn(a, "w7", windowSpec{project: "/p"}, c.si)
		_, doc := standInPageOf(t, a, "w7")
		if n := strings.Count(doc, "<form "); n != len(c.want) {
			t.Errorf("%s page has %d buttons, want %v", c.si.kind, n, c.want)
		}
		for _, action := range c.want {
			if !strings.Contains(doc, `action="/`+controlSecretOf(a, "w7")+"/win/w7/"+action+`"`) {
				t.Errorf("%s page does not post %s to its window", c.si.kind, action)
			}
		}
	}
}

// TestAStandInHoldsThePlacesOfTheWindowsItKeeps: a launch that stopped at a
// version mismatch shows one stand-in, which keeps the rest of the windows in
// the workspace set until it is answered.
func TestAStandInHoldsThePlacesOfTheWindowsItKeeps(t *testing.T) {
	a := newTestAppState(t)
	si := mismatchStandIn(&versionMismatchError{server: "v0.0.1"})
	si.held = []windowSpec{{project: "/b"}, {url: "http://devbox:8080", connected: true}}
	registerStandIn(a, "w1", windowSpec{project: "/a"}, si)
	var specs []windowSpec
	a.reg(func(st *regState) { specs = restorableSpecs(st) })
	if len(specs) != 3 || specs[0].project != "/a" || specs[1].project != "/b" || specs[2].url != "http://devbox:8080" {
		t.Fatalf("restorable %+v, want /a, /b and the connected server", specs)
	}
}

// A stand-in's frame is kept where the window it stands in for keeps its own:
// on this machine for a server by URL, and nowhere for a local window, whose
// session is not there to keep it.
func TestAStandInsFrameIsKeptForTheWindowItStandsFor(t *testing.T) {
	a := newTestAppState(t)
	a.remoteFrames = newRemoteFramesAt(filepath.Join(t.TempDir(), "remote-frames.json"))
	frame := core.WindowState{X: 10, Y: 20, Width: 900, Height: 700, HasPos: true}

	unreachable := registerStandIn(a, "w1", windowSpec{url: "http://devbox:8080/", connected: true}, unreachableStandIn("http://devbox:8080"))
	a.storeFrame(context.Background(), unreachable, frame)
	if got, ok := a.remoteFrames.get("http://devbox:8080", roleMain); !ok || got.Width != 900 {
		t.Fatalf("frame under the remote = %+v, %v; want the stand-in's", got, ok)
	}

	var served atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		served.Store(true)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	local := registerStandIn(a, "w2", windowSpec{project: t.TempDir()}, lostServerStandIn())
	a.reg(func(*regState) { local.view.serverURL = srv.URL })
	a.storeFrame(context.Background(), local, frame)
	if served.Load() {
		t.Fatal("a local window's stand-in wrote its frame to a server")
	}
}
