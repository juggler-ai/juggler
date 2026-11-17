//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"slices"
	"sort"
	"strconv"
	"strings"

	"juggler/cmd/juggler/gitview/internal/clocks"
	"juggler/cmd/juggler/msg"
)

// Signature is who made or committed a commit, and when, in Unix seconds.
type Signature struct {
	Name  string `json:"name"`
	Email string `json:"email"`
	Date  int64  `json:"date"`
}

// Commit is one commit as History's detail shows it: its metadata, and every
// file it changed against its first parent — a merge as what it brought to the
// branch it was made on, a root commit against the tree of nothing.
//
// Scope is the comparison those files are of, as a review scope spells it
// ("<sha>^!"), so that one file's diff is asked for with the very scope the
// list was read with, and Base and Target are the ids it resolved to. Files
// are lettered as a review's are, the change on the worktree side, and listed
// up to the review's ceiling: Total counts them all and Truncated says the
// list stopped short.
type Commit struct {
	Repo      string          `json:"repo"`
	Sha       string          `json:"sha"`
	Parents   []string        `json:"parents"`
	Author    Signature       `json:"author"`
	Committer Signature       `json:"committer"`
	Subject   string          `json:"subject"`
	Body      string          `json:"body"`
	Scope     string          `json:"scope"`
	Base      string          `json:"base"`
	Target    string          `json:"target"`
	Files     []gitFileStatus `json:"files"`
	Total     int             `json:"total"`
	Truncated bool            `json:"truncated"`
}

// commitFormat is a commit's metadata, one field per NUL. Subject and body are
// git's own split: the first paragraph, its lines joined, then the rest.
const commitFormat = "%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s%x00%b"

// commitReadMax bounds a commit's message; a longer one is cut at a line.
const commitReadMax = 256 << 10

// ReadCommit reads the commit rev names in one repository under root, named
// as the API names it. A revision that is not one, or names no commit, is a
// *RequestError.
func ReadCommit(ctx context.Context, root, repo, rev string) (Commit, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	if rev == "" {
		return Commit{}, &RequestError{msg.NewError("No commit was named")}
	}
	if err := checkRevision(rev); err != nil {
		return Commit{}, err
	}
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return Commit{}, err
	}
	sha, err := resolveCommit(ctx, dir, rev, clocks.Review.PerCmd)
	if err != nil {
		return Commit{}, err
	}

	// A commit's detail is fixed by its id (see historyCache). Repo is the one
	// field that is about where it was asked from rather than what it is, so it
	// is left out of what is kept and filled in for each asker.
	repoID, cacheable := repoIdentity(dir)
	key := cacheKey{repo: repoID, kind: cacheCommit, target: sha, limit: gitReviewMaxFiles, limit2: gitDiffMaxMeta}
	cacheable = cacheable && isObjectID(sha)
	if cacheable {
		if v, ok := historyCache.get(key); ok {
			return v.(Commit).forRepo(RepoPath(root, dir)), nil
		}
	}
	c, err := readCommit(ctx, dir, rev, sha)
	if err != nil {
		return Commit{}, err
	}
	if cacheable {
		historyCache.put(key, c, commitSize(c))
	}
	return c.forRepo(RepoPath(root, dir)), nil
}

// forRepo is a kept commit as an answer to one asker: its own copy of what a
// caller might change, named as that asker names its repository.
func (c Commit) forRepo(repo string) Commit {
	c.Repo = repo
	c.Parents = slices.Clone(c.Parents)
	c.Files = slices.Clone(c.Files)
	return c
}

// readCommit reads the commit sha, which rev resolved to, from git: its
// metadata in one command, and its files and their lines in one more. Repo is
// left empty.
func readCommit(ctx context.Context, dir, rev, sha string) (Commit, error) {
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, commitReadMax, "log", "-1", "--no-walk", "--format="+commitFormat, sha, "--")
	if err != nil {
		return Commit{}, err
	}
	f := strings.SplitN(string(out.Kept), "\x00", 10)
	if len(f) != 10 {
		return Commit{}, &RequestError{msg.NewError("Unknown revision {revision}", "revision", rev)}
	}
	c := Commit{
		Sha: f[0], Parents: strings.Fields(f[1]),
		Author:    Signature{Name: f[2], Email: f[3], Date: unixField(f[4])},
		Committer: Signature{Name: f[5], Email: f[6], Date: unixField(f[7])},
		Subject:   f[8], Body: strings.TrimRight(f[9], "\n"),
		Scope: sha + "^!",
	}

	// The scope is the commit against its first parent, which the metadata has
	// just named — or, for a root commit, the tree of nothing.
	scope, err := ParseScope(c.Scope)
	if err != nil {
		return Commit{}, err
	}
	resolved := resolvedScope{Scope: scope, target: sha}
	if len(c.Parents) > 0 {
		resolved.base = c.Parents[0]
	} else if empty, ok := emptyTreeFor(sha); ok {
		resolved.base = empty
	} else if resolved.base, err = gitEmptyTree(ctx, dir, clocks.Review.PerCmd); err != nil {
		return Commit{}, err
	}
	rememberParent(dir, sha, resolved.base)
	c.Base, c.Target = resolved.base, resolved.target

	// What each file is and how many of its lines changed are one diff-tree:
	// git writes every raw record and then every numstat record, from a single
	// rename detection. Its ceiling is the two separate passes' together.
	both, err := gitRead(ctx, dir, clocks.Review.PerCmd, 2*gitDiffMaxMeta,
		resolved.diffArgs("--no-ext-diff", "--no-textconv", "--find-renames", "--raw", "--abbrev", "--numstat", "-z")...)
	if err != nil {
		return Commit{}, err
	}
	meta, stats := parseGitRawNumstat(both.Kept)
	files, err := scopedFilesFrom(ctx, dir, resolved, RepoStatus{}, meta)
	if err != nil {
		return Commit{}, err
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	listed := RepoStatus{Files: files, Total: len(files)}
	truncateGitFiles(&listed, gitReviewMaxFiles)
	applyGitDiffstats(&listed, stats)
	c.Files, c.Total, c.Truncated = listed.Files, listed.Total, listed.Truncated
	return c, nil
}

// unixField reads a Unix time git printed, 0 for one it did not.
func unixField(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}
