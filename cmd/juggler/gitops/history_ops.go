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

// The History place's writes: a commit picked onto, or reverted on, the
// current branch, and the current branch reset to a commit.
//
// A hard reset throws away the working tree's changes to tracked files, so it
// saves them to DiscardRef first, as a discard does; undoing it is one more
// reset, back to the old tip, that writes them back.

// emptyResult is how git says a pick or a revert made no change: what the
// commit does is already there. A pick says so and stays in progress; a revert
// says only that there is nothing to commit.
var emptyResult = []string{"is now empty", "nothing to commit"}

func cherryPick(r *runner, op Op) (Result, error) {
	return r.applyCommit(op, "cherry-pick",
		msg.NewError("That commit's change is already here, so nothing was picked."))
}

func revert(r *runner, op Op) (Result, error) {
	return r.applyCommit(op, "revert",
		msg.NewError("That commit's change is already undone here, so nothing was reverted."), "--no-edit")
}

// applyCommit picks or reverts Rev on the current branch — a merge as its
// change against its first parent. One that would change nothing is abandoned
// and refused with empty, before the pick it leaves in progress could be read
// as a stop on conflicts.
func (r *runner) applyCommit(op Op, verb string, empty *msg.Error, flags ...string) (Result, error) {
	at, err := r.rev(op.Rev)
	if err != nil {
		return Result{}, err
	}
	args := append([]string{verb}, flags...)
	line, _, err := r.ask("rev-list", "--parents", "-n", "1", at)
	if err != nil {
		return Result{}, err
	}
	if len(strings.Fields(line)) > 2 {
		args = append(args, "-m", "1")
	}
	args = append(args, at)
	refuse := func(err error) error {
		if !said(err, emptyResult...) {
			return nil
		}
		for _, name := range []string{"CHERRY_PICK_HEAD", "REVERT_HEAD"} {
			if _, statErr := os.Stat(filepath.Join(r.gitDir, name)); statErr == nil {
				_, _ = r.git(verb, "--abort")
				break
			}
		}
		return refused(empty)
	}
	return r.intoCurrent(op, "Juggler: set aside to "+verb+" "+op.Rev, refuse, args...)
}

// reset moves the current branch, from where the client saw it, to Rev.
// Result.Sha is where it was, which is what resetting back names. A hard reset
// saves the changes it throws away first and names the save in Result.Saved;
// one naming such a save in Discard is the undo of one, and writes them back.
func reset(r *runner, op Op) (Result, error) {
	switch op.Mode {
	case ResetSoft, ResetMixed, ResetHard, ResetKeep:
	default:
		return Result{}, refused(msg.NewError("Unknown way to reset: {mode}", "mode", op.Mode))
	}
	branch, ok, err := r.ask("symbolic-ref", "-q", "--short", "HEAD")
	if err != nil {
		return Result{}, err
	}
	if !ok || branch == "" {
		return Result{}, refused(msg.NewError("HEAD is detached: there is no branch to reset."))
	}
	if err := r.expect("HEAD", branch, op.ExpectHead); err != nil {
		return Result{}, err
	}
	to, err := r.rev(op.Rev)
	if err != nil {
		return Result{}, err
	}
	if op.Discard != "" {
		return r.resetBack(op, to)
	}
	if op.Mode == ResetKeep {
		// git refuses, touching nothing, when a file it would change has
		// local changes.
		if _, err := r.rawGit("reset", "-q", "--keep", to); err != nil {
			if said(err, "not uptodate", "Cannot merge") {
				return Result{}, dirtyError()
			}
			return Result{}, r.explain(err)
		}
		return Result{Head: r.headSha(), Sha: op.ExpectHead}, nil
	}

	var saved *discardSave
	if op.Mode == ResetHard {
		paths, err := r.trackedChanges()
		if err != nil {
			return Result{}, err
		}
		if len(paths) > 0 {
			if saved, err = r.saveDiscard(paths); err != nil {
				return Result{}, err
			}
		}
	}
	if _, err := r.git("reset", "-q", "--"+op.Mode, to); err != nil {
		return Result{}, err
	}
	res := Result{Head: r.headSha(), Sha: op.ExpectHead}
	if saved != nil {
		res.Saved, err = saved.finish()
	}
	return res, err
}

// resetBack undoes a hard reset: the branch back to Rev and the saved changes
// written back — only into a tree nobody has changed since, since the reset
// would throw away anything done to a tracked file and the writing back
// anything done to a saved one. What was staged is not put back: the save
// holds the working tree alone.
func (r *runner) resetBack(op Op, to string) (Result, error) {
	if op.Mode != ResetHard {
		return Result{}, refused(msg.NewError("Only a hard reset puts saved changes back."))
	}
	rec, err := r.discardRecord(op.Discard)
	if err != nil {
		return Result{}, err
	}
	changes, _, err := r.ask("status", "--porcelain", "-uno")
	if err != nil {
		return Result{}, err
	}
	if changes != "" {
		return Result{}, dirtyError()
	}
	if err := r.leftAsSaved(rec); err != nil {
		return Result{}, err
	}
	if _, err := r.git("reset", "-q", "--hard", to); err != nil {
		return Result{}, err
	}
	for _, f := range rec.Files {
		if err := r.restore(f); err != nil {
			return Result{}, err
		}
	}
	return Result{Head: r.headSha(), Sha: op.ExpectHead}, nil
}

// trackedChanges lists the tracked files whose index or working-tree content
// differs from HEAD — deleted ones included, untracked ones not: what a hard
// reset overwrites. A submodule is left out; the reset does not touch its
// working tree.
func (r *runner) trackedChanges() ([]string, error) {
	out, err := r.run(call{args: []string{"diff", "--name-only", "-z", "HEAD", "--"}, quiet: true})
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, p := range strings.Split(string(out), "\x00") {
		if p == "" {
			continue
		}
		if info, err := os.Lstat(filepath.Join(r.dir, filepath.FromSlash(p))); err == nil && info.IsDir() {
			continue
		}
		paths = append(paths, p)
	}
	return paths, nil
}
