//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The answers to "is something running here?".
//
// Two records can say a thread is busy, and they can disagree for a moment:
//
//   - The claim registry in the document (processingState.runs, see
//     activity_state.go). One entry per thread that holds a claim, written by
//     every status frame. It is durable, every viewer reads it, and it is true
//     for the whole of a turn, including a turn parked on an approval and a
//     thread queued for dispatch (awaiting_llm) with nothing running yet.
//   - The live turns (runScheduler's registry plus the ambient turn). One
//     turnState per turn goroutine, with its in-memory WorkerState. It is true
//     only while a strategy loop is actually running, and it can be true with
//     no claim held: a loop driven with no document claim, or the moment
//     between a pickup taking the thread and its first status frame.
//
// Each question below names which record it reads, and the callers pick by the
// question, never by the record:
//
//   - threadActivity(id): one thread's claim. The reducer's walk, and whether a
//     thread is queued for dispatch.
//   - getActivity(): the projection, i.e. what the conversation is showing. It
//     names one run, so it is the wrong question for "is any thread busy".
//   - hasActiveRun() / subtreeHasActiveRun(id): any claim, in the conversation
//     or under one thread. What a pause asks before it leaves a mark.
//   - isActivelyRunning(): any claim that is not parked solely on approvals.
//     The safe-to-quit question.
//   - anyRunState(): the live turns, conversation-wide. What a request that
//     starts a run of its own asks.
//   - threadBusy(id): both records, for one thread. The intake gate: a send or
//     an injected message for this thread queues if either says it is busy, and
//     a sibling's run is no reason to.
//
// Whether a thread may START is a different question with a different answer
// (a read-only child may join a live writer), and it is canAdmitThread's, in
// live_runs.go.

// threadActivity reads one thread's own activity from the run registry,
// unaffected by what any sibling is doing. This is what a busy gate for a
// specific target thread must ask, so an idle thread is never made to queue
// behind an unrelated run.
func (w *ConversationWorker) threadActivity(threadItemID string) string {
	return entryActivity(runEntryOf(w.readProcessingState(), threadItemID))
}

// threadActivityLocked is threadActivity without the lock; callers MUST already
// hold ycrdtMu.
func (w *ConversationWorker) threadActivityLocked(threadItemID string) string {
	return entryActivity(runEntryOf(w.readProcessingStateLocked(), threadItemID))
}

// getActivity reads the top-level processingState.activity projection — the
// activity of whichever run is live (see projectLiveRun). Readers asking about
// one particular thread must use threadActivity instead; this one answers "what
// is this conversation showing".
func (w *ConversationWorker) getActivity() string {
	existing := w.readProcessingState()
	if existing == nil {
		return ActivityNone
	}
	activity, _ := existing["activity"].(string)
	return activity
}

// hasActiveRun reports whether ANY thread holds a claim. The conversation-wide
// question — "is something running here at all" — as distinct from getActivity,
// which describes only the run the projection currently names.
func (w *ConversationWorker) hasActiveRun() bool {
	return w.subtreeHasActiveRun("")
}

// subtreeHasActiveRun reports whether any thread under this one holds a claim.
// The scoped form of hasActiveRun ("" is the root, so the whole tree): what a
// pause on one column has to ask, so pausing a column with nothing running
// strands no mark.
func (w *ConversationWorker) subtreeHasActiveRun(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	for _, raw := range runsView(w.readProcessingStateLocked()) {
		entry, ok := raw.(map[string]any)
		if !ok || entryActivity(entry) == ActivityNone {
			continue
		}
		id, _ := entry["threadItemId"].(string)
		if w.doc.markCoversLocked(threadItemID, id) {
			return true
		}
	}
	return false
}

// isActivelyRunning reports whether a turn is genuinely doing work on this
// worker: some thread holds the doc-native LLM claim AND the turn is
// not merely parked waiting for the user to approve a tool. A turn blocked
// solely on pending approvals is doing nothing — quitting and restarting leaves
// the approval intact — so it does not count as running. This is the "is it
// safe to quit / rebuild without interrupting work" signal (see AnyActive /
// ActiveConversationIDs); it is deliberately narrower than activity != none,
// which stays true for the whole turn including the approval-parked pause.
func (w *ConversationWorker) isActivelyRunning() bool {
	if !w.hasActiveRun() {
		return false
	}
	// Conversation-wide ("" is the root, so the whole tree): the caller is asking
	// whether it is safe to quit, which no thread can answer on its own.
	return !w.blockedOnlyByApprovals("")
}

// anyRunState reports the state of the busiest run this worker owns: any turn on
// a goroutine of its own that is not idle, else the ambient turn — which is what
// carries the busy frame across the moment a pickup hands a thread to the loop.
// It is the question every conversation-wide gate asks ("is anything in flight
// in this conversation?").
func (w *ConversationWorker) anyRunState() WorkerState {
	for _, e := range w.sched.runs() {
		if state, ok := e.t.state.Load().(WorkerState); ok && state != StateIdle {
			return state
		}
	}
	return w.currentRun().loadState()
}

// threadBusy reports whether threadItemID has work in flight by either record:
// its own claim in the document, or a live turn writing to it. Both are asked
// because each can be true without the other (see the top of this file), and a
// message let through on the strength of one alone would land in the middle of
// a turn instead of queueing for its boundary.
//
// Asked of the target thread only: a run streaming on a sibling is not a reason
// to hold up a send or an injected message (a delivered task result) here.
func (w *ConversationWorker) threadBusy(threadItemID string) bool {
	if w.threadActivity(threadItemID) != ActivityNone {
		return true
	}
	for _, e := range w.sched.runs() {
		if e.threadItemID != threadItemID {
			continue
		}
		if state, ok := e.t.state.Load().(WorkerState); ok {
			return state != StateIdle
		}
	}
	r := w.currentRun()
	return r.t.thread.itemID == threadItemID && r.loadState() != StateIdle
}
