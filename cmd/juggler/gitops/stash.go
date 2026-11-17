//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"strconv"
	"strings"

	"juggler/cmd/juggler/msg"
)

// The stash, as the Refs place shows it.
//
// The client names a stash by its commit, never by stash@{n}: that position
// moves whenever a stash is made or dropped, so the one the user chose could
// be another by the time the write runs. The position is worked out here,
// under the queue, and a stash that is no longer on the list is stale.

// stashTop is the newest stash's commit, or "" when there is none.
func (r *runner) stashTop() string {
	sha, _, _ := r.ask("rev-parse", "-q", "--verify", "refs/stash")
	return sha
}

// stashAt finds a stash by its commit, returning its stash@{n} and its message.
func (r *runner) stashAt(sha string) (string, string, error) {
	if sha == "" {
		return "", "", refused(msg.NewError("No stash was named."))
	}
	out, _, err := r.ask("stash", "list", "--format=%H%x00%gs")
	if err != nil {
		return "", "", err
	}
	for i, line := range strings.Split(out, "\n") {
		id, message, _ := strings.Cut(line, "\x00")
		if id == sha {
			return "stash@{" + strconv.Itoa(i) + "}", message, nil
		}
	}
	return "", "", &StaleError{Err: msg.NewError("That stash is no longer on the list. Look again.")}
}

// setAside stashes the working tree's changes, untracked files included, and
// returns the stash's commit — "" when there was nothing to set aside, which is
// told by whether a stash was made rather than from what git printed.
func (r *runner) setAside(message string) (string, error) {
	before := r.stashTop()
	if _, err := r.run(call{args: []string{"stash", "push", "-q", "-u", "-m", message}, noPathspecs: true}); err != nil {
		return "", err
	}
	if after := r.stashTop(); after != before {
		return after, nil
	}
	return "", nil
}

// putBack restores what setAside stashed after the write it made way for
// failed before touching anything. It is cleanup after a failure already being
// reported; if it cannot, the stash stays on the list for the user.
func (r *runner) putBack(stash string) {
	_ = r.applyStash(stash, true)
}

// applyStash applies a stash, its staged changes staged again where git can
// manage it, and drops it afterwards when drop is set. One that stops on
// conflicts is kept, whatever drop says.
func (r *runner) applyStash(sha string, drop bool) error {
	ref, _, err := r.stashAt(sha)
	if err != nil {
		return err
	}
	if _, err := r.rawGit("stash", "apply", "-q", "--index", ref); err != nil {
		if r.stopped() {
			return conflictsError()
		}
		// --index refuses a stash whose staged changes no longer apply to the
		// index; the changes themselves may still apply to the working tree.
		if _, err := r.rawGit("stash", "apply", "-q", ref); err != nil {
			if r.stopped() {
				return conflictsError()
			}
			if said(err, dirtyRefusal...) {
				return dirtyError()
			}
			return r.explain(err)
		}
	}
	if !drop {
		return nil
	}
	// Applying may have made nothing new, but the position is read again rather
	// than trusted: the stash is dropped by what it is.
	if ref, _, err = r.stashAt(sha); err != nil {
		return err
	}
	_, err = r.git("stash", "drop", "-q", ref)
	return err
}

func stashSave(r *runner, op Op) (Result, error) {
	before := r.stashTop()
	args := []string{"stash", "push", "-q"}
	if op.Untracked {
		args = append(args, "-u")
	}
	if op.Message != "" {
		args = append(args, "-m", op.Message)
	}
	if _, err := r.run(call{args: args, noPathspecs: true}); err != nil {
		return Result{}, err
	}
	after := r.stashTop()
	if after == before {
		return Result{}, refused(msg.NewError("There are no changes to stash."))
	}
	return Result{Stash: after}, nil
}

func stashApply(r *runner, op Op) (Result, error) {
	return Result{}, r.applyStash(op.Stash, false)
}

func stashPop(r *runner, op Op) (Result, error) {
	return Result{}, r.applyStash(op.Stash, true)
}

// stashDrop drops a stash; the result holds its commit and message, which is
// everything stash-store needs to put it back.
func stashDrop(r *runner, op Op) (Result, error) {
	ref, message, err := r.stashAt(op.Stash)
	if err != nil {
		return Result{}, err
	}
	_, err = r.git("stash", "drop", "-q", ref)
	return Result{Stash: op.Stash, Message: message}, err
}

// stashStore puts a dropped stash back on the list, newest.
func stashStore(r *runner, op Op) (Result, error) {
	if op.Stash == "" || strings.HasPrefix(op.Stash, "-") {
		return Result{}, refused(msg.NewError("No stash was named."))
	}
	if _, ok, err := r.ask("cat-file", "-e", op.Stash+"^{commit}"); err != nil || !ok {
		if err != nil {
			return Result{}, err
		}
		return Result{}, refused(msg.NewError("What was deleted is no longer in the repository."))
	}
	message := op.Message
	if message == "" {
		message = "Restored by Juggler"
	}
	_, err := r.git("stash", "store", "-q", "-m", message, op.Stash)
	return Result{Stash: op.Stash}, err
}

// stashBranch makes a new branch where a stash was made, switches to it, and
// applies and drops the stash there — the way back for a stash that no longer
// applies where the user is.
func stashBranch(r *runner, op Op) (Result, error) {
	if err := r.branchName(op.Name); err != nil {
		return Result{}, err
	}
	ref, _, err := r.stashAt(op.Stash)
	if err != nil {
		return Result{}, err
	}
	if _, err := r.rawGit("stash", "branch", op.Name, ref); err != nil {
		if r.stopped() {
			return Result{Head: r.headSha()}, conflictsError()
		}
		if said(err, dirtyRefusal...) {
			return Result{}, dirtyError()
		}
		return Result{}, r.explain(err)
	}
	return Result{Head: r.headSha()}, nil
}
