//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"sync/atomic"

	"juggler/cmd/juggler/osactivity"
)

// runScheduler is the worker's bookkeeping for which turns run, and when the
// reducer is next asked what should run. It holds five things:
//
//   - The reconcile bit: "the reducer should take another pass". Any goroutine
//     may raise it, and only the run loop clears it.
//   - The three hand-offs the run loop selects on: a wake for that bit, a
//     prepared turn whose claim a pickup has already taken, and a finished turn
//     handing itself back.
//   - The live-run registry: one entry per turn goroutine, which is where every
//     "what is in flight in this conversation" question looks (see
//     live_runs.go).
//   - The turn boundaries: the state a logical turn carries between its LLM
//     runs, filed under the thread it ran on.
//   - Whether this worker holds an App Nap defeat for its busy span.
//
// What a turn IS, and what the reducer decides, stay with the worker; this type
// decides nothing that needs the document. Every field is read and written only
// by the methods in this file (TestRunSchedulerOwnsItsState). Run goroutine
// only, apart from the reconcile bit, the registry snapshot and the hand-offs,
// which say below who may use them.
type runScheduler struct {
	// reconcileBit is the reducer's dirty bit. The reducer is called from the
	// document observer (handleItemsChange), which fires synchronously and so
	// cannot run the LLM inline; it raises the bit, and the run loop drains it
	// after every event.
	//
	// Atomic because a turn on its own goroutine finds work for the reducer too
	// (promoting a queued message re-enters the observer), and this is one bit
	// whose only meaning is "look again". Only the run goroutine clears it, so
	// the reducer itself stays single-threaded.
	reconcileBit atomic.Bool

	// reconcileWake carries "the reducer needs another pass" to the run loop.
	// Buffered by one and sent to non-blockingly: the bit is a single bit, so a
	// burst coalesces into one pass, which is all a re-tickle ever asked for.
	//
	// It is also what keeps a finished turn from dispatching the next one on its
	// own stack: finishStrategyRun posts here and returns, so the reducer's
	// walk-down runs as a fresh iteration of the event loop rather than as
	// recursion underneath the run that just ended.
	reconcileWake chan struct{}

	// dispatchQueue carries a prepared turn whose claim checkForNewThreads has already
	// taken. Preparing it publishes the admission reservation before the run loop
	// starts the strategy goroutine.
	dispatchQueue chan *turnState

	// retiredQueue carries a finished turn's state back to the run loop, which drops
	// it from the registry, files its turn boundary and asks the reducer for the
	// pass that settles what is left. Buffered so a turn never parks on the way
	// out.
	retiredQueue chan *turnState

	// workerDone is the worker's: a retirement posted after the loop has stopped falls
	// through rather than blocking.
	workerDone <-chan struct{}

	// liveRegistry publishes the live-run registry as an immutable slice, rewritten
	// copy-on-write. Only the run loop writes it, so the rewrite races with
	// nothing; readers take a snapshot and may be on any goroutine, which Stop,
	// the wake interrupt and the manager's activity scan all are.
	liveRegistry atomic.Pointer[[]liveRunEntry]

	// turnBoundaries is the continuation state of each thread's last settled run,
	// keyed by the thread the registry recorded for it. Actor-owned, so siblings
	// retiring in either order cannot overwrite one another's.
	turnBoundaries map[string]turnBoundary

	// activityAsserted is whether this worker holds an osactivity assertion (App
	// Nap defeat). Taken when the first turn is published as live, handed back
	// by releaseActivity once nothing is. Per worker because each conversation
	// has its own busy span; the osactivity package refcounts across workers.
	activityAsserted bool
}

// newRunScheduler builds an idle scheduler. done is the worker's.
func newRunScheduler(done <-chan struct{}) runScheduler {
	return runScheduler{
		reconcileWake:  make(chan struct{}, 1),
		dispatchQueue:  make(chan *turnState, 4),
		retiredQueue:   make(chan *turnState, 4),
		workerDone:     done,
		turnBoundaries: make(map[string]turnBoundary),
	}
}

// ---- The reconcile bit ----

// markReconcile raises the reconcile bit without waking the loop. Enough from
// anything the loop is already iterating for, since it drains after every event.
func (s *runScheduler) markReconcile() { s.reconcileBit.Store(true) }

// wakeReconcile raises the reconcile bit and wakes the loop to run the pass. A
// wake to a loop that has since stopped is dropped, which is what shutdown wants.
func (s *runScheduler) wakeReconcile() {
	s.reconcileBit.Store(true)
	select {
	case s.reconcileWake <- struct{}{}:
	default: // a pass is already queued, and one pass is all this asks for
	}
}

// reconcilePending reports whether a pass has been asked for.
func (s *runScheduler) reconcilePending() bool { return s.reconcileBit.Load() }

// takeReconcile clears the bit and reports whether it was set: the start of one
// pass. Run goroutine only.
func (s *runScheduler) takeReconcile() bool { return s.reconcileBit.Swap(false) }

// dropReconcile clears the bit without a pass. Run goroutine only.
func (s *runScheduler) dropReconcile() { s.reconcileBit.Store(false) }

// ---- The run loop's hand-offs ----

// wakes is the run loop's end of wakeReconcile. A receive means the bit is set.
func (s *runScheduler) wakes() <-chan struct{} { return s.reconcileWake }

// dispatches is the run loop's end of postDispatch.
func (s *runScheduler) dispatches() <-chan *turnState { return s.dispatchQueue }

// retirements is the run loop's end of retire.
func (s *runScheduler) retirements() <-chan *turnState { return s.retiredQueue }

// postDispatch queues a prepared turn for the run loop to start, and reports
// false if the queue is full. Never blocks.
func (s *runScheduler) postDispatch(t *turnState) bool {
	select {
	case s.dispatchQueue <- t:
		return true
	default:
		return false
	}
}

// retire hands a finished turn back to the run loop. Called from the turn's own
// goroutine as it unwinds; falls through on shutdown, where there is no loop
// left to hand anything to.
func (s *runScheduler) retire(t *turnState) {
	select {
	case s.retiredQueue <- t:
	case <-s.workerDone:
	}
}

// ---- The live-run registry ----

// runs returns the current registry snapshot. Never mutated in place, so the
// caller may hold it across anything.
func (s *runScheduler) runs() []liveRunEntry {
	if p := s.liveRegistry.Load(); p != nil {
		return *p
	}
	return nil
}

// hasLive reports whether any turn is on its own goroutine right now.
func (s *runScheduler) hasLive() bool { return len(s.runs()) > 0 }

// liveThreads returns the thread ids whose state is owned by live run
// goroutines. Actor-side reconciliation uses the snapshot to leave those
// subtrees alone while continuing to settle idle siblings.
func (s *runScheduler) liveThreads() map[string]bool {
	owned := make(map[string]bool)
	for _, live := range s.runs() {
		owned[live.threadItemID] = true
	}
	return owned
}

// runOn returns the live run on threadItemID, or nil when that thread is not
// running.
func (s *runScheduler) runOn(threadItemID string) *liveRunEntry {
	runs := s.runs()
	for i := range runs {
		if runs[i].threadItemID == threadItemID {
			return &runs[i]
		}
	}
	return nil
}

// owns reports whether t belongs to a published live run. Status paths use it
// to distinguish a turn goroutine handing finalization to retirement from
// actor-side reducer cleanup that must finalize immediately.
func (s *runScheduler) owns(t *turnState) bool {
	for _, live := range s.runs() {
		if live.t == t {
			return true
		}
	}
	return false
}

// admits reports whether a thread can join the current live set, given whether
// it is stamped read-only. A thread already running is refused. A write-capable
// thread needs no other write-capable run alongside it; a read-only one shares
// the writer slot, up to maxConcurrentReadOnlyThreads at a time.
//
// The ceiling counts only the read-only runs in flight. A write-capable run
// alongside them is already limited to one by the rule above it, and charging it
// to a pacing limit meant for fan-out would stall the main thread behind its own
// children.
func (s *runScheduler) admits(threadItemID string, readOnly bool) bool {
	liveReadOnly := 0
	for _, live := range s.runs() {
		if live.threadItemID == threadItemID {
			return false
		}
		if !readOnly && !live.readOnly {
			return false
		}
		if live.readOnly {
			liveReadOnly++
		}
	}
	return !readOnly || liveReadOnly < maxConcurrentReadOnlyThreads
}

// register publishes a turn as running, taking the App Nap defeat if it is the
// first. Run goroutine only.
func (s *runScheduler) register(entry liveRunEntry) {
	cur := s.runs()
	if len(cur) == 0 && !s.activityAsserted {
		osactivity.Begin()
		s.activityAsserted = true
	}
	next := make([]liveRunEntry, len(cur), len(cur)+1)
	copy(next, cur)
	next = append(next, entry)
	s.liveRegistry.Store(&next)
}

// unregister drops a turn from the registry and returns the thread it was
// registered for. Run goroutine only.
//
// The registered thread is the turn's identity, and it is fixed when the turn is
// begun. The turn's own thread context is not fixed: finishStrategyRun clears it
// as the run settles, so anything filed under the turn's thread after its
// goroutine has returned must use this answer rather than t.thread.
func (s *runScheduler) unregister(t *turnState) (threadItemID string) {
	cur := s.runs()
	next := make([]liveRunEntry, 0, len(cur))
	for _, e := range cur {
		if e.t != t {
			next = append(next, e)
		} else {
			threadItemID = e.threadItemID
		}
	}
	s.liveRegistry.Store(&next)
	return threadItemID
}

// releaseActivity hands back the App Nap defeat register took for this worker's
// busy span. Run goroutine only; a no-op when none is held.
func (s *runScheduler) releaseActivity() {
	if s.activityAsserted {
		osactivity.End()
		s.activityAsserted = false
	}
}

// nudgeRetryWait tells a run parked in a retry backoff on this thread that a
// fresh user message is queued for it. The wait loops do not read the mailbox,
// so this is the explicit signal that carries an intake through to a turn that
// has no boundary coming.
func (s *runScheduler) nudgeRetryWait(threadItemID string) {
	for _, e := range s.runs() {
		if e.threadItemID == threadItemID {
			e.t.signalInterject()
		}
	}
}

// ---- Turn boundaries ----

// fileBoundary records a settled turn's continuation state under the thread it
// was registered for. Run goroutine only.
func (s *runScheduler) fileBoundary(threadItemID string, t *turnState) {
	s.turnBoundaries[threadItemID] = boundaryFromTurn(t)
}

// seedBoundary gives a fresh run only the boundary owned by its thread. Run
// goroutine only.
func (s *runScheduler) seedBoundary(threadItemID string, t *turnState) {
	boundary, ok := s.turnBoundaries[threadItemID]
	if !ok {
		return
	}
	t.processingStartedAt.Store(boundary.processingStartedAt)
	t.approvalWaitStartedAt.Store(boundary.approvalWaitStartedAt)
	t.wasBlockedOnApprovals = boundary.wasBlockedOnApprovals
	t.lastProgressWriteMs = boundary.lastProgressWriteMs
	t.lastCacheMissNotice = boundary.lastCacheMissNotice
	t.lastProviderNotice = boundary.lastProviderNotice
	t.runBudget = boundary.runBudget
}
