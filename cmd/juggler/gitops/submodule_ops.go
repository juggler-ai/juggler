//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/msg"
)

// submoduleUpdate checks the submodule at Path out at the commit its
// repository records: cloned first if it never was, and that commit fetched if
// it lacks it, which is why this is a network write. --checkout is explicit, so
// a `.gitmodules` that makes an update merge or rebase, or skip it, makes no
// difference here: nothing of the submodule's own is merged into or replayed.
//
// It is the one write the client makes to a submodule as a submodule. Nothing
// is lost by it — a branch the submodule had out stays where it was, and local
// changes in the way make git refuse (DirtyError) — and where its HEAD was is
// the result: Sha and Branch, which switching the submodule's own repository
// back to undoes it. Both are "" for one that was not checked out.
func submoduleUpdate(r *runner, op Op) (Result, error) {
	paths, err := r.files([]string{op.Path})
	if err != nil {
		return Result{}, err
	}
	path := paths[0]
	entry, _, err := r.ask("ls-files", "--stage", "--", path)
	if err != nil {
		return Result{}, err
	}
	if !strings.HasPrefix(entry, "160000 ") {
		return Result{}, refused(msg.NewError("{path} is not a submodule.", "path", path))
	}

	var res Result
	if _, err := os.Lstat(filepath.Join(r.dir, filepath.FromSlash(path), ".git")); err == nil {
		// Only a submodule with a .git of its own is asked: in one not checked
		// out, git would answer for the repository around it.
		if head, ok, err := r.ask("-C", path, "rev-parse", "-q", "--verify", "HEAD"); err != nil {
			return Result{}, err
		} else if ok {
			res.Sha = head
			if branch, ok, err := r.ask("-C", path, "symbolic-ref", "-q", "--short", "HEAD"); err != nil {
				return Result{}, err
			} else if ok {
				res.Branch = branch
			}
		}
	}

	if _, err := r.netGit(false, "submodule", "update", "--init", "--checkout", "--progress", "--", path); err != nil {
		if said(err, dirtyRefusal...) {
			return Result{}, dirtyError()
		}
		return Result{}, err
	}
	return res, nil
}
