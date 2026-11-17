//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"strings"

	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/msg"
)

// The plain worktree writes: lock, unlock, remove and prune, on any tree of
// the repository wherever it is.
//
// A tree that is a Juggler workspace is its provider's to remove — it knows
// the branch it made and the conversations bound there — and the client asks
// the provider instead. Nothing here can tell such a tree from any other, so
// the rule is the client's to keep.

// worktree finds the tree an op names among the repository's.
func (r *runner) worktree(path string) (gitview.Worktree, error) {
	trees, err := r.worktrees()
	if err != nil {
		return gitview.Worktree{}, err
	}
	want := gitview.RealPath(path)
	for _, t := range trees {
		if t.Path == want && path != "" {
			return t, nil
		}
	}
	return gitview.Worktree{}, refused(msg.NewError("{path} is not a worktree of this repository.", "path", path))
}

func worktreeLock(r *runner, op Op) (Result, error) {
	t, err := r.worktree(op.Worktree)
	if err != nil {
		return Result{}, err
	}
	args := []string{"worktree", "lock"}
	if op.Reason != "" {
		args = append(args, "--reason", op.Reason)
	}
	_, err = r.git(append(args, "--", t.Path)...)
	return Result{}, err
}

func worktreeUnlock(r *runner, op Op) (Result, error) {
	t, err := r.worktree(op.Worktree)
	if err != nil {
		return Result{}, err
	}
	_, err = r.git("worktree", "unlock", "--", t.Path)
	return Result{}, err
}

// worktreeRemove removes a tree other than the main one and the one the write
// runs in. A dirty or locked tree is refused until forced; a forced removal of
// a dirty one saves its changes to DiscardRef first, untracked files included,
// and names the recovery point in Result.Saved.
func worktreeRemove(r *runner, op Op) (Result, error) {
	t, err := r.worktree(op.Worktree)
	if err != nil {
		return Result{}, err
	}
	switch {
	case t.Main:
		return Result{}, refused(msg.NewError("The main worktree can't be removed."))
	case t.Current:
		return Result{}, refused(msg.NewError("The worktree being shown can't be removed from itself."))
	}
	var changed []string
	if !t.Prunable {
		if changed, err = r.changedIn(t.Path); err != nil {
			return Result{}, err
		}
	}
	if !op.Force {
		switch {
		case len(changed) > 0:
			return Result{}, refused(msg.NewError("{path} has uncommitted changes.", "path", t.Path))
		case t.Locked:
			return Result{}, refused(msg.NewError("{path} is locked.", "path", t.Path))
		}
	}
	var res Result
	if len(changed) > 0 {
		inTree := &runner{ctx: r.ctx, root: t.Path, dir: t.Path, gitDir: r.gitDir, hooks: Hooks{}}
		save, err := inTree.saveDiscard(changed)
		if err != nil {
			return Result{}, err
		}
		res.Saved = save.first
	}
	args := []string{"worktree", "remove"}
	if op.Force {
		args = append(args, "--force")
		if t.Locked {
			args = append(args, "--force")
		}
	}
	_, err = r.git(append(args, "--", t.Path)...)
	return res, err
}

// changedIn lists the files of a tree with changes in its working tree,
// untracked ones each by name.
func (r *runner) changedIn(dir string) ([]string, error) {
	inTree := &runner{ctx: r.ctx, root: dir, dir: dir, gitDir: r.gitDir}
	out, err := inTree.run(call{args: []string{"status", "--porcelain", "-z", "--untracked-files=all"}, quiet: true})
	if err != nil {
		return nil, err
	}
	var paths []string
	records := strings.Split(string(out), "\x00")
	for i := 0; i < len(records); i++ {
		rec := records[i]
		if len(rec) < 4 {
			continue
		}
		paths = append(paths, rec[3:])
		if rec[0] == 'R' || rec[0] == 'C' {
			i++ // the old name follows
		}
	}
	return paths, nil
}

func worktreePrune(r *runner, _ Op) (Result, error) {
	_, err := r.git("worktree", "prune")
	return Result{}, err
}
