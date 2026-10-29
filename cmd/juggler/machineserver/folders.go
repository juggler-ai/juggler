//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/msg"
	"juggler/internal/userpaths"
)

// folderResponse is the POST /api/server/folders payload.
type folderResponse struct {
	Path string `json:"path"`
}

// handleCreateFolder makes a new, empty folder for a project, so starting from
// nothing does not mean leaving Juggler to make one by hand. It only creates:
// the sessions page opens the folder's session next, as it would any folder.
// POST /api/server/folders {"parent": "/abs/path" or "~/path", "name": "myapp"}
// answers 201 {"path": "/abs/path/myapp"}.
func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}
	body := http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeMessageError(w, http.StatusBadRequest, msg.New("invalid request body: {error}", "error", err.Error()))
		return
	}

	// The name must land directly inside the parent the user named. A separator
	// would put it somewhere else entirely, and "." or ".." name the parent
	// itself — none of which is what the field in front of them asked for.
	name := strings.TrimSpace(req.Name)
	switch {
	case name == "":
		writeMessageError(w, http.StatusBadRequest, msg.New("name is required"))
		return
	case name == "." || name == "..":
		writeMessageError(w, http.StatusBadRequest, msg.New("name must be a folder name, not a path"))
		return
	case strings.ContainsAny(name, `/\`):
		writeMessageError(w, http.StatusBadRequest, msg.New("name cannot contain a slash — it is created inside the parent folder"))
		return
	}

	parent, refusal := resolveParent(strings.TrimSpace(req.Parent))
	if refusal != nil {
		writeMessageError(w, http.StatusBadRequest, *refusal)
		return
	}

	// Mkdir, never MkdirAll: one level, inside a parent already proven to be
	// there. A mistyped parent has to fail in front of the user rather than
	// quietly grow a tree of empty folders they will never find again.
	abs := filepath.Join(parent, name)
	if err := os.Mkdir(abs, 0o755); err != nil {
		if os.IsExist(err) {
			// Not silently adopted: they asked to create something new, and
			// opening a folder that is already full of someone else's work is a
			// different decision, taken by opening it.
			writeMessageError(w, http.StatusConflict, msg.New("there is already something called {name} in {parent}", "name", name, "parent", parent))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, folderResponse{Path: abs})
}

// resolveParent validates the folder a new one is made in, as resolveProject
// does a project: absolute or under ~, there, and a directory. A relative path
// is refused for the same reason — it would resolve against the folder
// `juggler serve` started in.
func resolveParent(p string) (string, *msg.Message) {
	refuse := func(m msg.Message) (string, *msg.Message) { return "", &m }
	if p == "" {
		return refuse(msg.New("parent is required"))
	}
	expanded := userpaths.ExpandHome(p)
	if !filepath.IsAbs(expanded) {
		return refuse(msg.New("parent {path}: give an absolute path, or one starting with ~/", "path", p))
	}
	abs := filepath.Clean(expanded)
	info, err := os.Stat(abs)
	switch {
	case os.IsNotExist(err):
		return refuse(msg.New("parent folder not found: {path}", "path", abs))
	case err != nil:
		return refuse(msg.New("parent {path}: {error}", "path", abs, "error", err.Error()))
	case !info.IsDir():
		return refuse(msg.New("parent is not a folder: {path}", "path", abs))
	}
	return abs, nil
}
