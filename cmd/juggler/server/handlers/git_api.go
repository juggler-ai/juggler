//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/workspace"
)

// GitStatusAPI serves the git views of a working tree — the status card, the
// review manifest, one file's diff and the git client's reads — for
// the tree a request names: the
// root repo plus any nested subrepos/submodules. Each request's tree is
// resolved afresh. What git
// says is the workspace's business; this is only which tree, and the HTTP
// around the answer.
type GitStatusAPI struct {
	resolve workspace.ResolveFunc

	// worktreeIDs names the trees of a worktree read by the ids that view
	// them (workspace.GitTrees.Annotate); nil leaves them unnamed.
	worktreeIDs func(read string, w *gitview.Worktrees)
}

// NewGitStatusAPI creates a new GitStatusAPI. resolve turns the `workspace`
// query parameter into the tree a request is about ("" is the project, rooted
// nowhere when no project is open).
func NewGitStatusAPI(resolve workspace.ResolveFunc) *GitStatusAPI {
	return &GitStatusAPI{resolve: resolve}
}

// WithWorktreeIDs has every worktree read name its trees through annotate.
func (a *GitStatusAPI) WithWorktreeIDs(annotate func(read string, w *gitview.Worktrees)) *GitStatusAPI {
	a.worktreeIDs = annotate
	return a
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
// Every git endpoint resolves it through here, because every git surface in
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
		WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	resp := gitStatusResponse{Root: tree.Root(), Workspace: tree.Name(), Repos: []gitview.RepoStatus{}}
	if tree.Root() != "" {
		repos, err := tree.GitStatus(r.Context())
		if err != nil {
			WriteMessageError(w, r, http.StatusBadGateway, msg.New("Couldn't read the status. {detail}", "detail", err.Error()))
			return
		}
		resp.Repos = repos
	}
	WriteJSON(w, r, 0, resp)
}

// HandleGitReview handles GET /api/git/review?scope=<scope>&conv=<id>: every
// repository under the tree the request names and every file in each of them
// that the scope compares, freshly read (see gitview.Review and
// gitview.ParseScope). conv is the conversation @turn compares against the
// snapshot of. A scope that cannot be read is a 400.
func (a *GitStatusAPI) HandleGitReview(w http.ResponseWriter, r *http.Request) {
	tree, err := a.gitTree(r)
	if err != nil {
		WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	scope, err := gitview.ParseScope(r.URL.Query().Get("scope"))
	if err != nil {
		WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	scope = scope.WithConversation(r.URL.Query().Get("conv"))
	if tree.Root() == "" {
		// An empty manifest would be a complete review of nothing, which is a
		// stronger claim than "there is no project open".
		WriteMessageError(w, r, http.StatusBadRequest, msg.New("No project is open"))
		return
	}
	manifest, err := tree.GitReview(r.Context(), scope)
	if err != nil {
		WriteMessageError(w, r, http.StatusBadGateway, msg.New("Couldn't read the review. {detail}", "detail", err.Error()))
		return
	}
	WriteJSON(w, r, 0, gitReviewResponse{Root: tree.Root(), Workspace: tree.Name(), Manifest: manifest})
}

// HandleGitDiff handles GET /api/git/diff?repo=<rel>&path=<rel>&context=<n>&scope=<scope>&conv=<id>:
// one file's change within the scope, the working tree against HEAD by default
// (see gitview.Diff, which validates all four parameters). A request the workspace refuses is a 400; a
// diff that could not be produced, the clock and cancellation included, is a
// 502.
func (a *GitStatusAPI) HandleGitDiff(w http.ResponseWriter, r *http.Request) {
	tree, err := a.gitTree(r)
	if err != nil {
		WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	if tree.Root() == "" {
		WriteMessageError(w, r, http.StatusBadRequest, msg.New("No project is open"))
		return
	}
	q := r.URL.Query()
	resp, err := tree.GitDiff(r.Context(), gitview.DiffRequest{
		Repo: q.Get("repo"), Path: q.Get("path"), Context: q.Get("context"), Scope: q.Get("scope"),
		Conv: q.Get("conv"),
	})
	writeGitDiff(w, r, resp, err)
}

// HandleGitRead handles GET /api/git/read?kind=<kind>&repo=<rel>: one of the
// git client's reads (see gitview.Read — a place's contents, or the
// repository's worktrees) of one repository of the tree the request names,
// answered as the workspace reads it. A log read takes the rest of a
// gitview.LogQuery as parameters of the same names (refresh=1 for Refresh),
// a commit read its revision as commit=, a blame read its file as path=
// and its revision as rev=, an attribution read amend=1 to score an amend
// of HEAD and conv= for the conversation that breaks ties, a stranded read
// its full ref name as ref=, and a
// commit-context read amend=1 to describe an amend of HEAD. A request the workspace
// refuses, an unknown kind included, is a 400; a read that failed is a 502.
func (a *GitStatusAPI) HandleGitRead(w http.ResponseWriter, r *http.Request) {
	tree, err := a.gitTree(r)
	if err != nil {
		WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	if tree.Root() == "" {
		WriteMessageError(w, r, http.StatusBadRequest, msg.New("No project is open"))
		return
	}
	q := r.URL.Query()
	query := gitview.Query{Kind: q.Get("kind"), Repo: q.Get("repo"), Commit: q.Get("commit")}
	if query.Kind == gitview.QueryBlame {
		query.Blame = gitview.BlameQuery{Path: q.Get("path"), Rev: q.Get("rev")}
	}
	if query.Kind == gitview.QueryAttribution {
		query.Attribution = gitview.AttributionQuery{Amend: q.Get("amend") == "1", Conv: q.Get("conv")}
	}
	if query.Kind == gitview.QueryStranded {
		query.Ref = q.Get("ref")
	}
	if query.Kind == gitview.QueryCommitContext {
		query.CommitContext = gitview.CommitContextQuery{Amend: q.Get("amend") == "1"}
	}
	if query.Kind == gitview.QueryLog {
		if query.Log, err = logQueryOf(q); err != nil {
			WriteErr(w, r, http.StatusBadRequest, err)
			return
		}
	}
	answer, err := tree.GitRead(r.Context(), query)
	var refused *gitview.RequestError
	switch {
	case errors.As(err, &refused):
		WriteErr(w, r, http.StatusBadRequest, refused)
	case err != nil:
		WriteMessageError(w, r, http.StatusBadGateway, msg.New("Couldn't read the repository. {detail}", "detail", err.Error()))
	default:
		if trees, ok := answer.(gitview.Worktrees); ok && a.worktreeIDs != nil {
			a.worktreeIDs(q.Get("workspace"), &trees)
			answer = trees
		}
		WriteJSON(w, r, 0, answer)
	}
}

// logQueryOf reads a log read's parameters. A position that is not a number
// is the asker's mistake.
func logQueryOf(q url.Values) (gitview.LogQuery, error) {
	lq := gitview.LogQuery{
		Graph: q.Get("graph"), Scope: q.Get("scope"), Ref: q.Get("ref"), Message: q.Get("message"),
		Author: q.Get("author"), Path: q.Get("path"), Refresh: q.Get("refresh") == "1", Find: q.Get("find"),
	}
	for name, field := range map[string]*int{"offset": &lq.Offset, "limit": &lq.Limit} {
		raw := q.Get(name)
		if raw == "" {
			continue
		}
		n, err := strconv.Atoi(raw)
		if err != nil {
			return gitview.LogQuery{}, msg.NewError("{name} is not a number: {value}", "name", name, "value", raw)
		}
		*field = n
	}
	return lq, nil
}

// writeGitDiff sends a diff, or the status its failure deserves.
func writeGitDiff(w http.ResponseWriter, r *http.Request, resp gitview.FileDiff, err error) {
	var refused *gitview.RequestError
	switch {
	case errors.As(err, &refused):
		WriteErr(w, r, http.StatusBadRequest, refused)
	case err != nil:
		WriteMessageError(w, r, http.StatusBadGateway, msg.New("Couldn't read the diff. {detail}", "detail", err.Error()))
	default:
		WriteJSON(w, r, 0, resp)
	}
}
