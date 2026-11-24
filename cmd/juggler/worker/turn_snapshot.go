//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"sync/atomic"
	"time"
)

// turnSnapshots runs a conversation's @turn snapshots (TurnSnapshotFunc) off the
// turn's path. A snapshot is a git command over the whole working tree, which on
// a slow disk can take seconds, and a user's message must never wait for one: it
// is taken while the turn's model call is in flight, and only the turn's tools
// wait for it, since it must record the tree before the agent changes anything.
//
// The snapshots are chained, each starting when the one before it has finished,
// so a slow snapshot can never write its ref over a newer turn's. The wait is
// for the latest of them, whichever turn started it: a Continue takes no
// snapshot of its own, and its tools must not run under the one its user turn
// started.
type turnSnapshots struct {
	// last holds the channel closed when the most recently started snapshot has
	// finished. Nil until the first one starts. Swapped, so each snapshot learns
	// exactly which one it follows.
	last atomic.Pointer[chan struct{}]
}

// start begins one snapshot in the background, after any still in progress.
func (s *turnSnapshots) start(take func()) {
	done := make(chan struct{})
	prev := s.last.Swap(&done)
	go func() {
		defer close(done)
		if prev != nil {
			<-*prev
		}
		take()
	}()
}

// pending returns the channel that closes when the latest snapshot has
// finished, or nil when none is in progress.
func (s *turnSnapshots) pending() <-chan struct{} {
	last := s.last.Load()
	if last == nil {
		return nil
	}
	select {
	case <-*last:
		return nil
	default:
		return *last
	}
}

// startTurnSnapshot hands the turn-start snapshot to the server's callback, in
// the background.
func (r *run) startTurnSnapshot() {
	fn := r.deps().turnSnapshot
	if fn == nil {
		return
	}
	convID, workspaceID := r.conversationID, r.workspaceID()
	r.turnSnapshots.start(func() { fn(convID, workspaceID) })
}

// awaitTurnSnapshot holds this turn's tools until the conversation's latest
// snapshot has been taken. It runs on the turn's goroutine, never the run loop,
// and is bounded by the snapshot itself, which the server's callback bounds.
func (r *run) awaitTurnSnapshot() {
	pending := r.turnSnapshots.pending()
	if pending == nil {
		return
	}
	r.tape.Record("turn-snapshot-wait", nil)
	start := time.Now()
	<-pending
	r.log.Info("[worker] tools waited %s for the turn snapshot", time.Since(start).Round(time.Millisecond))
}
