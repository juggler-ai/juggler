//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"
	"strconv"

	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
)

// CompletionsAPI handles file completion requests for the "@" mention UI. Each
// request's tree is resolved afresh, so runtime project switches transparently
// retarget the search.
type CompletionsAPI struct {
	resolve workspace.ResolveFunc
}

// NewCompletionsAPI creates a new CompletionsAPI handler. resolve turns the
// `workspace` query parameter into the tree a request is about ("" is the
// project, whose "@" search is answered from its path index).
func NewCompletionsAPI(resolve workspace.ResolveFunc) *CompletionsAPI {
	return &CompletionsAPI{resolve: resolve}
}

// completionTree is the tree a completion request is about: the workspace named
// by the `workspace` query parameter, or the project when it names none.
//
// A mention becomes a file-content item that reads from the conversation's
// workspace, so the menu offering it must list that tree — the project's would
// offer files the read cannot find and hide the ones it can.
//
// ok is false when the workspace cannot be honoured (any refusal of
// workspace.Resolver.Resolve). Completion is best-effort, so the caller answers
// empty rather than failing — and never with the project instead.
func (a *CompletionsAPI) completionTree(r *http.Request) (workspace.Workspace, bool) {
	ws, err := a.resolve(r.URL.Query().Get("workspace"))
	return ws, err == nil
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

	// The tree only anchors a "./" or "../" query; an absolute one ignores it.
	ws, ok := a.completionTree(r)
	if !ok {
		WriteJSON(w, r, 0, fileCompletionsResponse{Results: []ops.FileMatch{}})
		return
	}
	results, err := ws.CompletePath(r.Context(), query, limit)
	if err != nil || results == nil {
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
// when none is named); leading "~" is the user's home. Used by the @-mention
// parser to filter out stray "@word" tokens that look like identifiers, not
// file paths.
func (a *CompletionsAPI) HandlePathExists(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query()["paths"]
	ws, ok := a.completionTree(r)
	if len(raw) == 0 || !ok {
		WriteJSON(w, r, 0, pathExistsResponse{Existing: []string{}})
		return
	}

	existing := make([]string, 0, len(raw))
	for _, p := range raw {
		if p == "" {
			continue
		}
		if _, err := ws.Stat(p); err == nil {
			existing = append(existing, p)
		}
	}
	WriteJSON(w, r, 0, pathExistsResponse{Existing: existing})
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

	ws, ok := a.completionTree(r)
	if !ok || ws.Root() == "" {
		WriteJSON(w, r, 0, fileCompletionsResponse{Results: []ops.FileMatch{}})
		return
	}
	results, err := ws.SearchFiles(r.Context(), query, limit)
	if err != nil || results == nil {
		// Completions are best-effort: an error answers empty.
		results = []ops.FileMatch{}
	}

	WriteJSON(w, r, 0, fileCompletionsResponse{Results: results})
}
