//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"juggler/cmd/juggler/gitcmd"
	"juggler/cmd/juggler/msg"
)

// turnRefPrefix is where a conversation's turn snapshot is kept: one ref per
// conversation, naming the tree its working tree held when its latest user turn
// began. A ref, so gc keeps the tree and every blob in it.
const turnRefPrefix = "refs/juggler/turns/"

// turnConversationPattern is what a conversation id must look like to be put in
// a ref name: no slash, no "..", no ".lock" ending, nothing git refuses.
var turnConversationPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// TurnRef is the ref that holds conv's turn snapshot, and false for an id that
// cannot name one.
func TurnRef(conv string) (string, bool) {
	if !turnConversationPattern.MatchString(conv) {
		return "", false
	}
	return turnRefPrefix + conv, true
}

// WorktreeTree writes the working tree of the repository at dir as a tree object
// and returns its id: every tracked file as it is on disk and every untracked
// file `git add -A` would take, ignored files left out.
//
// The real index is never touched. The adds go to a private copy of it — a copy,
// so the stat information already there spares rehashing every unchanged file —
// or, in a repository with no index yet, to one read from HEAD. Blobs for files
// not yet in the object store are written to it, which is what lets the tree be
// read back later.
func WorktreeTree(ctx context.Context, dir string) (string, error) {
	indexPath, err := gitOutput(ctx, dir, nil, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp("", "juggler-turn-index-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	seeded, err := copyIndex(indexPath, tmp)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if seeded {
		// git trusts an entry's stat only when its mtime predates the index
		// file's own; a copy with a fresh mtime would pass a same-second,
		// same-size edit as clean. The copy keeps the original's.
		if err := keepIndexTime(indexPath, tmpPath); err != nil {
			return "", err
		}
	}
	env := []string{"GIT_INDEX_FILE=" + tmpPath}
	if !seeded {
		// git reads an empty file as a corrupt index, so the copy that never
		// happened leaves none at all.
		if err := os.Remove(tmpPath); err != nil {
			return "", err
		}
		if _, err := gitOutput(ctx, dir, nil, "rev-parse", "--verify", "-q", "HEAD"); err == nil {
			if _, err := gitOutput(ctx, dir, env, "read-tree", "HEAD"); err != nil {
				return "", err
			}
		}
	}
	if _, err := gitOutput(ctx, dir, env, "add", "-A", "--ignore-errors"); err != nil {
		return "", err
	}
	tree, err := gitOutput(ctx, dir, env, "write-tree")
	if err != nil {
		return "", err
	}
	if tree == "" {
		return "", errors.New("git wrote no tree")
	}
	return tree, nil
}

// copyIndex copies the index at path into dst, false when there is none.
func copyIndex(path string, dst io.Writer) (bool, error) {
	src, err := os.Open(filepath.Clean(path))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer func() { _ = src.Close() }()
	_, err = io.Copy(dst, src)
	return err == nil, err
}

// keepIndexTime gives the copy at dst the modification time of the index at src.
func keepIndexTime(src, dst string) error {
	info, err := os.Stat(filepath.Clean(src))
	if err != nil {
		return err
	}
	return os.Chtimes(dst, info.ModTime(), info.ModTime())
}

// TurnSnapshot is the tree conv's turn snapshot names in the repository at dir,
// and false when it has none, asked of git within budget.
func TurnSnapshot(ctx context.Context, dir, conv string, budget time.Duration) (string, bool, error) {
	ref, ok := TurnRef(conv)
	if !ok {
		return "", false, nil
	}
	return gitResolve(ctx, dir, budget, "rev-parse", "--verify", "-q", "--end-of-options", ref+"^{tree}")
}

// WriteTurnSnapshot points conv's turn ref at tree. A ref write, so a caller
// with the git write queue holds the repository's turn on it while it runs.
func WriteTurnSnapshot(ctx context.Context, dir, conv, tree string) error {
	ref, ok := TurnRef(conv)
	if !ok {
		return fmt.Errorf("conversation id %q cannot name a ref", conv)
	}
	return turnRefWrite(ctx, dir, "update-ref", "-m", "juggler: turn snapshot", ref, tree)
}

// DropTurnSnapshot deletes conv's turn ref, if it has one, so the tree it
// kept is gc's to collect. A conversation's going is final, so nothing waits
// on the write queue for it: the ref is the conversation's alone and git's own
// ref lock is all that guards it. Without git there is nothing it could drop,
// and nothing to say about that.
func DropTurnSnapshot(ctx context.Context, dir, conv string) error {
	ref, ok := TurnRef(conv)
	if !ok || gitcmd.Available() != nil {
		return nil
	}
	if _, found, err := gitResolve(ctx, dir, time.Minute, "rev-parse", "--verify", "-q", "--end-of-options", ref); err != nil || !found {
		return err
	}
	return turnRefWrite(ctx, dir, "update-ref", "-d", ref)
}

// turnRefWrite runs one write of a turn ref.
func turnRefWrite(ctx context.Context, dir string, args ...string) error {
	cmd := gitcmd.Command(ctx, dir, gitcmd.Write, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return nil
}

// gitOutput runs one command over the temporary index and returns what it
// printed, trimmed; a failure carries git's own complaint. The adds write the
// temporary index and blobs, never the repository's index or its refs, so it
// runs as a Read and takes no lock the user's git client could be waiting on.
func gitOutput(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	cmd := gitcmd.Command(ctx, dir, gitcmd.Read, args...)
	if env != nil {
		cmd.Env = append(os.Environ(), env...)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}

// resolveTurn pins @turn to one repository: the conversation's snapshot against
// the working tree as it is now, both as trees, so an untracked file is on
// either side exactly when it was there.
func resolveTurn(ctx context.Context, dir string, s Scope, budget time.Duration) (resolvedScope, error) {
	r := resolvedScope{Scope: s}
	if _, ok := TurnRef(s.conv); !ok {
		return r, &RequestError{msg.NewError("The @turn scope needs a conversation")}
	}
	base, ok, err := TurnSnapshot(ctx, dir, s.conv, budget)
	switch {
	case err != nil:
		return r, err
	case !ok:
		return r, &RequestError{msg.NewError("This conversation has no turn snapshot yet")}
	}
	cctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	target, err := WorktreeTree(cctx, dir)
	if err != nil {
		if cctx.Err() != nil {
			return r, gitDeadlineError(ctx, cctx, budget)
		}
		return r, err
	}
	r.base, r.target = base, target
	return r, nil
}
