//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/gitview/internal/clocks"
)

// GitDirs names the two directories git keeps a working tree's state in, each
// absolute with every symbolic link resolved. gitDir holds what belongs to this
// tree alone — HEAD, the index, the files of an operation in progress — and
// commonDir what every tree of the repository shares: refs, packed-refs, the
// stash, the configuration. In a main tree they are the same directory; in a
// linked worktree, whose `.git` is a file, gitDir is `<commonDir>/worktrees/<name>`.
//
// The links are resolved because the two are compared across trees: git spells a
// main tree's directory relative to the tree and a linked tree's common directory
// as the real path, so the same directory reached through a symbolic link (macOS
// keeps its temporary directories under one) would otherwise be two.
func GitDirs(ctx context.Context, dir string) (gitDir, commonDir string, err error) {
	out, err := gitRead(ctx, dir, clocks.Status.PerCmd, 64*1024, "rev-parse", "--git-dir", "--git-common-dir")
	if err != nil {
		return "", "", err
	}
	lines := strings.Split(strings.TrimRight(string(out.Kept), "\n"), "\n")
	if len(lines) != 2 {
		return "", "", errors.New("git rev-parse named no git directory")
	}
	if gitDir, err = resolveGitDir(dir, lines[0]); err != nil {
		return "", "", err
	}
	if commonDir, err = resolveGitDir(dir, lines[1]); err != nil {
		return "", "", err
	}
	return gitDir, commonDir, nil
}

// gitDirsOf is GitDirs read off disk where it can be (see repoIdentity), and
// asked of git where it cannot.
func gitDirsOf(ctx context.Context, dir string) (gitDir, commonDir string, err error) {
	if id, ok := repoIdentity(dir); ok {
		return id.gitDir, id.commonDir, nil
	}
	return GitDirs(ctx, dir)
}

// mainTreePath names the main working tree that git listed at path, in the
// repository whose common git directory is common. git lists a main tree that
// core.worktree places — every submodule's — by its git directory, in
// `worktree list` and in for-each-ref's worktreepath alike; that is resolved to
// the tree core.worktree names. Any other path, and a bare repository's, is
// returned as it is.
func mainTreePath(ctx context.Context, common, path string) string {
	if path != common {
		return path
	}
	out, err := gitRead(ctx, common, clocks.Status.PerCmd, 64*1024, "--git-dir", common, "rev-parse", "--show-toplevel")
	if err != nil {
		return path
	}
	top := strings.TrimSpace(string(out.Kept))
	if top == "" {
		return path
	}
	return resolvedPath(top)
}

// resolveGitDir makes one directory rev-parse printed absolute and real. git
// prints it relative to the directory it ran in, or absolute.
func resolveGitDir(dir, printed string) (string, error) {
	if !filepath.IsAbs(printed) {
		printed = filepath.Join(dir, printed)
	}
	return filepath.EvalSymlinks(printed)
}

// Repos is every repository under root that the status card reports: the same
// shallow, pruned search, so a caller naming a repository by RepoPath names it
// as the card does.
func Repos(ctx context.Context, root string) []string {
	return discoverRepos(ctx, root)
}

// RepoPath names a repository found under root the way the card and the API do:
// relative, forward-slashed, and "" for the root repository itself.
func RepoPath(root, dir string) string {
	return repoRelativePath(root, dir)
}

// RealPath is a path with its symbolic links resolved, up to the last part of
// it that exists: two names for one place compare equal, even once the place
// itself has gone.
func RealPath(p string) string {
	return resolvedPath(p)
}
