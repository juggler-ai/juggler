//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/workspace"
)

// The workspace table through its routes: a workspace is registered before it
// is built, flipped to ready when it is, and tombstoned when it is finished
// with — and every one of those is broadcast whole, because a second window has
// no other way to learn that the thing it is watching became usable.

// newWorkspaceTestServer wires the real session routes over a real (temp-dir)
// session manager, so these tests exercise registered routes rather than
// calling handlers directly.
func newWorkspaceTestServer(t *testing.T) (*Server, *recordingBroadcaster, string) {
	t.Helper()
	dir := t.TempDir()
	mgr, err := core.NewSessionManagerForPath(dir)
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	bc := &recordingBroadcaster{}
	s := &Server{router: mux.NewRouter()}
	api := handlers.NewSessionAPI(func() *core.SessionManager { return mgr }, nil, bc, nil, nil)
	api.SetWorkspaceResolver(workspace.NewResolver(func() string { return dir }, mgr.GetWorkspace, nil).Resolve)
	s.setupSessionRoutes(api)
	return s, bc, dir
}

// decodeWorkspace reads the `workspace` object out of a response.
func decodeWorkspace(t *testing.T, rec *httptest.ResponseRecorder) core.Workspace {
	t.Helper()
	var body struct {
		Workspace core.Workspace `json:"workspace"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode workspace from %q: %v", rec.Body.String(), err)
	}
	return body.Workspace
}

// decodeWorkspaces reads the `workspaces` array out of a response.
func decodeWorkspaces(t *testing.T, rec *httptest.ResponseRecorder) []core.Workspace {
	t.Helper()
	var body struct {
		Workspaces []core.Workspace `json:"workspaces"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode workspaces from %q: %v", rec.Body.String(), err)
	}
	return body.Workspaces
}

// A workspace's whole life through the routes: registered as provisioning,
// flipped to ready, listed, then tombstoned — still there, still resolving.
func TestWorkspaceRoutes_RegisterReadyCloseRoundTrip(t *testing.T) {
	s, bc, dir := newWorkspaceTestServer(t)

	rec := pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET workspaces: got %d, want 200", rec.Code)
	}
	// An empty table must serialize as [], not null, so a client can iterate it
	// without sanitizing first.
	if got := rec.Body.String(); !strings.Contains(got, `"workspaces":[]`) {
		t.Fatalf("empty table serialized as %q, want an empty array", got)
	}

	rec = pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q,"label":"feat/tunnels","providerId":"git-worktree"}`, dir))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST workspaces: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	ws := decodeWorkspace(t, rec)
	if ws.ID == "" {
		t.Fatalf("registered workspace has no id: %+v", ws)
	}
	if ws.State != core.WorkspaceStateProvisioning {
		t.Fatalf("state = %q, want a workspace registered before it is built", ws.State)
	}
	if len(bc.workspaces) != 1 || len(bc.workspaces[0]) != 1 {
		t.Fatalf("broadcasts = %v, want one carrying the whole table", bc.workspaces)
	}

	rec = pinboardRequest(t, s, http.MethodPatch, "/api/session/workspaces/"+ws.ID,
		`{"state":"ready","meta":{"treeAdded":true}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH workspace: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if ready := decodeWorkspace(t, rec); ready.State != core.WorkspaceStateReady || ready.Meta["treeAdded"] != true {
		t.Fatalf("patched workspace = %+v, want it ready with the checkpoint kept", ready)
	}

	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	listed := decodeWorkspaces(t, rec)
	if len(listed) != 1 || listed[0].ID != ws.ID || !listed[0].Available {
		t.Fatalf("listed = %+v, want the one ready workspace", listed)
	}

	rec = pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces/"+ws.ID+"/close", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST close: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if closed := decodeWorkspace(t, rec); closed.State != core.WorkspaceStateClosed {
		t.Fatalf("closed workspace = %+v, want a tombstone", closed)
	}

	// The tombstone stays on the table: the id has to keep resolving, or a
	// conversation bound to it is told it is unknown rather than closed.
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	if after := decodeWorkspaces(t, rec); len(after) != 1 || after[0].State != core.WorkspaceStateClosed {
		t.Fatalf("table after close = %+v, want the tombstone kept", after)
	}
	if len(bc.workspaces) != 3 {
		t.Fatalf("%d broadcasts, want one per edit", len(bc.workspaces))
	}
}

// Whether a workspace can host a provider Juggler spawns as a subprocess is the
// workspace's own answer, and every row the browser is handed carries it: the
// register and list responses, the broadcast, and the session load — which
// also carries the project's answer, since the project has no row. The model
// picker reads nothing else, so a row that left it out would make the refusal
// it backs silently never fire.
func TestWorkspaceRoutes_RowsSayWhetherTheyHostLocalProviders(t *testing.T) {
	s, bc, dir := newWorkspaceTestServer(t)

	hosts := func(where string, row map[string]any) {
		t.Helper()
		if row["hostsLocalProviders"] != true {
			t.Errorf("%s: row = %v, want hostsLocalProviders:true for a tree on this machine", where, row)
		}
	}

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q,"state":"ready"}`, dir))
	var registered struct {
		Workspace map[string]any `json:"workspace"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &registered); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	hosts("register", registered.Workspace)

	var listed struct {
		Workspaces []map[string]any `json:"workspaces"`
	}
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed.Workspaces) != 1 {
		t.Fatalf("list = %q (%v), want one row", rec.Body.String(), err)
	}
	hosts("list", listed.Workspaces[0])

	if len(bc.workspaces) == 0 {
		t.Fatal("no workspaces broadcast")
	}
	encoded, err := json.Marshal(bc.workspaces[len(bc.workspaces)-1])
	if err != nil {
		t.Fatal(err)
	}
	var broadcast []map[string]any
	if err := json.Unmarshal(encoded, &broadcast); err != nil || len(broadcast) != 1 {
		t.Fatalf("broadcast = %s (%v), want one row", encoded, err)
	}
	hosts("broadcast", broadcast[0])

	var load struct {
		Workspaces                 []map[string]any `json:"workspaces"`
		ProjectHostsLocalProviders *bool            `json:"projectHostsLocalProviders"`
	}
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &load); err != nil || len(load.Workspaces) != 1 {
		t.Fatalf("session load = %q (%v), want one workspace row", rec.Body.String(), err)
	}
	hosts("session load", load.Workspaces[0])
	if load.ProjectHostsLocalProviders == nil || !*load.ProjectHostsLocalProviders {
		t.Errorf("session load projectHostsLocalProviders = %v, want true: the project is a tree on this machine", load.ProjectHostsLocalProviders)
	}
}

// Unregistering is the rollback path: the workspace was never built, so the row
// goes rather than being tombstoned.
func TestWorkspaceRoutes_UnregisterRemovesTheRow(t *testing.T) {
	s, _, dir := newWorkspaceTestServer(t)

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q}`, dir))
	ws := decodeWorkspace(t, rec)

	rec = pinboardRequest(t, s, http.MethodDelete, "/api/session/workspaces/"+ws.ID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE workspace: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	if after := decodeWorkspaces(t, rec); len(after) != 0 {
		t.Fatalf("table = %+v, want it empty", after)
	}
}

// A request about a workspace that is not there is a 404, not a 400: the client
// asked a well-formed question about something that has gone.
func TestWorkspaceRoutes_UnknownIDIsNotFound(t *testing.T) {
	s, _, _ := newWorkspaceTestServer(t)

	rec := pinboardRequest(t, s, http.MethodPatch, "/api/session/workspaces/ws_nope", `{"label":"ghost"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("PATCH unknown workspace: got %d, want 404", rec.Code)
	}
	rec = pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces/ws_nope/close", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST close of unknown workspace: got %d, want 404", rec.Code)
	}
}

// A tree removed while the app is running stops reading as available.
//
// Availability is otherwise settled at load and on each register or update, so
// a worktree deleted mid-session leaves the flag saying the tree is there.
// Everything that protects the user from a place that has gone keys off that
// one boolean — the rows the setup panel offers, the chip, and the banner that
// tells a bound conversation its tree is not where it was — so a stale true is
// three silent failures at once. Listing re-stats, and broadcasts when the
// answer has moved so that every viewer's mirror is corrected with it.
func TestWorkspaceRoutes_ListRestatsAVanishedRoot(t *testing.T) {
	s, bc, _ := newWorkspaceTestServer(t)

	tree := t.TempDir()
	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q,"label":"feat/tunnels","state":"ready"}`, tree))
	ws := decodeWorkspace(t, rec)
	if !ws.Available {
		t.Fatalf("registered workspace = %+v, want it available while its tree is there", ws)
	}
	edits := len(bc.workspaces)

	if err := os.RemoveAll(tree); err != nil {
		t.Fatalf("removing the tree: %v", err)
	}

	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	listed := decodeWorkspaces(t, rec)
	if len(listed) != 1 || listed[0].ID != ws.ID {
		t.Fatalf("listed = %+v, want the one row still on the table", listed)
	}
	if listed[0].Available {
		t.Fatalf("workspace = %+v, want available:false once its root has gone", listed[0])
	}
	// Unavailable, not closed. A tree can come back — an unmounted disk, a
	// prune somebody regrets — and tombstoning is one-way.
	if listed[0].State != core.WorkspaceStateReady {
		t.Fatalf("state = %q, want it left ready: a missing root is not a tombstone", listed[0].State)
	}
	if len(bc.workspaces) != edits+1 {
		t.Fatalf("%d broadcasts, want one more so every viewer's mirror is corrected", len(bc.workspaces))
	}

	// Nothing has moved on the second look, so nothing is said. This sweep sits
	// on a read path and must stay silent when it has nothing to report, or
	// every list turns into a broadcast to every window.
	pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	if len(bc.workspaces) != edits+1 {
		t.Fatalf("%d broadcasts, want the unchanged re-list to stay quiet", len(bc.workspaces))
	}
}

// Tombstones are capped, so finishing with workspaces cannot grow session.json
// without bound.
//
// A closed row is kept to tell the conversations bound to it what became of
// their workspace, which is worth keeping for the ones somebody might go back
// to and worth nothing for the hundredth. Past the cap the oldest go, and a
// conversation bound to one that has gone falls back to the banner for a
// binding the table has lost — which offers to put it back.
//
// A ready row is never evicted to make room. The cap is on the dead ones; a
// workspace somebody is still working in is not a candidate however full the
// table is.
func TestWorkspaceRoutes_ClosedWorkspacesAreCapped(t *testing.T) {
	s, _, dir := newWorkspaceTestServer(t)

	live := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q,"label":"still-working-here","state":"ready"}`, dir))
	liveID := decodeWorkspace(t, live).ID

	over := core.MaxClosedWorkspaces + 2
	closed := make([]string, 0, over)
	for i := range over {
		rec := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
			fmt.Sprintf(`{"kind":"local","root":%q,"label":"finished-%d","state":"ready"}`, dir, i))
		id := decodeWorkspace(t, rec).ID
		if rec = pinboardRequest(t, s, http.MethodPost,
			"/api/session/workspaces/"+id+"/close", ""); rec.Code != http.StatusOK {
			t.Fatalf("closing workspace %d: got %d (%s)", i, rec.Code, rec.Body.String())
		}
		closed = append(closed, id)
	}

	listed := decodeWorkspaces(t, pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", ""))
	tombstones := make(map[string]bool)
	liveRows := 0
	for _, ws := range listed {
		if ws.State == core.WorkspaceStateClosed {
			tombstones[ws.ID] = true
			continue
		}
		liveRows++
	}

	if len(tombstones) != core.MaxClosedWorkspaces {
		t.Fatalf("%d tombstones kept, want the cap of %d", len(tombstones), core.MaxClosedWorkspaces)
	}
	// Oldest first: the two closed before any others are the two that went.
	for _, gone := range closed[:2] {
		if tombstones[gone] {
			t.Fatalf("workspace %s survived, want the oldest tombstones evicted first", gone)
		}
	}
	for _, kept := range closed[2:] {
		if !tombstones[kept] {
			t.Fatalf("workspace %s was evicted, want the most recent %d kept", kept, core.MaxClosedWorkspaces)
		}
	}
	if liveRows != 1 || listed[0].ID != liveID {
		t.Fatalf("live rows = %d (first %q), want the one ready workspace untouched by the cap",
			liveRows, listed[0].ID)
	}
}

// Reconciling is destructive and only the browser can do it, so exactly one
// viewer per run of the server is told to.
func TestWorkspaceRoutes_ReconcileClaimedOnce(t *testing.T) {
	s, _, _ := newWorkspaceTestServer(t)

	first := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces/reconcile", "")
	second := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces/reconcile", "")

	if !strings.Contains(first.Body.String(), `"reconcile":true`) {
		t.Fatalf("first claim = %q, want it granted", first.Body.String())
	}
	if !strings.Contains(second.Body.String(), `"reconcile":false`) {
		t.Fatalf("second claim = %q, want it refused", second.Body.String())
	}
}

// The table's order is part of the sidebar's arrangement — it is what decides
// between two boxes drawn in the same place, with no conversation between them
// for either to sit behind — so a viewer can write it, and every other viewer
// is told.
func TestWorkspaceRoutes_ReorderWritesTheTableOrder(t *testing.T) {
	s, bc, dir := newWorkspaceTestServer(t)

	first := decodeWorkspace(t, pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q,"state":"ready"}`, dir)))
	second := decodeWorkspace(t, pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q,"state":"ready"}`, dir)))
	broadcasts := len(bc.workspaces)

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces/reorder",
		fmt.Sprintf(`{"ids":[%q,%q]}`, second.ID, first.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST reorder: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	list := decodeWorkspaces(t, rec)
	if len(list) != 2 || list[0].ID != second.ID || list[1].ID != first.ID {
		t.Fatalf("reorder answered %+v, want %s before %s", list, second.ID, first.ID)
	}
	if len(bc.workspaces) != broadcasts+1 {
		t.Fatalf("broadcasts = %d, want one more: a window that was only watching has to be told", len(bc.workspaces))
	}

	// And a plain read agrees, which is what the window told to look again gets.
	listed := decodeWorkspaces(t, pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", ""))
	if len(listed) != 2 || listed[0].ID != second.ID {
		t.Fatalf("list = %+v, want the order just written", listed)
	}
}
