//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"
)

// workspaceBindRequest is the body of POST /api/workspace/bind.
type workspaceBindRequest struct {
	ConversationID string `json:"conversationId"`
	// Root is the absolute path of an alternate execution root the extension has
	// prepared for this conversation (e.g. a git worktree it just created). While
	// bound, the conversation's file/shell/search/tree ops execute under it.
	Root string `json:"root"`
}

// workspaceUnbindRequest is the body of POST /api/workspace/unbind.
type workspaceUnbindRequest struct {
	ConversationID string `json:"conversationId"`
}

// handleWorkspaceBind is the extension-facing endpoint an extension calls (via
// the SDK `bindWorkspace`) to route a conversation's ops into an alternate
// execution root it manages. Core stores the mapping and remaps ops through it;
// it never creates, inspects, or owns the root — that is entirely the
// extension's concern (see the worktrees extension). The path is required to be
// an existing absolute directory, a sanity check only (extensions are
// unsandboxed and already hold full authority — see the extension trust model).
func (s *Server) handleWorkspaceBind(w http.ResponseWriter, r *http.Request) {
	var req workspaceBindRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid request"})
		return
	}
	if req.ConversationID == "" || req.Root == "" {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "conversationId and root are required"})
		return
	}
	if !filepath.IsAbs(req.Root) {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "root must be an absolute path"})
		return
	}
	if info, err := os.Stat(req.Root); err != nil || !info.IsDir() {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "root must be an existing directory"})
		return
	}
	s.bindWorkspace(req.ConversationID, req.Root)
	jlog.Info("workspace: bound conv=%s → %s", req.ConversationID, req.Root)
	handlers.WriteJSON(w, r, 0, map[string]any{"ok": true, "root": req.Root})
}

// handleWorkspaceUnbind clears a conversation's workspace binding (its ops
// revert to the project root). Idempotent.
func (s *Server) handleWorkspaceUnbind(w http.ResponseWriter, r *http.Request) {
	var req workspaceUnbindRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid request"})
		return
	}
	if req.ConversationID == "" {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "conversationId is required"})
		return
	}
	s.unbindWorkspace(req.ConversationID)
	jlog.Info("workspace: unbound conv=%s", req.ConversationID)
	handlers.WriteJSON(w, r, 0, map[string]any{"ok": true})
}
