//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"strings"
	"sync"

	"juggler/cmd/juggler/gitview/internal/clocks"
)

// Worktrees is every working tree of a repository, the main one first, as the
// git client's worktree switcher and the Refs place list them.
type Worktrees struct {
	Repo  string     `json:"repo"`
	Trees []Worktree `json:"trees"`
}

// Worktree is one working tree, wherever it is on disk.
//
// Path has its symbolic links resolved — up to the last part that still exists,
// for a tree whose directory is gone — so that it can be compared with any
// other path that names the same place.
//
// Dirty, Upstream, Ahead, Behind and Operation are read from the tree itself,
// and only from a tree that is there to read: Dirty is nil for a tree that is
// prunable, bare, or that git could not answer for in time, which is a tree
// whose state is unknown rather than one that is clean.
type Worktree struct {
	Path        string `json:"path"`
	Head        string `json:"head"`
	Branch      string `json:"branch,omitempty"`
	Detached    bool   `json:"detached,omitempty"`
	Bare        bool   `json:"bare,omitempty"`
	Main        bool   `json:"main,omitempty"`
	Current     bool   `json:"current,omitempty"` // the tree the read was asked of
	Locked      bool   `json:"locked,omitempty"`
	LockReason  string `json:"lockReason,omitempty"`
	Prunable    bool   `json:"prunable,omitempty"`
	PruneReason string `json:"pruneReason,omitempty"`
	Dirty       *int   `json:"dirty"`
	Upstream    string `json:"upstream,omitempty"`
	Ahead       int    `json:"ahead"`
	Behind      int    `json:"behind"`
	Operation   string `json:"operation,omitempty"`

	// Tree is the id that views this tree through the git API — null for a
	// tree that cannot be viewed, since "" is the project's id — and Rows the
	// open workspace rows rooted at it. TreeRepo is the repository to view
	// within the tree Tree names, by its path there: "" for that tree's root,
	// a nested repository's path when Tree names the tree it is nested in.
	// gitview cannot know any of them; the caller that knows the workspace
	// table fills them in (workspace.GitTrees.Annotate).
	Tree     *string  `json:"tree"`
	TreeRepo string   `json:"treeRepo,omitempty"`
	Rows     []string `json:"rows,omitempty"`
}

// worktreeReads is how many trees are asked for their state at once.
const worktreeReads = 4

// ReadWorktrees reads the worktrees of one repository under root, named as the
// API names it.
//
// The list is `worktree list --porcelain` without -z, which needs git 2.36:
// without it git C-quotes a path holding a newline or a quote, and the quoting
// is undone here, which serves every git the server may find.
func ReadWorktrees(ctx context.Context, root, repo string) (Worktrees, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	w, err := ListWorktrees(ctx, root, repo)
	if err != nil {
		return Worktrees{}, err
	}
	readTreeStates(ctx, w.Trees)
	return w, nil
}

// ListWorktrees is ReadWorktrees without asking any tree for its state: what
// git lists, and no more, for a caller that only needs to know which trees
// there are.
func ListWorktrees(ctx context.Context, root, repo string) (Worktrees, error) {
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return Worktrees{}, err
	}
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, refsReadMax, "worktree", "list", "--porcelain")
	if err != nil {
		return Worktrees{}, err
	}
	w := Worktrees{Repo: RepoPath(root, dir), Trees: parseWorktreeList(string(out.Kept))}
	if len(w.Trees) > 0 && w.Trees[0].Main {
		if _, common, err := gitDirsOf(ctx, dir); err == nil {
			w.Trees[0].Path = mainTreePath(ctx, common, w.Trees[0].Path)
		}
	}
	here := resolvedPath(dir)
	for i := range w.Trees {
		w.Trees[i].Current = w.Trees[i].Path == here
	}
	return w, nil
}

// parseWorktreeList reads `worktree list --porcelain`: a block of lines per
// tree, blocks separated by an empty line, the main tree's first.
func parseWorktreeList(out string) []Worktree {
	trees := []Worktree{}
	var cur *Worktree
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			cur = nil
			continue
		}
		key, value, _ := strings.Cut(line, " ")
		if key == "worktree" {
			trees = append(trees, Worktree{Path: resolvedPath(unquoteGitPath(value)), Main: len(trees) == 0})
			cur = &trees[len(trees)-1]
			continue
		}
		if cur == nil {
			continue
		}
		switch key {
		case "HEAD":
			cur.Head = value
		case "branch":
			cur.Branch = strings.TrimPrefix(value, "refs/heads/")
		case "detached":
			cur.Detached = true
		case "bare":
			cur.Bare = true
		case "locked":
			cur.Locked, cur.LockReason = true, unquoteGitPath(value)
		case "prunable":
			cur.Prunable, cur.PruneReason = true, unquoteGitPath(value)
		}
	}
	return trees
}

// readTreeStates asks each live tree for its state, a few at a time, each
// under the status card's clock: a tree on a slow disk is reported as unknown
// rather than holding back the list.
func readTreeStates(ctx context.Context, trees []Worktree) {
	slots := make(chan struct{}, worktreeReads)
	var wg sync.WaitGroup
	for i := range trees {
		t := &trees[i]
		if t.Prunable || t.Bare {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			readTreeState(ctx, t)
		}()
	}
	wg.Wait()
}

// readTreeState fills in one tree's state, leaving Dirty nil when git could not
// say.
func readTreeState(ctx context.Context, t *Worktree) {
	status, err := repoStatus(ctx, t.Path, repoStatusOptions{perCmd: clocks.Status.PerCmd})
	if err != nil {
		return
	}
	gitDir, _, err := gitDirsOf(ctx, t.Path)
	if err != nil {
		return
	}
	dirty := status.Total
	t.Dirty = &dirty
	t.Upstream, t.Ahead, t.Behind = status.Upstream, status.Ahead, status.Behind
	t.Operation = OperationIn(gitDir)
}
