//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Git worktree helpers shared by the per-conversation worktree registry
// (conv_worktree.go).
//
// Juggler hosts many conversations (side-tabs) in one process, and the engine
// is a single, engine-wide tool executor shared by all of them. Left alone, two
// tabs each running an agent edit the same working tree and clobber each other.
// The fix, modelled on t3code (each agent in its own worktree), gives every
// conversation a dedicated linked git worktree on its own branch — isolated
// checkout and index, shared object store and history. This file holds the
// low-level git plumbing; ConvWorktrees builds the per-conversation policy on
// top of it.

// WorktreePlan describes a conversation's worktree.
type WorktreePlan struct {
	// Path is the absolute worktree working directory.
	Path string
	// Branch is the branch checked out in the worktree.
	Branch string
	// BaseRepo is the absolute toplevel of the source repository.
	BaseRepo string
	// BaseBranch is the branch (or "HEAD" when detached) the worktree was
	// created from; surfaced to the user so they know how to merge work back.
	BaseBranch string
	// Adopted is true when an existing worktree was reused (continuity across
	// restarts) rather than freshly created.
	Adopted bool
}

// PruneWorktreeIfPristine removes a worktree and its branch iff it holds no
// work — no uncommitted changes and no commits beyond its base branch. It is a
// safe no-op (returns false, nil) for a detached-HEAD base or any worktree that
// holds work, so a conversation's edits and commits are never discarded. Used
// when a conversation is permanently deleted.
func PruneWorktreeIfPristine(plan *WorktreePlan) (bool, error) {
	if plan == nil || plan.BaseBranch == "" || plan.BaseBranch == "HEAD" {
		return false, nil
	}
	// Any working-tree change (staged, unstaged, or untracked) means keep.
	if status, err := runGit(plan.Path, "status", "--porcelain"); err != nil || strings.TrimSpace(status) != "" {
		return false, nil
	}
	// Any commit on the branch not reachable from the base branch means keep.
	ahead, err := runGit(plan.BaseRepo, "rev-list", "--count", plan.BaseBranch+".."+plan.Branch)
	if err != nil || strings.TrimSpace(ahead) != "0" {
		return false, nil
	}
	if _, err := runGit(plan.BaseRepo, "worktree", "remove", plan.Path); err != nil {
		return false, err
	}
	// Best-effort branch cleanup; the worktree is already gone.
	_, _ = runGit(plan.BaseRepo, "branch", "-D", plan.Branch)
	return true, nil
}

// createWorktree adds a worktree at dir on branch, reusing the branch if it
// already exists (e.g. a conversation re-opened after a restart) or creating it
// off the current HEAD otherwise. On success it drops a self-contained ignore
// file so Juggler's own .juggler/ metadata never shows up in the worktree's git
// status or diff.
func createWorktree(top, dir, branch string) error {
	var err error
	if branchExists(top, branch) {
		_, err = runGit(top, "worktree", "add", dir, branch)
	} else {
		_, err = runGit(top, "worktree", "add", "-b", branch, dir, "HEAD")
	}
	if err != nil {
		return err
	}
	writeJugglerIgnore(dir)
	return nil
}

// writeJugglerIgnore ensures <dir>/.juggler/.gitignore ignores everything under
// .juggler/, so Juggler's per-project metadata (lock, sessions, config) stays
// out of the worktree's git status and diff view. It touches only the worktree,
// never the base repository's ignore rules. Best-effort: on any error Juggler
// still works, the metadata just isn't hidden.
func writeJugglerIgnore(dir string) {
	jdir := filepath.Join(dir, ".juggler")
	if err := os.MkdirAll(jdir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(jdir, ".gitignore"), []byte("*\n"), 0o644)
}

// worktreeGroupName is a filesystem-safe, per-repository directory name that
// stays stable across restarts (so a conversation's worktree is re-found and
// adopted) and unique per repo path (so unrelated repos with the same basename
// don't collide).
func worktreeGroupName(top string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(top)))
	return sanitizeName(filepath.Base(top)) + "-" + hex.EncodeToString(sum[:])[:8]
}

// sanitizeName reduces s to a conservative filesystem-safe token.
func sanitizeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-.")
	if out == "" {
		return "repo"
	}
	return out
}

// isRegisteredWorktree reports whether dir is a worktree git currently knows
// about for the repository at top.
func isRegisteredWorktree(top, dir string) bool {
	out, err := runGit(top, "worktree", "list", "--porcelain")
	if err != nil {
		return false
	}
	want := filepath.Clean(dir)
	for _, line := range strings.Split(out, "\n") {
		if rest, ok := strings.CutPrefix(line, "worktree "); ok {
			if filepath.Clean(strings.TrimSpace(rest)) == want {
				return true
			}
		}
	}
	return false
}

// isLinkedWorktree reports whether top is itself a linked worktree (as opposed
// to the repository's main working tree). A linked worktree's git dir sits
// under <common>/worktrees/<name>, so it differs from the common dir.
func isLinkedWorktree(top string) (bool, error) {
	gitDir, err := runGit(top, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return false, err
	}
	commonDir, err := runGit(top, "rev-parse", "--git-common-dir")
	if err != nil {
		return false, err
	}
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(top, commonDir)
	}
	return filepath.Clean(gitDir) != filepath.Clean(commonDir), nil
}

// branchExists reports whether refs/heads/<branch> exists in the repo at top.
func branchExists(top, branch string) bool {
	_, err := runGit(top, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil
}

// gitToplevel returns the absolute toplevel of the git working tree containing
// dir, or an error if dir is not inside one.
func gitToplevel(dir string) (string, error) {
	return runGit(dir, "rev-parse", "--show-toplevel")
}

// repoRootWithin returns the toplevel of the git repository that path belongs
// to, but only when that repository lies within (or is) projectRoot — so a
// conversation is isolated per repo *under the project*. It walks up from path
// to projectRoot looking for a .git entry, catching nested repos and submodules
// (each maps to itself). primaryTop is gitToplevel(projectRoot) — possibly an
// ancestor of projectRoot when the project folder sits inside a larger repo, or
// "" when the project isn't in a repo at all — and is the fallback for paths in
// the project's own repo. Returns "" when path is outside projectRoot or belongs
// to no eligible repo (e.g. a loose non-git file, which then stays shared).
func repoRootWithin(path, projectRoot, primaryTop string) string {
	path = filepath.Clean(path)
	projectRoot = filepath.Clean(projectRoot)
	if !isWithinDir(projectRoot, path) {
		return "" // outside the project — not isolated (see Q2 default)
	}
	for cur := path; ; {
		if hasGitEntry(cur) {
			return cur
		}
		if cur == projectRoot {
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	if primaryTop != "" && isWithinDir(primaryTop, path) {
		return primaryTop
	}
	return ""
}

// hasGitEntry reports whether dir contains a `.git` entry (a directory for a
// normal repo, a file for a submodule or linked worktree) — i.e. dir is a repo
// toplevel.
func hasGitEntry(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, ".git"))
	return err == nil
}

// isWithinDir reports whether child is parent or lives beneath it.
func isWithinDir(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// runGit runs a git command in dir and returns trimmed stdout, wrapping any
// failure with the command and stderr for context.
func runGit(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg != "" {
			return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, msg)
		}
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(out.String()), nil
}
