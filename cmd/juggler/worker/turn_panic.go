//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// Panic recovery.
//
// One server process holds every conversation, so a panic nobody recovers ends
// all of them, not just the one that hit the bug. Three places recover:
// handleMessage (recoverWorkerPanic, for the run loop's handlers), tryReconcile
// (for a reducer pass), and the two below, for a dispatched turn, which runs on
// a goroutine of its own and so is reached by neither.
//
// A recovered turn is treated as a run that failed: the panic becomes an error
// item in the run's own thread, its in-flight provider call is cancelled, and it
// settles the way a terminal provider error does. A parent parked on it is told
// it errored rather than left waiting for an answer that will never come.
//
// Every recover asks one question before it carries on: whether the doc lock is
// still usable. ycrdtMu is process-wide, and most holds are a bare Lock/Unlock
// pair rather than a deferred Unlock, so a panic between the two leaves it held
// for good. Carrying on would then park this goroutine on its first doc write,
// and every conversation behind it; ending the process is the better of the two
// failures, so that is what happens.

import (
	"fmt"
	"os"
	"runtime/debug"
	"time"

	"juggler/internal/jlog"
)

// docLockRecoveryGrace is how long a recover waits to take the doc lock before
// concluding the panic left it held. Legitimate holds are microseconds, and the
// longest (bulk compaction splices) are far below this.
const docLockRecoveryGrace = 5 * time.Second

// requireDocLockAfterPanic ends the process if the doc lock cannot be taken
// within docLockRecoveryGrace, with the panic and its stack on the log. It
// exits rather than re-panicking because a re-panic still runs the remaining
// deferred calls on this goroutine, and the first of those to write the
// document would block on the held lock instead of ending anything.
func requireDocLockAfterPanic(where string, panicValue any, stack []byte) {
	if ycrdtMu.acquirableWithin(docLockRecoveryGrace) {
		return
	}
	jlog.Error("[panic] %s panicked with the process-wide y-crdt lock held: %v. Recovery would freeze every conversation behind that lock, so the process is exiting.\n%s",
		where, panicValue, stack)
	os.Exit(2)
}

// recoverTurnPanic is runStrategyLoopWithIntent's recover. Deferred AFTER
// finishStrategyRun, so it runs first: the run is turned into a failed one
// before it is settled, and finishStrategyRun then settles it as an error.
func (r *run) recoverTurnPanic() {
	panicValue := recover()
	if panicValue == nil {
		return
	}
	stack := debug.Stack()
	threadID := r.t.thread.itemID
	r.log.Error("[panic] turn on thread %q panicked: %v\n%s", threadID, panicValue, stack)
	requireDocLockAfterPanic("a turn", panicValue, stack)

	r.cancelInFlightCall(threadID)
	r.sendErrorWithData(turnPanicMessage(panicValue), string(stack), nil)

	// The run is over, whatever it was doing. Dropping the claim takes
	// finishStrategyRun past its awaiting_llm early return, which would leave
	// the run open for the reducer to drive again, and clearing the pause flag
	// past its rest-without-settling one. Either would keep a run alive that
	// has just shown it cannot be trusted to carry on.
	r.t.politelyStopped = false
	r.releaseLLM(threadID)
}

// recoverTurnBackstop is runTurn's recover: the last line for a panic the
// strategy loop's own recovery did not catch — in finishStrategyRun, or in a
// turn body that is not a strategy loop. Nothing about the run's state can be
// assumed, finishStrategyRun least of all, since it may be what panicked, so
// this rests the run with the fewest steps that leave the conversation usable:
// an error in the thread, the run settled, the claim dropped, an idle frame.
// The thread is the registry's, which beginTurn fixed, because the turn's own
// may already have been cleared.
func (r *run) recoverTurnBackstop(tr *run) {
	panicValue := recover()
	if panicValue == nil {
		return
	}
	stack := debug.Stack()
	threadID := r.registeredThread(tr.t)
	tr.log.Error("[panic] turn on thread %q panicked outside its strategy loop: %v\n%s", threadID, panicValue, stack)
	requireDocLockAfterPanic("a turn", panicValue, stack)

	tr.cancelInFlightCall(threadID)
	tr.t.txnID = ""
	if dest, ok := tr.resolveThread(threadID); ok {
		tr.sendErrorTo(dest, turnPanicMessage(panicValue), string(stack), nil)
	}
	if threadID != "" {
		tr.settleThreadRun(threadID, false)
	}
	tr.storeState(StateIdle)
	tr.releaseLLM(threadID)
	tr.resetThreadContext()
	tr.sendStatus("idle", "")
	tr.requestReconcile()
}

// registeredThread returns the thread a live turn was registered for, or "" for
// the root or a turn not in the registry. Safe from any goroutine: it reads the
// registry's published copy.
func (w *ConversationWorker) registeredThread(t *turnState) string {
	for _, e := range w.sched.runs() {
		if e.t == t {
			return e.threadItemID
		}
	}
	return ""
}

// cancelInFlightCall cancels this run's provider call, if one is in flight, and
// releases a provider session parked on threadID — the same two steps abortTurn
// takes, without the cancellation verdict: a panicked run ends as an error, not
// as a cancel.
func (r *run) cancelInFlightCall(threadID string) {
	if p := r.t.cancelLLM.Swap(nil); p != nil {
		(*p)()
	}
	if r.cancelLLMSession != nil {
		r.cancelLLMSession(r.conversationID, threadID)
	}
}

// turnPanicMessage is the error item's text for a recovered panic. It says what
// happened in words a user can act on, and keeps the panic value, which is what
// a bug report needs.
func turnPanicMessage(panicValue any) string {
	return fmt.Sprintf("Internal error: this turn crashed and was stopped (%v). The conversation is safe to continue.", panicValue)
}
