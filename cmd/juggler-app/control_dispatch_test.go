//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The control listener's routing, for every answer it can give without a native
// window: which requests reach which handler, and the status and JSON the page
// reads back. Each action's own behaviour is tested beside it; this is the map.

// controlRequest sends target (/win/<id>/…) as the page of window <id> would:
// under that window's secret, or one no window holds when there is none.
func controlRequest(a *appState, method, target string) *httptest.ResponseRecorder {
	id, _, _ := strings.Cut(strings.TrimPrefix(target, "/win/"), "/")
	rec := httptest.NewRecorder()
	a.handleControl(rec, httptest.NewRequest(method, "/"+controlSecretOf(a, id)+target, nil))
	return rec
}

func TestWindowControlRouting(t *testing.T) {
	a := newTestAppState(t)
	registerTestWindow(a, "w1")

	cases := []struct {
		name, target string
		want         int
	}{
		{"no action", "/win/w1", http.StatusNotFound},
		{"no window id", "/win//theme", http.StatusNotFound},
		{"unknown action", "/win/w1/frobnicate", http.StatusNotFound},
		{"known action, unknown window", "/win/nope/zoom", http.StatusNotFound},
		{"open refuses a non-browser URL", "/win/w1/open?url=file%3A%2F%2F%2Fetc%2Fpasswd", http.StatusBadRequest},
		{"zoom ignores a non-positive value", "/win/w1/zoom?zoom=0", http.StatusNoContent},
		{"drafts-flushed always answers 204", "/win/w1/drafts-flushed?token=stale", http.StatusNoContent},
		{"updater rejects an unknown op", "/win/w1/updater?op=frobnicate", http.StatusBadRequest},
		{"save-file refuses an empty body", "/win/w1/save-file?name=a.html", http.StatusBadRequest},
		{"connect refuses an address with no host", "/win/w1/connect?url=http%3A%2F%2F", http.StatusBadRequest},
		{"retry-server refuses a window that is not the unreachable page", "/win/w1/retry-server", http.StatusConflict},
		{"server-lost refuses a window that is not a main window", "/win/w1/server-lost", http.StatusConflict},
		{"server-page refuses a window not on a server by URL", "/win/w1/server-page", http.StatusConflict},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if rec := controlRequest(a, http.MethodPost, c.target); rec.Code != c.want {
				t.Fatalf("POST %s = %d, want %d", c.target, rec.Code, c.want)
			}
		})
	}
}

// The names the page posts, and which of them a window on a server by URL may
// post. A name dropped from the table answers 404, and these are
// fire-and-forget posts from the page's side, so this is where it shows; a name
// added to the remote set is a grant to every server ever connected to.
func TestWindowControlActionTable(t *testing.T) {
	// Whether a remote window may ask at all; "new" is granted for a board
	// only (TestARemoteWindowOpensWindowsOnlyOntoItsOwnServer).
	want := map[string]bool{
		"theme": true, "title": true, "control": true, "attention": true,
		"drafts-flushed": true, "attach": true, "server-page": true, "server-lost": true,
		"open": true, "new": true, "save-file": true,
		"locale": false, "zoom": false, "folder-dropped": false, "pick-directory": false,
		"pick-file": false, "updater": false, "connect": false,
		"quit": false, "retry-server": false, "start-server": false, "restart-server": false, "open-local": false,
	}
	if len(windowActions) != len(want) {
		t.Fatalf("windowActions has %d entries, want %d: %v", len(windowActions), len(want), want)
	}
	for name, remote := range want {
		act, ok := windowActions[name]
		if !ok || act.handle == nil {
			t.Errorf("windowActions has no %q", name)
			continue
		}
		if (act.remote != nil) != remote {
			t.Errorf("windowActions[%q] grants a remote window something: %v, want %v", name, act.remote != nil, remote)
		}
	}
}

func TestWindowControlPreflightAnswersBeforeRouting(t *testing.T) {
	a := newTestAppState(t)
	registerTestWindow(a, "w1")
	rec := controlRequest(a, http.MethodOptions, "/win/w1/frobnicate")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS = %d, want 204 for a window's secret, whatever the path names", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "POST, OPTIONS" {
		t.Fatalf("Access-Control-Allow-Methods = %q", got)
	}
}

func TestWindowControlDraftsFlushedReleasesTheWaiter(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")
	token, done := a.armFlushWait(e)

	controlRequest(a, http.MethodPost, "/win/w1/drafts-flushed?token="+token)
	if !closed(done) {
		t.Fatal("a drafts-flushed reply quoting the current token must release the close")
	}
}

// The in-page Exit takes the same path as the app's Quit command, answering at
// once because the window that asked is about to close; a quit already under
// way is not started twice.
func TestWindowControlQuitStartsTheAppQuitOnce(t *testing.T) {
	saved := startQuit
	started := 0
	startQuit = func(*appState) { started++ }
	t.Cleanup(func() { startQuit = saved })

	a := newTestAppState(t)
	registerTestWindow(a, "w1")

	if rec := controlRequest(a, http.MethodPost, "/win/w1/quit"); rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if started != 1 {
		t.Fatalf("quit started %d times, want 1", started)
	}

	a.reg(func(st *regState) { st.quitting = true })
	if rec := controlRequest(a, http.MethodPost, "/win/w1/quit"); rec.Code != http.StatusNoContent {
		t.Fatalf("status while quitting = %d, want 204", rec.Code)
	}
	if started != 1 {
		t.Fatalf("a quit while already quitting started another (%d in all)", started)
	}
}

// TestWindowControlUpdaterStateIsJSON: the updater's state, with whether the
// window views this machine's server, which the relaunched app restarts at its
// own version. A window on a server by URL is not told it at all: the updater
// is app-wide (windowActions), and its page shows no updater.
func TestWindowControlUpdaterStateIsJSON(t *testing.T) {
	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: "http://127.0.0.1:1/s/s1"})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{url: "http://devbox:8080", connected: true}, serverURL: "http://devbox:8080"})

	if rec := controlRequest(a, http.MethodPost, "/win/w2/updater?op=state"); rec.Code != http.StatusForbidden {
		t.Fatalf("w2: status = %d, want 403", rec.Code)
	}
	for id, want := range map[string]bool{"w1": true} {
		rec := controlRequest(a, http.MethodPost, "/win/"+id+"/updater?op=state")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", id, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Fatalf("%s: Content-Type = %q, want application/json", id, ct)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: body is not JSON: %q (%v)", id, rec.Body.String(), err)
		}
		if managed, ok := body["appManagedServer"].(bool); !ok || managed != want {
			t.Fatalf("%s: appManagedServer = %v, want %v", id, body["appManagedServer"], want)
		}
	}
}

func TestWindowControlUpdaterRestartFailureIsReportedAndRolledBack(t *testing.T) {
	// Stubbed rather than trusted to be the default: a packaging build copies a
	// real updater into this package, and this must never reach a real restart.
	saved := updaterRestart
	updaterRestart = func() error { return errors.New("nothing staged") }
	t.Cleanup(func() { updaterRestart = saved })

	a := newTestAppState(t)
	registerTestWindow(a, "w1")

	rec := controlRequest(a, http.MethodPost, "/win/w1/updater?op=restart")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 from a restart that failed", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error == "" {
		t.Fatalf("the page needs the reason, got %q (%v)", rec.Body.String(), err)
	}
	var quitting bool
	a.reg(func(st *regState) { quitting = st.quitting })
	if quitting {
		t.Fatal("a failed restart must withdraw the quit it authorised")
	}
}
