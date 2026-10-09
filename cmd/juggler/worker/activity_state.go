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
func runsView(state map[string]any) map[string]any {
	if runs, ok := state["runs"].(map[string]any); ok {
		return runs
	}
	activity, _ := state["activity"].(string)
	if activity == ActivityNone {
		return nil
	}
	threadItemID, _ := state["threadItemId"].(string)
	entry := map[string]any{"activity": activity, "threadItemId": threadItemID}
	if claimedAt, ok := state["claimedAt"]; ok {
		entry["claimedAt"] = claimedAt
	}
	if explicit, _ := state["explicitContinuation"].(bool); explicit {
		entry["explicitContinuation"] = true
	}
	return map[string]any{runKey(threadItemID): entry}
}

// runEntryOf returns one thread's run entry, or nil when that thread holds no
// claim. Read-only — the returned map belongs to state.
func runEntryOf(state map[string]any, threadItemID string) map[string]any {
	entry, _ := runsView(state)[runKey(threadItemID)].(map[string]any)
	return entry
}

// entryActivity reads a run entry's activity, reporting an absent entry as idle.
func entryActivity(entry map[string]any) string {
	activity, _ := entry["activity"].(string)
	return activity
}

// entryClaimedAt reads a run entry's claim timestamp. The value survives a JSON
// round-trip through toYcrdt, so it can come back as any numeric kind.
func entryClaimedAt(entry map[string]any) int64 {
	switch v := entry["claimedAt"].(type) {
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

// runEntryIsSpent reports whether an entry has nothing left worth storing: no
// activity and no pending continuation marker. Such entries are dropped so an
// idle conversation's runs map is absent entirely, exactly as an idle
// conversation's activity field is.
func runEntryIsSpent(entry map[string]any) bool {
	if entryActivity(entry) != ActivityNone {
		return false
	}
	explicit, _ := entry["explicitContinuation"].(bool)
	return !explicit
}

// copyRuns returns a deep-enough copy of processingState's runs sub-map (the
// map and each entry), always non-nil so callers can write into it. Copying
// matters because the map read back through fromYcrdt is also reachable from
// the frame clone patchProcessingStateIf builds: mutating it in place would
// edit state a rejected compare-and-set is supposed to leave untouched.
func copyRuns(state map[string]any) map[string]any {
	out := map[string]any{}
	for key, raw := range runsView(state) {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		clone := make(map[string]any, len(entry))
		for k, v := range entry {
			clone[k] = v
		}
		out[key] = clone
	}
	return out
}

// storeRuns writes the registry back into a frame, omitting the key entirely
// when no thread holds a claim.
func storeRuns(state map[string]any, runs map[string]any) {
	if len(runs) == 0 {
		delete(state, "runs")
		return
	}
	state["runs"] = runs
}

// pickLiveRun chooses which run the top-level projection describes: the thread
// just touched if it still holds a claim, else the run actually calling the LLM,
// else one awaiting dispatch. Ties break on the most recent claim and then on
// key, so the projection is a stable function of the registry rather than of Go
// map iteration order.
func pickLiveRun(runs map[string]any, touchedKey string) map[string]any {
	if entry, ok := runs[touchedKey].(map[string]any); ok && entryActivity(entry) != ActivityNone {
		return entry
	}
	for _, want := range []string{ActivityCallingLLM, ActivityAwaitingLLM} {
		var best map[string]any
		bestKey := ""
		for key, raw := range runs {
			entry, ok := raw.(map[string]any)
			if !ok || entryActivity(entry) != want {
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
func preferRun(a map[string]any, aKey string, b map[string]any, bKey string) bool {
	if aAt, bAt := entryClaimedAt(a), entryClaimedAt(b); aAt != bAt {
		return aAt > bAt
	}
	return aKey < bKey
}

// runProjectedFields are the spinner fields a run owns: what it is doing, since
// when, and how much has flowed. Each live run carries its own copy in its entry
// — two runs streaming at once each describe themselves — and the projection
// republishes the chosen run's copy at the top level for the conversation-wide
// readers.
var runProjectedFields = []string{
	"status", "message", "code", "startedAt",
	"description", "phase", "inputTokens", "outputTokens", "cachedTokens",
}

// projectLiveRun refreshes the top-level activity/threadItemId/claimedAt fields
// from the registry. threadItemId is deliberately left in place when no run is
// live: a released claim keeps naming the thread it was released from, which is
// what handleCancel and the reducer read on the way to rest.
func projectLiveRun(state map[string]any, touchedThreadID string) {
	runs, _ := state["runs"].(map[string]any)
	entry := pickLiveRun(runs, runKey(touchedThreadID))
	if entry == nil {
		delete(state, "activity")
		delete(state, "claimedAt")
		return
	}
	state["activity"] = entryActivity(entry)
	for _, field := range runProjectedFields {
		if value, ok := entry[field]; ok {
			state[field] = value
		} else {
			delete(state, field)
		}
	}
	if id, ok := entry["threadItemId"].(string); ok {
		state["threadItemId"] = id
	}
	if claimedAt, ok := entry["claimedAt"]; ok {
		state["claimedAt"] = claimedAt
	} else {
		delete(state, "claimedAt")
	}
}

// patchRunIf is the per-thread compare-and-set every activity transition is
// built from. Inside one Yjs transaction it offers the target thread's run entry
// to cond and, if accepted, applies mutate to that entry (and, where a
// transition also touches UI-facing frame fields, to the frame), stores the
// result and refreshes the projection. Returns false — changing nothing — when
// cond rejects.
func (w *ConversationWorker) patchRunIf(
	threadItemID string,
	cond func(entry map[string]any) bool,
	mutate func(entry, state map[string]any),
) bool {
	key := runKey(threadItemID)
	return w.patchProcessingStateIf(
		func(existing map[string]any) bool { return cond(runEntryOf(existing, threadItemID)) },
		func(updated map[string]any) {
			runs := copyRuns(updated)
			entry, ok := runs[key].(map[string]any)
			if !ok {
				entry = map[string]any{}
			}
			entry["threadItemId"] = threadItemID
			mutate(entry, updated)
			if runEntryIsSpent(entry) {
				delete(runs, key)
			} else {
				runs[key] = entry
			}
			// A claim taken or released changes which threads a pause is still
			// waiting on, so the pause projection is recomputed with the registry
			// that carries it rather than left to the next status frame.
			w.refreshPoliteStopsLocked(updated, runs)
			storeRuns(updated, runs)
			projectLiveRun(updated, threadItemID)
		},
	)
}

// statusIsLive reports whether a run entry's own status is one that is still
// working. The mid-stream progress writers gate on it, so a chunk that arrives
// after its run rested cannot revive a spinner on that thread.
func statusIsLive(entry map[string]any) bool {
	switch status, _ := entry["status"].(string); status {
	case "preparing", "streaming", "processing_tools", "retrying":
		return true
	default:
		return false
	}
}

// patchLiveRun applies mutate to this run's OWN entry, and only while that entry
// is still working. Every mid-stream progress field goes through it: a run
// describes itself, so two turns streaming at once cannot overwrite each other's
// token counts or activity line.
func (r *run) patchLiveRun(mutate func(entry map[string]any)) {
	r.patchRunIf(r.t.thread.itemID, statusIsLive, func(entry, _ map[string]any) { mutate(entry) })
}

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
		func(entry map[string]any) bool {
			// Succeed from idle or "awaiting_llm"; fail if already "calling_llm".
			return entryActivity(entry) != ActivityCallingLLM
		},
		func(entry, _ map[string]any) {
			now := time.Now().UnixMilli()
			entry["activity"] = ActivityCallingLLM
			entry["claimedAt"] = now
			// Seed the entry, not the frame: the projection republishes the
			// entry's own fields and would drop anything written beside it. Any
			// status this thread already carries is kept, so the UI doesn't
			// flicker through an intermediate state; sendStatus overwrites it
			// with the first loop phase a moment later.
			if _, hasStatus := entry["status"]; !hasStatus {
				entry["status"] = "preparing"
			}
			if _, hasStarted := entry["startedAt"]; !hasStarted {
				entry["startedAt"] = now
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
		func(entry map[string]any) bool { return entryActivity(entry) != ActivityNone },
		func(entry, _ map[string]any) {
			delete(entry, "activity")
			delete(entry, "claimedAt")
		},
	)
}

// releaseAllLLM drops every thread's claim at once. Used where the user has
// revoked the whole conversation's LLM intent rather than one thread's — undo,
// redo, and the history-navigation suppression window — after which no thread's
// pending dispatch still stands.
func (w *ConversationWorker) releaseAllLLM() {
	w.patchProcessingStateIf(
		func(existing map[string]any) bool { return existing != nil },
		func(updated map[string]any) {
			delete(updated, "runs")
			delete(updated, "activity")
			delete(updated, "claimedAt")
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
	var applied bool
	w.doc.transactTracked(func(_ *ycrdt.Transaction) {
		raw := w.doc.metadata.Get("processingState")
		existing, _ := fromYcrdt(raw).(map[string]any)
		if !cond(existing) {
			return
		}
		updated := map[string]any{}
		for k, v := range existing {
			updated[k] = v
		}
		mutate(updated)
		w.doc.metadata.Set("processingState", toYcrdt(updated))
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
	updateRuns func(runs map[string]any),
) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	existing, _ := fromYcrdt(w.doc.metadata.Get("processingState")).(map[string]any)
	runs := copyRuns(existing)
	updateRuns(runs)
	w.refreshPoliteStopsLocked(stateMap, runs)
	storeRuns(stateMap, runs)
	projectLiveRun(stateMap, touchedThreadID)
	w.doc.setMetadata("processingState", stateMap)
}

// patchProcessingState applies mutate to a shallow copy of the doc's
// processingState map inside a single transaction and writes it back. No-op when
// processingState is absent — the plain field-level updates below never create
// fresh state, only edit an existing busy frame.
func (w *ConversationWorker) patchProcessingState(mutate func(map[string]any)) {
	w.patchProcessingStateIf(func(existing map[string]any) bool { return existing != nil }, mutate)
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
		r.requestLLM(threadID)
	}
}

// hideElapsedAnchor removes startedAt from the doc's processingState. Clients
// render the spinner's elapsed digit only when startedAt is present, so dropping
// it makes the timer disappear — used while a turn is parked on a human approval,
// so the deliberation is never shown as elapsed work. startedAt reappears (with
// the wait excluded) when work resumes, via advanceElapsedAnchor.
func (r *run) hideElapsedAnchor() {
	r.patchRunIf(r.t.thread.itemID,
		func(entry map[string]any) bool { return entryActivity(entry) != ActivityNone },
		func(entry, _ map[string]any) { delete(entry, "startedAt") },
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
		func(entry map[string]any) bool { return entryActivity(entry) != ActivityNone },
		func(entry, _ map[string]any) { entry["startedAt"] = anchor },
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
	raw := w.doc.metadata.Get("processingState")
	existing, _ := fromYcrdt(raw).(map[string]any)
	return existing
}

// statusHoldsClaim reports whether a processingState.status represents an
// active operation that holds the doc-native LLM claim (activity != none).
// "idle" and the terminal-error statuses ("error", "validation-error") are
// resting states: the operation has ended, so the claim must be released and a
// new send/continue allowed to start. Every other status (preparing, streaming,
// processing_tools, retrying, …) is an in-flight phase that holds the claim.
//
// Treating the terminal-error statuses as resting is essential: a no-model send
// surfaces via sendStatus("validation-error", …) and returns without running a
// turn, so it must release the claim — otherwise activity="calling_llm" wedges
// in the doc, parking every later message in the pending queue and dropping
// Continue.
func statusHoldsClaim(status string) bool {
	switch status {
	case "idle", "error", "validation-error":
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
	switch v := w.doc.GetMetadata("completedTurns").(type) {
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
		func(map[string]any) bool { return true },
		func(entry, _ map[string]any) { entry["explicitContinuation"] = true },
	)
}

// isExplicitContinuation reports whether the one-shot continuation marker is set
// on the given thread.
func (w *ConversationWorker) isExplicitContinuation(threadItemID string) bool {
	flag, _ := runEntryOf(w.readProcessingState(), threadItemID)["explicitContinuation"].(bool)
	return flag
}

// consumeExplicitContinuation returns and clears the one-shot continuation
// marker on the thread currently being dispatched.
func (w *ConversationWorker) consumeExplicitContinuation(threadItemID string) bool {
	return w.patchRunIf(threadItemID,
		func(entry map[string]any) bool {
			flag, _ := entry["explicitContinuation"].(bool)
			return flag
		},
		func(entry, _ map[string]any) { delete(entry, "explicitContinuation") },
	)
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
		func(entry map[string]any) bool { return entryActivity(entry) != ActivityCallingLLM },
		func(entry, _ map[string]any) { entry["activity"] = ActivityAwaitingLLM },
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
	var best map[string]any
	bestKey := ""
	for key, raw := range runsView(w.readProcessingState()) {
		entry, ok := raw.(map[string]any)
		if !ok || entryActivity(entry) != ActivityAwaitingLLM {
			continue
		}
		if id, _ := entry["threadItemId"].(string); id == exclude {
			continue
		}
		if best == nil || preferRun(entry, key, best, bestKey) {
			best, bestKey = entry, key
		}
	}
	if best == nil {
		return "", false
	}
	id, _ := best["threadItemId"].(string)
	return id, true
}

// getProcessingThreadItemID reads the threadItemId from processingState.
// This is the doc-native record of which thread is the target of the
// current operation (written by requestLLM and claimLLM).
func (w *ConversationWorker) getProcessingThreadItemID() string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	raw := w.doc.metadata.Get("processingState")
	existing, _ := fromYcrdt(raw).(map[string]any)
	if existing == nil {
		return ""
	}
	threadItemID, _ := existing["threadItemId"].(string)
	return threadItemID
}

// phaseProgressFields are the mid-stream progress fields, which belong to the
// phase that produced them: a token count from the last stream means nothing
// beside "Running tools", and a provider activity line describes a call that
// has ended.
var phaseProgressFields = []string{"description", "phase", "inputTokens", "outputTokens", "cachedTokens"}

// dropPhaseProgress clears a run entry's mid-stream progress fields, as every
// change of phase must.
func dropPhaseProgress(entry map[string]any) {
	for _, field := range phaseProgressFields {
		delete(entry, field)
	}
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
		func(map[string]any) bool { return true },
		func(entry, _ map[string]any) {
			entry["activity"] = ActivityAwaitingLLM
			entry["status"] = "processing_tools"
			entry["message"] = ""
			delete(entry, "code")
			dropPhaseProgress(entry)
		},
	)
}
