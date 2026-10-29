//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// The per-thread run registry.
//
// processingState carries one entry per thread that holds a claim, under the
// `runs` key:
//
//	runs: { "<key>": {activity, threadItemId, claimedAt, explicitContinuation} }
//
// `runs` is the source of truth. Every claim, dispatch request and continuation
// marker is a compare-and-set against ONE thread's entry, so an idle thread is
// never refused because an unrelated sibling is busy — the property the
// read-only sub-agent fan-out is built on.
//
// The top-level activity / threadItemId / claimedAt fields are a PROJECTION of
// whichever run is live (projectLiveRun). They exist because every browser
// reader of processingState — and the reducer's own walk-down — still describes
// one conversation-wide turn; the projection keeps those readers correct while
// the registry underneath them learns to hold several.
const rootRunKey = "root"

// runKey maps a thread item id to its key in the runs map. Thread items are
// always minted as "msg_…" (generateItemID) or "msg-…" (the browser's
// Conversation._nextItemId), so the root sentinel cannot collide with a real
// thread's id.
func runKey(threadItemID string) string {
	if threadItemID == "" {
		return rootRunKey
	}
	return threadItemID
}

// runsView returns the registry a processingState frame describes. A frame
// carrying only the top-level projection — one written before the registry
// existed, restored from disk, or seeded directly by a test — still describes
// exactly one run, on the thread its threadItemId names, so synthesize that
// entry rather than reading the frame as idle. The first compare-and-set against
// such a frame writes a real registry and the synthesis stops applying.
//
// The entries are the frame's own maps, so the result is for reading; copyRuns
// is the registry to write into.
func runsView(state map[string]any) runRegistry {
	if raw, ok := state[keyRuns].(map[string]any); ok {
		runs := make(runRegistry, len(raw))
		for key, v := range raw {
			if entry, ok := v.(map[string]any); ok {
				runs[key] = entry
			}
		}
		return runs
	}
	entry := runEntryFromLegacy(state)
	if entry == nil {
		return nil
	}
	return runRegistry{runKey(entry.threadItemID()): entry}
}

// runEntryOf returns one thread's run entry, or nil when that thread holds no
// claim. Read-only — the returned map belongs to state. A nil entry reads as
// idle through every accessor.
func runEntryOf(state map[string]any, threadItemID string) runEntry {
	return runsView(state)[runKey(threadItemID)]
}

// copyRuns returns a deep-enough copy of processingState's runs sub-map (the
// map and each entry), always non-nil so callers can write into it. Copying
// matters because the map read back through fromYcrdt is also reachable from
// the frame clone patchProcessingStateIf builds: mutating it in place would
// edit state a rejected compare-and-set is supposed to leave untouched.
func copyRuns(state map[string]any) runRegistry {
	out := runRegistry{}
	for key, entry := range runsView(state) {
		out[key] = entry.clone()
	}
	return out
}

// storeRuns writes the registry back into a frame, omitting the key entirely
// when no thread holds a claim.
func storeRuns(state map[string]any, runs runRegistry) {
	if len(runs) == 0 {
		delete(state, keyRuns)
		return
	}
	state[keyRuns] = runs.toDoc()
}

// pickLiveRun chooses which run the top-level projection describes: the thread
// just touched if it still holds a claim, else the run actually calling the LLM,
// else one awaiting dispatch. Ties break on the most recent claim and then on
// key, so the projection is a stable function of the registry rather than of Go
// map iteration order.
func pickLiveRun(runs runRegistry, touchedKey string) runEntry {
	if entry, ok := runs[touchedKey]; ok && entry.activity() != ActivityNone {
		return entry
	}
	for _, want := range []string{ActivityCallingLLM, ActivityAwaitingLLM} {
		var best runEntry
		bestKey := ""
		for key, entry := range runs {
			if entry.activity() != want {
				continue
			}
			if best == nil || preferRun(entry, key, best, bestKey) {
				best, bestKey = entry, key
			}
		}
		if best != nil {
			return best
		}
	}
	return nil
}

// preferRun orders two candidate runs for the projection: most recently claimed
// first, then by key so the choice is deterministic.
func preferRun(a runEntry, aKey string, b runEntry, bKey string) bool {
	if aAt, bAt := a.claimedAt(), b.claimedAt(); aAt != bAt {
		return aAt > bAt
	}
	return aKey < bKey
}

// projectLiveRun refreshes the top-level activity/threadItemId/claimedAt fields
// from the registry. threadItemId is deliberately left in place when no run is
// live: a released claim keeps naming the thread it was released from, which is
// what handleCancel and the reducer read on the way to rest.
func projectLiveRun(state map[string]any, runs runRegistry, touchedThreadID string) {
	entry := pickLiveRun(runs, runKey(touchedThreadID))
	if entry == nil {
		delete(state, runFieldActivity)
		delete(state, runFieldClaimedAt)
		return
	}
	entry.projectInto(state)
}

// patchRunIf is the per-thread compare-and-set every activity transition is
// built from. Inside one Yjs transaction it offers the target thread's run entry
// to cond and, if accepted, applies mutate to that entry (and, where a
// transition also touches UI-facing frame fields, to the frame), stores the
// result and refreshes the projection. Returns false — changing nothing — when
// cond rejects. cond may be handed a nil entry: the thread holds no claim.
func (w *ConversationWorker) patchRunIf(
	threadItemID string,
	cond func(entry runEntry) bool,
	mutate func(entry runEntry, state map[string]any),
) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return w.patchRunIfLocked(threadItemID, cond, mutate)
}

// patchRunIfLocked is patchRunIf for a caller already holding ycrdtMu.
func (w *ConversationWorker) patchRunIfLocked(
	threadItemID string,
	cond func(entry runEntry) bool,
	mutate func(entry runEntry, state map[string]any),
) bool {
	key := runKey(threadItemID)
	return w.patchProcessingStateIfLocked(
		func(existing map[string]any) bool { return cond(runEntryOf(existing, threadItemID)) },
		func(updated map[string]any) {
			runs := copyRuns(updated)
			entry, ok := runs[key]
			if !ok {
				entry = runEntry{}
			}
			entry.setThreadItemID(threadItemID)
			mutate(entry, updated)
			if entry.isSpent() {
				delete(runs, key)
			} else {
				runs[key] = entry
			}
			// A claim taken or released changes which threads a pause is still
			// waiting on, so the pause projection is recomputed with the registry
			// that carries it rather than left to the next status frame.
			w.refreshPoliteStopsLocked(updated, runs)
			storeRuns(updated, runs)
			projectLiveRun(updated, runs, threadItemID)
		},
	)
}

// patchLiveRun applies mutate to this run's OWN entry, and only while that entry
// is still working. Every mid-stream progress field goes through it: a run
// describes itself, so two turns streaming at once cannot overwrite each other's
// token counts or activity line.
func (r *run) patchLiveRun(mutate func(entry runEntry)) {
	r.patchRunIf(r.t.thread.itemID, runEntry.isLive, func(entry runEntry, _ map[string]any) { mutate(entry) })
}

// entryHoldsClaim and entryNotCallingLLM are the two gates most transitions are offered
// under: the thread holds a claim at all, and the thread is not mid-turn.
func entryHoldsClaim(entry runEntry) bool    { return entry.activity() != ActivityNone }
func entryNotCallingLLM(entry runEntry) bool { return entry.activity() != ActivityCallingLLM }

// anyEntry is the gate for a transition that applies whatever the entry holds.
func anyEntry(runEntry) bool { return true }

// claimLLM atomically claims the given thread for an LLM turn. The
// compare-and-set reads that thread's run entry and, if it is not already
// calling the LLM, writes the claim. Returns true on success; false if this
// thread's own turn is already in flight.
//
// The claim is the doc-native source of truth for "is this thread busy". The
// reducer calls it before dispatching an LLM turn (dispatchCallLLMOnThread): a
// failed claim means that thread already has a turn running, so the reducer
// leaves the work for the next reconcile tick.
func (w *ConversationWorker) claimLLM(threadItemID string) bool {
	return w.patchRunIf(threadItemID,
		// Succeed from idle or "awaiting_llm"; fail if already "calling_llm".
		entryNotCallingLLM,
		func(entry runEntry, _ map[string]any) {
			now := time.Now().UnixMilli()
			entry.setActivity(ActivityCallingLLM)
			entry.setClaimedAt(now)
			// Seed the entry, not the frame: the projection republishes the
			// entry's own fields and would drop anything written beside it. Any
			// status this thread already carries is kept, so the UI doesn't
			// flicker through an intermediate state; sendStatus overwrites it
			// with the first loop phase a moment later.
			if !entry.hasStatus() {
				entry.setStatus(statusPreparing)
			}
			if !entry.hasStartedAt() {
				entry.setStartedAt(now)
			}
		},
	)
}

// releaseLLM clears one thread's claim without touching any other
// processingState field. Symmetric with claimLLM. An idle frame drops the entry
// for the thread the frame names, so every path that rests a thread it is not
// itself running — the reducer's rest branch, the cancel park, the child→parent
// handoff, an abandoned pickup — names that thread here instead.
func (w *ConversationWorker) releaseLLM(threadItemID string) {
	w.patchRunIf(threadItemID,
		entryHoldsClaim,
		func(entry runEntry, _ map[string]any) { entry.releaseClaim() },
	)
}

// releaseAllLLM drops every thread's claim at once. Used where the user has
// revoked the whole conversation's LLM intent rather than one thread's — undo,
// redo, and the history-navigation suppression window — after which no thread's
// pending dispatch still stands.
//
// It writes only when a claim is actually held. The recoil window calls it from
// handleItemsChange, and the write is itself an items change: a release that
// rewrote an already-released frame would re-enter itself for the whole window,
// broadcasting tens of thousands of updates for every viewer to apply
// (TestNavRecoilDoesNotFeedItsOwnObserver).
func (w *ConversationWorker) releaseAllLLM() {
	w.patchProcessingStateIf(
		func(existing map[string]any) bool {
			_, hasRuns := existing[keyRuns]
			_, hasActivity := existing[runFieldActivity]
			_, hasClaimedAt := existing[runFieldClaimedAt]
			return hasRuns || hasActivity || hasClaimedAt
		},
		func(updated map[string]any) {
			delete(updated, keyRuns)
			delete(updated, runFieldActivity)
			delete(updated, runFieldClaimedAt)
		},
	)
}

// patchProcessingStateIf is the shared compare-and-set preamble (lock + read +
// gate + clone + mutate + set) for every doc-native processingState transition.
// It reads the current processingState (possibly nil) and passes it to cond; if
// cond returns false the transaction is a no-op and the call returns false.
// Otherwise it shallow-clones the map (starting empty when absent — callers whose
// cond accepts nil create fresh state), applies mutate, writes it back inside the
// single Yjs transaction, and returns true.
func (w *ConversationWorker) patchProcessingStateIf(
	cond func(existing map[string]any) bool,
	mutate func(updated map[string]any),
) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return w.patchProcessingStateIfLocked(cond, mutate)
}

// patchProcessingStateIfLocked is patchProcessingStateIf for a caller already
// holding ycrdtMu.
func (w *ConversationWorker) patchProcessingStateIfLocked(
	cond func(existing map[string]any) bool,
	mutate func(updated map[string]any),
) bool {
	var applied bool
	w.doc.transactTracked(func(_ *ycrdt.Transaction) {
		raw := w.doc.metadata.Get(keyProcessingState)
		existing, _ := fromYcrdt(raw).(map[string]any)
		if !cond(existing) {
			return
		}
		updated := map[string]any{}
		for k, v := range existing {
			updated[k] = v
		}
		mutate(updated)
		w.doc.metadata.Set(keyProcessingState, toYcrdt(updated))
		applied = true
	})
	return applied
}

// replaceProcessingState publishes a processingState frame built from scratch,
// carrying the per-thread run registry across the replacement: updateRuns is
// handed the live registry (a copy) and the frame is written with the result and
// its refreshed projection. Read and write happen under ONE hold, so a rebuild
// can never drop a claim taken between reading the old frame and writing the
// new one — the hazard a from-scratch SetMetadata would otherwise carry now that
// the frame holds state the writer did not author.
func (w *ConversationWorker) replaceProcessingState(
	stateMap map[string]any,
	touchedThreadID string,
	updateRuns func(runs runRegistry),
) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	existing, _ := fromYcrdt(w.doc.metadata.Get(keyProcessingState)).(map[string]any)
	runs := copyRuns(existing)
	updateRuns(runs)
	w.refreshPoliteStopsLocked(stateMap, runs)
	storeRuns(stateMap, runs)
	projectLiveRun(stateMap, runs, touchedThreadID)
	w.doc.setMetadata(keyProcessingState, stateMap)
}

// patchProcessingStateLocked applies mutate to a shallow copy of the doc's
// processingState map inside a single transaction and writes it back. No-op when
// processingState is absent — the plain field-level updates below never create
// fresh state, only edit an existing busy frame. Caller MUST hold ycrdtMu.
func (w *ConversationWorker) patchProcessingStateLocked(mutate func(map[string]any)) {
	w.patchProcessingStateIfLocked(func(existing map[string]any) bool { return existing != nil }, mutate)
}

// reconcileProcessingStateOnLoad resets the doc-native claim to idle after a load
// and, unless the doc was forked mid-turn, re-establishes activity="awaiting_llm"
// when a non-terminal tool-action remains. That re-drive is the crash-recovery
// path: after a quit-while-approving restart, the reducer would otherwise see
// activity="" and never fire the follow-up LLM turn once the tool finishes.
//
// A fork-parked clone carries the same in-flight tool but must REST, not resume:
// it was copied from a running conversation and should appear stopped. The
// forkParked marker (stamped on the copy at snapshot time) suppresses the
// re-drive for exactly this first load, then is consumed so a later reload of the
// clone behaves like any normal conversation.
func (r *run) reconcileProcessingStateOnLoad() {
	// Empties the run registry and rests the conversation: a freshly loaded doc
	// may carry claims persisted mid-turn, on any number of threads, and nothing
	// is running yet. An idle frame alone drops only its own run's entry, so the
	// registry is swept explicitly first.
	r.releaseAllLLM()
	r.sendStatus("idle", "")
	if b, _ := r.doc.GetMetadata(metaForkParked).(bool); b {
		r.doc.SetMetadata(metaForkParked, false) // one-shot: consume the marker
		return
	}
	if threadID, ok := r.findThreadWithIncompleteTool(); ok {
		r.requestLLMAfterTools(threadID)
	}
	// What the queues hold was written by an earlier run of the server: the
	// held-send timer is armed for it, and an idle thread's queue that is
	// already due — a send whose time passed while the server was down, a
	// message queued behind a turn that ended with it — fires.
	r.markHeldStale()
}

// hideElapsedAnchor removes startedAt from the doc's processingState. Clients
// render the spinner's elapsed digit only when startedAt is present, so dropping
// it makes the timer disappear — used while a turn is parked on a human approval,
// so the deliberation is never shown as elapsed work. startedAt reappears (with
// the wait excluded) when work resumes, via advanceElapsedAnchor.
func (r *run) hideElapsedAnchor() {
	r.patchRunIf(r.t.thread.itemID,
		entryHoldsClaim,
		func(entry runEntry, _ map[string]any) { entry.clearStartedAt() },
	)
}

// advanceElapsedAnchor pushes processingStartedAt forward by waitMs (the just-
// ended approval wait) and writes the new value back into the doc's startedAt, so
// the elapsed digit reappears counting active work with the deliberation excluded
// — never snapping to 0. The deduction is pure in-memory arithmetic; only the one
// derived startedAt field touches the doc, and that single write propagates to
// every connected client at once.
func (r *run) advanceElapsedAnchor(waitMs int64) {
	anchor := r.t.processingStartedAt.Load()
	if waitMs > 0 {
		anchor += waitMs
		r.t.processingStartedAt.Store(anchor)
	}
	r.patchRunIf(r.t.thread.itemID,
		entryHoldsClaim,
		func(entry runEntry, _ map[string]any) { entry.setStartedAt(anchor) },
	)
}

// readProcessingState returns the doc's processingState as a plain map (nil if
// absent), taking ycrdtMu. Shared read preamble for the field accessors below so
// the lock + Get + fromYcrdt + nil-guard lives in one place.
func (w *ConversationWorker) readProcessingState() map[string]any {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return w.readProcessingStateLocked()
}

// readProcessingStateLocked is readProcessingState without the lock; callers
// MUST already hold ycrdtMu. The lock is not reentrant, so a routine that is
// already inside a transaction has to read the frame this way (ycrdt_watchdog).
func (w *ConversationWorker) readProcessingStateLocked() map[string]any {
	raw := w.doc.metadata.Get(keyProcessingState)
	existing, _ := fromYcrdt(raw).(map[string]any)
	return existing
}

// statusHoldsClaim reports whether a processingState.status represents an
// active operation that holds the doc-native LLM claim (activity != none).
// "idle" and the terminal-error status "validation-error" are resting states:
// the operation has ended, so the claim must be released and a new
// send/continue allowed to start. Every other status (preparing, streaming,
// processing_tools, retrying, …) is an in-flight phase that holds the claim.
//
// Treating validation-error as resting is essential: a no-model send
// surfaces via sendStatus("validation-error", …) and returns without running a
// turn, so it must release the claim — otherwise activity="calling_llm" wedges
// in the doc, parking every later message in the pending queue and dropping
// Continue.
func statusHoldsClaim(status string) bool {
	switch processingStatus(status) {
	case statusIdle, statusValidationError:
		return false
	default:
		return true
	}
}

// docTurnCounter reads the completed-turn counter currently stored in the doc's
// dedicated `completedTurns` metadata key (0 if absent). It lives outside the
// ephemeral processingState blob precisely because it is the one value read back
// across a load. Used to keep the in-memory turn counter monotonic across a
// worker restart on a reloaded conversation — a fresh worker's counter starts at
// 0 but the persisted doc may already hold a higher value, and the fence
// observing it must never see the count go backwards.
func (w *ConversationWorker) docTurnCounter() int64 {
	switch v := w.doc.GetMetadata(keyCompletedTurns).(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case int:
		return int64(v)
	default:
		return 0
	}
}

// markExplicitContinuation records a one-shot continuation intent on the given
// thread's run entry. The reducer consumes it when dispatching that thread's
// LLM turn. This distinguishes a fresh Continue click after an assistant message
// from stale awaiting_llm activity left after deleted tools/threads. Held
// per-thread, so a Continue on one thread is never consumed by another's
// dispatch.
func (w *ConversationWorker) markExplicitContinuation(threadItemID string) {
	w.patchRunIf(threadItemID,
		anyEntry,
		func(entry runEntry, _ map[string]any) { entry.setExplicitContinuation() },
	)
}

// isExplicitContinuation reports whether the one-shot continuation marker is set
// on the given thread.
func (w *ConversationWorker) isExplicitContinuation(threadItemID string) bool {
	return runEntryOf(w.readProcessingState(), threadItemID).explicitContinuation()
}

// consumeExplicitContinuation returns and clears the one-shot continuation
// marker on the thread currently being dispatched.
func (w *ConversationWorker) consumeExplicitContinuation(threadItemID string) bool {
	return w.patchRunIf(threadItemID,
		runEntry.explicitContinuation,
		func(entry runEntry, _ map[string]any) { entry.clearExplicitContinuation() },
	)
}

// markRaiseMaxOutput records a one-shot Max output for the given thread's next
// LLM request: the user's retry of a turn that ran out of it. The turn that
// sends that request consumes it (consumeRaiseMaxOutput), so the raise reaches
// exactly one request and every turn after it reverts to the model's own limit.
func (w *ConversationWorker) markRaiseMaxOutput(threadItemID string, tokens int) {
	w.patchRunIf(threadItemID,
		anyEntry,
		func(entry runEntry, _ map[string]any) { entry.setRaiseMaxOutputTokens(tokens) },
	)
}

// consumeRaiseMaxOutput returns and clears the one-shot Max output pending on
// the thread, 0 when there is none.
func (w *ConversationWorker) consumeRaiseMaxOutput(threadItemID string) int {
	tokens := 0
	w.patchRunIf(threadItemID,
		func(entry runEntry) bool { return entry.raiseMaxOutputTokens() > 0 },
		func(entry runEntry, _ map[string]any) {
			tokens = entry.raiseMaxOutputTokens()
			entry.clearRaiseMaxOutputTokens()
		},
	)
	return tokens
}

// requestLLM marks the given thread "awaiting_llm", signaling that an LLM call
// should be dispatched on it once all its work is terminal. The threadItemID
// identifies which thread needs dispatch ("" = root).
//
// This is one of the three verbs that start work, so a caller reached from a
// human act lifts the pause covering threadItemID first (see the classification
// in polite_stop.go). Queueing under a standing mark is legitimate — the thread
// rests at the reducer's gate and waits — but only if what the caller has already
// written to the document can still be driven once the mark is lifted.
//
// The postcondition is what the return value reports: true means this thread is
// queued for dispatch, so a thread already awaiting is an idempotent success —
// the caller's request stands either way. It fails only when that same thread is
// mid-turn (calling_llm), which is the one state a queued dispatch cannot be
// added to. A busy SIBLING is irrelevant: each thread queues on its own.
func (w *ConversationWorker) requestLLM(threadItemID string) bool {
	return w.patchRunIf(threadItemID,
		entryNotCallingLLM,
		func(entry runEntry, _ map[string]any) { entry.setActivity(ActivityAwaitingLLM) },
	)
}

// requestLLMAfterTools is requestLLM for a thread whose dispatch waits on a tool
// it already holds — the load-time re-drive and a tool retry. Those re-arm the
// thread from no entry at all, and requestLLM writes no status: the client
// treats an entry without one as live but gives it no status line, so the footer
// would fall back to the tool card's own label until the next turn claims the
// thread. A status the entry already carries is kept, as claimLLM keeps it.
func (w *ConversationWorker) requestLLMAfterTools(threadItemID string) bool {
	return w.patchRunIf(threadItemID,
		entryNotCallingLLM,
		func(entry runEntry, _ map[string]any) {
			entry.setActivity(ActivityAwaitingLLM)
			if !entry.hasStatus() {
				entry.setStatus(statusProcessingTools)
			}
		},
	)
}

// queuedThreadIDExcept returns the id of a thread OTHER than exclude that is
// queued for dispatch (awaiting_llm), with ok=false when there is none. Ordered
// like the projection — earliest claim first, ties on key — so the answer never
// depends on Go's map iteration order.
//
// It exists because a resting status empties the entire registry: a thread
// queued while another held the loop needs its dispatch carried across that
// sweep, or it sits unanswered with the conversation reporting idle.
func (w *ConversationWorker) queuedThreadIDExcept(exclude string) (string, bool) {
	var best runEntry
	bestKey := ""
	for key, entry := range runsView(w.readProcessingState()) {
		if entry.activity() != ActivityAwaitingLLM || entry.threadItemID() == exclude {
			continue
		}
		if best == nil || preferRun(entry, key, best, bestKey) {
			best, bestKey = entry, key
		}
	}
	if best == nil {
		return "", false
	}
	return best.threadItemID(), true
}

// getProcessingThreadItemID reads the threadItemId from processingState.
// This is the doc-native record of which thread is the target of the
// current operation (written by requestLLM and claimLLM).
func (w *ConversationWorker) getProcessingThreadItemID() string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return w.processingThreadItemIDLocked()
}

// processingThreadItemIDLocked is getProcessingThreadItemID without the lock;
// callers MUST already hold ycrdtMu.
func (w *ConversationWorker) processingThreadItemIDLocked() string {
	threadItemID, _ := w.readProcessingStateLocked()[runFieldThreadItemID].(string)
	return threadItemID
}

// transitionToAwaitingLLM moves THIS turn's thread from "calling_llm" to
// "awaiting_llm" and sets the UI status to "processing_tools". Used when the
// strategy loop dispatches async tools and returns without blocking — the
// reducer will re-dispatch when the tools complete. Scoped to the turn's own
// thread, so handing the loop back never disturbs a sibling's claim.
//
// The status is written to the run's entry, not the frame: the projection
// republishes the entry's own fields over the frame, and the UI reads the entry.
func (r *run) transitionToAwaitingLLM() {
	r.patchRunIf(r.t.thread.itemID,
		anyEntry,
		func(entry runEntry, _ map[string]any) {
			entry.setActivity(ActivityAwaitingLLM)
			entry.setStatus(statusProcessingTools)
			entry.setMessage("")
			entry.setCode("")
			entry.dropPhaseProgress()
		},
	)
}
