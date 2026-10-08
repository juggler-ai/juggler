//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The live-run registry.
//
// A dispatched turn runs on a goroutine of its own with a turnState of its own,
// which is what lets the run loop keep pumping the mailbox — and so handle a
// cancel, a pause or a sync update — while the turn streams. The consequence is
// that the worker's ambient turn is no longer the one running, so every question
// of the form "what is in flight in this conversation" needs somewhere else to
// look. This is that somewhere: one entry per turn goroutine.
//
// The registry itself is runScheduler's (run_scheduler.go): it holds the
// snapshot and the copy-on-write that maintains it. This file holds the rules
// that need the worker to apply: which thread is read-only, how a turn is begun
// and started, and what retiring one does to the conversation.

// liveRunEntry names one turn goroutine.
type liveRunEntry struct {
	// threadItemID is the thread the run was dispatched on, fixed for the run's
	// lifetime. The run's own thread field is plain memory it owns, so this is
	// the copy anyone off that goroutine may read.
	threadItemID string
	readOnly     bool
	t            *turnState
}

// maxConcurrentReadOnlyThreads caps how many read-only children may run AT ONCE.
//
// Read-only siblings share the writer slot because none of them can tread on
// another's work, and that is still true — but "cannot conflict" was read as "may
// all go together", and a turn that calls four sub-agents then runs four agent
// loops side by side, each growing a context of its own at full speed. The cost
// of a fan-out is not the threads, it is the tokens they spend simultaneously,
// and nothing was counting them.
//
// This is a pacing limit, not a budget: a child over the ceiling keeps its place
// in the reducer's walk and is dispatched the moment a sibling retires, so the
// same work still happens and the model is told nothing (there is nothing to tell
// it — no call was refused). What it buys is a conversation whose spend a person
// can see accumulating, and stop.
//
// Three, because that covers the fan-out a real question has — compare these
// three implementations, check this against those two docs — while keeping one
// slot's worth of headroom between "working in parallel" and "running away".
const maxConcurrentReadOnlyThreads = 3

// canAdmitThread reports whether threadItemID can join the current live set.
// The durable thread stamp is the admission input: root and unstamped children
// are write-capable, while stamped read-only children may share the writer slot
// — up to maxConcurrentReadOnlyThreads of them at a time.
//
// The rule itself is runScheduler.admits; this supplies the stamp.
func (w *ConversationWorker) canAdmitThread(threadItemID string) bool {
	return w.sched.admits(threadItemID, w.threadIsReadOnly(threadItemID))
}

// exclusivelyOwnsConversation reports whether this run is the only live owner.
// Compaction rewrites shared ancestry and therefore cannot use read-only sibling
// admission: it retains conversation-wide exclusion.
func (r *run) exclusivelyOwnsConversation() bool {
	runs := r.sched.runs()
	return len(runs) == 1 && runs[0].t == r.t
}

// allTurnStates returns every turn this worker owns: the live ones and the
// ambient one. What a teardown or a system-wake interrupt has to sweep, since
// either can arrive with a turn on its own goroutine or with none at all.
func (w *ConversationWorker) allTurnStates() []*turnState {
	runs := w.sched.runs()
	out := make([]*turnState, 0, len(runs)+1)
	for _, e := range runs {
		out = append(out, e.t)
	}
	return append(out, w.turn)
}

// registerLiveRun publishes a turn as running, stamped with whether its thread
// is read-only. Actor goroutine only.
func (w *ConversationWorker) registerLiveRun(threadItemID string, t *turnState) {
	w.sched.register(liveRunEntry{
		threadItemID: threadItemID,
		readOnly:     w.threadIsReadOnly(threadItemID),
		t:            t,
	})
}

// beginTurn prepares the run a dispatch is about to start on threadItemID: a
// fresh turnState, seeded with the state a TURN owns across its dispatches and
// published to the registry before the caller marks it busy — so the
// conversation is never readable as idle between the two.
func (r *run) beginTurn(threadItemID string) *run {
	t := newTurnState()
	r.sched.seedBoundary(threadItemID, t)
	tr := r.runFor(t)
	tr.t.thread.itemID = threadItemID
	if threadItemID != "" {
		tr.t.thread.itemsArray = r.doc.GetThreadItemsArray(threadItemID)
	}
	r.registerLiveRun(threadItemID, tr.t)
	return tr
}

// runTurn starts a prepared run's strategy loop on its own goroutine, so the run
// loop keeps pumping the mailbox while it streams.
//
// The ambient turn's busy state was the conversation's while this dispatch was
// being decided; the run that owns it now carries it, so it is handed back to
// idle here — after the registry entry is published, so no reader passing
// through sees an idle conversation whose turn has already started.
func (r *run) runTurn(tr *run, body func(*run)) {
	r.storeState(StateIdle)
	go func() {
		defer r.sched.retire(tr.t)
		defer close(tr.t.finished)
		// Runs first, while the turn is still registered: a panic here is on a
		// goroutine nothing else recovers, and would end the process.
		defer r.recoverTurnBackstop(tr)
		body(tr)
	}()
}

// finishRetiredTurn folds a finished turn goroutine back into the worker. Run
// goroutine only. The reducer stays out of the way for as long as a turn is live
// (see drainReconcile), so this is also the moment it is asked for the pass that
// settles whatever the turn left behind.
func (r *run) finishRetiredTurn(t *turnState) {
	r.sched.fileBoundary(r.sched.unregister(t), t)
	if t.completedIdle {
		r.bumpTurnCounterAtIdle()
	}
	if !r.sched.hasLive() {
		r.finishIdleTransition()
	} else {
		// Publish this sibling's terminal frame promptly without closing the shared
		// undo capture window still used by live runs.
		r.batcher.Flush()
	}
	r.sched.markReconcile()
}

// turnBoundary is the state one logical turn carries between its LLM runs.
type turnBoundary struct {
	processingStartedAt   int64
	approvalWaitStartedAt int64
	wasBlockedOnApprovals bool
	lastProgressWriteMs   int64
	lastCacheMissNotice   string
	lastProviderNotice    string
	runBudget             runBudgetState
}

func boundaryFromTurn(t *turnState) turnBoundary {
	return turnBoundary{
		processingStartedAt:   t.processingStartedAt.Load(),
		approvalWaitStartedAt: t.approvalWaitStartedAt.Load(),
		wasBlockedOnApprovals: t.wasBlockedOnApprovals,
		lastProgressWriteMs:   t.lastProgressWriteMs,
		lastCacheMissNotice:   t.lastCacheMissNotice,
		lastProviderNotice:    t.lastProviderNotice,
		runBudget:             t.runBudget,
	}
}
