//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// A window on a server by URL — another machine's, connected to from Session ▸
// Connect to Server — shows that server's sessions page, and opening a session
// there shows it in the same window, as a viewer. The window stays the
// server's: it keeps its URL spec (so it reopens on the server's page), and the
// page it loads stays marked as being on a server this app did not start.

// TestAttachInAWindowOnAServerByURLShowsTheSessionThere: the page has opened the
// session through its own server's control API; the app only moves the window
// to /s/<id>/ on that same server. An id that is not one is refused, so the
// page cannot send the window anywhere else.
func TestAttachInAWindowOnAServerByURLShowsTheSessionThere(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	const server = "http://devbox:3939"
	remote := registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{url: server, connected: true}, serverURL: server})

	post := func(session string) int {
		rec := httptest.NewRecorder()
		a.controlAttach(rec, httptest.NewRequest(http.MethodPost, "/win/w1/attach?session="+session, nil), remote)
		return rec.Code
	}
	for _, bad := range []string{"", "..%2F..%2Fevil", "a%2Fb"} {
		if code := post(bad); code != http.StatusBadRequest {
			t.Errorf("attach to session %q: %d, want 400", bad, code)
		}
	}
	if code := post("abc123"); code != http.StatusNoContent {
		t.Fatalf("attach: %d, want 204", code)
	}
	var spec windowSpec
	var url string
	a.reg(func(*regState) { spec, url = remote.spec, remote.serverURL })
	if spec != (windowSpec{url: server, connected: true}) || url != server+"/s/abc123" {
		t.Fatalf("after attach the window is %+v on %s; want still the server's, on %s/s/abc123", spec, url, server)
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
	remote := registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{url: "http://devbox:3939", connected: true}})
	local := registerWindow(a, &winEntry{id: "w2", role: roleMain})
	if page := a.navigateWindow(remote, remote.spec, "http://devbox:3939/s/abc"); !strings.Contains(page, "&external=1") {
		t.Errorf("a window on a server by URL navigated to %s, without external=1", page)
	}
	if page := a.navigateWindow(local, windowSpec{project: "/p"}, "http://127.0.0.1:3939/s/abc"); strings.Contains(page, "external=1") {
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
	remote := registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{url: server, connected: true}, serverURL: server + "/s/abc"})
	local := registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: "http://127.0.0.1:3939/s/x"})

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
	a.reg(func(*regState) { url = remote.serverURL })
	if url != server {
		t.Fatalf("after server-page the window is on %s, want %s", url, server)
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
		if got := takesFolderDrops(c.spec); got != c.want {
			t.Errorf("takesFolderDrops(%+v) = %v, want %v", c.spec, got, c.want)
		}
	}
}
