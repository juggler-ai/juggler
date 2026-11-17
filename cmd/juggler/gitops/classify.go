//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import "strings"

// Kinds is a set of the parts of a working tree's git state that changed, so a
// reader re-reads only those: the index, the refs (branches, tags, remotes, the
// stash, upstream configuration), HEAD, the files of the working tree, and an
// operation in progress (merge, rebase, cherry-pick, revert).
type Kinds uint8

// The kinds of change. Their order is the order Names lists them in.
const (
	KindIndex Kinds = 1 << iota
	KindRefs
	KindHead
	KindWorktree
	KindOperation

	// AllKinds is what a tree is told when what changed cannot be known — its
	// git directory vanished, or events were lost — so that everything is read
	// again.
	AllKinds = KindIndex | KindRefs | KindHead | KindWorktree | KindOperation
)

// kindNames are the kinds as the wire spells them, in bit order.
var kindNames = [...]string{"index", "refs", "head", "worktree", "operation"}

// Names lists the kinds in the set as the wire spells them, in a fixed order.
func (k Kinds) Names() []string {
	names := []string{}
	for i, name := range kindNames {
		if k&(1<<i) != 0 {
			names = append(names, name)
		}
	}
	return names
}

// operationDirs are the directories git keeps an operation's progress in, in
// the tree's own git directory. Their appearing and going is the operation
// starting and ending.
var operationDirs = map[string]bool{"rebase-merge": true, "rebase-apply": true, "sequencer": true}

// classifyTreeDir names what a change to a path in a tree's own git directory
// (relative to it, forward-slashed) means: the files git keeps per worktree.
// FETCH_HEAD is kept with the tree that fetched, but what a fetch changes is the
// repository's, so it is a change to refs and every tree hears of it.
//
// A lock file is a write in progress, and its rename into place is the change,
// so a lock is nothing.
func classifyTreeDir(rel string) Kinds {
	if strings.HasSuffix(rel, ".lock") {
		return 0
	}
	switch rel {
	case "HEAD", "logs/HEAD":
		return KindHead
	case "index":
		return KindIndex
	case "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD":
		return KindOperation
	case "FETCH_HEAD":
		return KindRefs
	}
	first, _, _ := strings.Cut(rel, "/")
	if operationDirs[first] {
		return KindOperation
	}
	return 0
}

// classifyCommonDir names what a change to a path in a repository's common
// directory (relative to it, forward-slashed) means: what every tree of the
// repository shares. Everything it reports is a change to refs, in the broad
// sense: the refs themselves, packed or loose; the stash's reflog, which is all
// that changes when an older stash entry is dropped; the configuration, where a
// branch's upstream lives; and the list of linked worktrees. A linked tree's own
// directory lies inside this one (worktrees/<name>/…) and is classified as that
// tree's, not here.
func classifyCommonDir(rel string) Kinds {
	if strings.HasSuffix(rel, ".lock") {
		return 0
	}
	switch rel {
	case "packed-refs", "config", "logs/refs/stash", "refs", "worktrees":
		return KindRefs
	}
	if strings.HasPrefix(rel, "refs/") {
		return KindRefs
	}
	if name, ok := strings.CutPrefix(rel, "worktrees/"); ok && !strings.Contains(name, "/") {
		return KindRefs
	}
	return 0
}
