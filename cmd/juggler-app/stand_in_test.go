//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/logpaths"
)

// A stand-in window, as buildStandInWindow registers one: filed under the spec
// it stands in for, its page served by a local server of its own.
func registerStandIn(a *appState, id string, spec windowSpec, si *standIn) *winEntry {
	e := &winEntry{id: id, role: roleMain, spec: spec, standIn: si, serverURL: "http://127.0.0.1:4100"}
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

func TestStandInTellsItsPageWhatItStandsFor(t *testing.T) {
	a := newTestAppState(t)
	registerStandIn(a, "w1", windowSpec{url: "http://devbox:8080", connected: true}, unreachableStandIn("http://devbox:8080"))
	registerTestWindow(a, "w2")

	rec := controlRequest(a, http.MethodPost, "/win/w1/stand-in")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got struct {
		Kind  string `json:"kind"`
		Title struct {
			Key string `json:"key"`
		} `json:"title"`
		Message []struct {
			Key    string         `json:"key"`
			Params map[string]any `json:"params"`
		} `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not JSON: %q (%v)", rec.Body.String(), err)
	}
	if got.Kind != standInUnreachable || got.Title.Key != unreachablePageTitle.Key {
		t.Fatalf("got kind %q title %q, want the unreachable-server stand-in", got.Kind, got.Title.Key)
	}
	if len(got.Message) != 1 || got.Message[0].Params["url"] != "http://devbox:8080" {
		t.Fatalf("the explanation must name the server, as a message the page translates: %s", rec.Body.String())
	}

	// An ordinary window, asked the same, is told it is not one, which is what
	// lets a reloaded page that was one fall back to the welcome panel.
	rec = controlRequest(a, http.MethodPost, "/win/w2/stand-in")
	var plain struct {
		Kind *string `json:"kind"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &plain); err != nil || plain.Kind == nil || *plain.Kind != "" {
		t.Fatalf("an ordinary window should answer kind \"\", got %q (%v)", rec.Body.String(), err)
	}
}

// Trying again on a server still down leaves the stand-in where it is, and says
// so to the page, rather than replacing it with another.
func TestRetryingAServerStillDownLeavesTheStandIn(t *testing.T) {
	a := newTestAppState(t)
	server := addressWithNoServer(t)
	e := registerStandIn(a, "w1", windowSpec{url: server, connected: true}, unreachableStandIn(server))

	rec := controlRequest(a, http.MethodPost, "/win/w1/retry-server?reply=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got struct {
		Opened *bool `json:"opened"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.Opened == nil || *got.Opened {
		t.Fatalf("want {opened:false}, got %q (%v)", rec.Body.String(), err)
	}
	if _, si := a.standInOf(e); si == nil {
		t.Fatal("the window stopped standing in for a server that is still down")
	}
}

// A lock still held may be held by something else now, so a failed retry
// brings what the stand-in says up to date.
func TestRetryingAProjectStillLockedUpdatesTheStandIn(t *testing.T) {
	project := t.TempDir()
	saved := resolveSpec
	resolveSpec = func(windowSpec) (string, *serverProc, error) {
		return "", nil, newLockedProjectError(project, &core.InstanceInfo{PID: 4242, Host: "127.0.0.1", Port: 7777})
	}
	t.Cleanup(func() { resolveSpec = saved })

	a := newTestAppState(t)
	spec := windowSpec{project: project}
	e := registerStandIn(a, "w1", spec, lockedStandIn(newLockedProjectError(project, nil)))

	rec := controlRequest(a, http.MethodPost, "/win/w1/retry-server?reply=1")
	var got struct {
		Opened *bool `json:"opened"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.Opened == nil || *got.Opened {
		t.Fatalf("want {opened:false}, got %q (%v)", rec.Body.String(), err)
	}
	_, si := a.standInOf(e)
	if si == nil || si.kind != standInLocked {
		t.Fatalf("the window should still stand in for the locked project, got %+v", si)
	}
	if len(si.message) != 2 || si.message[1].Params["pid"] != "4242" {
		t.Fatalf("the stand-in should now name the process holding the lock: %+v", si.message)
	}
}

// A window whose server could not be started opens as a stand-in that says so,
// with the reason and where the logs are, rather than not opening at all. A
// locked project is still told apart: it has advice of its own.
func TestAWindowWhoseServerFailsToStartStandsInSayingWhy(t *testing.T) {
	project := t.TempDir()
	spec := windowSpec{project: project}

	si := standInFor(spec, errors.New("server exited: could not find available port after 100 attempts"))
	if si.kind != standInFailed || si.title.Key != failedPageTitle.Key {
		t.Fatalf("got kind %q title %q, want the failed-server stand-in", si.kind, si.title.Key)
	}
	if len(si.message) != 1 {
		t.Fatalf("want one explanation, got %+v", si.message)
	}
	got := si.message[0].Params
	if got["project"] != project || !strings.Contains(fmt.Sprint(got["error"]), "could not find available port") {
		t.Fatalf("the explanation must name the project and the reason: %+v", got)
	}
	if got["dir"] != logpaths.ProjectLogDir(project) {
		t.Fatalf("logs dir = %v, want %s", got["dir"], logpaths.ProjectLogDir(project))
	}

	// An empty window has no project to name, and still says why.
	empty := standInFor(windowSpec{}, errors.New("boom"))
	if empty.kind != standInFailed || fmt.Sprint(empty.message[0].Params["error"]) != "boom" {
		t.Fatalf("empty window stand-in = %+v", empty)
	}

	locked := standInFor(spec, fmt.Errorf("resolve: %w", newLockedProjectError(project, nil)))
	if locked.kind != standInLocked {
		t.Fatalf("a locked project got kind %q, want %q", locked.kind, standInLocked)
	}
}

// A server that still fails may fail differently, so a failed retry brings what
// the stand-in says up to date.
func TestRetryingAServerThatStillFailsUpdatesTheStandIn(t *testing.T) {
	saved := resolveSpec
	resolveSpec = func(windowSpec) (string, *serverProc, error) {
		return "", nil, errors.New("the second reason")
	}
	t.Cleanup(func() { resolveSpec = saved })

	a := newTestAppState(t)
	spec := windowSpec{project: t.TempDir()}
	e := registerStandIn(a, "w1", spec, standInFor(spec, errors.New("the first reason")))

	rec := controlRequest(a, http.MethodPost, "/win/w1/retry-server?reply=1")
	var got struct {
		Opened *bool `json:"opened"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.Opened == nil || *got.Opened {
		t.Fatalf("want {opened:false}, got %q (%v)", rec.Body.String(), err)
	}
	_, si := a.standInOf(e)
	if si == nil || si.kind != standInFailed {
		t.Fatalf("the window should still stand in for the failed server, got %+v", si)
	}
	if reason := fmt.Sprint(si.message[0].Params["error"]); reason != "the second reason" {
		t.Fatalf("the stand-in still gives the old reason %q", reason)
	}
}

// A window onto a server by URL whose page has given up waiting for it is
// replaced by the stand-in it would have opened as — but only once the app has
// found the server still silent itself, and only for a window that has one.
func TestAWindowWhoseServerIsLostBecomesItsStandIn(t *testing.T) {
	type opened struct {
		spec windowSpec
		si   *standIn
		opts windowOpts
	}
	var got []opened
	saved := openLostServerStandIn
	openLostServerStandIn = func(_ *appState, spec windowSpec, si *standIn, opts windowOpts) {
		got = append(got, opened{spec, si, opts})
	}
	t.Cleanup(func() { openLostServerStandIn = saved })

	replaced := func(t *testing.T, rec *httptest.ResponseRecorder) bool {
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

	a := newTestAppState(t)

	// Still down: the stand-in opens in the window's place, filed as the same
	// server, so it stays in the workspace set and Try again reaches it.
	down := addressWithNoServer(t)
	lost := &winEntry{id: "w1", role: roleMain, spec: windowSpec{url: down, connected: true}, serverURL: down}
	a.reg(func(st *regState) { st.windows["w1"] = lost })
	if !replaced(t, controlRequest(a, http.MethodPost, "/win/w1/server-lost")) {
		t.Fatal("a window onto a server still down was not replaced")
	}
	if len(got) != 1 || got[0].spec != lost.spec || got[0].si.kind != standInUnreachable || got[0].opts.replaces != "w1" {
		t.Fatalf("opened %+v, want one unreachable stand-in for %+v in w1's place", got, lost.spec)
	}

	// Answering after all: the page's own reconnect is the one to finish the job.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	back := &winEntry{id: "w2", role: roleMain, spec: windowSpec{url: srv.URL, connected: true}, serverURL: srv.URL}
	a.reg(func(st *regState) { st.windows["w2"] = back })
	if replaced(t, controlRequest(a, http.MethodPost, "/win/w2/server-lost")) {
		t.Fatal("a window onto a server that answers was replaced")
	}

	// Nothing else has a stand-in to become: a project window's server is this
	// app's to restart, a stand-in already is one, and a detached pinboard is
	// not the window the stand-in would be.
	project := &winEntry{id: "w3", role: roleMain, spec: windowSpec{project: t.TempDir()}}
	a.reg(func(st *regState) { st.windows["w3"] = project })
	registerStandIn(a, "w4", windowSpec{url: down, connected: true}, unreachableStandIn(down))
	board := &winEntry{id: "w5", role: rolePinboard, spec: windowSpec{url: down, connected: true}, serverURL: down}
	a.reg(func(st *regState) { st.windows["w5"] = board })
	for _, id := range []string{"w3", "w4", "w5"} {
		if rec := controlRequest(a, http.MethodPost, "/win/"+id+"/server-lost"); rec.Code != http.StatusConflict {
			t.Fatalf("%s: status = %d, want 409", id, rec.Code)
		}
	}
	if len(got) != 1 {
		t.Fatalf("opened %d stand-ins, want just the one", len(got))
	}
}

// "Open a local window instead" makes the stand-in the empty window its page
// already is, where it stands: no second server, and the server it stood in for
// leaves the workspace set.
func TestOpenLocalTurnsTheStandInIntoAnEmptyWindowInPlace(t *testing.T) {
	path := workspacePath(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(path)
	e := registerStandIn(a, "w1", windowSpec{url: "http://devbox:8080", connected: true}, unreachableStandIn("http://devbox:8080"))

	if rec := controlRequest(a, http.MethodPost, "/win/w1/open-local"); rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	spec, si := a.standInOf(e)
	if si != nil || spec != (windowSpec{}) {
		t.Fatalf("got spec %+v standIn %+v, want an ordinary empty window", spec, si)
	}
	a.workspace.flush(nil) // barrier: nil entries leave the set unchanged
	if got := readWorkspaceFile(path).Windows; len(got) != 1 || got[0] != (workspaceEntry{}) {
		t.Fatalf("the workspace holds %+v, want just the empty window", got)
	}
	if rec := controlRequest(a, http.MethodPost, "/win/w1/open-local"); rec.Code != http.StatusConflict {
		t.Fatalf("a window that no longer stands in took open-local: %d", rec.Code)
	}
}

// A project opened in the stand-in's page is the window it is now. Until then
// the page's reports of no project leave it standing in for what it was.
func TestAProjectOpenedInAStandInEndsIt(t *testing.T) {
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	locked := t.TempDir()
	e := registerStandIn(a, "w1", windowSpec{project: locked}, lockedStandIn(newLockedProjectError(locked, nil)))

	a.setWindowProject(e, "")
	if spec, si := a.standInOf(e); si == nil || spec.project != locked {
		t.Fatalf("an empty report changed the stand-in: spec %+v standIn %+v", spec, si)
	}

	other := t.TempDir()
	a.setWindowProject(e, other)
	if spec, si := a.standInOf(e); si != nil || spec != (windowSpec{project: other}) {
		t.Fatalf("got spec %+v standIn %+v, want an ordinary window on %s", spec, si, other)
	}
	a.workspace.flush(nil) // barrier: lets the save finish before the directory goes
}

// windowSpecOf reports the registry entry's spec for window id, read on the
// registry goroutine because the page's project reports write it.
func (a *appState) windowSpecOf(id string) (windowSpec, bool) {
	var spec windowSpec
	var ok bool
	a.reg(func(st *regState) {
		if e := st.windows[id]; e != nil {
			spec, ok = e.spec, true
		}
	})
	return spec, ok
}

// What a stand-in's page may ask for is decided by what it is — an empty
// window on a server this app spawned — not by the server by URL it is filed
// under, whose refusals exist because that server's pages are not ours.
func TestAStandInsPageIsAnEmptyWindows(t *testing.T) {
	a := newTestAppState(t)
	registerStandIn(a, "w1", windowSpec{url: "http://devbox:8080", connected: true}, unreachableStandIn("http://devbox:8080"))

	spec, ok := a.pageSpecOf("w1")
	if !ok || spec != (windowSpec{}) {
		t.Fatalf("pageSpecOf = %+v, %v; want the empty window", spec, ok)
	}
	if spec, _ := a.windowSpecOf("w1"); !spec.isURL() {
		t.Fatalf("the workspace identity must stay the server by URL, got %+v", spec)
	}

	q := query(t, windowOpts{standIn: unreachableStandIn("http://devbox:8080")})
	if q.Get("standIn") != standInUnreachable {
		t.Fatalf("standIn = %q, want %q", q.Get("standIn"), standInUnreachable)
	}
}

// A stand-in's frame is kept where the window it stands in for keeps its own,
// so that window comes back where the stand-in was — never in the session of
// the server the stand-in's page comes from.
func TestAStandInsFrameIsKeptForTheWindowItStandsFor(t *testing.T) {
	a := newTestAppState(t)
	a.remoteFrames = newRemoteFramesAt(filepath.Join(t.TempDir(), "remote-frames.json"))
	frame := core.WindowState{X: 10, Y: 20, Width: 900, Height: 700, HasPos: true}

	// Its own server is dead, so a write that went there would be lost — and
	// would show here as nothing kept under the remote.
	unreachable := registerStandIn(a, "w1", windowSpec{url: "http://devbox:8080/", connected: true}, unreachableStandIn("http://devbox:8080"))
	unreachable.serverURL = addressWithNoServer(t)
	a.storeFrame(context.Background(), unreachable, frame)
	if got, ok := a.remoteFrames.get("http://devbox:8080", roleMain); !ok || got.Width != 900 {
		t.Fatalf("frame under the remote = %+v, %v; want the stand-in's", got, ok)
	}
	if _, ok := a.remoteFrames.get(unreachable.serverURL, roleMain); ok {
		t.Fatal("the frame was filed under the stand-in's own server")
	}

	locked := t.TempDir()
	lockedWin := registerStandIn(a, "w2", windowSpec{project: locked}, lockedStandIn(newLockedProjectError(locked, nil)))
	var served atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		served.Store(true)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	lockedWin.serverURL = srv.URL
	a.storeFrame(context.Background(), lockedWin, frame)
	if served.Load() {
		t.Fatal("a locked project's stand-in wrote its frame into its own server's session")
	}
}
