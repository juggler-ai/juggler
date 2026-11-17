//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitattr

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"juggler/cmd/juggler/gitcmd"
)

// hashBudget is how long reading one file's blob id may take.
const hashBudget = 10 * time.Second

// Located is a file as a Record names it, and the blob id of what it holds.
type Located struct {
	Repo string
	Path string
	Blob string
}

// Locate names a file of the tree rooted at root as a Record does, and reads
// its blob id. ok is false for a file outside root, in no git repository, or
// inside a repository's .git.
//
// The repository is the nearest folder above the file holding a .git (a
// folder, or the file a linked worktree or submodule has). The blob id is
// `git hash-object`'s, run there, so it is what staging the file would store,
// in the repository's own hash.
func Locate(ctx context.Context, root, file string) (Located, bool, error) {
	root, file = filepath.Clean(root), filepath.Clean(file)
	if !within(root, file) {
		return Located{}, false, nil
	}
	top := ""
	for dir := filepath.Dir(file); ; dir = filepath.Dir(dir) {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			top = dir
			break
		}
		if parent := filepath.Dir(dir); parent == dir {
			return Located{}, false, nil
		}
	}
	rel, err := filepath.Rel(top, file)
	if err != nil {
		return Located{}, false, nil
	}
	rel = filepath.ToSlash(rel)
	if slices.Contains(strings.Split(rel, "/"), ".git") {
		return Located{}, false, nil
	}
	repo := ""
	if within(root, top) && top != root {
		r, err := filepath.Rel(root, top)
		if err != nil {
			return Located{}, false, nil
		}
		repo = filepath.ToSlash(r)
	}
	out, err := gitcmd.Capture(ctx, top, hashBudget, 1024, "hash-object", "--", rel)
	if err != nil {
		return Located{}, false, err
	}
	return Located{Repo: repo, Path: rel, Blob: strings.TrimSpace(string(out.Kept))}, true, nil
}

// within says whether path is dir or under it.
func within(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
