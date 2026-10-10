//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
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
//
// Base and Target are the object ids the scope resolved to here, for any scope
// but the default: the old side, and the new side when it is a commit rather
// than the working tree or the index. BaseName is the branch @branch settled on.
type gitReviewRepo struct {
	RepoStatus
	Complete bool   `json:"complete"`
	Error    string `json:"error,omitempty"`
	Base     string `json:"base,omitempty"`
	Target   string `json:"target,omitempty"`
	BaseName string `json:"baseName,omitempty"`
}

// Manifest is the file manifest a deliberate review works from.
//
// Complete is the claim the whole review exists to make honestly. Ceilings and
// failures are unavoidable; presenting what they left behind as the complete
// working tree is not, so each one names itself in Warnings and Complete goes
// false. Partial results stay in the answer — they are worth reading, they are
// just not everything. Scope says what was compared.
type Manifest struct {
	Complete bool            `json:"complete"`
	Warnings []string        `json:"warnings"`
	Scope    ScopeInfo       `json:"scope"`
	Repos    []gitReviewRepo `json:"repos"`
}

// warn records something the review could not reach, once. A warning and an
// incomplete review are the same statement made twice, so they are made in one
// place: there is no way to add the first without the second.
func (resp *Manifest) warn(format string, args ...any) {
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

// Review reads every repository under root and every file in each of them,
// freshly.
//
// This is the card's question asked in earnest. The card is a number in the
// corner of a window, polled every twenty seconds, and it can afford to skip a
// repository that was slow or a directory that is usually enormous. A review is
// what the user reads before telling the agent what to fix, and a file missing
// from it is a change that never gets reviewed — so nothing is quietly left out
// here, and what cannot be included says so. That is also why it returns no
// error: a failure is part of the manifest, named in its Warnings — a scope
// naming a revision one repository lacks included.
//
// The scope is resolved in each repository separately. The zero Scope is the
// working tree against HEAD.
func Review(ctx context.Context, root string, scope Scope) Manifest {
	ctx, cancel := context.WithTimeout(ctx, gitReviewBudget)
	defer cancel()

	resp := Manifest{Complete: true, Warnings: []string{}, Scope: scope.Info(), Repos: []gitReviewRepo{}}

	scan := scanRepos(ctx, root, reviewScanLimits())
	for _, reason := range scan.Cut {
		resp.warn("%s", reason)
	}
	budget := gitReviewMaxFiles
	for _, dir := range scan.Repos {
		repo := reviewRepo(ctx, root, dir, scope, budget, &resp)
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
	return resp
}

// reviewRepo reads one repository, listing at most budget of its files and
// recording against the manifest whatever it could not establish.
func reviewRepo(ctx context.Context, root, dir string, scope Scope, budget int, resp *Manifest) gitReviewRepo {
	rel := repoRelativePath(root, dir)
	repo := gitReviewRepo{
		RepoStatus: RepoStatus{Path: rel, Files: []gitFileStatus{}},
		Complete:   true,
	}

	// Status is read whatever the scope: it is where the branch, its upstream
	// and the untracked files come from. Only the default scope's file list is
	// status's own, so any other reads all of it before choosing.
	listed := budget
	if !scope.IsDefault() {
		listed = gitReviewMaxFiles
	}
	status, err := repoStatus(ctx, dir, repoStatusOptions{maxFiles: listed, allUntracked: true, perCmd: gitReviewPerCmd})
	if err != nil {
		repo.Complete = false
		repo.Error = gitReviewFailure(err)
		resp.warn("Couldn't read %s: %s", repoDescription(rel), repo.Error)
		return repo
	}
	status.Path = rel
	repo.RepoStatus = status

	if !scope.IsDefault() {
		reviewScopedRepo(ctx, dir, scope, budget, &repo, resp)
		return repo
	}

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
	if err := repoDiffstats(ctx, dir, gitReviewPerCmd, &repo.RepoStatus); err != nil {
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

// reviewScopedRepo replaces the file list status gave with the one the scope
// describes, and counts its lines the same way. repo holds status's answer on
// the way in.
func reviewScopedRepo(ctx context.Context, dir string, scope Scope, budget int, repo *gitReviewRepo, resp *Manifest) {
	rel := repo.Path
	status := repo.RepoStatus
	repo.Files, repo.Total, repo.Changed, repo.Staged, repo.Conflicted = []gitFileStatus{}, 0, 0, 0, 0
	repo.Truncated = false

	resolved, err := resolveScope(ctx, dir, scope, gitReviewPerCmd)
	if err != nil {
		repo.Complete = false
		repo.Error = gitReviewFailure(err)
		resp.warn("Couldn't compare %s: %s", repoDescription(rel), repo.Error)
		return
	}
	repo.Base, repo.Target, repo.BaseName = resolved.base, resolved.target, resolved.baseName
	if resolved.base == "HEAD" {
		repo.Base = status.Head
	}

	files, err := scopedFiles(ctx, dir, resolved, status)
	if err != nil {
		repo.Complete = false
		repo.Error = gitReviewFailure(err)
		resp.warn("Couldn't read %s: %s", repoDescription(rel), repo.Error)
		return
	}
	for _, file := range files {
		repo.Total++
		if file.Index != "." {
			repo.Staged++
		}
		if file.Worktree != "." {
			repo.Changed++
		}
		if file.Conflicted {
			repo.Conflicted++
		}
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	repo.Files = files
	truncateGitFiles(&repo.RepoStatus, budget)
	if repo.Truncated {
		repo.Complete = false
		resp.warn("%s: %d of %d changed files listed", repoDescription(rel), len(repo.Files), repo.Total)
	}

	out, err := gitRead(ctx, dir, gitReviewPerCmd, gitDiffMaxMeta,
		resolved.diffArgs("--no-ext-diff", "--no-textconv", "--find-renames", "--numstat", "-z")...)
	if err != nil {
		repo.Complete = false
		resp.warn("Couldn't count the changed lines in %s: %s", repoDescription(rel), gitReviewFailure(err))
		return
	}
	applyGitDiffstats(&repo.RepoStatus, parseGitNumstat(out.Kept))
}

// scopedFiles lists the files a scope compares, lettered the way status letters
// them: a change between the index and a commit on the index side, any other on
// the working-tree side — which is where a reader of the two-letter code looks
// for "this changed".
//
// The working tree against the index is read off status, which has refreshed
// what it knows of each file on the way; asked of diff-files instead, a file
// merely touched since the index last looked at it reads as modified. Every
// other scope is a raw diff, plus — when the new side is the working tree — the
// files git has never been told about.
func scopedFiles(ctx context.Context, dir string, scope resolvedScope, status RepoStatus) ([]gitFileStatus, error) {
	if scope.Kind() == ScopeUnstaged {
		files := []gitFileStatus{}
		for _, file := range status.Files {
			if file.Worktree == "." {
				continue
			}
			file.Index = "."
			files = append(files, file)
		}
		return files, nil
	}

	out, err := gitRead(ctx, dir, gitReviewPerCmd, gitDiffMaxMeta, scope.diffArgs(
		"--no-ext-diff", "--no-textconv", "--find-renames", "--raw", "--abbrev", "-z")...)
	if err != nil {
		return nil, err
	}
	meta := parseGitRawDiff(out.Kept)

	inStatus := make(map[string]gitFileStatus, len(status.Files))
	for _, file := range status.Files {
		inStatus[file.Path] = file
	}
	// Against the working tree, git reports a file whose cached stat no longer
	// matches as changed without reading it. Status has read it: a file status
	// calls clean is the commit's, so it differs from the base only if the
	// commits between them changed it.
	var committed map[string]gitFileMeta
	if scope.Kind() == ScopeWorktree {
		for path, file := range meta {
			if _, listed := inStatus[path]; listed || strings.Trim(file.NewID, "0") != "" {
				continue
			}
			if committed == nil {
				head, ok, err := revParse(ctx, dir, "HEAD", gitReviewPerCmd)
				if err != nil {
					return nil, err
				}
				committed = map[string]gitFileMeta{}
				if ok {
					between, err := gitRead(ctx, dir, gitReviewPerCmd, gitDiffMaxMeta,
						"diff-tree", "-r", "--no-ext-diff", "--no-textconv", "--find-renames", "--raw", "-z", scope.base, head, "--")
					if err != nil {
						return nil, err
					}
					committed = parseGitRawDiff(between.Kept)
				}
			}
			if _, changed := committed[path]; !changed {
				delete(meta, path)
			}
		}
	}

	files := make([]gitFileStatus, 0, len(meta))
	for path, file := range meta {
		entry := gitFileStatus{Path: path, OldPath: file.OldPath, Index: ".", Worktree: file.Letter}
		if scope.Kind() == ScopeIndex {
			entry.Index, entry.Worktree = file.Letter, "."
		}
		if scope.Kind() != ScopeCommits && (inStatus[path].Conflicted || file.Letter == "U") {
			entry.Conflicted = true
		}
		files = append(files, entry)
	}
	if scope.touchesWorktree() {
		for _, file := range status.Files {
			if file.Worktree == "?" {
				files = append(files, file)
			}
		}
	}
	return files, nil
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
