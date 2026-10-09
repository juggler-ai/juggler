//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"
)

// Review bounds. A review is asked for rather than polled, so it can afford a
// search the card cannot: nothing is skipped for being expensive, and whatever
// it still fails to reach is reported instead of dropped.
// The two clocks are var rather than const so a test can lend itself more of
// them. A test that means to check what the review reports is not asking how
// fast this machine's git is, and on a loaded CI runner those are different
// questions with the same answer.
var (
	// gitReviewBudget is the whole request's clock. Longer than the card's,
	// because the card can shrug at a repository it did not reach in time and
	// this cannot.
	gitReviewBudget = 30 * time.Second

	// gitReviewPerCmd is one git command's clock. The card reads the same
	// repositories on a far shorter one, which is right for a number in the
	// corner of a window and wrong here: a read cut off early is a repository
	// reported as unreadable, and a review that calls a slow machine a broken one
	// has failed at the only thing it claims to do.
	gitReviewPerCmd = 10 * time.Second
)

const (
	// gitReviewMaxRepos and gitReviewMaxDirs stop an unbounded walk of a tree
	// nobody meant to hand over — a home directory opened as a project. The
	// directory count is the one that binds in practice: it is roughly a large
	// monorepo with its dependencies installed, reached in well under a second,
	// and a project past it gets a manifest that says where the search stopped.
	gitReviewMaxRepos = 64
	gitReviewMaxDirs  = 100000

	// gitReviewMaxFiles is the most files the response lists, spent across every
	// repository in it. A ceiling on each repository separately would bound
	// nothing: the number of repositories is itself a ceiling and not a one. Far
	// past what anybody reviews in a sitting, which is what makes it a guard on
	// the size of the response rather than an opinion about the work.
	gitReviewMaxFiles = 5000
)

// gitReviewRepo is one repository in the manifest: everything the card reports
// about it, plus whether this is the whole story and what went wrong when it is
// not. A repository git could not read is still listed — the user is owed the
// knowledge that it is there and unreviewed.
type gitReviewRepo struct {
	gitRepoStatus
	Complete bool   `json:"complete"`
	Error    string `json:"error,omitempty"`
}

// gitReviewResponse is the JSON response shape for GET /api/git/review: the file
// manifest a deliberate review works from.
//
// Complete is the claim the whole endpoint exists to make honestly. Ceilings and
// failures are unavoidable; presenting what they left behind as the complete
// working tree is not, so each one names itself in Warnings and Complete goes
// false. Partial results stay in the response — they are worth reading, they are
// just not everything.
type gitReviewResponse struct {
	Root      string          `json:"root"`
	Workspace string          `json:"workspace,omitempty"` // See gitTree.Name
	Complete  bool            `json:"complete"`
	Warnings  []string        `json:"warnings"`
	Repos     []gitReviewRepo `json:"repos"`
}

// warn records something the review could not reach, once. A warning and an
// incomplete review are the same statement made twice, so they are made in one
// place: there is no way to add the first without the second.
func (resp *gitReviewResponse) warn(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	for _, existing := range resp.Warnings {
		if existing == msg {
			return
		}
	}
	resp.Warnings = append(resp.Warnings, msg)
	resp.Complete = false
}

// reviewScanLimits is the search a review runs — and the one a diff falls back
// on, because the two have to agree about which repositories exist. A manifest
// listing a repository whose files then cannot be opened is worse than one that
// never listed it.
func reviewScanLimits() repoScanLimits {
	return repoScanLimits{maxRepos: gitReviewMaxRepos, maxDirs: gitReviewMaxDirs}
}

// HandleGitReview handles GET /api/git/review: every repository under the
// project and every file in each of them, freshly read.
//
// This is the card's question asked in earnest. The card is a number in the
// corner of a window, polled every twenty seconds, and it can afford to skip a
// repository that was slow or a directory that is usually enormous. A review is
// what the user reads before telling the agent what to fix, and a file missing
// from it is a change that never gets reviewed — so nothing is quietly left out
// here, and what cannot be included says so.
func (a *GitStatusAPI) HandleGitReview(w http.ResponseWriter, r *http.Request) {
	tree, err := a.gitRoot(r)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	root := tree.Root
	if root == "" {
		// An empty manifest would be a complete review of nothing, which is a
		// stronger claim than "there is no project open".
		WriteError(w, r, http.StatusBadRequest, "No project is open")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), gitReviewBudget)
	defer cancel()

	resp := gitReviewResponse{Root: root, Workspace: tree.Name, Complete: true, Warnings: []string{}, Repos: []gitReviewRepo{}}

	scan := scanRepos(ctx, root, reviewScanLimits())
	for _, reason := range scan.Cut {
		resp.warn("%s", reason)
	}
	budget := gitReviewMaxFiles
	for _, dir := range scan.Repos {
		repo := reviewRepo(ctx, root, dir, budget, &resp)
		budget -= len(repo.Files)
		resp.Repos = append(resp.Repos, repo)
	}

	// Root repository first, then nested ones alphabetically. A manifest is
	// scrolled and returned to, so the order it lists things in has to be a
	// property of the project rather than of the order a walk happened to find
	// them in.
	sort.SliceStable(resp.Repos, func(i, j int) bool {
		return resp.Repos[i].Path < resp.Repos[j].Path
	})

	WriteJSON(w, r, 0, resp)
}

// reviewRepo reads one repository, listing at most budget of its files and
// recording against the manifest whatever it could not establish.
func reviewRepo(ctx context.Context, root, dir string, budget int, resp *gitReviewResponse) gitReviewRepo {
	rel := repoRelativePath(root, dir)
	repo := gitReviewRepo{
		gitRepoStatus: gitRepoStatus{Path: rel, Files: []gitFileStatus{}},
		Complete:      true,
	}

	status, err := repoStatus(ctx, dir, repoStatusOptions{maxFiles: budget, allUntracked: true, perCmd: gitReviewPerCmd})
	if err != nil {
		repo.Complete = false
		repo.Error = gitReviewFailure(err)
		resp.warn("Couldn't read %s: %s", repoDescription(rel), repo.Error)
		return repo
	}
	status.Path = rel
	repo.gitRepoStatus = status

	if status.Truncated {
		repo.Complete = false
		switch {
		case status.Total > len(status.Files):
			resp.warn("%s: %d of %d changed files listed", repoDescription(rel), len(status.Files), status.Total)
		default:
			resp.warn("%s: more changes than could be read in one pass", repoDescription(rel))
		}
	}

	// A repository whose lines could not be counted is not a repository that did
	// not change, and zero is what both look like. Only the warning separates
	// them, so the count failing has to produce one.
	if err := repoDiffstats(ctx, dir, gitReviewPerCmd, &repo.gitRepoStatus); err != nil {
		repo.Complete = false
		resp.warn("Couldn't count the changed lines in %s: %s", repoDescription(rel), gitReviewFailure(err))
	}

	// One order for the files, whoever listed them and however many refreshes
	// later: a comment is attached to a row the user found by looking, and the
	// row has to still be where they left it.
	sort.SliceStable(repo.Files, func(i, j int) bool {
		return repo.Files[i].Path < repo.Files[j].Path
	})
	return repo
}

// repoDescription names a repository in a sentence. The root repository has no
// path to be called by, and "" in the middle of a warning names nothing.
func repoDescription(rel string) string {
	if rel == "" {
		return "the project repository"
	}
	return rel
}

// gitReviewFailure says what went wrong in terms of the review rather than of
// the Go that ran it: git's own complaint, or the clock.
func gitReviewFailure(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "the review ran out of time"
	case errors.Is(err, context.Canceled):
		return "the review was cancelled"
	}
	return err.Error()
}
