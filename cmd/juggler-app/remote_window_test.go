//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// A window on a server by URL — another machine's, connected to from Session ▸
// Connect to Server — shows that server's sessions page, and opening a session
// there shows it in the same window, as a viewer. The window stays the
// server's, and the page it loads stays marked as being on a server this app
// did not start. It also remembers the project of the session it shows, so a
// next launch can open that project's session there again.

// TestAttachInAWindowOnAServerByURLShowsTheSessionThere: a window on a server
// by URL shows the session its page chose there. The page opened the session
// through its own server's control API; the app only moves the window to the
// session's link on that same server. A link that is not one — another path,
// another host — is refused, so the page cannot send the window anywhere
// else. A server's page that names no link, as one older than project links
// does, has its session shown at /s/<id>/, the address that server serves it
// at, and an id that is not one is refused just the same. The project the
// page names is what the workspace records, beside the server, since it
// outlives the session.
func TestAttachInAWindowOnAServerByURLShowsTheSessionThere(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	path := workspacePath(t)
	a.workspace = newWorkspaceStoreAt(path)
	const server = "http://devbox:3939"
	remote := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{url: server, connected: true}, serverURL: server}})

	post := func(query string) int {
		rec := httptest.NewRecorder()
		a.controlAttach(rec, httptest.NewRequest(http.MethodPost, "/win/w1/attach?project=%2Fhome%2Fme%2Fproj&"+query, nil), remote)
		return rec.Code
	}
	shown := func() string {
		var url string
		a.reg(func(*regState) { url = remote.view.serverURL })
		return url
	}
	for _, bad := range []string{
		"session=abc123&link=%2Fp%2F..%2F..%2Fevil%2F",
		"session=abc123&link=%2Fp%2Fa%2Fb%2F",
		"session=abc123&link=http%3A%2F%2Fevil%2Fp%2Fproj-0123abcd%2F",
		"session=abc123&link=%2F%2Fevil%2Fp%2Fproj-0123abcd%2F",
		"session=abc123&link=%2Fs%2Fabc123%2F",
		"session=abc123&link=%2Fp%2FProj-0123abcd%2F",
		"session=abc123&link=%2Fp%2F%2F",
		"session=&link=",
		"session=..%2F..%2Fevil",
		"session=a%2Fb",
	} {
		if code := post(bad); code != http.StatusBadRequest {
			t.Errorf("attach with %s: %d, want 400", bad, code)
		}
	}
	if url := shown(); url != server {
		t.Fatalf("a refused attach moved the window to %s", url)
	}

	if code := post("session=abc123&link=%2Fp%2Fproj-0123abcd%2F"); code != http.StatusNoContent {
		t.Fatalf("attach: %d, want 204", code)
	}
	var spec windowSpec
	a.reg(func(*regState) { spec = remote.view.spec })
	want := windowSpec{url: server, connected: true, remoteProject: "/home/me/proj"}
	if url := shown(); spec != want || url != server+"/p/proj-0123abcd" {
		t.Fatalf("after attach the window is %+v on %s; want %+v, on %s/p/proj-0123abcd", spec, url, want, server)
	}
	a.persistWorkspaceSync()
	if got := readWorkspaceFile(path).Windows; len(got) != 1 || got[0] != (workspaceEntry{Server: server, Project: "/home/me/proj"}) {
		t.Fatalf("the workspace records %+v, want the server and the session's project", got)
	}
	if got := newWorkspaceStoreAt(path).load(); len(got) != 1 || got[0] != want {
		t.Fatalf("a next launch reads back %+v, want %+v", got, want)
	}

	a.showServerPage(remote, a.viewOf(remote))
	if code := post("session=abc123"); code != http.StatusNoContent || shown() != server+"/s/abc123" {
		t.Fatalf("attach from a page naming no link: %d, on %s; want 204, on %s/s/abc123", code, shown(), server)
	}
}

// TestAWindowOnAServerByURLReopensItsProjectOnce: a restored window loads its
// server's page, which asks the app what it was showing and opens that
// project's session there, through its own server's control API. The app hands
// it over once and forgets it: if the session opens, the attach records it
// again; if it does not, the window is on the server's page, and is saved as
// that. Only a main window on a server by URL is asked about.
func TestAWindowOnAServerByURLReopensItsProjectOnce(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	const server = "http://devbox:3939"
	remote := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{url: server, connected: true, remoteProject: "/home/me/proj"}, serverURL: server}})
	local := registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{project: "/p"}, serverURL: "http://127.0.0.1:3939/p/p-0123abcd"}})

	post := func(e *winEntry) (int, string) {
		rec := httptest.NewRecorder()
		a.controlReopen(rec, httptest.NewRequest(http.MethodPost, "/win/"+e.id+"/reopen", nil), e)
		var body struct {
			Project string `json:"project"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&body)
		return rec.Code, body.Project
	}
	if code, _ := post(local); code != http.StatusConflict {
		t.Errorf("reopen from a window on this machine's server: %d, want 409", code)
	}
	if code, project := post(remote); code != http.StatusOK || project != "/home/me/proj" {
		t.Fatalf("reopen: %d %q, want 200 /home/me/proj", code, project)
	}
	var spec windowSpec
	a.reg(func(*regState) { spec = remote.view.spec })
	if spec != (windowSpec{url: server, connected: true}) {
		t.Fatalf("after reopen the window is filed as %+v, want the server's page", spec)
	}
	if code, project := post(remote); code != http.StatusOK || project != "" {
		t.Fatalf("a second reopen: %d %q, want 200 and nothing", code, project)
	}
	a.workspace.flush(nil)
}

// TestAWindowOnAServerByURLStaysMarkedExternal: what a window navigates to on a
// server by URL is loaded with external=1, as its first page was, so a session
// there knows it is on another machine's server.
func TestAWindowOnAServerByURLStaysMarkedExternal(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	remote := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{url: "http://devbox:3939", connected: true}}})
	local := registerWindow(a, &winEntry{id: "w2", role: roleMain})
	if page := a.showView(remote, showing(a.viewOf(remote)), windowView{spec: a.viewOf(remote).spec, serverURL: "http://devbox:3939/p/proj-0123abcd"}, windowOpts{}); !strings.Contains(page, "&external=1") {
		t.Errorf("a window on a server by URL navigated to %s, without external=1", page)
	}
	if page := a.showView(local, showing(a.viewOf(local)), windowView{spec: windowSpec{project: "/p"}, serverURL: "http://127.0.0.1:3939/p/p-0123abcd"}, windowOpts{}); strings.Contains(page, "external=1") {
		t.Errorf("a window on this machine's server navigated to %s, marked external", page)
	}
	a.workspace.flush(nil)
}

// TestServerPageReturnsAWindowOnAServerByURLToItsPage: Session ▸ Open… in a
// window on a server by URL shows that server's sessions page in the same
// window, since another project there is another of its sessions. A window
// on this machine's server opens a new window instead, so it is refused here.
func TestServerPageReturnsAWindowOnAServerByURLToItsPage(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	const server = "http://devbox:3939"
	remote := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{url: server, connected: true, remoteProject: "/home/me/proj"}, serverURL: server + "/p/proj-0123abcd"}})
	local := registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{project: "/p"}, serverURL: "http://127.0.0.1:3939/p/p-0123abcd"}})

	post := func(e *winEntry) int {
		rec := httptest.NewRecorder()
		a.controlServerPage(rec, httptest.NewRequest(http.MethodPost, "/win/"+e.id+"/server-page", nil), e)
		return rec.Code
	}
	if code := post(local); code != http.StatusConflict {
		t.Errorf("server-page from a window on this machine's server: %d, want 409", code)
	}
	if code := post(remote); code != http.StatusNoContent {
		t.Fatalf("server-page: %d, want 204", code)
	}
	var url string
	var spec windowSpec
	a.reg(func(*regState) { url, spec = remote.view.serverURL, remote.view.spec })
	if url != server {
		t.Fatalf("after server-page the window is on %s, want %s", url, server)
	}
	if spec != (windowSpec{url: server, connected: true}) {
		t.Fatalf("after server-page the window is filed as %+v, still showing a session", spec)
	}
	a.workspace.flush(nil)
}

// TestOnlyAnEmptyLocalWindowTakesDroppedFolders: native folder drop is on only
// for a window showing this machine's server's page. A window on a server by
// URL is on another machine, where a dropped folder's path means nothing — and
// while it shows a session, its composer takes drops itself.
func TestOnlyAnEmptyLocalWindowTakesDroppedFolders(t *testing.T) {
	for _, c := range []struct {
		spec windowSpec
		want bool
	}{
		{windowSpec{}, true},
		{windowSpec{project: "/p"}, false},
		{windowSpec{url: "http://devbox:3939", connected: true}, false},
	} {
		if got := takesFolderDrops(windowView{spec: c.spec}); got != c.want {
			t.Errorf("takesFolderDrops(%+v) = %v, want %v", c.spec, got, c.want)
		}
	}
}
