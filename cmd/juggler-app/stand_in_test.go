//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
)

// A stand-in window, as buildStandInWindow registers one: filed under the spec
// it stands in for, with a static page and no server.
func registerStandIn(a *appState, id string, spec windowSpec, si *standIn) *winEntry {
	e := withSecret(&winEntry{id: id, role: roleMain, spec: spec, standIn: si})
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

// TestAWindowOnAServerByURLThatIsLostBecomesItsStandIn: a window onto a server
// by URL whose page has given up reconnecting is replaced by the stand-in it
// would have opened as — but only once the app has found the server still
// silent itself. A stand-in already is one, and a board goes with its window.
func TestAWindowOnAServerByURLThatIsLostBecomesItsStandIn(t *testing.T) {
	a := newTestAppState(t)
	got := lostWindows(t)

	down := addressWithNoServer(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{url: down, connected: true}, serverURL: down})
	if !replaced(t, controlRequest(a, http.MethodPost, "/win/w1/server-lost")) || <-got != "w1" {
		t.Fatal("a window onto a server still down was not replaced")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{url: srv.URL, connected: true}, serverURL: srv.URL})
	if replaced(t, controlRequest(a, http.MethodPost, "/win/w2/server-lost")) {
		t.Fatal("a window onto a server that answers was replaced")
	}

	registerStandIn(a, "w4", windowSpec{url: down, connected: true}, unreachableStandIn(down))
	registerWindow(a, &winEntry{id: "w5", role: rolePinboard, spec: windowSpec{url: down, connected: true}, serverURL: down})
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

// TestALocalWindowWhoseSessionIsLostBecomesItsStandIn: a local window whose
// page has given up reconnecting is replaced by its stand-in only when its
// session is no longer running on the server, or the server has gone; a
// session still running leaves the page to its own reconnect.
func TestALocalWindowWhoseSessionIsLostBecomesItsStandIn(t *testing.T) {
	a := newTestAppState(t)
	got := lostWindows(t)
	srv := newStubMachineServer(t, a, core.Version)
	base := "http://" + srv.addr()
	srv.list.Store(&[]machineserver.Session{{ID: "s1", Project: "/p", State: machineserver.SessionRunning}})
	c, err := a.serverClient()
	if err != nil {
		t.Fatal(err)
	}
	on := procOf(c)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: base + "/s/s1", server: on})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{project: "/q"}, serverURL: base + "/s/s2", server: on})
	registerWindow(a, &winEntry{id: "w3", role: roleMain, serverURL: base, server: on})

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
	registerWindow(a, &winEntry{id: "w4", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: base + "/s/s1", server: serverProc{addr: on.addr, pid: on.pid + 1}})
	if !replaced(t, controlRequest(a, http.MethodPost, "/win/w4/server-lost")) || <-got != "w4" {
		t.Fatal("a window on a server process that has gone was not replaced")
	}
}

// TestStandInActionsBelongToStandIns: a working window cannot be made to
// replace itself, and only a version mismatch's stand-in restarts the server.
func TestStandInActionsBelongToStandIns(t *testing.T) {
	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: "http://127.0.0.1:1/s/s1"})
	registerStandIn(a, "w2", windowSpec{project: "/p"}, lostServerStandIn())
	for _, c := range []struct{ id, action string }{
		{"w1", "retry-server"}, {"w1", "open-local"}, {"w1", "restart-server"}, {"w2", "restart-server"},
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
		{lostSessionStandIn("/p"), []string{"retry-server"}},
		{mismatchStandIn(&versionMismatchError{server: "v0.0.1"}), []string{"restart-server", "quit"}},
	} {
		page := a.standInPageFor(c.si, "w7", "secret")
		raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(page, "data:text/html;charset=utf-8;base64,"))
		if err != nil {
			t.Fatal(err)
		}
		doc := string(raw)
		if n := strings.Count(doc, "<form "); n != len(c.want) {
			t.Errorf("%s page has %d buttons, want %v", c.si.kind, n, c.want)
		}
		for _, action := range c.want {
			if !strings.Contains(doc, `action="`+a.controlBase("w7", "secret")+"/"+action+`"`) {
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
	a.reg(func(*regState) { local.serverURL = srv.URL })
	a.storeFrame(context.Background(), local, frame)
	if served.Load() {
		t.Fatal("a local window's stand-in wrote its frame to a server")
	}
}
