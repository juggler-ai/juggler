//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/http"
	"testing"
)

// A window opened with --url views a server this app did not start, quite
// possibly on another machine. The project paths its page offers are paths on
// that machine, so the app cannot open one of them in a window of its own: it
// would spawn a local server for a folder that is not here. The page is told
// which kind of window it is, so it switches in place as a browser would, and
// a new window it asks for opens on its own server, whatever project it names.

func TestWindowPageURLMarksAWindowOnAnExternalServer(t *testing.T) {
	if q := query(t, windowOpts{external: true}); q.Get("external") != "1" {
		t.Fatalf("a window on an external server must say so, got %v", q)
	}
	if q := query(t, windowOpts{}); q.Has("external") {
		t.Fatalf("a window on a server the app spawned must not claim to be external, got %v", q)
	}
}

func TestAWindowOnAnExternalServerCannotOpenAProjectInANewWindow(t *testing.T) {
	var got []windowSpec
	saved := openNewWindow
	openNewWindow = func(_ *appState, spec windowSpec, _ windowOpts) { got = append(got, spec) }
	t.Cleanup(func() { openNewWindow = saved })

	a := newTestAppState(t)
	remote := windowSpec{url: "http://remote:8080"}
	registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: remote, serverURL: "http://remote:8080"}})

	rec := controlRequest(a, http.MethodPost, "/win/w1/new?project=%2Fhome%2Fremote%2Fproj")

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if len(got) != 1 || got[0] != remote {
		t.Fatalf("opened %+v; want one window on %+v — a remote path must not spawn a local server", got, remote)
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
