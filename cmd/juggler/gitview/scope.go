//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// ScopeKind is what a review compares: which two states of a repository stand
// either side of the diff.
type ScopeKind string

// The four comparisons a scope can name. Every other spelling a user can type
// comes down to one of these and the commits either side of it.
const (
	ScopeWorktree ScopeKind = "worktree" // the working tree against a commit
	ScopeIndex    ScopeKind = "index"    // the index against a commit
	ScopeUnstaged ScopeKind = "unstaged" // the working tree against the index
	ScopeCommits  ScopeKind = "commits"  // one commit against another
)

// scopeMaxLen bounds what a scope may be typed as. A real one is a few words; the
// bound exists so a query string cannot hand git an argument of any size.
const scopeMaxLen = 256

// presetPattern is what a preset looks like. Git itself gives "@" and "@{…}"
// meanings, so only an "@" followed by a plain word is ours — and an unknown one
// is refused rather than handed to git to be misread as a revision.
var presetPattern = regexp.MustCompile(`^@[a-z]+$`)

// defaultBranchCandidates are the names tried, in order, for the branch a
// feature branch is reviewed against.
var defaultBranchCandidates = []string{"origin/HEAD", "main", "master", "origin/main", "origin/master"}

// Scope is a review's comparison as the user asked for it: a preset or a small,
// checked subset of `git diff`'s own arguments. It is parsed once by ParseScope
// and resolved against each repository separately, since a ref one repository
// has is a ref the next may not.
//
// The zero Scope is the working tree against HEAD, staged and unstaged together.
//
// What may be typed:
//
//	@uncommitted, ""      working tree against HEAD
//	@staged               index against HEAD
//	@unstaged             working tree against the index
//	@branch               working tree against its merge-base with the default branch
//	@last                 the last commit against its first parent
//	<rev>                 working tree against <rev>
//	--merge-base <rev>    working tree against the merge-base of <rev> and HEAD
//	--cached [<rev>]      index against <rev> (HEAD by default); --staged is the same
//	--worktree            working tree against the index
//	<a>..<b>, <a> <b>     <b> against <a>; an omitted side is HEAD
//	<a>...<b>             <b> against the merge-base of <a> and <b>
//
// Nothing typed reaches git as an option. Every revision is checked here for the
// shape of one and then resolved to an object id by rev-parse, and the diff runs
// on the ids.
type Scope struct {
	input     string
	kind      ScopeKind
	left      string // the old side as typed; "" is HEAD
	right     string // the new side of a commit range as typed; "" is HEAD
	mergeBase bool   // the old side is the merge-base of left and the new side
	branch    bool   // left is the repository's default branch, found at resolve time
	last      bool   // left is HEAD's first parent, or the empty tree for a root commit
}

// ScopeInfo is how a scope is reported back: the spelling it was asked for by,
// the comparison it came down to, and a sentence that says which.
type ScopeInfo struct {
	Input string    `json:"input"`
	Kind  ScopeKind `json:"kind"`
	Label string    `json:"label"`
}

// ParseScope reads a scope as typed. A scope it cannot read is a *RequestError,
// because the fault is in what was asked.
func ParseScope(raw string) (Scope, error) {
	input := strings.Join(strings.Fields(raw), " ")
	if len(input) > scopeMaxLen {
		return Scope{}, &RequestError{fmt.Sprintf("Scope is longer than %d characters", scopeMaxLen)}
	}
	if strings.ContainsFunc(raw, func(r rune) bool { return unicode.IsControl(r) && !unicode.IsSpace(r) }) {
		return Scope{}, &RequestError{"Scope holds a control character"}
	}

	switch input {
	case "", "@uncommitted":
		return Scope{input: "@uncommitted", kind: ScopeWorktree}, nil
	case "@staged":
		return Scope{input: input, kind: ScopeIndex}, nil
	case "@unstaged":
		return Scope{input: input, kind: ScopeUnstaged}, nil
	case "@branch":
		return Scope{input: input, kind: ScopeWorktree, mergeBase: true, branch: true}, nil
	case "@last":
		return Scope{input: input, kind: ScopeCommits, left: "HEAD^1", right: "HEAD", last: true}, nil
	}
	if presetPattern.MatchString(input) {
		return Scope{}, &RequestError{fmt.Sprintf("Unknown scope %s: the presets are @uncommitted, @staged, @unstaged, @branch and @last", input)}
	}

	var cached, mergeBase, worktree bool
	var revs []string
	for _, token := range strings.Fields(input) {
		switch token {
		case "--cached", "--staged":
			cached = true
		case "--merge-base":
			mergeBase = true
		case "--worktree":
			worktree = true
		default:
			if strings.HasPrefix(token, "-") {
				return Scope{}, &RequestError{fmt.Sprintf("Unsupported option %s: only --cached, --staged, --merge-base and --worktree are understood", token)}
			}
			revs = append(revs, token)
		}
	}

	s := Scope{input: input}
	switch {
	case worktree:
		if cached || mergeBase || len(revs) > 0 {
			return Scope{}, &RequestError{"--worktree compares the working tree with the index and takes nothing else"}
		}
		s.kind = ScopeUnstaged
		return s, nil
	case len(revs) > 2:
		return Scope{}, &RequestError{"A scope compares at most two commits"}
	case len(revs) == 1 && strings.Contains(revs[0], ".."):
		if cached || mergeBase {
			return Scope{}, &RequestError{"A range compares two commits, so --cached and --merge-base do not apply"}
		}
		left, right, symmetric := strings.Cut(revs[0], "...")
		if !symmetric {
			left, right, _ = strings.Cut(revs[0], "..")
		}
		s.kind, s.left, s.right, s.mergeBase = ScopeCommits, left, right, symmetric
	case len(revs) == 2:
		if cached {
			return Scope{}, &RequestError{"--cached compares the index with one commit, not two"}
		}
		s.kind, s.left, s.right, s.mergeBase = ScopeCommits, revs[0], revs[1], mergeBase
	case len(revs) == 1:
		s.kind, s.left, s.mergeBase = ScopeWorktree, revs[0], mergeBase
		if cached {
			s.kind = ScopeIndex
		}
	default:
		if mergeBase {
			return Scope{}, &RequestError{"--merge-base needs a commit to find the merge-base with"}
		}
		s.kind = ScopeWorktree
		if cached {
			s.kind = ScopeIndex
		}
	}

	for _, rev := range []string{s.left, s.right} {
		if err := checkRevision(rev); err != nil {
			return Scope{}, err
		}
	}
	return s, nil
}

// checkRevision refuses what cannot be a revision before git is asked to
// resolve it. A leading dash is the one shape that matters for safety: it is
// what turns a name into an option. A leading dot or a ".." left over from a
// range git would not have split this way is no name git accepts either, and is
// refused here so the message says why. "" is allowed and means HEAD.
func checkRevision(rev string) error {
	switch {
	case rev == "":
		return nil
	case strings.HasPrefix(rev, "-"), strings.HasPrefix(rev, "."), strings.Contains(rev, ".."):
		return &RequestError{fmt.Sprintf("Not a revision: %s", rev)}
	}
	return nil
}

// Info is the scope as it is reported back with a review.
func (s Scope) Info() ScopeInfo {
	return ScopeInfo{Input: s.Input(), Kind: s.Kind(), Label: s.Label()}
}

// Input is the scope's spelling, whitespace folded; the zero Scope's is the
// preset it stands for.
func (s Scope) Input() string {
	if s.input == "" {
		return "@uncommitted"
	}
	return s.input
}

// Kind is the comparison the scope comes down to.
func (s Scope) Kind() ScopeKind {
	if s.kind == "" {
		return ScopeWorktree
	}
	return s.kind
}

// Label says, in a phrase, what is being compared.
func (s Scope) Label() string {
	name := func(rev string) string {
		if rev == "" {
			return "HEAD"
		}
		return rev
	}
	switch {
	case s.branch:
		return "Working tree against the merge-base with the default branch"
	case s.last:
		return "Last commit against its parent"
	}
	switch s.Kind() {
	case ScopeIndex:
		if s.mergeBase {
			return "Staged against the merge-base with " + name(s.left)
		}
		return "Staged against " + name(s.left)
	case ScopeUnstaged:
		return "Working tree against the index"
	case ScopeCommits:
		if s.mergeBase {
			return name(s.left) + "..." + name(s.right)
		}
		return name(s.left) + ".." + name(s.right)
	}
	if s.mergeBase {
		return "Working tree against the merge-base with " + name(s.left)
	}
	return "Working tree against " + name(s.left)
}

// IsDefault reports whether this is the working tree against HEAD, staged and
// unstaged together — the comparison `git status` describes, and the one the
// file list can be read straight from it.
func (s Scope) IsDefault() bool {
	return s.Kind() == ScopeWorktree && !s.mergeBase && !s.branch && (s.left == "" || s.left == "HEAD")
}

// touchesWorktree reports whether the new side of the comparison is the working
// tree, which is the only side an untracked file or an unresolved conflict is on.
func (s Scope) touchesWorktree() bool {
	k := s.Kind()
	return k == ScopeWorktree || k == ScopeUnstaged
}

// resolvedScope is a scope pinned to one repository: the ids git will diff,
// found once and used for every command a review or a diff runs there.
type resolvedScope struct {
	Scope
	base     string // the old side: an object id, or "" for the index of ScopeUnstaged
	target   string // the new side of ScopeCommits; "" otherwise
	baseName string // the default branch @branch settled on
}

// resolveScope finds the ids a scope names in one repository. A revision the
// repository does not have is a *RequestError naming it; anything else is git
// failing or the clock running out.
func resolveScope(ctx context.Context, dir string, s Scope, budget time.Duration) (resolvedScope, error) {
	r := resolvedScope{Scope: s}
	switch s.Kind() {
	case ScopeUnstaged:
		return r, nil

	case ScopeCommits:
		if s.last {
			head, err := resolveCommit(ctx, dir, "HEAD", budget)
			if err != nil {
				return r, err
			}
			parent, ok, err := revParse(ctx, dir, "HEAD^1", budget)
			if err != nil {
				return r, err
			}
			if !ok {
				// A root commit has no parent to be compared with, and is all
				// addition against the tree of nothing.
				if parent, err = gitEmptyTree(ctx, dir, budget); err != nil {
					return r, err
				}
			}
			r.base, r.target = parent, head
			return r, nil
		}
		left, err := resolveCommit(ctx, dir, s.left, budget)
		if err != nil {
			return r, err
		}
		right, err := resolveCommit(ctx, dir, s.right, budget)
		if err != nil {
			return r, err
		}
		if s.mergeBase {
			if left, err = mergeBaseOf(ctx, dir, left, right, budget); err != nil {
				return r, err
			}
		}
		r.base, r.target = left, right
		return r, nil
	}

	// The working tree or the index, against one commit.
	if s.IsDefault() || (s.Kind() == ScopeIndex && s.left == "" && !s.mergeBase) {
		base, err := gitDiffBase(ctx, dir, budget)
		r.base = base
		return r, err
	}
	left := s.left
	if s.branch {
		name, err := defaultBranch(ctx, dir, budget)
		if err != nil {
			return r, err
		}
		left, r.baseName = name, name
	}
	base, err := resolveCommit(ctx, dir, left, budget)
	if err != nil {
		return r, err
	}
	if s.mergeBase {
		head, err := resolveCommit(ctx, dir, "HEAD", budget)
		if err != nil {
			return r, err
		}
		if base, err = mergeBaseOf(ctx, dir, base, head, budget); err != nil {
			return r, err
		}
	}
	r.base = base
	return r, nil
}

// diffArgs is the git command comparing the scope's two sides, carrying opts,
// ending at the "--" that any pathspec follows. Each kind is asked of the
// plumbing that compares exactly those two states, for the reason gitCommand
// gives: porcelain diff would refresh the index on the way.
func (r resolvedScope) diffArgs(opts ...string) []string {
	var args []string
	switch r.Kind() {
	case ScopeUnstaged:
		args = append(append([]string{"diff-files"}, opts...), "--")
	case ScopeIndex:
		args = append(append([]string{"diff-index", "--cached"}, opts...), r.base, "--")
	case ScopeCommits:
		args = append(append([]string{"diff-tree", "-r"}, opts...), r.base, r.target, "--")
	default:
		args = append(append([]string{"diff-index"}, opts...), r.base, "--")
	}
	return args
}

// revParse asks git for the id of the commit rev names. A name git does not know
// is ok=false rather than an error, so the caller can say which name it was.
func revParse(ctx context.Context, dir, rev string, budget time.Duration) (string, bool, error) {
	return gitResolve(ctx, dir, budget, "rev-parse", "--verify", "-q", "--end-of-options", rev+"^{commit}")
}

// resolveCommit is revParse for a revision the user named, "" being HEAD.
func resolveCommit(ctx context.Context, dir, rev string, budget time.Duration) (string, error) {
	if rev == "" {
		rev = "HEAD"
	}
	id, ok, err := revParse(ctx, dir, rev, budget)
	switch {
	case err != nil:
		return "", err
	case !ok && rev == "HEAD":
		return "", &RequestError{"This repository has no commits yet"}
	case !ok:
		return "", &RequestError{fmt.Sprintf("Unknown revision %s", rev)}
	}
	return id, nil
}

// mergeBaseOf is the best common ancestor of two commits.
func mergeBaseOf(ctx context.Context, dir, a, b string, budget time.Duration) (string, error) {
	id, ok, err := gitResolve(ctx, dir, budget, "merge-base", a, b)
	switch {
	case err != nil:
		return "", err
	case !ok:
		return "", &RequestError{fmt.Sprintf("%s and %s have no common ancestor", shortID(a), shortID(b))}
	}
	return id, nil
}

// defaultBranch is the first of the usual names for the branch work is merged
// into that this repository actually has.
func defaultBranch(ctx context.Context, dir string, budget time.Duration) (string, error) {
	for _, name := range defaultBranchCandidates {
		_, ok, err := revParse(ctx, dir, name, budget)
		if err != nil {
			return "", err
		}
		if ok {
			return name, nil
		}
	}
	return "", &RequestError{"No default branch: none of " + strings.Join(defaultBranchCandidates, ", ") + " exists"}
}

// gitEmptyTree is the id of the tree with nothing in it, asked of git because it
// depends on the repository's hash algorithm.
func gitEmptyTree(ctx context.Context, dir string, budget time.Duration) (string, error) {
	out, err := gitRead(ctx, dir, budget, 1024, "hash-object", "-t", "tree", "--stdin")
	if err != nil {
		return "", err
	}
	empty := strings.TrimSpace(string(out.Kept))
	if empty == "" {
		return "", errors.New("git named no empty tree")
	}
	return empty, nil
}

// gitResolve runs a git command that prints one id. A command that ran and said
// no — exit status non-zero, nothing on the clock — is ok=false; the clock, the
// caller going away and git failing to start are errors.
func gitResolve(ctx context.Context, dir string, budget time.Duration, args ...string) (string, bool, error) {
	cctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	out, err := gitCommand(cctx, dir, args...).Output()
	if err != nil {
		if cctx.Err() != nil {
			return "", false, gitDeadlineError(ctx, cctx, budget)
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return "", false, nil
		}
		return "", false, err
	}
	id := strings.TrimSpace(string(out))
	return id, id != "", nil
}

// shortID is an object id as a person reads one.
func shortID(id string) string {
	if len(id) > 10 {
		return id[:10]
	}
	return id
}
