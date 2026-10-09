//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"errors"
	"net/http"

	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/workspace"
)

// GitStatusAPI serves the three git views of a working tree — the status card,
// the review manifest and one file's diff — for the tree a request names: the
// root repo plus any nested subrepos/submodules. Each request's tree is
// resolved afresh, so a runtime project switch retargets the scan. What git
// says is the workspace's business; this is only which tree, and the HTTP
// around the answer.
type GitStatusAPI struct {
	resolve workspace.ResolveFunc
}

// NewGitStatusAPI creates a new GitStatusAPI. resolve turns the `workspace`
// query parameter into the tree a request is about ("" is the project, rooted
// nowhere when no project is open).
func NewGitStatusAPI(resolve workspace.ResolveFunc) *GitStatusAPI {
	return &GitStatusAPI{resolve: resolve}
}

// gitStatusResponse is the JSON response shape for GET /api/git/status.
type gitStatusResponse struct {
	Root      string               `json:"root"`
	Workspace string               `json:"workspace,omitempty"` // See workspace.Workspace.Name
	Repos     []gitview.RepoStatus `json:"repos"`
}

// gitReviewResponse is the JSON response shape for GET /api/git/review: the
// tree it describes, then the manifest itself.
type gitReviewResponse struct {
	Root      string `json:"root"`
	Workspace string `json:"workspace,omitempty"` // See workspace.Workspace.Name
	gitview.Manifest
}

// gitTree is the tree a git request is about: the workspace named by the
// `workspace` query parameter, or the project when it names none. Its Name
// travels in the answer beside its Root, so a surface names the tree its counts
// came from rather than whichever conversation is showing now.
//
// All three git endpoints resolve it through here, because every git surface in
// the app shows one conversation's view of one tree. The card's counts, the
// review's file list and a file's diff sit on top of one another in the pin, so
// two of them answering about different trees would show the name of one and the
// bytes of another.
//
// The refusals are `WorkspaceLookup.Usable`'s, shared with the ops API so the
// words match, and there is deliberately no fall back to the project: a status
// that quietly reported the project for a binding that could not be honoured
// would show a clean tree for a conversation whose own tree has gone.
func (a *GitStatusAPI) gitTree(r *http.Request) (workspace.Workspace, error) {
	return a.resolve(r.URL.Query().Get("workspace"))
}

// HandleGitStatus handles GET /api/git/status: the status card's view of the
// tree the request names. With no project open it answers with no repositories
// rather than an error, because the card is polled.
func (a *GitStatusAPI) HandleGitStatus(w http.ResponseWriter, r *http.Request) {
	tree, err := a.gitTree(r)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	resp := gitStatusResponse{Root: tree.Root(), Workspace: tree.Name(), Repos: []gitview.RepoStatus{}}
	if tree.Root() != "" {
		repos, err := tree.GitStatus(r.Context())
		if err != nil {
			WriteError(w, r, http.StatusBadGateway, "Couldn't read the status. "+err.Error())
			return
		}
		resp.Repos = repos
	}
	WriteJSON(w, r, 0, resp)
}

// HandleGitReview handles GET /api/git/review: every repository under the tree
// the request names and every file in each of them, freshly read (see
// gitview.Review).
func (a *GitStatusAPI) HandleGitReview(w http.ResponseWriter, r *http.Request) {
	tree, err := a.gitTree(r)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	if tree.Root() == "" {
		// An empty manifest would be a complete review of nothing, which is a
		// stronger claim than "there is no project open".
		WriteError(w, r, http.StatusBadRequest, "No project is open")
		return
	}
	manifest, err := tree.GitReview(r.Context())
	if err != nil {
		WriteError(w, r, http.StatusBadGateway, "Couldn't read the review. "+err.Error())
		return
	}
	WriteJSON(w, r, 0, gitReviewResponse{Root: tree.Root(), Workspace: tree.Name(), Manifest: manifest})
}

// HandleGitDiff handles GET /api/git/diff?repo=<rel>&path=<rel>&context=<n>: one
// file's whole working-tree change relative to HEAD (see gitview.Diff, which
// validates all three parameters). A request the workspace refuses is a 400; a
// diff that could not be produced, the clock and cancellation included, is a
// 502.
func (a *GitStatusAPI) HandleGitDiff(w http.ResponseWriter, r *http.Request) {
	tree, err := a.gitTree(r)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	if tree.Root() == "" {
		WriteError(w, r, http.StatusBadRequest, "No project is open")
		return
	}
	q := r.URL.Query()
	resp, err := tree.GitDiff(r.Context(), gitview.DiffRequest{
		Repo: q.Get("repo"), Path: q.Get("path"), Context: q.Get("context"),
	})
	writeGitDiff(w, r, resp, err)
}

// writeGitDiff sends a diff, or the status its failure deserves.
func writeGitDiff(w http.ResponseWriter, r *http.Request, resp gitview.FileDiff, err error) {
	var refused *gitview.RequestError
	switch {
	case errors.As(err, &refused):
		WriteError(w, r, http.StatusBadRequest, refused.Error())
	case err != nil:
		WriteError(w, r, http.StatusBadGateway, "Couldn't read the diff. "+err.Error())
	default:
		WriteJSON(w, r, 0, resp)
	}
}
