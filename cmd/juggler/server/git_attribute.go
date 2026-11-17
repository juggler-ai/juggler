//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"os"
	"path/filepath"

	"juggler/cmd/juggler/gitattr"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/server/handlers"
)

// gitAttributeRequest is the body of POST /api/git/attribute: the file a tool
// wrote, as the tool named it, and who wrote it.
type gitAttributeRequest struct {
	Path   string `json:"path"`             // Absolute, or relative to the tree's root
	Conv   string `json:"conv"`             // The conversation
	Thread string `json:"thread,omitempty"` // Its thread item, "" for the root thread
	Item   string `json:"item,omitempty"`   // The tool use
}

// handleGitAttribute handles POST /api/git/attribute?workspace=<id> with a
// gitAttributeRequest body: an edit or write tool saying it has just written a
// file. The server reads the file as it now is on disk, names it as the git
// views do and records it as the conversation's in the project's attribution
// index (gitattr), strongly. It answers 204 whether or not anything was
// recorded — a file outside the tree, in no repository, gone already, or in a
// tree not on this machine records nothing — since the caller never waits on
// it. A workspace that cannot be resolved, or a body naming no file or
// conversation, is a 400; a file git could not hash, a 502.
func (s *Server) handleGitAttribute(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("workspace")
	ws, err := s.gitResolve(id)
	if err != nil {
		handlers.WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	req, ok := handlers.DecodeJSON[gitAttributeRequest](w, r)
	if !ok {
		return
	}
	if req.Path == "" || req.Conv == "" {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("An attribution needs a file and a conversation."))
		return
	}
	project := s.ProjectPath()
	root, local := ws.LocalDir()
	if project == "" || !local || root == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	file := filepath.FromSlash(req.Path)
	if !filepath.IsAbs(file) {
		file = filepath.Join(root, file)
	}
	if info, err := os.Stat(file); err != nil || !info.Mode().IsRegular() {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	at, ok, err := gitattr.Locate(r.Context(), root, file)
	if err != nil {
		handlers.WriteMessageError(w, r, http.StatusBadGateway, msg.New("Couldn't read the file's git object id. {detail}", "detail", err.Error()))
		return
	}
	if ok {
		gitattr.ForProject(project).Add(gitattr.Record{
			Workspace: id, Repo: at.Repo, Path: at.Path, Blob: at.Blob,
			Conv: req.Conv, Thread: req.Thread, Item: req.Item, Strength: gitattr.Strong,
		})
	}
	w.WriteHeader(http.StatusNoContent)
}
