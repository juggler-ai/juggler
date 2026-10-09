//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"errors"
	"net/http"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/workspace"
)

// The workspace table over HTTP. A workspace is where a conversation's tools
// run; the table is the set of them this project has, and it is session state
// like the pinboard — shared by every viewer, not a per-device preference.
//
// These hang off SessionAPI rather than an API of their own because they need
// exactly what it already holds: the session manager and the broadcaster. Every
// mutation broadcasts the whole table, so a second window sees a workspace
// appear, become usable, and be finished with, without asking.

// workspaceID reads the id out of the route, refusing a malformed one rather
// than defaulting. An id arrives from a client that was given it by this server,
// so one that does not look like an id is a bug at the other end.
func workspaceID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := mux.Vars(r)["workspaceId"]
	if id == "" {
		WriteError(w, r, http.StatusBadRequest, "workspace id is required")
		return "", false
	}
	return id, true
}

// workspaceStatus maps a manager error to the status it deserves: an unknown id
// is a request about something that is not there, anything else is a refusal of
// a well-formed request (a closed workspace, a table that is full).
func workspaceStatus(err error) int {
	if errors.Is(err, core.ErrWorkspaceNotFound) {
		return http.StatusNotFound
	}
	return http.StatusBadRequest
}

// SetWorkspaceResolver gives the session load a way to ask the project's own
// workspace what it can host (projectHostsLocalProviders). Without one the load
// leaves that answer out, which the browser reads as yes.
func (api *SessionAPI) SetWorkspaceResolver(resolve workspace.ResolveFunc) {
	api.resolveWorkspace = resolve
}

// projectHostsLocalProviders is the project's answer to the question every row
// answers in Row.HostsLocalProviders: whether a provider Juggler spawns can run
// there. False for ok when there is nothing to ask.
func (api *SessionAPI) projectHostsLocalProviders() (hosts, ok bool) {
	if api.resolveWorkspace == nil {
		return false, false
	}
	ws, err := api.resolveWorkspace(core.DefaultWorkspaceID)
	if err != nil {
		return false, false
	}
	_, hosts = ws.LocalDir()
	return hosts, true
}

// describeOne is one row as the browser is handed it (workspace.Describe).
// Every row that leaves these routes goes through Describe, so each carries
// what its workspace can do.
func describeOne(ws core.Workspace) workspace.Row {
	return workspace.Describe([]core.Workspace{ws})[0]
}

// broadcastWorkspaces publishes the whole table after an edit.
//
// The whole table rather than a diff, on the pinboard's reasoning: it is a
// short, wholly-owned list, and shipping it entire is what lets every viewer
// converge without replaying anyone's operations. It is also what carries the
// provisioning → ready flip to a window that is only watching.
func (api *SessionAPI) broadcastWorkspaces() {
	if api.broadcaster == nil {
		return
	}
	api.broadcaster.BroadcastWorkspacesChanged(workspace.Describe(api.manager().ListWorkspaces()))
}

// HandleListWorkspaces returns every registered workspace.
//
// The default workspace — the project itself — is deliberately not among them.
// It has no row, every client already knows the project path, and putting it in
// the list would make "is this workspace registered" and "is this the project"
// the same question.
// Listing is also when the table's availability is re-checked, and the only
// time it is: a place can go while the app runs, and nothing else looks. The
// broadcast is conditional on something having actually moved, so an unchanged
// list stays a read.
func (api *SessionAPI) HandleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	if api.manager().RefreshWorkspaceAvailability() {
		api.broadcastWorkspaces()
	}
	WriteJSON(w, r, 0, map[string]any{"workspaces": workspace.Describe(api.manager().ListWorkspaces())})
}

// HandleRegisterWorkspace puts a workspace on the table, in the provisioning
// state unless the caller says otherwise, and answers with the row as stored —
// including the id the server assigned it.
//
// It is registered before it is built. A provision that dies half way through
// then leaves a row describing what was started, instead of an unrecorded
// half-made worktree for the user to find months later.
func (api *SessionAPI) HandleRegisterWorkspace(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[core.Workspace](w, r)
	if !ok {
		return
	}
	ws, err := api.manager().RegisterWorkspace(req)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	WriteJSON(w, r, http.StatusOK, map[string]any{"workspace": describeOne(ws)})
	api.broadcastWorkspaces()
}

// HandleUpdateWorkspace applies a patch to one workspace: its label, its root,
// its state, or a key or two of the provider's own record of what it has built.
//
// A patch rather than a whole-row PUT, and meta merged key by key, because the
// heaviest user of this endpoint is a provider checkpointing its progress
// mid-provision. It must be able to write "the tree exists now" without
// restating a row it has not finished building, and without overwriting what a
// second window wrote a moment earlier.
func (api *SessionAPI) HandleUpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	id, ok := workspaceID(w, r)
	if !ok {
		return
	}
	patch, ok := DecodeJSON[core.WorkspacePatch](w, r)
	if !ok {
		return
	}
	ws, err := api.manager().UpdateWorkspace(id, patch)
	if err != nil {
		WriteError(w, r, workspaceStatus(err), err.Error())
		return
	}
	WriteJSON(w, r, http.StatusOK, map[string]any{"workspace": describeOne(ws)})
	api.broadcastWorkspaces()
}

// HandleCloseWorkspace tombstones a workspace. The row stays and the id keeps
// resolving, so a conversation still bound to it is told it was closed rather
// than told it is unknown — which is the message reserved for a binding that is
// genuinely stale.
func (api *SessionAPI) HandleCloseWorkspace(w http.ResponseWriter, r *http.Request) {
	id, ok := workspaceID(w, r)
	if !ok {
		return
	}
	ws, err := api.manager().CloseWorkspace(id)
	if err != nil {
		WriteError(w, r, workspaceStatus(err), err.Error())
		return
	}
	WriteJSON(w, r, http.StatusOK, map[string]any{"workspace": describeOne(ws)})
	api.broadcastWorkspaces()
}

// HandleUnregisterWorkspace removes a row outright — what rolling back a
// provision does, and the one case where forgetting is right: the workspace was
// never built, so nobody can have been bound to it.
func (api *SessionAPI) HandleUnregisterWorkspace(w http.ResponseWriter, r *http.Request) {
	id, ok := workspaceID(w, r)
	if !ok {
		return
	}
	if err := api.manager().UnregisterWorkspace(id); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	WriteSuccess(w, r, nil)
	api.broadcastWorkspaces()
}

// HandleReorderWorkspaces rewrites the order the table is held in.
//
// The table's order is what decides between two boxes drawn in the same place —
// two of them with no conversation between them to sit behind — so it is part
// of the arrangement a user drags the sidebar into, and has to be recorded like
// the rest of it. Ids the table does not have are ignored, and rows the caller
// did not name keep their order behind the ones it did.
func (api *SessionAPI) HandleReorderWorkspaces(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		IDs []string `json:"ids"`
	}](w, r)
	if !ok {
		return
	}
	list, err := api.manager().ReorderWorkspaces(req.IDs)
	if err != nil {
		WriteError(w, r, workspaceStatus(err), err.Error())
		return
	}
	WriteJSON(w, r, http.StatusOK, map[string]any{"workspaces": workspace.Describe(list)})
	api.broadcastWorkspaces()
}

// HandleClaimWorkspaceReconcile answers whether this viewer is the one to
// reconcile the table against what is actually on disk, and answers yes at most
// once per run of the server.
//
// The server cannot do it: reconciling means asking each provider what it can
// find, and providers are extensions, which live in the browser. But there is no
// leader among clients, so without this every open window would run it — and two
// windows would race each other's destructive git commands over the same trees.
// It is a POST rather than a GET because the claim is spent by asking.
func (api *SessionAPI) HandleClaimWorkspaceReconcile(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, http.StatusOK, map[string]any{"reconcile": api.manager().ClaimWorkspaceReconcile()})
}
