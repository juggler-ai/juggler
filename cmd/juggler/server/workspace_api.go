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
	// SourceRoot is a real directory in the project (e.g. a git repository's
	// toplevel). While bound, the conversation's file/shell/search/tree ops on a
	// path under SourceRoot execute under WorkspaceRoot instead. An extension
	// binds one source per repository it isolates.
	SourceRoot string `json:"sourceRoot"`
	// WorkspaceRoot is the absolute path of the alternate execution root the
	// extension prepared for SourceRoot (e.g. a git worktree it just created).
	WorkspaceRoot string `json:"workspaceRoot"`
}

// workspaceUnbindRequest is the body of POST /api/workspace/unbind. When
// SourceRoot is empty, every binding for the conversation is cleared.
type workspaceUnbindRequest struct {
	ConversationID string `json:"conversationId"`
	SourceRoot     string `json:"sourceRoot,omitempty"`
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
	if req.ConversationID == "" || req.SourceRoot == "" || req.WorkspaceRoot == "" {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "conversationId, sourceRoot and workspaceRoot are required"})
		return
	}
	if !filepath.IsAbs(req.SourceRoot) || !filepath.IsAbs(req.WorkspaceRoot) {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "sourceRoot and workspaceRoot must be absolute paths"})
		return
	}
	if info, err := os.Stat(req.WorkspaceRoot); err != nil || !info.IsDir() {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "workspaceRoot must be an existing directory"})
		return
	}
	s.bindWorkspace(req.ConversationID, req.SourceRoot, req.WorkspaceRoot)
	jlog.Info("workspace: bound conv=%s %s → %s", req.ConversationID, req.SourceRoot, req.WorkspaceRoot)
	handlers.WriteJSON(w, r, 0, map[string]any{"ok": true, "sourceRoot": req.SourceRoot, "workspaceRoot": req.WorkspaceRoot})
}

// handleWorkspaceUnbind clears a conversation's workspace binding for one source
// directory, or all of them when sourceRoot is omitted. Idempotent.
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
	if req.SourceRoot == "" {
		s.unbindAllWorkspaces(req.ConversationID)
	} else {
		s.unbindWorkspace(req.ConversationID, req.SourceRoot)
	}
	jlog.Info("workspace: unbound conv=%s source=%q", req.ConversationID, req.SourceRoot)
	handlers.WriteJSON(w, r, 0, map[string]any{"ok": true})
}
