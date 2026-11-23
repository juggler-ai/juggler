//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"context"

	"juggler/cmd/juggler/gitview"
)

// SnapshotTurn records the working tree of the repository dir is in as conv's
// turn snapshot (refs/juggler/turns/<conv>), which the @turn scope compares the
// working tree against, and returns the tree. A dir in no repository, or on a
// machine without git (gitcmd.Available), has no snapshot and is ok=false with
// no error; without git, nothing is run to find that out.
//
// Writing the tree touches only a private index and the object store, so it
// runs outside the queue; the ref update waits its turn on the repository's
// common directory, like every other write to its refs.
func SnapshotTurn(ctx context.Context, q *Queue, dir, conv string) (string, bool, error) {
	_, common, err := gitview.GitDirs(ctx, dir)
	if err != nil {
		if ctx.Err() != nil {
			return "", false, ctx.Err()
		}
		return "", false, nil
	}
	tree, err := gitview.WorktreeTree(ctx, dir)
	if err != nil {
		return "", false, err
	}
	turn, err := q.Wait(ctx, common)
	if err != nil {
		return "", false, err
	}
	defer turn.Done()
	if err := gitview.WriteTurnSnapshot(ctx, dir, conv, tree); err != nil {
		return "", false, err
	}
	return tree, true, nil
}
