//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/internal/jlog"

	"github.com/gorilla/mux"
)

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }

// SessionAPI handles session-related HTTP endpoints. The current
// SessionManager is fetched through a provider func so runtime project
// switches transparently retarget all session I/O.
type SessionAPI struct {
	managerProvider func() *core.SessionManager
	workerManager   WorkerManager
	broadcaster     Broadcaster
	// closeConversation releases provider-side resources for a deleted
	// conversation (Conversation cache entries, CLI subprocesses, etc.).
	// Set by the server at construction; may be nil in setups that don't
	// run an LLM-call pipeline.
	closeConversation   func(conversationID string)
	resolveDefaultModel func(ctx context.Context) (core.ModelRef, bool)

	// Test-mode conversation-ownership hooks (all nil in production). In the
	// multi-lane test pool every lane shares one session, so creates tagged
	// with ?lane= record ownership and deletes are checked against it — a
	// cross-lane delete tears down a live test's worker mid-test and is
	// rejected with 403 instead of trusted to never happen. Wired by
	// RegisterTestRoutes from the testing package's ConvOwnership ledger.
	recordConvOwner  func(convID, lane, reason string)
	checkConvDelete  func(convID, lane string) error
	releaseConvOwner func(convID string)
}

// SetConvOwnershipHooks wires the test-mode ownership ledger. Production
// never calls this, leaving the hooks nil (no recording, no enforcement).
func (api *SessionAPI) SetConvOwnershipHooks(
	record func(convID, lane, reason string),
	check func(convID, lane string) error,
	release func(convID string),
) {
	api.recordConvOwner = record
	api.checkConvDelete = check
	api.releaseConvOwner = release
}

// WorkerManager interface for worker cleanup during conversation deletion.
// Uses an interface to avoid circular import with worker package.
type WorkerManager interface {
	// Remove stops the worker and blocks the conversation from loading another
	// one, so a client message in flight during the folder move cannot recreate
	// it. Only ConversationRestored lifts that block.
	Remove(conversationID string)
	// ConversationRestored re-admits a conversation brought back out of the bin.
	ConversationRestored(conversationID string)
	// RemoveAndPurgeLogs is Remove plus deletion of the conversation's
	// per-conversation log file(s) — for a PERMANENT delete only, never a bin.
	RemoveAndPurgeLogs(conversationID string)
	// FlushConversation persists the (loaded) worker's doc to disk before an
	// out-of-band file read such as the server-side duplicate. No-op if unloaded.
	FlushConversation(conversationID string) error
	// SnapshotParkedState returns an in-memory, race-free doc snapshot of a loaded
	// worker (ok=true), marked so the clone loads stopped instead of auto-resuming
	// an in-flight tool. Lets a duplicate copy a conversation that is mid-turn —
	// where FlushConversation would block on the busy run loop. ok=false when no
	// worker is loaded, in which case the on-disk doc is authoritative.
	SnapshotParkedState(conversationID string) ([]byte, bool)
	// SeedNewConversation initializes and saves a brand-new conversation's Yjs doc
	// before it is announced to clients, so every viewer loads a doc with the
	// authoritative creation metadata already present.
	SeedNewConversation(conversationID, name, projectPath, created string, model *core.ModelRef) error
	// RenameLog tells the loaded worker (if any) to move its per-conversation log
	// file to match the conversation's new name. No-op if unloaded.
	RenameLog(conversationID string)
}

// Broadcaster lets the API notify all connected clients of session-level
// changes so engine and other viewers can apply the change locally.
//
// `BroadcastSessionChanged` is for messageHistory + metadata sync only
// (PUT /session). It has no conversation-list semantics — any
// conversation-list mutation (create/delete/rename/bin/restore/
// bin-delete/bin-emptied) MUST go through `BroadcastConversationsChanged`.
//
// `BroadcastConversationsChanged` carries every per-conversation mutation
// as `{op, id, name?}` — a single op-tagged diff event with the minimum
// payload needed to apply it idempotently. Clients run the op against
// their local model — no full session re-fetch — which keeps in-flight
// selection/UI state from being clobbered. Valid ops: "created",
// "deleted", "renamed", "binned", "restored", "binned-deleted",
// "bin-emptied". `name` is the canonical folder name and is supplied for
// "created", "renamed", and "restored"; empty otherwise.
//
// `BroadcastConversationsReordered` carries a drag-reorder as the full new
// id order. It rides the same `conversations-changed` event type with
// `op:"reordered"` and an `order:[id,...]` payload.
//
// `BroadcastConversationFocus` asks every viewer to switch to a conversation.
// It rides the same event type with `op:"focus"` plus a `from` id naming the
// conversation that requested the switch, so each viewer can decide whether to
// follow (see ConversationSyncReducer.focus, web/js/model/conversation-sync-reducer.js).
//
// `BroadcastPinboardChanged` carries the whole board after an edit, named by the
// board it is. Unlike the conversation list there is no per-op diff on the wire:
// a board is a short, wholly-owned list, and shipping it entire is what lets
// every viewer of it converge on the same order without replaying anyone's
// operations. The name is what a viewer needs to ignore the boards it is not
// showing — a project has several, and each document reads exactly one.
//
// `BroadcastPinboardReveal` is the separate, advisory presentation request that
// may accompany an edit. `from` names the conversation that asked, so each
// viewer can decline to move when it is elsewhere or has a draft in progress.
// Keeping it separate from the composition event means ordinary pinboard edits
// never acquire presentation side effects.
//
// `BroadcastWorkspacesChanged` carries the whole workspace table after an edit,
// on the same reasoning as the board: it is short, wholly owned here, and
// shipping it entire is what converges every viewer without replaying
// operations. It is also how a window that is merely watching learns that a
// workspace another window was provisioning has become usable.
type Broadcaster interface {
	BroadcastSessionChanged()
	BroadcastSessionMetadataChanged(metadata map[string]any)
	BroadcastWorkspacesChanged(workspaces []core.Workspace)
	BroadcastConversationsChanged(op, id, name string)
	BroadcastConversationsReordered(order []string)
	BroadcastConversationFocus(id, from string)
	BroadcastPinboardChanged(board string, pins []core.Pin)
	BroadcastPinboardReveal(board, pin, from string)
}

// NewSessionAPI creates a new session API handler. managerProvider must
// return the current SessionManager on each call. broadcaster may be nil
// in setups that don't need cross-client notifications. closeConversation
// is an optional hook the server uses to release per-conversation provider
// resources (Conversation cache, CLI subprocesses); nil is treated as a
// no-op. resolveDefaultModel may be nil in setups (e.g. tests) that don't
// resolve a default model.
func NewSessionAPI(
	managerProvider func() *core.SessionManager,
	workerManager WorkerManager,
	broadcaster Broadcaster,
	closeConversation func(string),
	resolveDefaultModel func(context.Context) (core.ModelRef, bool),
) *SessionAPI {
	return &SessionAPI{
		managerProvider:     managerProvider,
		workerManager:       workerManager,
		broadcaster:         broadcaster,
		closeConversation:   closeConversation,
		resolveDefaultModel: resolveDefaultModel,
	}
}

// manager returns the current SessionManager.
func (api *SessionAPI) manager() *core.SessionManager { return api.managerProvider() }

// windowRole is which of this project's windows a request is about, defaulting
// to the main window, which is what a caller naming no role means.
//
// Geometry and appearance both use it: a detached board keeps its own frame, its
// own theme and its own zoom, all in the one slot named by this role.
func windowRole(r *http.Request) string {
	if role := r.URL.Query().Get("role"); role != "" {
		return role
	}
	return core.WindowRoleMain
}

// HandleGetWindowState returns the native-window geometry saved in this
// project's session for the requested window role, so the desktop app can reopen
// that window where the user left it. Geometry is per-project session state and
// travels with the session. `hasState` is false when this project has never
// saved one for that role (first open, or a no-project window).
func (api *SessionAPI) HandleGetWindowState(w http.ResponseWriter, r *http.Request) {
	ws, ok := api.manager().GetWindowState(windowRole(r))
	WriteJSON(w, r, 0, map[string]any{"windowState": ws, "hasState": ok})
}

// HandleSetWindowState persists the native-window geometry for one window role
// into this project's session. The desktop app posts it (debounced) as the user
// moves/resizes the window and once more at close. A no-project session no-ops
// (see SessionManager.SetWindowState).
func (api *SessionAPI) HandleSetWindowState(w http.ResponseWriter, r *http.Request) {
	ws, ok := DecodeJSON[core.WindowState](w, r)
	if !ok {
		return
	}
	if err := api.manager().SetWindowState(windowRole(r), ws); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	WriteSuccess(w, r, nil)
}

// boardID is which of this project's boards a request is about, defaulting to
// the docked panel, which is what a caller naming none means.
//
// A malformed id is refused rather than defaulted. Board ids are minted by the
// client and travel in a window's URL, so one that arrives misspelt is a bug at
// the other end, and quietly editing the main board instead would answer it by
// rearranging the panel the user was looking at.
func boardID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.URL.Query().Get("board")
	if id == "" {
		return core.MainBoardID, true
	}
	if !core.ValidBoardID(id) {
		WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("invalid board id %q", id))
		return "", false
	}
	return id, true
}

// HandleGetPinboard returns one board's composition: the ordered pins of the
// docked panel, or of the window named by `?board=`. Presentation — which tab is
// active, how wide the panel is, whether it is open at all — is deliberately
// absent. That is per-viewer state, and a laptop and a detached display must not
// fight over it.
func (api *SessionAPI) HandleGetPinboard(w http.ResponseWriter, r *http.Request) {
	board, ok := boardID(w, r)
	if !ok {
		return
	}
	WriteJSON(w, r, 0, map[string]any{"board": board, "pins": api.manager().GetPinboard(board)})
}

// HandlePinboardOperations applies a batch of semantic edits (add, remove, move,
// update) to one board and returns the resulting composition.
//
// Operations rather than a whole-board PUT, and no revision: each op names the pin
// it acts on, so two viewers editing at once merge on the actor goroutine instead
// of one of them being told its write was stale. Ops are idempotent, so a client
// that retries after a dropped response cannot duplicate a pin.
func (api *SessionAPI) HandlePinboardOperations(w http.ResponseWriter, r *http.Request) {
	board, ok := boardID(w, r)
	if !ok {
		return
	}
	req, ok := DecodeJSON[struct {
		Operations []core.PinboardOp `json:"operations"`
		Reveal     *struct {
			Pin  string `json:"pin"`
			From string `json:"from,omitempty"`
		} `json:"reveal,omitempty"`
	}](w, r)
	if !ok {
		return
	}
	if len(req.Operations) == 0 {
		WriteError(w, r, http.StatusBadRequest, "operations is required")
		return
	}
	pins, err := api.manager().ApplyPinboardOps(board, req.Operations)
	if err != nil {
		// A rejected batch is a malformed request, not a server fault: the ops
		// describe pins that can't exist, or more of them than the board holds.
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	WriteJSON(w, r, http.StatusOK, map[string]any{"board": board, "pins": pins})
	if api.broadcaster != nil {
		api.broadcaster.BroadcastPinboardChanged(board, pins)
		if req.Reveal != nil {
			pin := strings.TrimSpace(req.Reveal.Pin)
			from := strings.TrimSpace(req.Reveal.From)
			if from != "" {
				for _, candidate := range pins {
					if candidate.ID == pin {
						api.broadcaster.BroadcastPinboardReveal(board, pin, from)
						break
					}
				}
			}
		}
	}
}

// HandleClaimBoardSeed answers whether this viewer is the one to lay out the
// board's starting tabs, and answers yes at most once in a board's life.
//
// The server holds no list of what those tabs are: a pin's type belongs to an
// extension, and the session knows one only as an opaque string. So the client
// asks whether it is its place to furnish the board, and lays out its own list if
// told yes. It is a POST rather than a GET because the claim is spent by asking.
func (api *SessionAPI) HandleClaimBoardSeed(w http.ResponseWriter, r *http.Request) {
	board, ok := boardID(w, r)
	if !ok {
		return
	}
	WriteJSON(w, r, http.StatusOK, map[string]any{"board": board, "seed": api.manager().ClaimBoardSeed(board)})
}

// HandleCreateBoard records a board for a window being detached: its own
// composition, seeded with what the panel it came out of was showing, and tied
// to the conversation it is a view of.
//
// The id is minted by the client, like a pin's and for the same reason — a
// detach whose response went missing can be retried without opening a second
// board for the same window.
func (api *SessionAPI) HandleCreateBoard(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		ID           string     `json:"id"`
		Conversation string     `json:"conversation"`
		Pins         []core.Pin `json:"pins"`
	}](w, r)
	if !ok {
		return
	}
	board, err := api.manager().CreateBoard(req.ID, req.Conversation, req.Pins)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	WriteJSON(w, r, http.StatusOK, map[string]any{"board": board})
}

// HandleDeleteBoard forgets a board and the frame of the window that held it —
// what closing that window on purpose means. The docked panel cannot be deleted.
func (api *SessionAPI) HandleDeleteBoard(w http.ResponseWriter, r *http.Request) {
	board, ok := boardID(w, r)
	if !ok {
		return
	}
	if err := api.manager().DeleteBoard(board); err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	WriteSuccess(w, r, nil)
}

// HandleRestoreBoards answers with the detached boards left over from the last
// run of this server — the windows that were open when Juggler was shut — and
// answers only once.
//
// Once, because the answer is an instruction to open windows: every main window
// of a project asks as soon as it knows its own address, and a project can have
// several. It is a POST rather than a GET for the same reason. Nothing is
// changed on disk; what is spent is the claim.
func (api *SessionAPI) HandleRestoreBoards(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, http.StatusOK, map[string]any{"boards": api.manager().ClaimDetachedBoards()})
}

// HandleGetUIZoom returns the UI zoom (root font-size %) saved for the window
// making the request, so a reopened window paints at the size the user left it.
// A window that has never been zoomed itself is answered with the project's
// zoom, and `hasZoom` is false only when neither exists (first open, or a
// no-project window), letting the client fall back to an inherited seed or the
// default.
func (api *SessionAPI) HandleGetUIZoom(w http.ResponseWriter, r *http.Request) {
	zoom, ok := api.manager().GetWindowUIZoom(windowRole(r))
	WriteJSON(w, r, 0, map[string]any{"uiZoom": zoom, "hasZoom": ok})
}

// HandleSetUIZoom persists the UI zoom of one window into this project's
// session. A desktop window PUTs it when the user zooms (and when a brand-new
// window inherits a size), naming itself with ?role= so two windows of the same
// project keep two sizes. A no-project session no-ops (see
// SessionManager.SetWindowUIZoom). The route is wrapped in localViewerOnly: a
// remote viewer reads this value as its starting point but keeps its own size on
// its own device, so it never reaches here.
func (api *SessionAPI) HandleSetUIZoom(w http.ResponseWriter, r *http.Request) {
	body, ok := DecodeJSON[struct {
		UIZoom int `json:"uiZoom"`
	}](w, r)
	if !ok {
		return
	}
	if err := api.manager().SetWindowUIZoom(windowRole(r), body.UIZoom); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	WriteSuccess(w, r, nil)
}

// HandleGetUITheme returns the UI theme mode (system|light|dark) saved for the
// window making the request, so a reopened window paints in the theme the user
// left it. A window that has never been restyled itself is answered with the
// project's theme, and `hasTheme` is false only when neither exists (first open,
// or a no-project window), letting the client fall back to an inherited seed or
// the default.
func (api *SessionAPI) HandleGetUITheme(w http.ResponseWriter, r *http.Request) {
	mode, ok := api.manager().GetWindowUITheme(windowRole(r))
	WriteJSON(w, r, 0, map[string]any{"uiTheme": mode, "hasTheme": ok})
}

// HandleSetUITheme persists one window's UI theme mode into this project's
// session. A desktop window PUTs it when the user changes theme (and when a
// brand-new window inherits one), naming itself with ?role= so two boards
// detached from the same project can wear two different themes and each come
// back the way it was left. A no-project session no-ops (see
// SessionManager.SetWindowUITheme), and the route is wrapped in localViewerOnly
// exactly as the zoom route is.
func (api *SessionAPI) HandleSetUITheme(w http.ResponseWriter, r *http.Request) {
	body, ok := DecodeJSON[struct {
		UITheme string `json:"uiTheme"`
	}](w, r)
	if !ok {
		return
	}
	if err := api.manager().SetWindowUITheme(windowRole(r), body.UITheme); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	WriteSuccess(w, r, nil)
}

// uiPrefScopeProject is the ?scope= value naming the realm every window of the
// project shares. Anything else — including no scope at all — means the window
// making the request, which is what almost every preference wants.
const uiPrefScopeProject = "project"

// HandleGetUIPrefs returns the UI preferences stored for the window making the
// request, or for the project when ?scope=project. One round trip answers with
// the whole map, so a page hydrates everything it needs at boot rather than
// asking per preference.
//
// The values are opaque: the server stores what the viewer sent it and hands it
// back. A realm with nothing in it is answered with an empty object rather than
// null, so the client has one shape to read.
func (api *SessionAPI) HandleGetUIPrefs(w http.ResponseWriter, r *http.Request) {
	var prefs map[string]json.RawMessage
	if r.URL.Query().Get("scope") == uiPrefScopeProject {
		prefs = api.manager().GetSessionUIPrefs()
	} else {
		prefs = api.manager().GetWindowUIPrefs(windowRole(r))
	}
	if prefs == nil {
		prefs = map[string]json.RawMessage{}
	}
	WriteJSON(w, r, 0, map[string]any{"ui": prefs})
}

// HandleSetUIPrefs merges a patch into one realm's stored preferences. The
// viewer PUTs the preference it has just changed, so a key the body omits is
// left alone and a null value deletes one.
//
// A patch the server will not store — too many keys, a value too big — is the
// caller's fault rather than a storage failure, so it is answered 400 and
// nothing at all is written. The route is wrapped in localViewerOnly: a remote
// viewer reads these as its starting point but keeps its own on its own device.
func (api *SessionAPI) HandleSetUIPrefs(w http.ResponseWriter, r *http.Request) {
	body, ok := DecodeJSON[struct {
		UI map[string]json.RawMessage `json:"ui"`
	}](w, r)
	if !ok {
		return
	}
	var err error
	if r.URL.Query().Get("scope") == uiPrefScopeProject {
		err = api.manager().MergeSessionUIPrefs(body.UI)
	} else {
		err = api.manager().MergeWindowUIPrefs(windowRole(r), body.UI)
	}
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, core.ErrUIPrefsRejected) {
			status = http.StatusBadRequest
		}
		WriteError(w, r, status, err.Error())
		return
	}
	WriteSuccess(w, r, nil)
}

// HandleGetSession retrieves the session with runtime info
func (api *SessionAPI) HandleGetSession(w http.ResponseWriter, r *http.Request) {
	sess := api.manager().GetSession()
	runtime := api.manager().GetRuntimeInfo()

	response := map[string]any{
		"version":              sess.Version,
		"projectPath":          runtime.ProjectPath,
		"platform":             runtime.Platform,
		"home":                 runtime.Home,
		"conversationOrder":    sess.ConversationOrder,
		"conversationNames":    api.manager().ConvNames(),
		"activeConversationId": sess.ActiveConversationID,
		"messageHistory":       sess.MessageHistory,
		"metadata":             sess.Metadata,
		"workspaces":           api.manager().ListWorkspaces(),
		// What each KIND of workspace can do, which the rows themselves do not
		// say. Sent once beside the table, because kinds are registered at
		// startup and cannot change under a running client — unlike the table,
		// which is republished on every edit.
		"workspaceKinds": ops.WorkspaceKindCapabilities(),
		"binnedCount":    len(api.manager().ListBinnedConversations()),
		"binSizeBytes":   api.manager().BinSizeBytes(),
	}

	WriteJSON(w, r, 0, response)
}

// HandleUpdateSession replaces the session-level state the viewer owns: the
// active conversation, message history and metadata. No validation — the
// frontend manages their structure.
func (api *SessionAPI) HandleUpdateSession(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		ActiveConversationID string            `json:"activeConversationId"`
		MessageHistory       []json.RawMessage `json:"messageHistory"`
		Metadata             map[string]any    `json:"metadata"`
	}](w, r)
	if !ok {
		return
	}

	// All mutation runs inside the session actor (see SessionManager.Update):
	// the live session never escapes to this HTTP goroutine, so concurrent
	// PUT/PATCH/GET requests can't race its maps and slices.
	if err := api.manager().Update(func(sess *core.Session) error {
		// ConversationOrder is owned by the create / reorder / delete /
		// archive endpoints and the on-load reconcile, not this PUT.
		sess.ActiveConversationID = req.ActiveConversationID

		if req.MessageHistory != nil {
			sess.MessageHistory = req.MessageHistory
		}

		if req.Metadata != nil {
			sess.Metadata = req.Metadata
		}
		return nil
	}); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandlePatchSessionMetadata applies a targeted JSON metadata patch to the
// session manifest. It is intentionally narrower than PUT /session: callers can
// update project/session-scoped UI state without serializing conversation state
// or clobbering unrelated metadata keys.
func (api *SessionAPI) HandlePatchSessionMetadata(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Metadata map[string]any `json:"metadata"`
	}](w, r)
	if !ok {
		return
	}
	if req.Metadata == nil {
		WriteError(w, r, http.StatusBadRequest, "metadata is required")
		return
	}

	// The read-modify-write of the metadata map must happen inside the session
	// actor: mutating the shared map from this HTTP goroutine races concurrent
	// PATCH/PUT/GET handlers and trips Go's fatal "concurrent map writes"
	// detector, killing the whole server under load.
	changed, err := api.manager().PatchMetadata(req.Metadata)
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	WriteJSON(w, r, http.StatusOK, map[string]any{"metadata": changed})
	if api.broadcaster != nil {
		api.broadcaster.BroadcastSessionMetadataChanged(changed)
	}
}

// HandleCreateConversation atomically creates a new conversation: uses the
// optional requested id or picks one server-side, creates its on-disk folder
// with the collision-resolved canonical name, and appends the id to
// ConversationOrder. Returns {id, name, created} where `name` is the canonical
// name actually written to disk and is the single source of truth for the
// conversation's display name.
func (api *SessionAPI) HandleCreateConversation(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Name string `json:"name"`
		ID   string `json:"id"`
		// DuplicateFrom, when set, makes this create a clone: the server copies
		// the source conversation's doc.yjs + txns into the new folder BEFORE
		// the conversation is announced (broadcast/returned), so no client ever
		// observes an empty clone. This replaces the old worker→worker copy,
		// which raced the clone's own worker writing an empty doc over it.
		DuplicateFrom string `json:"duplicateFrom"`
		// Origin is a client-supplied gesture label (plus-button, slash-command,
		// initial-bootstrap, duplicate, copy-items, promote-thread, …). It is
		// logged for create attribution: static analysis proves every create is a
		// user-reachable gesture, but the bare "created conv=…" line names no
		// source, so a "phantom" tab is otherwise untraceable. Purely diagnostic.
		Origin string `json:"origin"`
		// Focus, when set, makes the server broadcast an extra "focus" op after
		// "created" asking viewers to switch to the new conversation. The creating
		// client is the engine (headless, no tab of its own) — e.g. the
		// new_conversation tool — which cannot move viewer focus locally because
		// visibleConversationId is per-client state. A plain viewer gesture
		// (plus-button, /new) omits this and activates its own tab locally.
		Focus bool `json:"focus"`
		// FocusFrom names the conversation that asked for the switch. It rides
		// the "focus" op so each viewer can decide whether to follow: a viewer
		// watching a different tab, or mid-message in the requesting one, keeps
		// its place. Empty means unattributed — viewers follow unconditionally.
		FocusFrom string `json:"focusFrom"`
		// Place and After say where the new conversation goes in
		// ConversationOrder. The order is the server's and is broadcast on every
		// create, so this is the only way a viewer's placement outlives its own
		// create: a conversation started in a workspace box belongs beside the
		// rest of that box, not at the head of the bar where a create goes when
		// told nothing.
		//
		// Place is "head", "after" or "end"; After names the conversation to sit
		// behind, for "after". A request carrying only After is read the way it
		// reads: behind that conversation, or at the head when it is empty.
		Place string `json:"place"`
		After string `json:"after"`
	}](w, r)
	if !ok {
		return
	}

	id, finalName, err := api.manager().CreateConversationAt(
		req.Name, req.ID, core.PlacementFor(req.Place, req.After))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, core.ErrInvalidConvID) {
			status = http.StatusBadRequest
		} else if errors.Is(err, core.ErrConvIDExists) {
			status = http.StatusConflict
		}
		WriteError(w, r, status, err.Error())
		return
	}

	// Attribute the create: which gesture, from which client. This is the only
	// record that can name the source of a "phantom" Task-N tab after the fact
	// (RemoteAddr's source port distinguishes concurrent windows on localhost;
	// the User-Agent separates the desktop app from a browser).
	origin := req.Origin
	if origin == "" {
		origin = "unspecified"
	}
	jlog.Info("[session.Create] conv=%s name=%q origin=%s dup=%q remote=%s ua=%q lane=%q",
		id, finalName, origin, req.DuplicateFrom, r.RemoteAddr, r.UserAgent(), r.URL.Query().Get("lane"))

	if req.DuplicateFrom != "" {
		if err := api.duplicateConversationFiles(req.DuplicateFrom, id); err != nil {
			jlog.Error("[session.Duplicate] conv=%s → %s failed: %v", req.DuplicateFrom, id, err)
			WriteError(w, r, http.StatusInternalServerError, "Couldn't duplicate conversation: "+err.Error())
			return
		}
		jlog.Info("[session.Duplicate] conv=%s → %s (server-side file copy)", req.DuplicateFrom, id)
	}

	created := nowRFC3339()
	if req.DuplicateFrom == "" && api.workerManager != nil {
		var model *core.ModelRef
		if api.resolveDefaultModel != nil {
			if ref, _ := api.resolveDefaultModel(r.Context()); ref.Provider != "" && ref.Model != "" {
				model = &ref
			}
		}
		projectPath := ""
		if mgr := api.manager(); mgr != nil {
			projectPath = mgr.GetProjectPath()
		}
		if err := api.workerManager.SeedNewConversation(id, finalName, projectPath, created, model); err != nil {
			jlog.Error("[session.Create] seed conv=%s failed: %v", id, err)
			WriteError(w, r, http.StatusInternalServerError, "Couldn't initialize conversation: "+err.Error())
			return
		}
	}

	// Test mode: record which lane created this conversation so the delete
	// guard can reject cross-lane deletes, tagged with ?reason= (the creating
	// test's name) so a suite-end leak dump names the culprit. Production sends
	// no lane and has nil hooks — both make this a no-op.
	if api.recordConvOwner != nil {
		api.recordConvOwner(id, r.URL.Query().Get("lane"), r.URL.Query().Get("reason"))
	}

	WriteJSON(w, r, http.StatusCreated, map[string]any{
		"id":      id,
		"name":    finalName,
		"created": created,
	})

	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsChanged("created", id, finalName)
		// A headless creator (the engine, via the new_conversation tool) asked
		// viewers to switch to this conversation. Sent right after "created" so
		// viewers that just built the tab can focus it; the engine ignores
		// conversations-changed, so it never self-focuses. FocusFrom names the
		// requesting conversation — each viewer applies its own follow policy.
		if req.Focus {
			api.broadcaster.BroadcastConversationFocus(id, req.FocusFrom)
		}
	}
}

// duplicateConversationFiles clones a source conversation's persisted state
// into the already-created destination folder, with no cross-worker writes, so
// the destination is complete before it is announced. What a folder holds, and
// so what a clone carries, is core.CloneConvFolder's to say; this decides only
// which copy of the document is current.
func (api *SessionAPI) duplicateConversationFiles(srcID, dstID string) error {
	mgr := api.manager()
	srcDir, ok := mgr.ConvDir(srcID)
	if !ok {
		return fmt.Errorf("source conversation %s not found", srcID)
	}
	dstDir, ok := mgr.ConvDir(dstID)
	if !ok {
		return fmt.Errorf("destination conversation %s not found", dstID)
	}
	doc, err := api.cloneDocSource(srcID)
	if err != nil {
		return err
	}
	return core.CloneConvFolder(srcDir, dstDir, doc)
}

// cloneDocSource chooses the current copy of a source's document for a clone.
// A loaded worker may be mid-turn, where FlushConversation would block on the
// run loop (its inner selects don't drain the flush queue); so when one is loaded, it
// returns an in-memory parked snapshot instead, race-free (ycrdtMu) and marked
// so the clone loads stopped. With no worker loaded, the on-disk doc is
// authoritative: it flushes (a no-op) and returns nil, which tells the clone to
// copy the file. Split from duplicateConversationFiles so the source selection
// is unit-testable without a SessionManager.
func (api *SessionAPI) cloneDocSource(srcID string) ([]byte, error) {
	if api.workerManager == nil {
		return nil, nil
	}
	if snap, ok := api.workerManager.SnapshotParkedState(srcID); ok {
		return snap, nil
	}
	if err := api.workerManager.FlushConversation(srcID); err != nil {
		return nil, fmt.Errorf("flush source worker: %w", err)
	}
	return nil, nil
}

// ConvIDFromVars extracts the {convId} route variable. On a missing/empty id it
// writes a 400 response and returns ok=false, so callers can `if !ok { return }`.
func ConvIDFromVars(w http.ResponseWriter, r *http.Request) (string, bool) {
	convID := mux.Vars(r)["convId"]
	if convID == "" {
		WriteError(w, r, http.StatusBadRequest, "Conversation ID is required")
		return "", false
	}
	return convID, true
}

// HandleGetConversation retrieves a single conversation's binary data
func (api *SessionAPI) HandleGetConversation(w http.ResponseWriter, r *http.Request) {
	convID, ok := ConvIDFromVars(w, r)
	if !ok {
		return
	}

	yjsData, err := api.manager().LoadConversationBinary(convID)
	if err != nil {
		WriteError(w, r, http.StatusNotFound, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	if _, err := w.Write(yjsData); err != nil {
		WriteError(w, r, http.StatusInternalServerError, "Couldn't write response")
	}
}

// assetSHARe matches a lowercase hex SHA-256 (exactly 64 hex chars). The asset
// id IS the file's content hash, so this is the path-traversal guard: the {sha}
// path segment is never used to build a filesystem path unless it matches.
var assetSHARe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// HandleGetAsset streams a content-addressed binary asset (e.g. an attached
// image) from <convDir>/assets/<sha>.<ext>. Assets are immutable — the
// filename is the content hash — so the response is cached aggressively.
func (api *SessionAPI) HandleGetAsset(w http.ResponseWriter, r *http.Request) {
	convID, ok := ConvIDFromVars(w, r)
	if !ok {
		return
	}
	sha := mux.Vars(r)["sha"]
	if !assetSHARe.MatchString(sha) {
		WriteError(w, r, http.StatusBadRequest, "Invalid asset id")
		return
	}
	convDir, ok := api.manager().ConvDir(convID)
	if !ok {
		WriteError(w, r, http.StatusNotFound, "Conversation not found")
		return
	}

	// sha is validated hex, so the glob can only match this conversation's
	// own assets/<sha>.<ext> — no traversal possible.
	var assetPath string
	matches, _ := filepath.Glob(filepath.Join(core.ConvAssetsDir(convDir), sha+".*"))
	for _, m := range matches {
		if strings.HasSuffix(m, ".tmp") {
			continue
		}
		assetPath = m
		break
	}
	if assetPath == "" {
		WriteError(w, r, http.StatusNotFound, "Asset not found")
		return
	}

	f, err := os.Open(assetPath)
	if err != nil {
		WriteError(w, r, http.StatusNotFound, "Asset not found")
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", assetContentType(assetPath))
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, filepath.Base(assetPath), time.Time{}, f)
}

// assetContentType derives the response mime type from a stored asset's file
// extension. Unknown extensions fall back to a generic binary type.
func assetContentType(path string) string {
	switch strings.ToLower(strings.TrimPrefix(filepath.Ext(path), ".")) {
	case "png":
		return "image/png"
	case "jpeg", "jpg":
		return "image/jpeg"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	default:
		return "application/octet-stream"
	}
}

// HandleUpdateConversation updates a single conversation (binary Yjs format)
func (api *SessionAPI) HandleUpdateConversation(w http.ResponseWriter, r *http.Request) {
	convID, ok := ConvIDFromVars(w, r)
	if !ok {
		return
	}

	contentType := r.Header.Get("Content-Type")

	if contentType == "application/octet-stream" {
		yjsData, err := io.ReadAll(r.Body)
		if err != nil {
			WriteError(w, r, http.StatusBadRequest, "Couldn't read request body")
			return
		}

		// Owned-only save, matching the worker persistence seam (SetSaveBinary →
		// SaveConversationBinaryIfOwned). Refuse to fabricate a folder for an id
		// this project no longer owns: a late PUT for a binned/deleted
		// conversation — e.g. from a lagging view after a store reload, where the
		// in-memory deletedIDs guard no longer holds the id — would otherwise
		// recreate an "Untitled--<id>" ghost folder that reappears as a phantom
		// tab. Unowned is a benign no-op (the owning project persists the doc when
		// it is the loaded project).
		saved, err := api.manager().SaveConversationBinaryIfOwned(convID, yjsData)
		if err != nil {
			WriteError(w, r, http.StatusInternalServerError, err.Error())
			return
		}
		if !saved {
			jlog.Debug("[session.Update] skipped unowned conv=%s (not in loaded project)", convID)
		}
	} else {
		WriteError(w, r, http.StatusBadRequest, "Only binary format (application/octet-stream) is supported")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandleDeleteConversation deletes a single conversation
func (api *SessionAPI) HandleDeleteConversation(w http.ResponseWriter, r *http.Request) {
	convID, ok := ConvIDFromVars(w, r)
	if !ok {
		return
	}

	// ?permanent=true signals test/programmatic teardown: use os.RemoveAll
	// instead of the OS trash, so tests don't flood the user's Recycle Bin.
	permanent := r.URL.Query().Get("permanent") == "true"

	// Attribute every delete to its requester. In the multi-lane test pool a
	// delete tears the worker down for every lane, so when one lane's
	// conversation dies mid-test the ?lane=/?reason= tags are what identify
	// the actor.
	lane := r.URL.Query().Get("lane")
	jlog.Info("[session.Delete] conv=%s permanent=%v lane=%q reason=%q t=%s",
		convID, permanent, lane, r.URL.Query().Get("reason"), nowRFC3339())

	// Test mode: a conversation may only be deleted by the lane that created
	// it. Anything else is the cross-lane bulldoze bug — it would tear down
	// a live test's worker mid-turn — so reject it before any teardown.
	if api.checkConvDelete != nil {
		if err := api.checkConvDelete(convID, lane); err != nil {
			jlog.Error("[session.Delete] REJECTED: %v", err)
			WriteError(w, r, http.StatusForbidden, err.Error())
			return
		}
	}

	// Stop the Go worker BEFORE deleting files to prevent orphaned workers, and
	// have it delete this conversation's per-conversation log(s) on the way down
	// (the conversation is gone for good, so its logs should go too).
	if api.workerManager != nil {
		api.workerManager.RemoveAndPurgeLogs(convID)
	}

	// Release per-conversation provider resources (Conversation cache
	// entries, CLI subprocesses, etc.). Goes through the server-supplied
	// hook so we don't tie this package to specific providers.
	if api.closeConversation != nil {
		api.closeConversation(convID)
	}

	if err := api.manager().DeleteConversation(convID, permanent); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	// The conversation is gone; release its ownership so the suite-end leak
	// dump only reports conversations that genuinely outlived their test.
	if api.releaseConvOwner != nil {
		api.releaseConvOwner(convID)
	}

	w.WriteHeader(http.StatusNoContent)

	// Notify viewers + engine so they drop the conversation locally.
	// Without this, the engine retains stale conversation state across the
	// test suite, accumulating workers and observers indefinitely.
	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsChanged("deleted", convID, "")
	}
}

// HandleBinConversation moves a conversation to .juggler/bin/.
// Tears down the worker and provider-side resources like Delete does;
// unlike a permanent delete, the folder is preserved so it can be restored
// (it lingers in the bin until the user restores it or empties the bin).
func (api *SessionAPI) HandleBinConversation(w http.ResponseWriter, r *http.Request) {
	convID, ok := ConvIDFromVars(w, r)
	if !ok {
		return
	}

	lane := r.URL.Query().Get("lane")
	jlog.Info("[session.Bin] conv=%s lane=%q t=%s", convID, lane, nowRFC3339())

	// Binning tears the worker down exactly like delete, so the same
	// test-mode cross-lane guard applies (nil hook in production).
	if api.checkConvDelete != nil {
		if err := api.checkConvDelete(convID, lane); err != nil {
			jlog.Error("[session.Bin] REJECTED: %v", err)
			WriteError(w, r, http.StatusForbidden, err.Error())
			return
		}
	}

	if api.workerManager != nil {
		api.workerManager.Remove(convID)
	}
	if api.closeConversation != nil {
		api.closeConversation(convID)
	}

	if err := api.manager().BinConversation(convID); err != nil {
		if errors.Is(err, core.ErrConversationNotFound) {
			WriteError(w, r, http.StatusNotFound, "Conversation not found")
			return
		}
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)

	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsChanged("binned", convID, "")
	}
}

// HandleRestoreConversation moves a conversation out of .juggler/bin/ back
// into the active set.
func (api *SessionAPI) HandleRestoreConversation(w http.ResponseWriter, r *http.Request) {
	convID, ok := ConvIDFromVars(w, r)
	if !ok {
		return
	}

	if err := api.manager().RestoreConversation(convID); err != nil {
		if errors.Is(err, core.ErrConversationNotFound) {
			WriteError(w, r, http.StatusNotFound, "Conversation not found")
			return
		}
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	// The conversation is workable again, so lift the block binning placed on
	// it — otherwise the restored tab opens to a worker that is never created.
	if api.workerManager != nil {
		api.workerManager.ConversationRestored(convID)
	}

	// Resolve the canonical folder name so clients can populate their
	// name cache without a follow-up GET.
	name := api.manager().ConvNames()[convID]

	w.WriteHeader(http.StatusNoContent)

	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsChanged("restored", convID, name)
	}
}

// HandleListBinnedConversations returns the bin listing,
// most-recently-modified first.
func (api *SessionAPI) HandleListBinnedConversations(w http.ResponseWriter, r *http.Request) {
	list := api.manager().ListBinnedConversations()
	WriteJSON(w, r, 0, map[string]any{
		"binned":       list,
		"binSizeBytes": api.manager().BinSizeBytes(),
	})
}

// HandleDeleteBinnedConversation permanently removes a single conversation
// folder from .juggler/bin/.
func (api *SessionAPI) HandleDeleteBinnedConversation(w http.ResponseWriter, r *http.Request) {
	convID, ok := ConvIDFromVars(w, r)
	if !ok {
		return
	}

	if err := api.manager().DeleteBinnedConversation(convID); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)

	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsChanged("binned-deleted", convID, "")
	}
}

// HandleEmptyBin permanently removes conversations from .juggler/bin/. Empties
// the whole bin by default; with ?olderThanDays=N (a positive integer) it
// removes only those whose last activity is more than N days old.
func (api *SessionAPI) HandleEmptyBin(w http.ResponseWriter, r *http.Request) {
	var removed []string
	var err error
	if raw := r.URL.Query().Get("olderThanDays"); raw != "" {
		days, convErr := strconv.Atoi(raw)
		if convErr != nil || days <= 0 {
			WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("olderThanDays must be a positive integer, got %q", raw))
			return
		}
		removed, err = api.manager().EmptyBinOlderThan(days)
	} else {
		removed, err = api.manager().EmptyBin()
	}
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)

	if api.broadcaster != nil {
		for _, id := range removed {
			api.broadcaster.BroadcastConversationsChanged("binned-deleted", id, "")
		}
	}
}

// HandleRenameConversation renames a conversation's on-disk folder.
// Body: {"name": "..."}. 200 with the canonical name on success, 400 for
// invalid input, 404 for unknown id, 409 for collision (case-folded).
func (api *SessionAPI) HandleRenameConversation(w http.ResponseWriter, r *http.Request) {
	convID, ok := ConvIDFromVars(w, r)
	if !ok {
		return
	}
	req, ok := DecodeJSON[struct {
		Name string `json:"name"`
	}](w, r)
	if !ok {
		return
	}

	canonical, err := api.manager().RenameConversation(convID, req.Name)
	if err != nil {
		switch {
		case errors.Is(err, core.ErrInvalidName):
			WriteError(w, r, http.StatusBadRequest, "Name is invalid")
		case errors.Is(err, core.ErrNameCollision):
			WriteError(w, r, http.StatusConflict, "Name already in use")
		case errors.Is(err, core.ErrConversationNotFound):
			WriteError(w, r, http.StatusNotFound, "Conversation not found")
		default:
			WriteError(w, r, http.StatusInternalServerError, err.Error())
		}
		return
	}

	WriteJSON(w, r, 0, map[string]any{"name": canonical})

	// Move the conversation's log file to match the new name (best-effort; no-op
	// if the worker isn't loaded — it picks up the name on next init).
	if api.workerManager != nil {
		api.workerManager.RenameLog(convID)
	}

	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsChanged("renamed", convID, canonical)
	}
}

// HandleReorderConversations updates the conversation order. `moved` is
// optional and names the one conversation a drag moved, which is what a
// workspace box anchored to it needs to keep its place; see
// SessionManager.ReorderConversations.
func (api *SessionAPI) HandleReorderConversations(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Order []string `json:"order"`
		Moved string   `json:"moved"`
	}](w, r)
	if !ok {
		return
	}

	merged, reanchored, err := api.manager().ReorderConversations(req.Order, req.Moved)
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)

	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsReordered(merged)
	}
	// A re-anchored box is a change to the workspace table, which rides its own
	// broadcast: a viewer told only the order would draw the box at the place
	// the row used to name.
	if reanchored {
		api.broadcastWorkspaces()
	}
}
