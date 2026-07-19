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
	"strings"
	"time"

	"juggler/cmd/juggler/core"
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
	// releaseConvWorktree lets a deleted conversation's dedicated git worktree
	// be pruned (only when permanent and pristine — see core.ConvWorktrees).
	// Set by the server; nil is a no-op.
	releaseConvWorktree func(conversationID string, permanent bool)

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

// SetConvWorktreeHook wires the per-conversation worktree release hook, called
// when a conversation is deleted so its dedicated worktree can be pruned if
// pristine. Nil (the default) disables worktree cleanup.
func (api *SessionAPI) SetConvWorktreeHook(release func(conversationID string, permanent bool)) {
	api.releaseConvWorktree = release
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
	Remove(conversationID string)
	// RemoveAndPurgeLogs is Remove plus deletion of the conversation's
	// per-conversation log file(s) — for a PERMANENT delete only, never a bin.
	RemoveAndPurgeLogs(conversationID string)
	// FlushConversation persists the (loaded) worker's doc to disk before an
	// out-of-band file read such as the server-side duplicate. No-op if unloaded.
	FlushConversation(conversationID string) error
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
type Broadcaster interface {
	BroadcastSessionChanged()
	BroadcastSessionMetadataChanged(metadata map[string]any)
	BroadcastConversationsChanged(op, id, name string)
	BroadcastConversationsReordered(order []string)
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

// HandleGetWindowState returns the native-window geometry saved in this
// project's session, so the desktop app can reopen the window where the user
// left it. Geometry is per-project session state and travels with the session.
// `hasState` is false when this project has never saved one (first open, or a
// no-project window).
func (api *SessionAPI) HandleGetWindowState(w http.ResponseWriter, r *http.Request) {
	ws, ok := api.manager().GetWindowState()
	WriteJSON(w, r, 0, map[string]any{"windowState": ws, "hasState": ok})
}

// HandleSetWindowState persists the native-window geometry into this project's
// session. The desktop app posts it (debounced) as the user moves/resizes the
// window and once more at close. A no-project session no-ops (see
// SessionManager.SetWindowState).
func (api *SessionAPI) HandleSetWindowState(w http.ResponseWriter, r *http.Request) {
	var ws core.WindowState
	if err := json.NewDecoder(r.Body).Decode(&ws); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid request body")
		return
	}
	if err := api.manager().SetWindowState(ws); err != nil {
		writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	WriteJSON(w, r, http.StatusOK, map[string]any{"ok": true})
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
		"conversations":        sess.Conversations,
		"conversationOrder":    sess.ConversationOrder,
		"conversationNames":    api.manager().ConvNames(),
		"activeConversationId": sess.ActiveConversationID,
		"messageHistory":       sess.MessageHistory,
		"metadata":             sess.Metadata,
		"binnedCount":          len(api.manager().ListBinnedConversations()),
		"binSizeBytes":         api.manager().BinSizeBytes(),
	}

	WriteJSON(w, r, 0, response)
}

// HandleUpdateSession replaces conversations/metadata for the session
// No validation - frontend manages all structure
func (api *SessionAPI) HandleUpdateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Conversations        []json.RawMessage `json:"conversations"`
		ActiveConversationID string            `json:"activeConversationId"`
		MessageHistory       []string          `json:"messageHistory"`
		Metadata             map[string]any    `json:"metadata"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid request body")
		return
	}

	// All mutation runs inside the session actor (see SessionManager.Update):
	// the live session never escapes to this HTTP goroutine, so concurrent
	// PUT/PATCH/GET requests can't race its maps and slices.
	if err := api.manager().Update(func(sess *core.Session) error {
		// ConversationOrder is owned by the create / reorder / delete /
		// archive endpoints and the on-load reconcile, not this PUT.
		if len(req.Conversations) > 0 {
			sess.SetConversations(req.Conversations)
		}

		sess.ActiveConversationID = req.ActiveConversationID

		if req.MessageHistory != nil {
			sess.MessageHistory = req.MessageHistory
		}

		if req.Metadata != nil {
			sess.Metadata = req.Metadata
		}
		return nil
	}); err != nil {
		writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandlePatchSessionMetadata applies a targeted JSON metadata patch to the
// session manifest. It is intentionally narrower than PUT /session: callers can
// update project/session-scoped UI state without serializing conversation state
// or clobbering unrelated metadata keys.
func (api *SessionAPI) HandlePatchSessionMetadata(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Metadata map[string]any `json:"metadata"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Metadata == nil {
		writeError(w, r, http.StatusBadRequest, "metadata is required")
		return
	}

	// The read-modify-write of the metadata map must happen inside the session
	// actor: mutating the shared map from this HTTP goroutine races concurrent
	// PATCH/PUT/GET handlers and trips Go's fatal "concurrent map writes"
	// detector, killing the whole server under load.
	changed, err := api.manager().PatchMetadata(req.Metadata)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, err.Error())
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
	var req struct {
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
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid request body")
		return
	}

	id, finalName, err := api.manager().CreateConversation(req.Name, req.ID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, core.ErrInvalidConvID) {
			status = http.StatusBadRequest
		} else if errors.Is(err, core.ErrConvIDExists) {
			status = http.StatusConflict
		}
		writeError(w, r, status, err.Error())
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
			writeError(w, r, http.StatusInternalServerError, "Failed to duplicate conversation: "+err.Error())
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
			writeError(w, r, http.StatusInternalServerError, "Failed to initialize conversation: "+err.Error())
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
	}
}

// duplicateConversationFiles copies a source conversation's persisted state
// (doc.yjs + the txns/ blob directory) into the already-created destination
// folder. It first flushes the source's worker (if loaded) so the on-disk doc
// is current, then copies files directly — size-independent and with no
// cross-worker writes, so the destination is complete before it is announced.
// A source with no doc.yjs yet (never saved) copies nothing, yielding a
// legitimately empty clone rather than an error.
func (api *SessionAPI) duplicateConversationFiles(srcID, dstID string) error {
	if api.workerManager != nil {
		if err := api.workerManager.FlushConversation(srcID); err != nil {
			return fmt.Errorf("flush source worker: %w", err)
		}
	}

	mgr := api.manager()
	srcDir, ok := mgr.ConvDir(srcID)
	if !ok {
		return fmt.Errorf("source conversation %s not found", srcID)
	}
	dstDir, ok := mgr.ConvDir(dstID)
	if !ok {
		return fmt.Errorf("destination conversation %s not found", dstID)
	}

	// doc.yjs carries items AND metadata (model config, permission rules, …).
	if err := copyFileIfExists(filepath.Join(srcDir, "doc.yjs"), filepath.Join(dstDir, "doc.yjs")); err != nil {
		return fmt.Errorf("copy doc.yjs: %w", err)
	}
	// txns/ holds per-round-trip blobs referenced by items by id.
	if err := copyDirContents(filepath.Join(srcDir, "txns"), filepath.Join(dstDir, "txns")); err != nil {
		return fmt.Errorf("copy txns: %w", err)
	}
	// assets/ holds content-addressed image blobs referenced by items by sha.
	// Cloning the doc carries the attachment refs, so the bytes must come too
	// or the clone's images resolve to nothing.
	if err := copyDirContents(filepath.Join(srcDir, "assets"), filepath.Join(dstDir, "assets")); err != nil {
		return fmt.Errorf("copy assets: %w", err)
	}
	return nil
}

// copyFileIfExists copies src→dst. A missing src is not an error (it means the
// source has nothing persisted yet); any other read/write failure is returned.
func copyFileIfExists(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

// copyDirContents copies every regular file in srcDir into dstDir (non-recursive
// — the txns directory is flat). A missing srcDir is not an error.
func copyDirContents(srcDir, dstDir string) error {
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if err := copyFileIfExists(filepath.Join(srcDir, e.Name()), filepath.Join(dstDir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// ConvIDFromVars extracts the {convId} route variable. On a missing/empty id it
// writes a 400 response and returns ok=false, so callers can `if !ok { return }`.
func ConvIDFromVars(w http.ResponseWriter, r *http.Request) (string, bool) {
	convID := mux.Vars(r)["convId"]
	if convID == "" {
		writeError(w, r, http.StatusBadRequest, "Conversation ID is required")
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
		writeError(w, r, http.StatusNotFound, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	if _, err := w.Write(yjsData); err != nil {
		writeError(w, r, http.StatusInternalServerError, "Failed to write response")
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
		writeError(w, r, http.StatusBadRequest, "Invalid asset id")
		return
	}
	convDir, ok := api.manager().ConvDir(convID)
	if !ok {
		writeError(w, r, http.StatusNotFound, "Conversation not found")
		return
	}

	// sha is validated hex, so the glob can only match this conversation's
	// own assets/<sha>.<ext> — no traversal possible.
	var assetPath string
	matches, _ := filepath.Glob(filepath.Join(convDir, "assets", sha+".*"))
	for _, m := range matches {
		if strings.HasSuffix(m, ".tmp") {
			continue
		}
		assetPath = m
		break
	}
	if assetPath == "" {
		writeError(w, r, http.StatusNotFound, "Asset not found")
		return
	}

	f, err := os.Open(assetPath)
	if err != nil {
		writeError(w, r, http.StatusNotFound, "Asset not found")
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
			writeError(w, r, http.StatusBadRequest, "Failed to read request body")
			return
		}

		if err := api.manager().SaveConversationBinary(convID, yjsData); err != nil {
			writeError(w, r, http.StatusInternalServerError, err.Error())
			return
		}
	} else {
		writeError(w, r, http.StatusBadRequest, "Only binary format (application/octet-stream) is supported")
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
			writeError(w, r, http.StatusForbidden, err.Error())
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
		writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	// Prune the conversation's dedicated git worktree (permanent + pristine only;
	// a bin keeps it so a restore can reuse it, and any unmerged work is kept).
	if api.releaseConvWorktree != nil {
		api.releaseConvWorktree(convID, permanent)
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
			writeError(w, r, http.StatusForbidden, err.Error())
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
			writeError(w, r, http.StatusNotFound, "Conversation not found")
			return
		}
		writeError(w, r, http.StatusInternalServerError, err.Error())
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
			writeError(w, r, http.StatusNotFound, "Conversation not found")
			return
		}
		writeError(w, r, http.StatusInternalServerError, err.Error())
		return
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
		writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)

	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsChanged("binned-deleted", convID, "")
	}
}

// HandleEmptyBin permanently removes every conversation in .juggler/bin/.
func (api *SessionAPI) HandleEmptyBin(w http.ResponseWriter, r *http.Request) {
	removed, err := api.manager().EmptyBin()
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, err.Error())
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
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid request body")
		return
	}

	canonical, err := api.manager().RenameConversation(convID, req.Name)
	if err != nil {
		switch {
		case errors.Is(err, core.ErrInvalidName):
			writeError(w, r, http.StatusBadRequest, "Name is invalid")
		case errors.Is(err, core.ErrNameCollision):
			writeError(w, r, http.StatusConflict, "Name already in use")
		case errors.Is(err, core.ErrConversationNotFound):
			writeError(w, r, http.StatusNotFound, "Conversation not found")
		default:
			writeError(w, r, http.StatusInternalServerError, err.Error())
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

// HandleReorderConversations updates the conversation order
func (api *SessionAPI) HandleReorderConversations(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Order []string `json:"order"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid request body")
		return
	}

	if err := api.manager().ReorderConversations(req.Order); err != nil {
		writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)

	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsReordered(req.Order)
	}
}
