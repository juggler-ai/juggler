//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
	"juggler/internal/userpaths/userpathstest"
)

// A local window belongs to this machine's server, as a window on a server by
// URL belongs to that server: it shows the server's page or one of its
// sessions, and moves between them in place. One project has one window: a
// pick of a project another window shows raises that window.

// raise is one window raiseWindow was asked to raise, and the conversation it
// was to open there.
type raise struct {
	id, conversation string
}

// recordRaises stands in for raiseWindow, which needs a native window, and
// returns what it was asked.
func recordRaises(t *testing.T) *[]raise {
	t.Helper()
	var got []raise
	orig := raiseWindow
	raiseWindow = func(e *winEntry, conversation string) { got = append(got, raise{e.id, conversation}) }
	t.Cleanup(func() { raiseWindow = orig })
	return &got
}

// switchingServer is a stub of this machine's server running alpha's and
// beta's sessions, attached to, and its base URL.
func switchingServer(t *testing.T) (*appState, string) {
	t.Helper()
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	t.Cleanup(func() { a.workspace.flush(nil) })
	srv := newStubMachineServer(t, a, core.Version)
	srv.list.Store(&[]machineserver.Session{
		{ID: "s7", Project: "/work/alpha", Link: "/p/alpha-0123abcd/", State: machineserver.SessionRunning},
		{ID: "s8", Project: "/work/beta", Link: "/p/beta-0123abcd/", State: machineserver.SessionRunning},
	})
	if _, err := a.serverClient(true); err != nil {
		t.Fatal(err)
	}
	return a, "http://" + srv.addr()
}

func postAttach(a *appState, e *winEntry, query string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	a.controlAttach(rec, httptest.NewRequest(http.MethodPost, "/win/"+e.id+"/attach?"+query, nil), e)
	return rec
}

// wasRaised is whether rec says the app raised another window rather than
// moving the asking one.
func wasRaised(t *testing.T, rec *httptest.ResponseRecorder) bool {
	t.Helper()
	if rec.Code != http.StatusOK {
		return false
	}
	var body struct {
		Raised bool `json:"raised"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("answer %q: %v", rec.Body.String(), err)
	}
	return body.Raised
}

// TestAProjectWindowAttachesAnotherSessionInPlace: picking another project's
// session from a project window's Home moves that window to the session, as
// it would an empty window, and files it as that project's window.
func TestAProjectWindowAttachesAnotherSessionInPlace(t *testing.T) {
	a, base := switchingServer(t)
	raised := recordRaises(t)
	beta := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{project: "/work/beta"}, serverURL: base + "/p/beta-0123abcd"}})

	if rec := postAttach(a, beta, "session=s7"); rec.Code != http.StatusNoContent {
		t.Fatalf("attach from a project window: %d %s, want 204", rec.Code, rec.Body)
	}
	var spec windowSpec
	var url string
	a.reg(func(*regState) { spec, url = beta.view.spec, beta.view.serverURL })
	if spec != (windowSpec{project: "/work/alpha"}) || url != base+"/p/alpha-0123abcd" {
		t.Fatalf("after attach the window is %+v on %s; want /work/alpha at its link on %s", spec, url, base)
	}
	if len(*raised) != 0 {
		t.Errorf("raised %+v; no other window shows alpha", *raised)
	}
}

// TestAnAttachToAProjectOpenElsewhereRaisesItsWindow: one project, one
// window. A pick of a project another window shows raises that window, at the
// conversation picked, and leaves the asking window where it was; the answer
// says so, so its page knows it was not replaced. A pick of the window's own
// project moves nothing.
func TestAnAttachToAProjectOpenElsewhereRaisesItsWindow(t *testing.T) {
	a, base := switchingServer(t)
	raised := recordRaises(t)
	beta := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{project: "/work/beta"}, serverURL: base + "/p/beta-0123abcd"}})
	alpha := registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{project: "/work/alpha"}, serverURL: base + "/p/alpha-0123abcd"}})
	before := a.viewOf(beta).secret

	rec := postAttach(a, beta, "session=s7&conversation=conv_abc123")
	if !wasRaised(t, rec) {
		t.Fatalf("attach to a project open elsewhere: %d %s, want 200 {\"raised\":true}", rec.Code, rec.Body)
	}
	if want := []raise{{alpha.id, "conv_abc123"}}; len(*raised) != 1 || (*raised)[0] != want[0] {
		t.Fatalf("raised %+v, want %+v", *raised, want)
	}
	if v := a.viewOf(beta); v.spec != (windowSpec{project: "/work/beta"}) || v.secret != before {
		t.Fatalf("the asking window moved to %+v; want it left on beta", v.spec)
	}

	*raised = nil
	before = a.viewOf(alpha).secret
	if rec := postAttach(a, alpha, "session=s7"); rec.Code != http.StatusNoContent {
		t.Fatalf("attach to the window's own project: %d, want 204", rec.Code)
	}
	if v := a.viewOf(alpha); len(*raised) != 0 || v.secret != before {
		t.Errorf("a pick of the window's own project raised %+v and reloaded=%v; want neither", *raised, v.secret != before)
	}
}

// TestOnlyAMainWindowOnThisServerAttaches: a board is a view of a conversation,
// with nowhere to put another session; a stand-in's page opens nothing; and a
// project window whose page another process of the server served is on no
// server the app is attached to.
func TestOnlyAMainWindowOnThisServerAttaches(t *testing.T) {
	a, base := switchingServer(t)
	recordRaises(t)
	board := registerWindow(a, &winEntry{id: "b1", role: rolePinboardFor("b"), board: "b", view: windowView{spec: windowSpec{project: "/work/beta"}, serverURL: base + "/p/beta-0123abcd"}})
	standing := registerWindow(a, &winEntry{id: "w5", role: roleMain, view: windowView{spec: windowSpec{project: "/work/beta"}, standIn: &standIn{kind: standInFailed}}})
	elsewhere := registerWindow(a, &winEntry{id: "w6", role: roleMain, view: windowView{spec: windowSpec{project: "/work/gamma"}, serverURL: "http://127.0.0.1:1/p/gamma-0123abcd"}})

	for _, e := range []*winEntry{board, standing, elsewhere} {
		if rec := postAttach(a, e, "session=s7"); rec.Code != http.StatusConflict {
			t.Errorf("attach from %s: %d, want 409", e.id, rec.Code)
		}
	}
}

// TestANewWindowForAnOpenProjectRaisesIt: a new window asked for a project
// another window shows (⌘-click in Home) raises that window, at the
// conversation named, rather than opening a second window onto one session.
func TestANewWindowForAnOpenProjectRaisesIt(t *testing.T) {
	var opened []windowSpec
	saved := openNewWindow
	openNewWindow = func(_ *appState, spec windowSpec, _ windowOpts) { opened = append(opened, spec) }
	t.Cleanup(func() { openNewWindow = saved })
	raised := recordRaises(t)

	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{project: "/work/beta"}, serverURL: "http://127.0.0.1:3939/p/beta-0123abcd"}})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{project: "/work/alpha"}, serverURL: "http://127.0.0.1:3939/p/alpha-0123abcd"}})

	rec := controlRequest(a, http.MethodPost, "/win/w1/new?project=%2Fwork%2Falpha&conversation=conv_abc123")
	if !wasRaised(t, rec) {
		t.Fatalf("new window for an open project: %d %s, want 200 {\"raised\":true}", rec.Code, rec.Body)
	}
	if len(opened) != 0 {
		t.Fatalf("opened %+v; want alpha's window raised instead", opened)
	}
	if len(*raised) != 1 || (*raised)[0] != (raise{"w2", "conv_abc123"}) {
		t.Fatalf("raised %+v, want w2 at conv_abc123", *raised)
	}
}

// TestServerPageMovesALocalProjectWindowToItsServersPage: Home's Show server
// page in a project window shows this machine's server's page in that window,
// which is filed as an empty window from then on — the way to another server
// in one window.
func TestServerPageMovesALocalProjectWindowToItsServersPage(t *testing.T) {
	a, base := switchingServer(t)
	beta := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{project: "/work/beta"}, serverURL: base + "/p/beta-0123abcd"}})

	rec := httptest.NewRecorder()
	a.controlServerPage(rec, httptest.NewRequest(http.MethodPost, "/win/w1/server-page", nil), beta)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("server-page from a local project window: %d, want 204", rec.Code)
	}
	if v := a.viewOf(beta); v.spec != (windowSpec{}) || v.serverURL != base {
		t.Fatalf("after server-page the window is %+v on %s; want the empty window on %s", v.spec, v.serverURL, base)
	}
}
