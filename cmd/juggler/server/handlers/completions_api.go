//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
)

// CompletionsAPI handles file completion requests for the "@" mention UI.
// The working directory is read through a provider func so runtime project
// switches transparently retarget the search root.
type CompletionsAPI struct {
	pathProvider  func() string
	workspaces    core.WorkspaceLookup
	indexProvider func() ops.PathSearcher
}

// NewCompletionsAPI creates a new CompletionsAPI handler. pathProvider must
// return the current project path on each call. indexProvider returns the
// current file-path index (or nil in no-project mode) for whole-tree "@"
// completion; it may itself be nil, in which case completion is prefix-scan
// only.
func NewCompletionsAPI(pathProvider func() string, workspaces core.WorkspaceLookup, indexProvider func() ops.PathSearcher) *CompletionsAPI {
	return &CompletionsAPI{pathProvider: pathProvider, workspaces: workspaces, indexProvider: indexProvider}
}

// completionRoot is the tree a completion request is about, and the searcher for
// whole-tree matches in it: the workspace named by the `workspace` query
// parameter, or the project when it names none.
//
// A mention becomes a file-content item that reads from the conversation's
// workspace, so the menu offering it must list that tree — the project's would
// offer files the read cannot find and hide the ones it can. The project's path
// index describes the project alone, so a workspace is searched by walking it.
//
// ok is false when the workspace cannot be honoured (`WorkspaceLookup.Usable`'s
// four refusals). Completion is best-effort, so the caller answers empty rather
// than failing — and never with the project instead.
func (a *CompletionsAPI) completionRoot(r *http.Request) (root string, searcher ops.PathSearcher, ok bool) {
	id := r.URL.Query().Get("workspace")
	if id == core.DefaultWorkspaceID {
		if a.indexProvider != nil {
			searcher = a.indexProvider()
		}
		return a.pathProvider(), searcher, true
	}
	ws, err := a.workspaces.Usable(id)
	if err != nil {
		return "", nil, false
	}
	return ws.Root, ops.NewTreeSearcher(r.Context(), ws.Root), true
}

// fileCompletionsResponse is the JSON response shape.
type fileCompletionsResponse struct {
	Results []ops.FileMatch `json:"results"`
}

// HandlePathCompletions handles GET /api/completions/path?q=<query>&limit=<n>
// Returns filesystem entries for an absolute path prefix. Unlike HandleFileCompletions,
// the results are NOT restricted to the current project directory.
func (a *CompletionsAPI) HandlePathCompletions(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	// The base only anchors a "./" or "../" query; an absolute one ignores it.
	base, _, ok := a.completionRoot(r)
	if !ok {
		WriteJSON(w, r, 0, fileCompletionsResponse{Results: []ops.FileMatch{}})
		return
	}
	results, err := ops.CompletePath(r.Context(), query, base, limit)
	if err != nil {
		results = []ops.FileMatch{}
	}
	if results == nil {
		results = []ops.FileMatch{}
	}

	WriteJSON(w, r, 0, fileCompletionsResponse{Results: results})
}

// pathExistsResponse is the JSON response shape for HandlePathExists.
type pathExistsResponse struct {
	Existing []string `json:"existing"`
}

// HandlePathExists handles GET /api/completions/exists?paths=p1&paths=p2&workspace=<id>
// Returns the subset of supplied paths that resolve to an existing filesystem
// entry. Relative paths are resolved against the workspace's root (the project
// when none is named); leading "~" is expanded to $HOME. Used by the @-mention
// parser to filter out stray "@word" tokens that look like identifiers, not
// file paths.
func (a *CompletionsAPI) HandlePathExists(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query()["paths"]
	workingDir, _, ok := a.completionRoot(r)
	if len(raw) == 0 || !ok {
		WriteJSON(w, r, 0, pathExistsResponse{Existing: []string{}})
		return
	}

	existing := make([]string, 0, len(raw))
	for _, p := range raw {
		if p == "" {
			continue
		}
		abs := resolveForExists(p, workingDir)
		if abs == "" {
			continue
		}
		if _, err := os.Stat(abs); err == nil {
			existing = append(existing, p)
		}
	}
	WriteJSON(w, r, 0, pathExistsResponse{Existing: existing})
}

// resolveForExists turns a user-supplied path into an absolute path for an
// os.Stat call. Empty string means "do not stat" (path was unresolvable).
func resolveForExists(p, workingDir string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		if p == "~" {
			return home
		}
		return filepath.Join(home, p[2:])
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	if workingDir == "" {
		return ""
	}
	return filepath.Join(workingDir, p)
}

// HandleFileCompletions handles GET /api/completions/files?q=<query>&limit=<n>&workspace=<id>
func (a *CompletionsAPI) HandleFileCompletions(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	workingDir, searcher, ok := a.completionRoot(r)
	if !ok || workingDir == "" {
		WriteJSON(w, r, 0, fileCompletionsResponse{Results: []ops.FileMatch{}})
		return
	}
	results, err := ops.CompleteFiles(r.Context(), workingDir, query, limit, searcher)
	if err != nil {
		// Return empty results on error — completions are best-effort
		results = []ops.FileMatch{}
	}
	if results == nil {
		results = []ops.FileMatch{}
	}

	WriteJSON(w, r, 0, fileCompletionsResponse{Results: results})
}
