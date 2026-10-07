//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The polite stop (Pause) marks.
//
// A mark names ONE thread and stands over that thread and everything nested
// below it, so a mark on the root ("") is the whole conversation and a mark on a
// sub-agent is that agent and its own children. A covered thread finishes what is
// in flight — the current stream, running tools, pending approvals — and then
// rests at its next boundary, before the model is invoked again. Nothing is
// marked Interrupted or Cancelled.
//
// Two properties are load-bearing, and both were learnt the hard way:
//
//   - A mark is SCOPED. A conversation routinely holds several live runs (a
//     parent and its read-only children stream side by side), so a pause with no
//     thread on it can only ever mean "somebody", and the thread it stopped was
//     whichever one reached a boundary first — not the one whose Pause button was
//     pressed.
//   - A mark STANDS until the user lifts it. A mark consumed by the first
//     boundary to see it stops one thread and then licenses every other: the
//     sibling that was still calling the model, and the parent that a settling
//     child re-drives through signalParentThread. So the boundary rests the
//     thread and leaves the mark where it is.
//
// A mark is lifted only by an explicit human act: the Pause button toggled back
// off (handleUnpause), a send or Continue into the covered thread (a resume), a
// hard cancel over it (an escalation), and undo/redo, which revokes the whole
// conversation's intent.
//
// Which means every path that starts work has to answer one question, and there
// is no third answer:
//
//   - HUMAN INTENT — the user asked for this, now. It lifts the marks covering
//     the thread the work runs on, exactly as a send does, because a mark that
//     outlives the rest it caused suppresses the very turn that was just asked
//     for. /compact and /handoff (handleCompact), Re-summarise
//     (handleResummarizeCompactionThread), a tool retry (resetToolActionAndRedrive)
//     and a thread the user created (handleCreateThread) all say so. Note it is
//     the OP that is human, not the plumbing under it: dispatchThread serves the
//     orchestrator too, so the lift lives in the handler.
//   - MACHINE CONTINUATION — the conversation carrying on by itself, which is
//     what a pause is a statement about. The mark stands and the work waits:
//     delivered background-task output (handleInjectThreadMessage), a thread the
//     model asked for, an orchestrated request.
//
// Which one an op picks is its own business; that it picks at all is not.
// TestEveryWorkStartingOpClassifiesItselfAgainstThePause reads the dispatch
// switch and fails on any op that starts work while saying neither.
//
// The second answer carries an obligation. Work committed to the document under
// a mark must still be drivable once the mark is lifted, and the trap is
// needsStrategyRun: a ONE-SHOT trigger, consumed by the pickup, that nothing
// re-arms and that the reducer's walk will not substitute for. Hence the two
// halves that make resting safe — checkForNewThreads declines covered threads
// before it consumes anything, and the paused settle re-arms the trigger a fold
// spent on its way in. A boundary that rests work it has already licensed leaves
// a thread nothing can ever start.
//
// The set is an immutable map behind an atomic pointer, rewritten copy-on-write —
// the same shape as the live-run registry, and for the same reason: the run loop
// is the only writer, while the readers are turn goroutines at their boundaries.
// It is projected into processingState (politeStops, plus politePending on each
// covered run) so a reloading client sees the pause; the marks themselves are the
// source of truth and are deliberately NOT restored from the document, since a
// worker that has just loaded is running nothing and a mark restored onto it
// would suppress the user's next turn.

// politeStopMaxAncestry bounds the walk up a thread's parents. Nesting is capped
// far below this (maxThreadDepth); the bound is here so a malformed document
// cannot spin the walk, not to express a rule.
const politeStopMaxAncestry = 32

// politeStopMarks returns the current mark set. Never mutated in place, so the
// caller may hold it across anything.
func (w *ConversationWorker) politeStopMarks() map[string]bool {
	if p := w.politeStops.Load(); p != nil {
		return *p
	}
	return nil
}

// hasPoliteStops reports whether any pause stands on this conversation.
func (w *ConversationWorker) hasPoliteStops() bool {
	return len(w.politeStopMarks()) > 0
}

// mutatePoliteStops rewrites the set copy-on-write and republishes the
// projection. Run goroutine only — every writer below is reached from the
// mailbox. A rewrite that changes nothing publishes nothing, which is what makes
// an unpause of an unpaused conversation a true no-op rather than a doc write.
func (w *ConversationWorker) mutatePoliteStops(edit func(next map[string]bool)) {
	cur := w.politeStopMarks()
	next := make(map[string]bool, len(cur)+1)
	for id := range cur {
		next[id] = true
	}
	edit(next)
	if sameMarks(cur, next) {
		return
	}
	w.politeStops.Store(&next)
	w.publishPoliteStops()
}

// sameMarks reports whether two mark sets stand over the same threads.
func sameMarks(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for id := range a {
		if !b[id] {
			return false
		}
	}
	return true
}

// markPoliteStop puts a pause over threadItemID and everything below it.
func (w *ConversationWorker) markPoliteStop(threadItemID string) {
	w.mutatePoliteStops(func(next map[string]bool) { next[threadItemID] = true })
}

// dropPoliteStopsCovering lifts every mark standing over threadItemID — the
// "resume this column" edit. It reaches upward rather than only at the named
// thread because a covered thread cannot be resumed while an ancestor's pause
// still stands over it: the button in that column says Paused, and lifting what
// the label refers to is the only honest thing a press can do.
func (w *ConversationWorker) dropPoliteStopsCovering(threadItemID string) {
	if !w.hasPoliteStops() {
		return
	}
	w.mutatePoliteStops(func(next map[string]bool) {
		ycrdtMu.Lock()
		defer ycrdtMu.Unlock()
		for id := range next {
			if w.doc.markCoversLocked(id, threadItemID) {
				delete(next, id)
			}
		}
	})
}

// dropPoliteStopsUnder lifts every mark inside this thread's subtree, its own
// included. Used by the hard cancel: a stop is an escalation over the work it
// destroys, so no mark is left behind to suppress the turn after it — and a
// stop at the root, which stops everything, lifts everything.
//
// It reaches DOWN only. A pause standing over this thread was put there by
// someone asking the conversation to wind down, and stopping one sub-agent
// inside it does not withdraw that: lifting an ancestor's mark here is what let a
// Stop in a child column wake the parent and carry on, under a Pause the user was
// still waiting on.
func (w *ConversationWorker) dropPoliteStopsUnder(threadItemID string) {
	if !w.hasPoliteStops() {
		return
	}
	w.mutatePoliteStops(func(next map[string]bool) {
		ycrdtMu.Lock()
		defer ycrdtMu.Unlock()
		for id := range next {
			if w.doc.markCoversLocked(threadItemID, id) {
				delete(next, id)
			}
		}
	})
}

// dropAllPoliteStops lifts every mark. For the revocations that are
// conversation-wide by nature — undo and redo, which withdraw the intent behind
// every run at once.
func (w *ConversationWorker) dropAllPoliteStops() {
	if !w.hasPoliteStops() {
		return
	}
	w.mutatePoliteStops(func(next map[string]bool) {
		for id := range next {
			delete(next, id)
		}
	})
}

// politeStopCovers reports whether a pause stands over this thread. The question
// each boundary asks before invoking the model.
func (w *ConversationWorker) politeStopCovers(threadItemID string) bool {
	marks := w.politeStopMarks()
	if len(marks) == 0 {
		return false
	}
	if marks[""] {
		return true // the root's mark stands over the whole conversation
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return w.doc.anyMarkCoversLocked(marks, threadItemID)
}

// anyMarkCoversLocked reports whether any mark in the set stands over
// threadItemID. Caller MUST hold ycrdtMu.
func (cd *ConversationDocument) anyMarkCoversLocked(marks map[string]bool, threadItemID string) bool {
	if marks[""] {
		return true
	}
	id := threadItemID
	for depth := 0; id != "" && depth < politeStopMaxAncestry; depth++ {
		if marks[id] {
			return true
		}
		id = cd.findParentThreadID(id)
	}
	return false
}

// markCoversLocked reports whether a mark on markThreadID stands over
// threadItemID — the same thread, or one nested below it. Caller MUST hold
// ycrdtMu.
func (cd *ConversationDocument) markCoversLocked(markThreadID, threadItemID string) bool {
	if markThreadID == "" {
		return true
	}
	return cd.anyMarkCoversLocked(map[string]bool{markThreadID: true}, threadItemID)
}

// subtreeHasActiveRun reports whether any thread under this one holds a claim.
// The scoped form of hasActiveRun: what a pause on one column has to ask, so
// pausing a column with nothing running strands no mark.
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

// handlePause marks a polite stop over threadItemID when that subtree is
// actually running — whether the pause arrives between turns or while one is
// streaming, since the run loop keeps servicing the mailbox either way.
//
// Pausing something that is not running is a no-op: a mark stands until a human
// lifts it, so one left on an idle thread would silently suppress that thread's
// next turn (verification item V3). The root is asked a second question because
// it speaks for the conversation: a strategy loop driven with no document claim
// (the direct-call tests) is still work a pause should catch.
func (w *ConversationWorker) handlePause(threadItemID string) {
	running := w.subtreeHasActiveRun(threadItemID)
	if !running && threadItemID == "" {
		running = w.anyRunState() != StateIdle
	}
	if !running {
		return
	}
	w.markPoliteStop(threadItemID)
	w.nudgePoliteStop()
}

// handleUnpause lifts the pause covering threadItemID so its work carries on to
// its next boundary instead of resting. The Pause button toggling itself back
// off. Idempotent: lifting a pause that is not there changes nothing, so an
// unpause racing a boundary is harmless — the thread was going to continue.
func (w *ConversationWorker) handleUnpause(threadItemID string) {
	if !w.hasPoliteStops() {
		return
	}
	w.dropPoliteStopsCovering(threadItemID)

	// A thread the pickup declined to start while covered is still sitting there
	// with its needsStrategyRun armed — a fold owed a summary, a re-summarise the
	// user asked for. Nothing else will offer it: the trigger is read by the
	// pickup, and the pickup runs on document change, which lifting a mark is not.
	// Both are cheap and idempotent when there is nothing waiting.
	r := w.currentRun()
	r.checkForNewThreads()
	r.requestReconcile()
}

// nudgePoliteStop asks any covered run parked in a retry backoff to abandon the
// wait. Every other wait a turn does ends on its own at a boundary the pause is
// then read at; a backoff has no boundary coming, and its whole purpose is to
// re-issue the request the pause exists to prevent. signalInterject is refused by
// a run that is not backing off, so this reaches exactly those.
func (w *ConversationWorker) nudgePoliteStop() {
	for _, e := range w.liveRuns() {
		if w.politeStopCovers(e.threadItemID) {
			e.t.signalInterject()
		}
	}
}

// publishPoliteStops refreshes the pause projection on the current frame, for
// the mark edits that happen between status frames. A no-op when there is no
// processingState at all (a worker that has never run), which is also a
// conversation no pause can stand on.
func (w *ConversationWorker) publishPoliteStops() {
	w.patchProcessingState(func(state map[string]any) {
		runs := copyRuns(state)
		w.refreshPoliteStopsLocked(state, runs)
		storeRuns(state, runs)
	})
}

// refreshPoliteStopsLocked recomputes what a processingState frame says about
// the pause, from the marks and the registry the frame is being written with.
// Every frame is rebuilt from scratch, so this runs on each one rather than
// leaving a flag to be carried. Caller MUST hold ycrdtMu.
//
// Each covered run carries its own `politePending`, because the column that must
// say "Pausing…" is the one whose work is still finishing — asking the top-level
// projection would answer with whichever run it happens to name. A mark reports
// `landed` once nothing under it holds a claim: that is the moment the pause has
// actually taken, and the only positive confirmation the user ever gets.
func (w *ConversationWorker) refreshPoliteStopsLocked(state map[string]any, runs map[string]any) {
	marks := w.politeStopMarks()
	if len(marks) == 0 {
		delete(state, "politeStops")
		delete(state, "politePending")
		for _, raw := range runs {
			if entry, ok := raw.(map[string]any); ok {
				delete(entry, "politePending")
			}
		}
		return
	}

	landed := make(map[string]bool, len(marks))
	for id := range marks {
		landed[id] = true
	}
	pending := false
	for _, raw := range runs {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if entryActivity(entry) == ActivityNone {
			delete(entry, "politePending")
			continue
		}
		threadID, _ := entry["threadItemId"].(string)
		covered := false
		for id := range marks {
			if w.doc.markCoversLocked(id, threadID) {
				landed[id] = false
				covered = true
			}
		}
		if covered {
			entry["politePending"] = true
			pending = true
		} else {
			delete(entry, "politePending")
		}
	}

	published := make(map[string]any, len(marks))
	for id := range marks {
		published[runKey(id)] = map[string]any{"landed": landed[id]}
	}
	state["politeStops"] = published
	// The conversation-wide alias: a pause is still winding something down. Read
	// by everything that only wants to know whether one is in progress at all.
	if pending {
		state["politePending"] = true
	} else {
		delete(state, "politePending")
	}
}
