//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/http"
	"net/url"
	"testing"
)

// A window opened with --url views a server this app did not start, quite
// possibly on another machine. The project paths its page offers are paths on
// that machine, so the app cannot open one of them in a window of its own: it
// would spawn a local server for a folder that is not here. The page is told
// which kind of window it is, and a new window it asks for opens on its own
// server, filed with the project it names there.

func TestWindowPageURLMarksAWindowOnAnExternalServer(t *testing.T) {
	if q := query(t, windowOpts{external: true}); q.Get("external") != "1" {
		t.Fatalf("a window on an external server must say so, got %v", q)
	}
	if q := query(t, windowOpts{}); q.Has("external") {
		t.Fatalf("a window on a server the app spawned must not claim to be external, got %v", q)
	}
}

// TestAWindowOnAnExternalServerOpensItsProjectInANewWindowThere: a project a
// window on a server by URL asks a new window for is a path on that server's
// machine, so the new window is that server's, filed with the project
// (windowSpec.remoteProject) — which its page opens there, as a relaunch's does
// (controlReopen) — and never a local server's for a folder that is not here.
// One project there has one window: a main window on the same server already
// filed with it is raised instead. One on another server, or this machine's
// window of a folder by the same path, is not that project's.
func TestAWindowOnAnExternalServerOpensItsProjectInANewWindowThere(t *testing.T) {
	var got []windowSpec
	saved := openNewWindow
	openNewWindow = func(_ *appState, spec windowSpec, _ windowOpts) { got = append(got, spec) }
	t.Cleanup(func() { openNewWindow = saved })
	var raised []string
	savedRaise := raiseWindow
	raiseWindow = func(e *winEntry, conversation string) { raised = append(raised, e.id+" "+conversation) }
	t.Cleanup(func() { raiseWindow = savedRaise })

	a := newTestAppState(t)
	const server = "http://remote:8080"
	remote := windowSpec{url: server}
	registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: remote, serverURL: server + "/p/beta-0123abcd"}})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, view: windowView{spec: windowSpec{url: "http://other:8080", remoteProject: "/home/remote/proj"}}})
	registerWindow(a, &winEntry{id: "w3", role: roleMain, view: windowView{spec: windowSpec{project: "/home/remote/proj"}}})

	post := func(query string) int {
		return controlRequest(a, http.MethodPost, "/win/w1/new?"+query).Code
	}
	if code := post("project=%2Fhome%2Fremote%2Fproj"); code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", code, http.StatusNoContent)
	}
	want := windowSpec{url: server, remoteProject: "/home/remote/proj"}
	if len(got) != 1 || got[0] != want || len(raised) != 0 {
		t.Fatalf("opened %+v, raised %v; want one window on %+v", got, raised, want)
	}
	got = nil
	if code := post(""); code != http.StatusNoContent || len(got) != 1 || got[0] != remote {
		t.Fatalf("no project: %d, opened %+v; want one window on the server's page, %+v", code, got, remote)
	}

	got = nil
	registerWindow(a, &winEntry{id: "w4", role: roleMain, view: windowView{spec: want, serverURL: server + "/p/proj-0123abcd"}})
	if code := post("project=%2Fhome%2Fremote%2Fproj&conversation=conv_abc123"); code != http.StatusOK || len(got) != 0 {
		t.Fatalf("a project with a window: %d, opened %+v; want 200 and no window", code, got)
	}
	if len(raised) != 1 || raised[0] != "w4 conv_abc123" {
		t.Fatalf("raised %v; want w4, at conv_abc123", raised)
	}
}

// TestANewWindowOpensItsProjectAtTheConversationItNames: a project's page may
// ask for a window onto another project of this machine's server, at one of
// that project's conversations (a ⌘-click in Home), so the window's page
// opens on it (?c=) — once: it is the page's to read, never filed with the
// window. An id that is not one is dropped and the window opened all the same,
// and a board's conversation is still the board's, never a link.
func TestANewWindowOpensItsProjectAtTheConversationItNames(t *testing.T) {
	type opened struct {
		spec windowSpec
		opts windowOpts
	}
	var got []opened
	saved := openNewWindow
	openNewWindow = func(_ *appState, spec windowSpec, opts windowOpts) { got = append(got, opened{spec, opts}) }
	t.Cleanup(func() { openNewWindow = saved })

	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{project: "/work/beta"}, serverURL: "http://127.0.0.1:3939/p/beta-0123abcd"}})

	for _, tc := range []struct{ query, want string }{
		{"project=%2Fwork%2Falpha&conversation=conv_abc123", "conv_abc123"},
		{"project=%2Fwork%2Falpha&conversation=..%2Fevil", ""},
		{"project=%2Fwork%2Falpha", ""},
	} {
		got = nil
		if rec := controlRequest(a, http.MethodPost, "/win/w1/new?"+tc.query); rec.Code != http.StatusNoContent {
			t.Fatalf("%s: status %d, want %d", tc.query, rec.Code, http.StatusNoContent)
		}
		if len(got) != 1 || got[0].spec != (windowSpec{project: "/work/alpha"}) {
			t.Fatalf("%s: opened %+v, want one window onto /work/alpha", tc.query, got)
		}
		page, err := url.Parse(windowPageURL("http://127.0.0.1:3939/p/alpha-0123abcd", testCtl, got[0].opts))
		if err != nil {
			t.Fatal(err)
		}
		if c := page.Query().Get("c"); c != tc.want || page.Query().Has("c") != (tc.want != "") {
			t.Errorf("%s: the window's page is %s, want it linked to %q", tc.query, page, tc.want)
		}
	}

	got = nil
	if rec := controlRequest(a, http.MethodPost, "/win/w1/new?view=pinboard&board=b1&owner=v1&conversation=conv_abc123"); rec.Code != http.StatusNoContent {
		t.Fatalf("board: status %d", rec.Code)
	}
	if len(got) != 1 || got[0].opts.conversation != "conv_abc123" || got[0].opts.linkedConversation != "" {
		t.Errorf("board: opened %+v, want the board's conversation and no link", got)
	}
}

// TestANewWindowFromAnotherComputersPageWearsThisMachinesTheme: the theme,
// mode and zoom a page hands a new window are its server's machine's, so a
// page another computer's server sent hands none of them on. The new window's
// header is this machine's sessions page, which wears this machine's own.
func TestANewWindowFromAnotherComputersPageWearsThisMachinesTheme(t *testing.T) {
	var got []windowOpts
	saved := openNewWindow
	openNewWindow = func(_ *appState, _ windowSpec, opts windowOpts) { got = append(got, opts) }
	t.Cleanup(func() { openNewWindow = saved })

	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: windowSpec{url: "http://remote:8080", connected: true}, serverURL: "http://remote:8080"}})

	if rec := controlRequest(a, http.MethodPost, "/win/w1/new?theme=dark&mode=dark&zoom=120"); rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if len(got) != 1 || got[0].theme != "" || got[0].mode != "" || got[0].zoom != 0 {
		t.Fatalf("opened %+v; want one window handed none of the other computer's theme, mode or zoom", got)
	}
}
