//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// A window opened with --url views a server this app did not start, quite
// possibly on another machine. The project paths its page offers are paths on
// that machine, so the app cannot open one of them in a window of its own: it
// would spawn a local server for a folder that is not here. The page is told
// which kind of window it is, so it switches in place as a browser would, and
// the app refuses the request if it arrives anyway.

func TestWindowPageURLMarksAWindowOnAnExternalServer(t *testing.T) {
	if q := query(t, windowOpts{external: true}); q.Get("external") != "1" {
		t.Fatalf("a window on an external server must say so, got %v", q)
	}
	if q := query(t, windowOpts{}); q.Has("external") {
		t.Fatalf("a window on a server the app spawned must not claim to be external, got %v", q)
	}
}

func TestAWindowOnAnExternalServerCannotOpenAProjectInANewWindow(t *testing.T) {
	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{url: "http://remote:8080"}, serverURL: "http://remote:8080"})

	rec := controlRequest(a, http.MethodPost, "/win/w1/new?project=%2Fhome%2Fremote%2Fproj")

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d: a remote path must not spawn a local server", rec.Code, http.StatusForbidden)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || !strings.Contains(body.Error, "another computer") {
		t.Fatalf("the refusal should say why, got %q (%v)", rec.Body.String(), err)
	}
}
