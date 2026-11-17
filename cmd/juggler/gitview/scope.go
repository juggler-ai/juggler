//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"errors"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode"

	"juggler/cmd/juggler/msg"
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
//	@turn                 the working tree against a conversation's snapshot of it
//	                      at its latest user turn's start (see WithConversation)
//	<rev>                 working tree against <rev>
//	--merge-base <rev>    working tree against the merge-base of <rev> and HEAD
//	--cached [<rev>]      index against <rev> (HEAD by default); --staged is the same
//	--worktree            working tree against the index
//	<a>..<b>, <a> <b>     <b> against <a>; an omitted side is HEAD
//	<a>...<b>             <b> against the merge-base of <a> and <b>
//	<rev>^!               <rev> against its first parent: one commit's change
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
	one       bool   // right against its first parent, or the empty tree for a root commit
	turn      bool   // the conversation's turn snapshot against the working tree, both as trees
	conv      string // the conversation @turn is about; see WithConversation
}

// WithConversation is the scope for one conversation: what @turn compares
// against is that conversation's own snapshot. Every other scope ignores it.
func (s Scope) WithConversation(conv string) Scope {
	s.conv = conv
	return s
}

// ScopeInfo is how a scope is reported back: the spelling it was asked for by,
// the comparison it came down to, and a sentence that says which — in English,
// and as a message for the client to show translated. A commit range's label is
// git's own notation rather than words, so it has no message.
type ScopeInfo struct {
	Input        string       `json:"input"`
	Kind         ScopeKind    `json:"kind"`
	Label        string       `json:"label"`
	LabelMessage *msg.Message `json:"labelMessage,omitempty"`
}

// ParseScope reads a scope as typed. A scope it cannot read is a *RequestError,
// because the fault is in what was asked.
func ParseScope(raw string) (Scope, error) {
	input := strings.Join(strings.Fields(raw), " ")
	if len(input) > scopeMaxLen {
		return Scope{}, &RequestError{msg.NewError("Scope is longer than {max} characters", "max", scopeMaxLen)}
	}
	if strings.ContainsFunc(raw, func(r rune) bool { return unicode.IsControl(r) && !unicode.IsSpace(r) }) {
		return Scope{}, &RequestError{msg.NewError("Scope holds a control character")}
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
	case "@turn":
		return Scope{input: input, kind: ScopeCommits, turn: true}, nil
	}
	if presetPattern.MatchString(input) {
		return Scope{}, &RequestError{msg.NewError("Unknown scope {scope}: the presets are @uncommitted, @staged, @unstaged, @branch, @last and @turn", "scope", input)}
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
				return Scope{}, &RequestError{msg.NewError("Unsupported option {option}: only --cached, --staged, --merge-base and --worktree are understood", "option", token)}
			}
			revs = append(revs, token)
		}
	}

	s := Scope{input: input}
	switch {
	case worktree:
		if cached || mergeBase || len(revs) > 0 {
			return Scope{}, &RequestError{msg.NewError("--worktree compares the working tree with the index and takes nothing else")}
		}
		s.kind = ScopeUnstaged
		return s, nil
	case len(revs) > 2:
		return Scope{}, &RequestError{msg.NewError("A scope compares at most two commits")}
	case len(revs) == 1 && strings.HasSuffix(revs[0], "^!"):
		if cached || mergeBase {
			return Scope{}, &RequestError{msg.NewError("A commit's own change compares it with its parent, so --cached and --merge-base do not apply")}
		}
		s.kind, s.right, s.one = ScopeCommits, strings.TrimSuffix(revs[0], "^!"), true
		if s.right == "" {
			return Scope{}, &RequestError{msg.NewError("Not a revision: {revision}", "revision", revs[0])}
		}
	case len(revs) == 1 && strings.Contains(revs[0], ".."):
		if cached || mergeBase {
			return Scope{}, &RequestError{msg.NewError("A range compares two commits, so --cached and --merge-base do not apply")}
		}
		left, right, symmetric := strings.Cut(revs[0], "...")
		if !symmetric {
			left, right, _ = strings.Cut(revs[0], "..")
		}
		s.kind, s.left, s.right, s.mergeBase = ScopeCommits, left, right, symmetric
	case len(revs) == 2:
		if cached {
			return Scope{}, &RequestError{msg.NewError("--cached compares the index with one commit, not two")}
		}
		s.kind, s.left, s.right, s.mergeBase = ScopeCommits, revs[0], revs[1], mergeBase
	case len(revs) == 1:
		s.kind, s.left, s.mergeBase = ScopeWorktree, revs[0], mergeBase
		if cached {
			s.kind = ScopeIndex
		}
	default:
		if mergeBase {
			return Scope{}, &RequestError{msg.NewError("--merge-base needs a commit to find the merge-base with")}
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
// refused here so the message says why, as is a "^!" anywhere but the end of
// a scope's only revision. "" is allowed and means HEAD.
func checkRevision(rev string) error {
	switch {
	case rev == "":
		return nil
	case strings.HasPrefix(rev, "-"), strings.HasPrefix(rev, "."), strings.Contains(rev, ".."), strings.Contains(rev, "^!"):
		return &RequestError{msg.NewError("Not a revision: {revision}", "revision", rev)}
	}
	return nil
}

// Info is the scope as it is reported back with a review.
func (s Scope) Info() ScopeInfo {
	info := ScopeInfo{Input: s.Input(), Kind: s.Kind(), Label: s.Label()}
	if m, words := s.labelMessage(); words {
		info.LabelMessage = &m
	}
	return info
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
	if m, words := s.labelMessage(); words {
		return m.English()
	}
	switch {
	case s.one:
		return s.right + "^!"
	case s.mergeBase:
		return revisionName(s.left) + "..." + revisionName(s.right)
	}
	return revisionName(s.left) + ".." + revisionName(s.right)
}

// revisionName is a revision as a label names it, "" being HEAD.
func revisionName(rev string) string {
	if rev == "" {
		return "HEAD"
	}
	return rev
}

// labelMessage is Label as a message, and false for a commit range, whose label
// is git's notation rather than words a language translates.
func (s Scope) labelMessage() (msg.Message, bool) {
	name := revisionName
	switch {
	case s.branch:
		return msg.New("Working tree against the merge-base with the default branch"), true
	case s.last:
		return msg.New("Last commit against its parent"), true
	case s.turn:
		return msg.New("Working tree against the start of this turn"), true
	}
	switch s.Kind() {
	case ScopeIndex:
		if s.mergeBase {
			return msg.New("Staged against the merge-base with {revision}", "revision", name(s.left)), true
		}
		return msg.New("Staged against {revision}", "revision", name(s.left)), true
	case ScopeUnstaged:
		return msg.New("Working tree against the index"), true
	case ScopeCommits:
		return msg.Message{}, false
	}
	if s.mergeBase {
		return msg.New("Working tree against the merge-base with {revision}", "revision", name(s.left)), true
	}
	return msg.New("Working tree against {revision}", "revision", name(s.left)), true
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
	if s.turn {
		return resolveTurn(ctx, dir, s, budget)
	}
	r := resolvedScope{Scope: s}
	switch s.Kind() {
	case ScopeUnstaged:
		return r, nil

	case ScopeCommits:
		if s.last || s.one {
			rev := "HEAD"
			if s.one {
				rev = s.right
			}
			head, parent, err := resolveWithParent(ctx, dir, rev, budget)
			if err != nil {
				return r, err
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

// resolveCommit is revParse for a revision the user named, "" being HEAD. A
// whole id a read of this repository has already resolved is a commit without
// asking git again: what an id names cannot change.
func resolveCommit(ctx context.Context, dir, rev string, budget time.Duration) (string, error) {
	if rev == "" {
		rev = "HEAD"
	}
	if knownCommit(dir, rev) {
		return rev, nil
	}
	id, ok, err := revParse(ctx, dir, rev, budget)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", unknownRevision(rev)
	}
	return id, nil
}

// unknownRevision is the refusal of a revision the repository does not have.
func unknownRevision(rev string) error {
	if rev == "HEAD" {
		return &RequestError{msg.NewError("This repository has no commits yet")}
	}
	return &RequestError{msg.NewError("Unknown revision {revision}", "revision", rev)}
}

// resolveWithParent is the commit rev names and what its own change is
// compared against: its first parent, or for a root commit the tree of
// nothing. One rev-parse names both — the commit, then its parents (^@, none
// for a root commit) — and an id already resolved costs nothing.
//
// Without --verify rev-parse echoes its --end-of-options and "--" back among
// the ids, which is why only the lines that are ids are read; a name it cannot
// resolve fails the whole command, which is the refusal revParse gives.
func resolveWithParent(ctx context.Context, dir, rev string, budget time.Duration) (id, base string, err error) {
	if rev == "" {
		rev = "HEAD"
	}
	if base, ok := cachedParent(dir, rev); ok {
		return rev, base, nil
	}
	out, ok, err := gitResolveOutput(ctx, dir, budget, "rev-parse", "--end-of-options", rev+"^{commit}", rev+"^{commit}^@", "--")
	if err != nil {
		return "", "", err
	}
	var ids []string
	for _, line := range strings.Split(out, "\n") {
		if isObjectID(line) {
			ids = append(ids, line)
		}
	}
	if !ok || len(ids) == 0 {
		return "", "", unknownRevision(rev)
	}
	id = ids[0]
	switch empty, known := emptyTreeFor(id); {
	case len(ids) > 1:
		base = ids[1]
	case known:
		// A root commit has no parent to be compared with, and is all addition
		// against the tree of nothing.
		base = empty
	default:
		if base, err = gitEmptyTree(ctx, dir, budget); err != nil {
			return "", "", err
		}
	}
	rememberParent(dir, id, base)
	return id, base, nil
}

// mergeBaseOf is the best common ancestor of two commits.
func mergeBaseOf(ctx context.Context, dir, a, b string, budget time.Duration) (string, error) {
	id, ok, err := gitResolve(ctx, dir, budget, "merge-base", a, b)
	switch {
	case err != nil:
		return "", err
	case !ok:
		return "", &RequestError{msg.NewError("{first} and {second} have no common ancestor", "first", shortID(a), "second", shortID(b))}
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
	return "", &RequestError{msg.NewError("No default branch: none of {branches} exists", "branches", strings.Join(defaultBranchCandidates, ", "))}
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
	id, ok, err := gitResolveOutput(ctx, dir, budget, args...)
	return id, ok && id != "", err
}

// gitResolveOutput is gitResolve for a command that prints any number of
// lines: what it printed, trimmed, and ok=false when it said no.
func gitResolveOutput(ctx context.Context, dir string, budget time.Duration, args ...string) (string, bool, error) {
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
	return strings.TrimSpace(string(out)), true, nil
}

// shortID is an object id as a person reads one.
func shortID(id string) string {
	if len(id) > 10 {
		return id[:10]
	}
	return id
}
