//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
)

// The session's UI preferences are the desktop window's own settings, stored
// per project. A phone or laptop browsing in over the LAN or a tunnel is handed
// those values as its starting point but keeps its own in localStorage, so the
// write route is gated to viewers on this machine. Without the gate the last
// device to drag a column rearranges every other one, and the desktop comes
// back changed from a session someone spent on a phone. These tests pin that
// gate, the page markers serveIndex injects (the machine's appearance, whether
// the viewer is remote), and the project key the viewer namespaces its own
// storage with.

const localViewerAddr = "127.0.0.1:54321"

// newUIPrefsTestServer wires the real session routes over a real (temp-dir)
// session manager, so these tests exercise the registered route — including its
// localViewerOnly wrapper — rather than a stand-in.
func newUIPrefsTestServer(t *testing.T) (*Server, *core.SessionManager) {
	t.Helper()
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s := &Server{router: mux.NewRouter()}
	s.setupSessionRoutes(handlers.NewSessionAPI(
		func() *core.SessionManager { return mgr }, nil, nil, nil, nil))
	return s, mgr
}

// uiPrefRequest issues one request at addr, optionally tagged as having arrived
// over a granted remote transport (a DataChannel dispatch or tunnel hop, both of
// which reach the server over loopback).
func uiPrefRequest(t *testing.T, s *Server, method, path, body, addr string, remote bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = addr
	if remote {
		req = withRemoteIngress(req)
	}
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)
	return rec
}

// The viewer's preferences — hidden info cards, dragged column widths — ride one
// route carrying an opaque map per realm. These pin the gate on its writes in
// the shapes a viewer reaches it by, then the merge semantics the map needs and
// the bounds that keep it from growing without limit.

func TestUIPrefsRouteAcceptsLocalViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs",
		`{"ui":{"juggler-column-width":"31.5"}}`, localViewerAddr, false)
	if rec.Code != http.StatusOK {
		t.Fatalf("local ui-prefs write: got %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if got := string(mgr.GetWindowUIPrefs(core.WindowRoleMain)["juggler-column-width"]); got != `"31.5"` {
		t.Fatalf("local ui-prefs write not stored: got %s", got)
	}

	rec = uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-prefs", "", localViewerAddr, false)
	if !strings.Contains(rec.Body.String(), `"31.5"`) {
		t.Fatalf("reading it back: got %s", rec.Body.String())
	}
}

func TestUIPrefsRouteRejectsLANViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.MergeWindowUIPrefs(core.WindowRoleMain, uiPrefsPatch(t, `{"juggler-column-width":"31.5"}`)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs",
		`{"ui":{"juggler-column-width":"90"}}`, remoteEdgeAddr, false)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("LAN ui-prefs write: got %d, want 403", rec.Code)
	}
	if got := string(mgr.GetWindowUIPrefs(core.WindowRoleMain)["juggler-column-width"]); got != `"31.5"` {
		t.Fatalf("LAN viewer changed the desktop's preferences: got %s", got)
	}
}

// The one the address check alone would miss: a DataChannel dispatch or tunnel
// forwarder hop reaches the server over loopback.
func TestUIPrefsRouteRejectsTunnelViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs",
		`{"ui":{"juggler-column-width":"90"}}`, localViewerAddr, true)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("tunnelled ui-prefs write: got %d, want 403", rec.Code)
	}
	if got := mgr.GetWindowUIPrefs(core.WindowRoleMain); len(got) != 0 {
		t.Fatalf("tunnelled viewer wrote the desktop's preferences: got %v", got)
	}
}

// Only the writes are gated: a remote viewer starts from the desktop's
// preferences and keeps its own changes in its own localStorage.
func TestUIPrefsRouteReadsStayOpen(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.MergeWindowUIPrefs(core.WindowRoleMain, uiPrefsPatch(t, `{"juggler-column-width":"31.5"}`)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-prefs", "", remoteEdgeAddr, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("remote ui-prefs read: got %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"31.5"`) {
		t.Fatalf("remote read should return the saved preferences, got %s", rec.Body.String())
	}
}

// Each window names itself with ?role=, and the project-wide realm is named with
// ?scope=project. Three slots, no leakage between them.
func TestUIPrefsRouteKeepsTheRealmsApart(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	board := core.WindowRolePinboardFor("board_a")

	writes := []struct{ path, body string }{
		{"/api/session/ui-prefs", `{"ui":{"juggler-column-width":"20"}}`},
		{"/api/session/ui-prefs?role=" + board, `{"ui":{"juggler-column-width":"55"}}`},
		{"/api/session/ui-prefs?scope=project", `{"ui":{"juggler-column-width":"80"}}`},
	}
	for _, wr := range writes {
		if rec := uiPrefRequest(t, s, http.MethodPut, wr.path, wr.body, localViewerAddr, false); rec.Code != http.StatusOK {
			t.Fatalf("PUT %s: got %d: %s", wr.path, rec.Code, rec.Body.String())
		}
	}

	for _, want := range []struct{ path, value string }{
		{"/api/session/ui-prefs?role=main", `"20"`},
		{"/api/session/ui-prefs?role=" + board, `"55"`},
		{"/api/session/ui-prefs?scope=project", `"80"`},
	} {
		rec := uiPrefRequest(t, s, http.MethodGet, want.path, "", localViewerAddr, false)
		if !strings.Contains(rec.Body.String(), want.value) {
			t.Fatalf("GET %s: got %s, want %s", want.path, rec.Body.String(), want.value)
		}
	}
	// A window nobody has told anything is answered with nothing rather than
	// another window's or the project's.
	rec := uiPrefRequest(t, s, http.MethodGet,
		"/api/session/ui-prefs?role="+core.WindowRolePinboardFor("board_b"), "", localViewerAddr, false)
	if strings.Contains(rec.Body.String(), "juggler-column-width") {
		t.Fatalf("an untouched window inherited someone else's preferences: %s", rec.Body.String())
	}
	if _, ok := mgr.GetSessionUIPrefs()["juggler-pinboard-width"]; ok {
		t.Fatal("a window's preference reached the project's realm")
	}
}

// The viewer PUTs the preference it just changed, so a key the body omits is
// unchanged; null is how it drops one it no longer has.
func TestUIPrefsRouteMergesAndDeletes(t *testing.T) {
	s, _ := newUIPrefsTestServer(t)

	put := func(body string) {
		t.Helper()
		if rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs", body, localViewerAddr, false); rec.Code != http.StatusOK {
			t.Fatalf("PUT %s: got %d: %s", body, rec.Code, rec.Body.String())
		}
	}
	put(`{"ui":{"a":1,"b":2}}`)
	put(`{"ui":{"a":3}}`)

	rec := uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-prefs", "", localViewerAddr, false)
	if body := rec.Body.String(); !strings.Contains(body, `"a":3`) || !strings.Contains(body, `"b":2`) {
		t.Fatalf("a partial write must not drop the keys it omits: got %s", body)
	}

	put(`{"ui":{"a":null}}`)
	rec = uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-prefs", "", localViewerAddr, false)
	if body := rec.Body.String(); strings.Contains(body, `"a"`) || !strings.Contains(body, `"b":2`) {
		t.Fatalf("null must delete just that key: got %s", body)
	}
}

// A patch past the bounds is the caller's fault, not the server's, and is
// refused whole — 400, with what was already stored left alone.
func TestUIPrefsRouteRefusesAPatchOverTheBounds(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.MergeWindowUIPrefs(core.WindowRoleMain, uiPrefsPatch(t, `{"kept":1}`)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	body := fmt.Sprintf(`{"ui":{"big":%q}}`, strings.Repeat("x", 9<<10))
	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs", body, localViewerAddr, false)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an oversized preference: got %d, want 400", rec.Code)
	}
	prefs := mgr.GetWindowUIPrefs(core.WindowRoleMain)
	if len(prefs) != 1 || string(prefs["kept"]) != `1` {
		t.Fatalf("a refused patch must leave what was stored alone: got %v", prefs)
	}
}

// uiPrefsPatch builds a patch for seeding, from the JSON object a viewer sends.
func uiPrefsPatch(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	var patch map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &patch); err != nil {
		t.Fatalf("uiPrefsPatch(%s): %v", body, err)
	}
	return patch
}

// serveIndex injects the theme and zoom the page must paint on its very first
// frame: the machine's, from settings.json, since they describe the screen
// rather than the project. A late correction would be a visible flash of the
// wrong colour, or a reflow, on every launch. While the machine has none, the
// project session's are injected beside them for the server's own window to
// adopt; once it has one, the session's are not offered at all.
func TestIndexInjectsTheMachinesAppearance(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	// A project left by an earlier Juggler, whose session.json holds a theme and
	// zoom of its own.
	projectDir := t.TempDir()
	store, err := core.NewFileSessionStore(projectDir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	seed := core.NewSession()
	seed.UITheme = "light"
	seed.UIZoom = 90
	if err := store.Save(seed); err != nil {
		t.Fatalf("seed project appearance: %v", err)
	}
	mgr, err := core.NewSessionManagerForPath(projectDir)
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)

	s := &Server{router: mux.NewRouter()}
	s.projectState.Store(&projectState{sessionManager: mgr, projectPath: t.TempDir()})
	tmpl, err := template.New("index").Parse(
		`machine={{.MachineThemeMode}}/{{.MachineZoom}} project={{.ProjectThemeMode}}/{{.ProjectZoom}}`)
	if err != nil {
		t.Fatalf("parse stand-in template: %v", err)
	}
	s.indexTemplate = tmpl

	serve := func() string {
		s.settings = newSettingsStore()
		req := httptest.NewRequest(http.MethodGet, "/?window=1", nil)
		req.RemoteAddr = localViewerAddr
		rec := httptest.NewRecorder()
		s.serveIndex(rec, req)
		return rec.Body.String()
	}

	if got, want := serve(), "machine=/0 project=light/90"; got != want {
		t.Fatalf("a machine with nothing stored: got %q, want %q", got, want)
	}

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.UI = map[string]json.RawMessage{
			machineThemePref: json.RawMessage(`"dark"`),
			machineZoomPref:  json.RawMessage(`130`),
		}
		return true
	}); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	if got, want := serve(), "machine=dark/130 project=/0"; got != want {
		t.Fatalf("a machine with its own: got %q, want %q", got, want)
	}

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.UI = map[string]json.RawMessage{
			machineThemePref: json.RawMessage(`"mauve"`),
			machineZoomPref:  json.RawMessage(`"big"`),
		}
		return true
	}); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	if got, want := serve(), "machine=/0 project=light/90"; got != want {
		t.Fatalf("values the page could not use are not injected: got %q, want %q", got, want)
	}
}

// The page decides which UI preferences are its to write from the same test the
// write routes apply, so the two can never disagree: a desktop app window on a
// server on another machine is a remote viewer like any other, however native
// its window is. Before this the page took ?window=1 to mean "the host's own
// window", read the host's values on every load and lost its own changes.
func TestIndexMarksAViewerOnAnotherMachine(t *testing.T) {
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s := &Server{router: mux.NewRouter()}
	s.projectState.Store(&projectState{sessionManager: mgr, projectPath: t.TempDir()})
	tmpl, err := template.New("index").Parse(`remote={{.RemoteViewer}}`)
	if err != nil {
		t.Fatalf("parse stand-in template: %v", err)
	}
	s.indexTemplate = tmpl

	serve := func(addr string, tunnelled bool) string {
		req := httptest.NewRequest(http.MethodGet, "/?window=1&external=1", nil)
		req.RemoteAddr = addr
		if tunnelled {
			req = withRemoteIngress(req)
		}
		rec := httptest.NewRecorder()
		s.serveIndex(rec, req)
		return rec.Body.String()
	}

	for _, c := range []struct {
		what      string
		addr      string
		tunnelled bool
		want      string
	}{
		{"a window on this machine", localViewerAddr, false, "remote=false"},
		{"a window across the LAN", remoteEdgeAddr, false, "remote=true"},
		{"a window through a tunnel", localViewerAddr, true, "remote=true"},
	} {
		if got := serve(c.addr, c.tunnelled); got != c.want {
			t.Errorf("%s: got %q, want %q", c.what, got, c.want)
		}
	}
}

// TestProjectStorageKeyIsStable pins the property the viewer's namespacing rests
// on: one project always yields one key, however its path is spelled.
func TestProjectStorageKeyIsStable(t *testing.T) {
	dir := t.TempDir()
	uncleaned := filepath.Join(dir, "sub", "..") + string(filepath.Separator)

	if got, want := projectStorageKey(uncleaned), projectStorageKey(dir); got != want {
		t.Fatalf("uncleaned spelling of the same project differs: got %q, want %q", got, want)
	}
	if key := projectStorageKey(dir); len(key) != projectStorageKeyLen {
		t.Fatalf("key length: got %d (%q), want %d", len(key), key, projectStorageKeyLen)
	}
}

func TestProjectStorageKeyIsPerProject(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	if projectStorageKey(a) == projectStorageKey(b) {
		t.Fatalf("two projects share a storage key (%q) — their stored preferences would collide",
			projectStorageKey(a))
	}
}

// TestProjectStorageKeyHidesThePath: the key lands in a localStorage the studio
// relay origin shares with other pages, so it must not carry where the project
// lives. A no-project window has no key at all and falls back to the bare one.
func TestProjectStorageKeyHidesThePath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "unmistakable-project-name")
	key := projectStorageKey(dir)
	if strings.Contains(key, "unmistakable-project-name") {
		t.Fatalf("storage key leaks the project path: %q", key)
	}
	if projectStorageKey("") != "" {
		t.Fatalf("no-project window should have no key, got %q", projectStorageKey(""))
	}
}
