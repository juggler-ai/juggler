//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
)

// expandTilde replaces a leading "~" with the current user's home directory.
func expandTilde(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return home + path[1:]
		}
	}
	return path
}

// ProjectAPI exposes endpoints for opening, closing, and listing recent
// project folders. It delegates the actual switch to a callback so the
// server's project-state lifecycle stays out of the handler layer.
type ProjectAPI struct {
	pathProvider  func() string
	switchFn      func(path string) error
	checkLockedFn func(path string) (bool, *core.InstanceInfo, error)
	recents       *core.RecentsStore
}

// NewProjectAPI creates a new ProjectAPI.
//   - pathProvider returns the currently-loaded project path ("" if none).
//   - switchFn is called with the desired project path ("" to clear) and
//     should perform the live swap. Errors propagate to the HTTP response.
func NewProjectAPI(pathProvider func() string, switchFn func(path string) error, recents *core.RecentsStore) *ProjectAPI {
	return &ProjectAPI{
		pathProvider:  pathProvider,
		switchFn:      switchFn,
		checkLockedFn: core.CheckProjectLocked,
		recents:       recents,
	}
}

// HandleGetProject returns the current project path.
// GET /api/project
func (api *ProjectAPI) HandleGetProject(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, map[string]any{
		"projectPath": api.pathProvider(),
	})
}

// HandlePostProject opens (or switches to) a project folder.
// POST /api/project  { "path": "/abs/or/relative/path" }
func (api *ProjectAPI) HandlePostProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{"error": "invalid request body"})
		return
	}
	if req.Path == "" {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{"error": "path is required"})
		return
	}

	abs, err := filepath.Abs(expandTilde(req.Path))
	if err != nil {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	if err := api.switchFn(abs); err != nil {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, core.ErrProjectNotFound), errors.Is(err, core.ErrProjectNotDir):
			status = http.StatusBadRequest
		case errors.Is(err, core.ErrProjectLocked):
			status = http.StatusConflict
		}
		WriteJSON(w, r, status, map[string]any{"error": err.Error()})
		return
	}

	if api.recents != nil {
		_ = api.recents.Add(abs)
	}

	WriteJSON(w, r, 0, map[string]any{"projectPath": abs})
}

// HandleCheckProject validates whether a path exists and is a directory, without switching.
// GET /api/project/check?path=...
func (api *ProjectAPI) HandleCheckProject(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("path")
	if raw == "" {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": "path is required"})
		return
	}
	abs, err := filepath.Abs(expandTilde(raw))
	if err != nil {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": err.Error()})
		return
	}
	info, err := os.Stat(abs)
	if os.IsNotExist(err) {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": "path not found"})
		return
	}
	if err != nil {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": err.Error()})
		return
	}
	if !info.IsDir() {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": "not a directory"})
		return
	}

	// Check whether another instance already has this project open.
	if locked, existing, _ := api.checkLockedFn(abs); locked {
		msg := "Already open in another Juggler instance"
		if existing != nil {
			isRunning, _ := core.VerifyInstance(existing, abs)
			if isRunning {
				msg = fmt.Sprintf("Already open at http://%s:%d/", existing.Host, existing.Port)
			}
		}
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": msg, "locked": true})
		return
	}

	WriteJSON(w, r, 0, map[string]any{"valid": true, "path": abs})
}

// HandleDeleteProject closes the current project (returns to no-project mode).
// DELETE /api/project
func (api *ProjectAPI) HandleDeleteProject(w http.ResponseWriter, r *http.Request) {
	if err := api.switchFn(""); err != nil {
		WriteJSON(w, r, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	WriteJSON(w, r, 0, map[string]any{"projectPath": ""})
}

// HandleGetRecents returns the user's recents list (most-recent first).
// GET /api/recents
func (api *ProjectAPI) HandleGetRecents(w http.ResponseWriter, r *http.Request) {
	paths := []string{}
	if api.recents != nil {
		// Prune folders that have since been deleted/moved so the picker never
		// offers a dead path (and the persisted list self-heals over time).
		if loaded, err := api.recents.Prune(); err == nil {
			paths = loaded
		}
	}
	if paths == nil {
		paths = []string{}
	}
	WriteJSON(w, r, 0, map[string]any{"paths": paths})
}

// HandleDeleteRecent removes one path from the recents list.
// DELETE /api/recents  { "path": "/abs/path" }
func (api *ProjectAPI) HandleDeleteRecent(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{"error": "invalid request body"})
		return
	}
	if api.recents != nil {
		_ = api.recents.Remove(req.Path)
	}
	w.WriteHeader(http.StatusNoContent)
}
