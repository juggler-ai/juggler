//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// A window on a server by URL shows that server's sessions page framed in this
// machine's server's own, whose header chooses the server, when that server
// can be framed (embedVersion in its GET /api/version). The outer page is this
// machine's, holding the window's secret; the framed page is the other
// server's, holding a secret of its own that reaches no further than a remote
// window's does.

// serverByURL starts a server by URL that answers what the app asks of one:
// GET /api/version — with embedVersion when embeds, as a server whose sessions
// page can be framed does — and anything else as also says, else 204, which is
// the server answering.
func serverByURL(t *testing.T, embeds bool, also http.HandlerFunc) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/version" {
			v := map[string]any{"version": "v1.0.0", "protocolVersion": 1}
			if embeds {
				v["embedVersion"] = 1
			}
			writeJSON(w, http.StatusOK, v)
			return
		}
		if also != nil {
			also(w, r)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// localServer starts this machine's server for a and attaches to it, returning
// its root and the process windows on it are served by.
func localServer(t *testing.T, a *appState) (string, serverProc) {
	t.Helper()
	srv := newStubMachineServer(t, a, core.Version)
	c, err := a.serverClient(true)
	if err != nil {
		t.Fatal(err)
	}
	return "http://" + srv.addr(), procOf(c)
}

// frameSecretOf is the secret window id's framed page holds.
func frameSecretOf(a *appState, id string) string {
	secret := "no-frame-holds-this"
	a.reg(func(st *regState) {
		if e := st.windows[id]; e != nil && e.view.frameSecret != "" {
			secret = e.view.frameSecret
		}
	})
	return secret
}

// registerFramed adds a main window showing server's sessions page framed in
// this machine's server's page at local, with both of its secrets.
func registerFramed(a *appState, id, server, local string, on serverProc) *winEntry {
	e := withSecret(&winEntry{id: id, role: roleMain, view: windowView{spec: windowSpec{url: server, connected: true}, serverURL: local, server: on, framed: server}})
	e.view.frameSecret = mintControlSecret()
	a.reg(func(st *regState) { st.windows[id] = e })
	return e
}

// controlAsFrame posts action to window id's control path holding the secret
// its framed page holds.
func controlAsFrame(a *appState, id, action string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	a.handleControl(rec, httptest.NewRequest(http.MethodPost, "/"+frameSecretOf(a, id)+"/win/"+id+"/"+action, nil))
	return rec
}

// TestAFramedSessionsPageIsThisMachinesPage: the page a framed window loads is
// this machine's server's root, not marked external, told which server to
// frame and the control base the framed page is to hold — a secret of its own.
// The window's own secret is in its ?nativeCtl= and nowhere else, so nothing
// the framed server receives carries it. Each load mints both again.
func TestAFramedSessionsPageIsThisMachinesPage(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.ctlPort = 5000
	const local, server = "http://127.0.0.1:3939", "http://devbox:3939"
	e := registerFramed(a, "w1", server, local, serverProc{})
	before := a.viewOf(e)

	page := a.showView(e, showing(before), windowView{spec: before.spec, serverURL: local, framed: server}, windowOpts{theme: "dark"})
	v := a.viewOf(e)

	u, err := url.Parse(page)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Scheme+"://"+u.Host != local || u.Path != "/" {
		t.Errorf("a framed window loads %s; want this machine's server's root, %s/", page, local)
	}
	if v.frameSecret == "" || v.frameSecret == v.secret {
		t.Fatalf("the framed page's secret is %q beside the window's %q; want one of its own", v.frameSecret, v.secret)
	}
	if v.secret == before.secret || v.frameSecret == before.frameSecret {
		t.Error("a page load kept a secret the page before it held")
	}
	if got := q.Get("nativeCtl"); got != a.controlBase("w1", v.secret) {
		t.Errorf("nativeCtl = %q, want the window's own control base", got)
	}
	if got := q.Get("server"); got != server {
		t.Errorf("server = %q, want %q", got, server)
	}
	if got := q.Get("frameCtl"); got != a.controlBase("w1", v.frameSecret) {
		t.Errorf("frameCtl = %q, want the framed page's control base", got)
	}
	if q.Has("external") {
		t.Errorf("a framed window's page is this machine's, but is marked external: %s", page)
	}
	if n := strings.Count(page, v.secret); n != 1 {
		t.Errorf("the window's secret appears %d times in %s; want once, in nativeCtl", n, page)
	}
	if rec := controlAsFrame(a, "w1", "drafts-flushed?token=x"); rec.Code != http.StatusNoContent {
		t.Errorf("the framed page's secret = %d, want 204", rec.Code)
	}
	rec := httptest.NewRecorder()
	a.handleControl(rec, httptest.NewRequest(http.MethodPost, "/"+before.frameSecret+"/win/w1/drafts-flushed?token=x", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("the replaced framed page's secret = %d, want 404", rec.Code)
	}
}

// TestAWindowOnAServerByURLIsFramedWhenTheServerEmbeds: a main window onto a
// server by URL is planned as the framed view, on this machine's server, when
// that server can be framed; as that server's own page, as ever, when it
// cannot or this machine's server cannot be had; and as the unreachable
// stand-in when it does not answer. A board onto it is never framed.
func TestAWindowOnAServerByURLIsFramedWhenTheServerEmbeds(t *testing.T) {
	a := newTestAppState(t)
	embeds := serverByURL(t, true, nil)
	old := serverByURL(t, false, nil)
	down := addressWithNoServer(t)

	// With no server on this machine to put the frame in.
	if p := a.planWindow(windowSpec{url: embeds, connected: true}, windowOpts{}); p.view.framed != "" || p.view.serverURL != embeds {
		t.Fatalf("with no local server, a window onto a server that embeds is planned as %+v; want its own page", p.view)
	}

	local, on := localServer(t, a)
	spec := windowSpec{url: embeds, connected: true, remoteProject: "/home/me/proj"}
	p := a.planWindow(spec, windowOpts{})
	if p.view.standIn != nil || p.view.framed != embeds || p.view.serverURL != local || p.view.server != on || p.view.spec != spec {
		t.Fatalf("a window onto a server that embeds is planned as %+v; want framed %s on %s (%+v), filed as %+v", p.view, embeds, local, on, spec)
	}
	if p := a.planWindow(windowSpec{url: old, connected: true}, windowOpts{}); p.view.standIn != nil || p.view.framed != "" || p.view.serverURL != old {
		t.Fatalf("a window onto a server that cannot be framed is planned as %+v; want its own page at %s", p.view, old)
	}
	if p := a.planWindow(windowSpec{url: down, connected: true}, windowOpts{}); p.view.standIn == nil || p.view.standIn.kind != standInUnreachable {
		t.Fatalf("a window onto a server that does not answer is planned as %+v; want the unreachable stand-in", p.view)
	}
	if p := a.planWindow(windowSpec{url: embeds, connected: true}, windowOpts{view: viewPinboard, board: "b1"}); p.view.framed != "" || p.view.serverURL != embeds {
		t.Fatalf("a board onto a server that embeds is planned as %+v; want the server's own page", p.view)
	}
}

// TestAFramedWindowsTwoSecretsReachWhatTheirPagesMay: the outer page is this
// machine's server's sessions page, and its secret reaches what any of that
// server's pages may; the framed page is the other server's, and its secret
// is refused all a remote window is. Either may attach, which shows the
// session on the framed server; the framed page learns only the name a file
// was saved under.
func TestAFramedWindowsTwoSecretsReachWhatTheirPagesMay(t *testing.T) {
	userpathstest.Isolate(t)
	dir := t.TempDir()
	saved := promptSaveFile
	promptSaveFile = func(*appState, *winEntry, string) (string, error) { return filepath.Join(dir, "chosen.html"), nil }
	t.Cleanup(func() { promptSaveFile = saved })

	a := newTestAppState(t)
	a.finder = &lanFinder{
		browse:     func() (serverSource, error) { return &fakeSource{}, nil },
		probe:      func(context.Context, string) (string, bool) { return "", false },
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	registerFramed(a, "w1", "http://devbox:3939", "http://127.0.0.1:1", serverProc{})

	for action, want := range map[string]int{
		"discover":         http.StatusOK,
		"locale?locale=en": http.StatusNoContent,
		"updater?op=state": http.StatusOK,
		"zoom?zoom=0":      http.StatusNoContent,
		"attach?session=":  http.StatusBadRequest, // reached attachRemote, which wants an id
	} {
		if rec := controlAs(a, "w1", "w1", action); rec.Code != want {
			t.Errorf("the outer page's %s = %d, want %d", action, rec.Code, want)
		}
	}
	rec := controlAs(a, "w1", "w1", "updater?op=state")
	var state struct {
		AppManagedServer bool `json:"appManagedServer"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &state); err != nil || !state.AppManagedServer {
		t.Errorf("the outer page's updater state %s (%v); want it on this machine's server", rec.Body, err)
	}

	for _, action := range []string{
		"discover",
		"switch-server?url=http%3A%2F%2Felsewhere%3A1",
		"locale?locale=en",
		"updater?op=state",
		"zoom?zoom=0",
		"folder-dropped?path=%2Fno%2Fsuch%2Fplace",
		"pick-file",
		"pick-directory",
		"open-local",
	} {
		if rec := controlAsFrame(a, "w1", action); rec.Code != http.StatusForbidden {
			t.Errorf("the framed page's %s = %d, want 403", action, rec.Code)
		}
	}
	for action, want := range map[string]int{
		"attach?session=": http.StatusBadRequest,
		"reopen":          http.StatusOK,
		"theme?theme=x":   http.StatusBadRequest,
	} {
		if rec := controlAsFrame(a, "w1", action); rec.Code != want {
			t.Errorf("the framed page's %s = %d, want %d", action, rec.Code, want)
		}
	}

	saveAs := func(secret string) string {
		rec := httptest.NewRecorder()
		a.handleControl(rec, httptest.NewRequest(http.MethodPost, "/"+secret+"/win/w1/save-file?name=a.html", strings.NewReader("hi")))
		var body struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return body.Path
	}
	if got := saveAs(frameSecretOf(a, "w1")); got != "a.html" {
		t.Errorf("the framed page's save is answered %q; want only the name it suggested", got)
	}
	if got := saveAs(controlSecretOf(a, "w1")); got != filepath.Join(dir, "chosen.html") {
		t.Errorf("the outer page's save is answered %q; want the path", got)
	}
}

// TestSwitchServerMovesTheWindowItself: the outer page's server chooser moves
// its own window, in place, between this machine's server's sessions page and
// another server's, and the workspace keeps what it moved to. It is asked only
// of a main window showing a sessions page, and only by that page: never a
// session's, a board's or a stand-in's, nor a page another server sent.
func TestSwitchServerMovesTheWindowItself(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	path := workspacePath(t)
	a.workspace = newWorkspaceStoreAt(path)
	shown := viewsShown(t)
	local, on := localServer(t, a)
	embeds := serverByURL(t, true, nil)
	e := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{serverURL: local, server: on}})

	if rec := controlRequest(a, http.MethodPost, "/win/w1/switch-server?url="+url.QueryEscape(embeds)); rec.Code != http.StatusNoContent {
		t.Fatalf("switch-server to %s = %d %s, want 204", embeds, rec.Code, rec.Body)
	}
	s := <-shown
	want := windowSpec{url: embeds, connected: true}
	if s.id != "w1" || s.view.spec != want || s.view.framed != embeds || s.view.serverURL != local {
		t.Fatalf("switch-server showed %+v in %s; want %+v framed in w1 on %s", s.view, s.id, want, local)
	}
	var n int
	var same bool
	a.reg(func(st *regState) { n, same = len(st.windows), st.windows["w1"] == e })
	if n != 1 || !same {
		t.Fatalf("switch-server left %d windows, w1 the same one %v; want the one window, moved", n, same)
	}
	a.persistWorkspaceSync()
	if got := readWorkspaceFile(path).Windows; len(got) != 1 || got[0] != (workspaceEntry{Server: embeds}) {
		t.Fatalf("the workspace records %+v, want the server switched to", got)
	}

	if rec := controlRequest(a, http.MethodPost, "/win/w1/switch-server?url="); rec.Code != http.StatusNoContent {
		t.Fatalf("switch-server to this computer = %d %s, want 204", rec.Code, rec.Body)
	}
	if s := <-shown; s.id != "w1" || s.view.spec != (windowSpec{}) || s.view.framed != "" || s.view.serverURL != local {
		t.Fatalf("switch-server to this computer showed %+v in %s; want this machine's sessions page in w1", s.view, s.id)
	}

	rec := controlRequest(a, http.MethodPost, "/win/w1/switch-server?url=file%3A%2F%2F%2Fetc")
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); rec.Code != http.StatusBadRequest || err != nil || body.Error != connectBadAddress.English() {
		t.Errorf("switch-server to a file URL = %d %s; want 400 saying what is wrong with the address", rec.Code, rec.Body)
	}

	registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{project: "/p"}, serverURL: local + "/p/p-0123abcd", server: on}})
	registerWindow(a, &winEntry{id: "w3", role: rolePinboardFor("b"), board: "b", view: windowView{serverURL: local, server: on}})
	registerStandIn(a, "w4", windowSpec{}, lostServerStandIn())
	registerWindow(a, &winEntry{id: "w5", role: roleMain, view: windowView{spec: want, serverURL: embeds}})
	registerFramed(a, "w6", embeds, local, on)
	for id, code := range map[string]int{"w2": http.StatusConflict, "w3": http.StatusConflict, "w4": http.StatusConflict, "w5": http.StatusForbidden} {
		if rec := controlRequest(a, http.MethodPost, "/win/"+id+"/switch-server?url="); rec.Code != code {
			t.Errorf("switch-server from %s = %d, want %d", id, rec.Code, code)
		}
	}
	if rec := controlAsFrame(a, "w6", "switch-server?url="); rec.Code != http.StatusForbidden {
		t.Errorf("switch-server from a framed page = %d, want 403", rec.Code)
	}
	select {
	case s := <-shown:
		t.Fatalf("a refused switch-server showed %+v in %s", s.view, s.id)
	default:
	}
}

// TestAWindowOnAServerByURLReturnsToItsFramedSessionsPage: Session ▸ Open…,
// and a session its server has since forgotten, take a window on a server by
// URL back to that server's sessions page — framed, when it can be.
func TestAWindowOnAServerByURLReturnsToItsFramedSessionsPage(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	local, _ := localServer(t, a)
	server := serverByURL(t, true, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/p/gone-0123abcd/") {
			http.Error(w, "this project has no session", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	spec := windowSpec{url: server, connected: true, remoteProject: "/home/me/proj"}

	gone := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: spec, serverURL: server + "/p/gone-0123abcd"}})
	if !replaced(t, controlRequest(a, http.MethodPost, "/win/w1/server-lost")) {
		t.Fatal("a window whose session its server no longer has was left reconnecting to it")
	}
	if v := a.viewOf(gone); v.framed != server || v.serverURL != local || v.spec != spec {
		t.Fatalf("a window whose session has gone shows %+v; want %s's sessions page framed on %s, filed as %+v", v, server, local, spec)
	}

	open := registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: spec, serverURL: server + "/p/live-0123abcd"}})
	if rec := controlRequest(a, http.MethodPost, "/win/w2/server-page"); rec.Code != http.StatusNoContent {
		t.Fatalf("server-page = %d, want 204", rec.Code)
	}
	if v := a.viewOf(open); v.framed != server || v.serverURL != local || v.spec != (windowSpec{url: server, connected: true}) {
		t.Fatalf("server-page shows %+v; want %s's sessions page framed on %s", v, server, local)
	}
}

// TestAFramedWindowsServerLostIsAskedOfTheServerItsPageIsOn: a framed window
// has two pages and two servers. The outer page giving up is this machine's
// server lost, and a stand-in for that; the framed page giving up is the other
// server's, and the unreachable stand-in for it. Either is filed under the
// server the window is on, so its Try again frames that server again.
func TestAFramedWindowsServerLostIsAskedOfTheServerItsPageIsOn(t *testing.T) {
	a := newTestAppState(t)
	shown := viewsShown(t)
	local, on := localServer(t, a)
	server := serverByURL(t, true, nil)
	want := windowSpec{url: server, connected: true}

	registerFramed(a, "w1", server, local, on)
	if replaced(t, controlAsFrame(a, "w1", "server-lost")) {
		t.Fatal("a framed page whose server answers was replaced")
	}
	if !replaced(t, controlAsFrame(a, "w1", "server-lost?now=1")) {
		t.Fatal("the framed page's Stop trying did not replace the window")
	}
	if s := <-shown; s.view.standIn == nil || s.view.standIn.kind != standInUnreachable || s.view.spec != want {
		t.Fatalf("the framed page's Stop trying showed %+v; want the unreachable stand-in for %+v", s.view, want)
	}

	registerFramed(a, "w2", server, local, on)
	if replaced(t, controlAs(a, "w2", "w2", "server-lost")) {
		t.Fatal("an outer page whose server is up was replaced")
	}
	if !replaced(t, controlAs(a, "w2", "w2", "server-lost?now=1")) {
		t.Fatal("the outer page's Stop trying did not replace the window")
	}
	if s := <-shown; s.view.standIn == nil || s.view.standIn.title.Key != disconnectedPageTitle.Key || s.view.spec != want {
		t.Fatalf("the outer page's Stop trying showed %+v; want this machine's server's stand-in, filed as %+v", s.view, want)
	}
}

// TestALostLocalServerTakesItsFramedWindows: a framed window's page is served
// by this machine's server, so when that server goes, the window shows its
// stand-in with the rest of that server's windows, still filed under the
// server it frames. A window showing that server's own page is not touched.
func TestALostLocalServerTakesItsFramedWindows(t *testing.T) {
	a := newTestAppState(t)
	shown := viewsShown(t)
	on := serverProc{addr: "127.0.0.1:3939", pid: 101}
	const server = "http://devbox:3939"
	registerFramed(a, "w1", server, "http://127.0.0.1:3939", on)
	registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{url: server, connected: true}, serverURL: server}})

	// serverLost shows each stand-in before it returns.
	a.serverLost(on)
	select {
	case s := <-shown:
		if s.id != "w1" || s.view.standIn == nil || s.view.standIn.kind != standInLost || s.view.spec != (windowSpec{url: server, connected: true}) {
			t.Fatalf("the server going showed %+v in %s; want w1's lost stand-in, filed under %s", s.view, s.id, server)
		}
	default:
		t.Fatal("the server going left its framed window showing its page")
	}
	select {
	case s := <-shown:
		t.Fatalf("a stand-in was also shown in %s", s.id)
	default:
	}
}
