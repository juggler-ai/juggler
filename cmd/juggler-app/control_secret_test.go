//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// What a control secret grants. Each window's page holds its own, in its
// ?nativeCtl=, and a window on a server by URL sends it to that server with
// every page load — so a secret must reach no other window, and a remote
// window's must reach nothing beyond that window's own chrome and navigation.

// controlSecretOf is the secret window id's page holds, or one no window holds
// when there is no such window.
func controlSecretOf(a *appState, id string) string {
	secret := "no-window-holds-this"
	a.reg(func(st *regState) {
		if e := st.windows[id]; e != nil {
			secret = e.ctlSecret
		}
	})
	return secret
}

// withSecret gives e a secret of its own, as building a window does, and
// returns it.
func withSecret(e *winEntry) *winEntry {
	if e.ctlSecret == "" {
		e.ctlSecret = mintControlSecret()
	}
	return e
}

// controlAs posts action to window id's control path, holding the secret of
// window holder.
func controlAs(a *appState, holder, id, action string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	a.handleControl(rec, httptest.NewRequest(http.MethodPost, "/"+controlSecretOf(a, holder)+"/win/"+id+"/"+action, nil))
	return rec
}

// TestAWindowsSecretActsOnlyOnThatWindow: a page holding one window's secret
// cannot name another window in the path and act on it.
func TestAWindowsSecretActsOnlyOnThatWindow(t *testing.T) {
	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{project: "/q"}})

	if rec := controlAs(a, "w1", "w1", "drafts-flushed?token=x"); rec.Code != http.StatusNoContent {
		t.Fatalf("w1's secret on w1 = %d, want 204", rec.Code)
	}
	if rec := controlAs(a, "w1", "w2", "drafts-flushed?token=x"); rec.Code != http.StatusNotFound {
		t.Fatalf("w1's secret on w2 = %d, want 404", rec.Code)
	}
	if controlSecretOf(a, "w1") == controlSecretOf(a, "w2") {
		t.Fatal("two windows hold the same secret")
	}
}

// TestANavigatedWindowsOldSecretOpensNothing: a page replaced in place takes
// its secret with it, so whichever server served it holds nothing for the page
// that follows.
func TestANavigatedWindowsOldSecretOpensNothing(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	e := registerWindow(a, &winEntry{id: "w1", role: roleMain})
	old := controlSecretOf(a, "w1")

	page := a.navigateWindow(e, windowSpec{project: "/p"}, "http://127.0.0.1:3939/s/abc")

	if strings.Contains(page, old) {
		t.Fatalf("the new page %s carries the old secret", page)
	}
	if !strings.Contains(page, url.QueryEscape(controlSecretOf(a, "w1"))) {
		t.Fatalf("the new page %s does not carry the window's secret", page)
	}
	rec := httptest.NewRecorder()
	a.handleControl(rec, httptest.NewRequest(http.MethodPost, "/"+old+"/win/w1/drafts-flushed?token=x", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("the replaced page's secret = %d, want 404", rec.Code)
	}
	a.workspace.flush(nil)
}

// TestARemoteWindowsSecretReachesOnlyItsOwnWindow: a page another machine's
// server sent is refused everything app-wide or on this machine's files, and
// keeps what showing a session in its own window needs.
func TestARemoteWindowsSecretReachesOnlyItsOwnWindow(t *testing.T) {
	userpathstest.Isolate(t)
	savedQuit, savedRestart := startQuit, updaterRestart
	quits, restarts := 0, 0
	startQuit = func(*appState) { quits++ }
	updaterRestart = func() error { restarts++; return nil }
	t.Cleanup(func() { startQuit, updaterRestart = savedQuit, savedRestart })

	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	const server = "http://devbox:3939"
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{url: server, connected: true}, serverURL: server + "/s/abc"})

	for _, action := range []string{
		"connect?url=http%3A%2F%2Felsewhere%3A1",
		"new?project=%2Ftmp",
		"new",
		"updater?op=restart&force=1",
		"updater?op=state",
		"quit",
		"folder-dropped?path=%2Fno%2Fsuch%2Fplace",
		"locale?locale=en",
		"restart-server",
		"retry-server",
		"start-server",
		"open-local",
		"zoom?zoom=0",
		"pick-file",
		"pick-directory",
	} {
		if rec := controlAs(a, "w1", "w1", action); rec.Code != http.StatusForbidden {
			t.Errorf("a remote window's %s = %d, want 403", action, rec.Code)
		}
	}
	if quits != 0 || restarts != 0 {
		t.Fatalf("a remote window's secret quit the app %d times and restarted it %d", quits, restarts)
	}

	for action, want := range map[string]int{
		"drafts-flushed?token=x": http.StatusNoContent,
		"attach?session=":        http.StatusBadRequest, // reached attachRemote, which wants an id
		"server-page":            http.StatusNoContent,
		// open reaches its handler, which hands the system browser nothing
		// but an http(s) URL.
		"open?url=file%3A%2F%2F%2Fetc%2Fpasswd": http.StatusBadRequest,
		"open?url=javascript%3Aalert(1)":        http.StatusBadRequest,
		"open?url=x-app%3A%2F%2Fdo-something":   http.StatusBadRequest,
		"open?url=%2Frelative":                  http.StatusBadRequest,
		// save-file reaches its handler, which refuses an empty body.
		"save-file?name=a.html": http.StatusBadRequest,
	} {
		if rec := controlAs(a, "w1", "w1", action); rec.Code != want {
			t.Errorf("a remote window's %s = %d, want %d", action, rec.Code, want)
		}
	}
	a.workspace.flush(nil)
}

// TestARemoteWindowOpensWindowsOnlyOntoItsOwnServer: a window on a server by
// URL may open a board of one of its own conversations, which opens on that
// same server; it may not open this machine's server's page or a project path.
func TestARemoteWindowOpensWindowsOnlyOntoItsOwnServer(t *testing.T) {
	type opened struct {
		spec windowSpec
		opts windowOpts
	}
	var got []opened
	saved := openNewWindow
	openNewWindow = func(_ *appState, spec windowSpec, opts windowOpts) { got = append(got, opened{spec, opts}) }
	t.Cleanup(func() { openNewWindow = saved })

	a := newTestAppState(t)
	remote := windowSpec{url: "http://devbox:3939", connected: true}
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: remote, serverURL: remote.url + "/s/abc"})

	for _, action := range []string{
		"new",
		"new?project=%2Ftmp",
		"new?view=frobnicate&project=%2Ftmp",
	} {
		if rec := controlAs(a, "w1", "w1", action); rec.Code != http.StatusForbidden {
			t.Errorf("a remote window's %s = %d, want 403", action, rec.Code)
		}
	}
	if len(got) != 0 {
		t.Fatalf("refused requests opened %v", got)
	}

	// A project named beside the board is not where the board opens.
	if rec := controlAs(a, "w1", "w1", "new?view=pinboard&board=b1&project=%2Ftmp"); rec.Code != http.StatusNoContent {
		t.Fatalf("a remote window's board = %d, want 204", rec.Code)
	}
	if len(got) != 1 || got[0].spec != remote || !got[0].opts.isPinboard() || got[0].opts.openedBy != "w1" {
		t.Fatalf("the board opened as %+v; want one board of w1 on %+v", got, remote)
	}
}

// TestARemoteWindowsSaveTellsItOnlyWhetherItSaved: save-file writes only what
// the user chose in the Save dialog. A window on a server by URL learns
// whether the file was saved, as a download would tell it, and not where: it
// is answered with the name it suggested. A local window is told the path.
func TestARemoteWindowsSaveTellsItOnlyWhetherItSaved(t *testing.T) {
	dir := t.TempDir()
	answer := ""
	prompts := 0
	saved := promptSaveFile
	promptSaveFile = func(_ *appState, _ *winEntry, _ string) (string, error) { prompts++; return answer, nil }
	t.Cleanup(func() { promptSaveFile = saved })

	a := newTestAppState(t)
	a.ctlPort = 1
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{url: "http://devbox:3939", connected: true}, serverURL: "http://devbox:3939"})
	registerWindow(a, &winEntry{id: "w2", role: roleMain, spec: windowSpec{project: "/p"}})

	save := func(id string) (int, string) {
		rec := httptest.NewRecorder()
		a.handleControl(rec, httptest.NewRequest(http.MethodPost, "/"+controlSecretOf(a, id)+"/win/"+id+"/save-file?name=a.html", strings.NewReader("hi")))
		var body struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body.Path
	}

	answer = filepath.Join(dir, "chosen.html")
	if code, path := save("w1"); code != http.StatusOK || path != "a.html" {
		t.Fatalf("a remote window's save = %d %q; want 200 and only the name it suggested", code, path)
	}
	if b, err := os.ReadFile(answer); err != nil || string(b) != "hi" {
		t.Fatalf("the chosen file holds %q (%v), want what was sent", b, err)
	}

	answer = filepath.Join(dir, "local.html")
	if code, path := save("w2"); code != http.StatusOK || path != answer {
		t.Fatalf("a local window's save = %d %q; want 200 and %s", code, path, answer)
	}

	answer = ""
	if code, path := save("w1"); code != http.StatusOK || path != "" {
		t.Fatalf("a cancelled save = %d %q; want 200 and no path", code, path)
	}
	if prompts != 3 {
		t.Fatalf("the dialog was shown %d times for 3 saves", prompts)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatalf("%d files written, want the 2 the user chose", len(entries))
	}
}

// TestAWindowThatTakesNoDropsIsToldOfNone: folder-dropped is the report of a
// drop on the window's native drag overlay, which only an empty local window
// has; from any other window it is refused.
func TestAWindowThatTakesNoDropsIsToldOfNone(t *testing.T) {
	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}})
	registerWindow(a, &winEntry{id: "w2", role: roleMain})

	if rec := controlAs(a, "w1", "w1", "folder-dropped?path=%2Fno%2Fsuch%2Fplace"); rec.Code != http.StatusConflict {
		t.Errorf("folder-dropped from a project's window = %d, want 409", rec.Code)
	}
	if rec := controlAs(a, "w2", "w2", "folder-dropped?path=%2Fno%2Fsuch%2Fplace"); rec.Code != http.StatusNoContent {
		t.Errorf("folder-dropped from an empty local window = %d, want 204", rec.Code)
	}
}
