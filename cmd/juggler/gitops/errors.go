//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"time"

	"juggler/cmd/juggler/msg"
)

// The three ways a write is turned down before git has failed at it, told
// apart by type because each asks something different of the client. Each
// unwraps to the *msg.Error a handler sends for the client to show
// translated.

// RefusedError is a write that was not attempted, or not finished, because of
// what it asked for: a path out of the repository, a commit of nothing, an
// undo that would overwrite later work. The asker can fix it; asking again
// unchanged will not.
type RefusedError struct{ Err *msg.Error }

func (e *RefusedError) Error() string { return e.Err.Error() }
func (e *RefusedError) Unwrap() error { return e.Err }

// StaleError is a write chosen on a diff that has since changed — the lines it
// names are not the lines the diff now holds. The client reads the diff again
// and lets the user choose again; nothing was written.
type StaleError struct{ Err *msg.Error }

func (e *StaleError) Error() string { return e.Err.Error() }
func (e *StaleError) Unwrap() error { return e.Err }

// LockedError is a write git could not make because another git process holds
// the working tree's index.lock — the user's own client, the agent's shell, or
// a crashed git that left it behind. Which of those it is cannot be told from
// here, so the lock is reported with its age and never removed.
type LockedError struct {
	Path string
	Age  time.Duration
	Err  *msg.Error
}

func (e *LockedError) Error() string { return e.Err.Error() }
func (e *LockedError) Unwrap() error { return e.Err }

// DirtyError is a write git would not make because local changes are in its
// way. Nothing was written; the client offers to set them aside (DirtyStash).
type DirtyError struct{ Err *msg.Error }

func (e *DirtyError) Error() string { return e.Err.Error() }
func (e *DirtyError) Unwrap() error { return e.Err }

// UnmergedError is a branch delete refused because the branch has commits no
// other branch has. The client confirms, then deletes it with Force.
type UnmergedError struct {
	Branch string
	Err    *msg.Error
}

func (e *UnmergedError) Error() string { return e.Err.Error() }
func (e *UnmergedError) Unwrap() error { return e.Err }

// CheckedOutError is a write refused because the branch it names is checked
// out in Worktree — here or in another tree of the repository, wherever that
// is — which git will not let another tree check out, delete or move.
type CheckedOutError struct {
	Branch   string
	Worktree string
	Err      *msg.Error
}

func (e *CheckedOutError) Error() string { return e.Err.Error() }
func (e *CheckedOutError) Unwrap() error { return e.Err }

// ConflictsError is a merge, rebase or stash that stopped on conflicts. What
// git did stands: the operation is in progress, or the stash half applied, for
// the user to resolve or abort.
type ConflictsError struct{ Err *msg.Error }

func (e *ConflictsError) Error() string { return e.Err.Error() }
func (e *ConflictsError) Unwrap() error { return e.Err }

// MarkersError is a file marked resolved while it still has conflict markers.
// Nothing was staged; the client confirms, then marks it with Force.
type MarkersError struct {
	Path string
	Err  *msg.Error
}

func (e *MarkersError) Error() string { return e.Err.Error() }
func (e *MarkersError) Unwrap() error { return e.Err }

// DivergedError is a fast-forward that cannot be one: the branch has commits
// the target lacks. The client offers a merge or a rebase instead; for a pull,
// Prefer is the one the repository's pull.rebase puts first ("merge" or
// "rebase").
type DivergedError struct {
	Prefer string
	Err    *msg.Error
}

func (e *DivergedError) Error() string { return e.Err.Error() }
func (e *DivergedError) Unwrap() error { return e.Err }

// RejectedError is a push the remote turned down: Refs are the remote refs it
// would not update, and Reason git's word for why ("non-fast-forward",
// "fetch first", or a hook's complaint). Nothing was pushed to them. The client
// offers a pull, or a forced push with a lease.
type RejectedError struct {
	Refs   []string
	Reason string
	Err    *msg.Error
}

func (e *RejectedError) Error() string { return e.Err.Error() }
func (e *RejectedError) Unwrap() error { return e.Err }

// RemoteNeededError is a push with no remote to go to that the repository
// names: the branch has none, there is no remote.pushDefault, and Remotes are
// more than one with none of them origin. The client asks which, and pushes
// again naming it.
type RemoteNeededError struct {
	Remotes []string
	Err     *msg.Error
}

func (e *RemoteNeededError) Error() string { return e.Err.Error() }
func (e *RemoteNeededError) Unwrap() error { return e.Err }

// PublishedError is a rewrite of a commit a remote-tracking branch already
// has: the rewritten branch could then only be pushed by force. Nothing was
// written; the client confirms, then rewrites with Force.
type PublishedError struct{ Err *msg.Error }

func (e *PublishedError) Error() string { return e.Err.Error() }
func (e *PublishedError) Unwrap() error { return e.Err }

// AuthError is a network write the remote would not let in: nobody signed in,
// or the answer was wrong — the question declined, a password the remote
// refused, no ssh key it takes, or a host the user would not trust. The client
// says so; asking again asks again.
type AuthError struct{ Err *msg.Error }

func (e *AuthError) Error() string { return e.Err.Error() }
func (e *AuthError) Unwrap() error { return e.Err }

func refused(err *msg.Error) *RefusedError {
	return &RefusedError{Err: err}
}

func stale() *StaleError {
	return &StaleError{Err: msg.NewError("The diff has changed since those lines were chosen. Choose them again.")}
}
