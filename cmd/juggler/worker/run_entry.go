//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "juggler/cmd/juggler/msg"

// runEntry is one thread's entry in processingState.runs (activity_state.go).
//
// It is the decoded map itself rather than a struct converted from it, for two
// reasons the doc imposes. Presence is part of the meaning: an entry without a
// `status` is live with no status line, one without `startedAt` hides the
// elapsed timer, and the projection copies a field across only when the entry
// has it — so a struct would need an "is set" flag on almost every field. And
// the entry is written back exactly as read, keys this worker does not know
// included. Every read and write goes through the methods below, which own the
// key strings and the value types, so callers never index the map or assert on
// what comes out of it.
type runEntry map[string]any

// The keys of a run entry. The spinner fields among them are also republished
// at the top level of processingState (runProjectedFields).
const (
	runFieldThreadItemID         = "threadItemId"
	runFieldActivity             = "activity"
	runFieldClaimedAt            = "claimedAt"
	runFieldExplicitContinuation = "explicitContinuation"
	runFieldPolitePending        = "politePending"
	runFieldStatus               = "status"
	runFieldMessage              = "message"
	runFieldCode                 = "code"
	runFieldText                 = "text"
	runFieldStartedAt            = "startedAt"
	runFieldDescription          = "description"
	runFieldPhase                = "phase"
	runFieldInputTokens          = "inputTokens"
	runFieldOutputTokens         = "outputTokens"
	runFieldCachedTokens         = "cachedTokens"
	runFieldRaiseMaxOutputTokens = "raiseMaxOutputTokens"
)

// runProjectedFields are the spinner fields a run owns: what it is doing, since
// when, and how much has flowed. Each live run carries its own copy in its entry
// — two runs streaming at once each describe themselves — and the projection
// (projectInto) republishes the chosen run's copy at the top level for the
// conversation-wide readers.
var runProjectedFields = []string{
	runFieldStatus, runFieldMessage, runFieldCode, runFieldStartedAt,
	runFieldDescription, runFieldPhase, runFieldInputTokens, runFieldOutputTokens, runFieldCachedTokens,
}

// runEntryFromLegacy is the one run a frame describes through its top-level
// projection alone (see runsView), or nil when that projection holds no claim.
// claimedAt is carried across in whatever numeric kind the frame holds it.
func runEntryFromLegacy(state map[string]any) runEntry {
	activity, _ := state[runFieldActivity].(string)
	if activity == ActivityNone {
		return nil
	}
	threadItemID, _ := state[runFieldThreadItemID].(string)
	e := runEntry{}
	e.setActivity(activity)
	e.setThreadItemID(threadItemID)
	if claimedAt, ok := state[runFieldClaimedAt]; ok {
		e[runFieldClaimedAt] = claimedAt
	}
	if explicit, _ := state[runFieldExplicitContinuation].(bool); explicit {
		e.setExplicitContinuation()
	}
	return e
}

// projectInto republishes the entry at a frame's top level: its activity, each
// runProjectedFields field it has (and the removal of each it lacks), its
// thread, and its claim time. Values are copied as stored, so the top level
// reads exactly as the entry does.
func (e runEntry) projectInto(state map[string]any) {
	state[runFieldActivity] = e.activity()
	for _, field := range runProjectedFields {
		if value, ok := e[field]; ok {
			state[field] = value
		} else {
			delete(state, field)
		}
	}
	if id, ok := e[runFieldThreadItemID].(string); ok {
		state[runFieldThreadItemID] = id
	}
	if claimedAt, ok := e[runFieldClaimedAt]; ok {
		state[runFieldClaimedAt] = claimedAt
	} else {
		delete(state, runFieldClaimedAt)
	}
}

// runRegistry is processingState.runs decoded: run entries by runKey.
type runRegistry map[string]runEntry

// toDoc is the registry as the plain maps processingState stores.
func (r runRegistry) toDoc() map[string]any {
	out := make(map[string]any, len(r))
	for key, entry := range r {
		out[key] = map[string]any(entry)
	}
	return out
}

// clone copies the entry, so writing to the copy leaves the original — which
// may still be reachable from a frame a rejected compare-and-set must not
// touch — as it was.
func (e runEntry) clone() runEntry {
	out := make(runEntry, len(e))
	for k, v := range e {
		out[k] = v
	}
	return out
}

func (e runEntry) str(key string) string {
	v, _ := e[key].(string)
	return v
}

func (e runEntry) has(key string) bool {
	_, ok := e[key]
	return ok
}

// docInt64 reads a number the doc stores. A value survives a JSON round trip
// through toYcrdt, so it can come back as any numeric kind.
func docInt64(v any) int64 {
	n, _ := yNumberInt64(v)
	return n
}

// threadItemID is the thread the entry belongs to ("" for the root).
func (e runEntry) threadItemID() string { return e.str(runFieldThreadItemID) }

func (e runEntry) setThreadItemID(id string) { e[runFieldThreadItemID] = id }

// activity is the entry's claim: ActivityCallingLLM, ActivityAwaitingLLM, or
// ActivityNone for an absent entry or one whose claim was released.
func (e runEntry) activity() string { return e.str(runFieldActivity) }

func (e runEntry) setActivity(activity string) { e[runFieldActivity] = activity }

// releaseClaim drops the claim and the time it was taken.
func (e runEntry) releaseClaim() {
	delete(e, runFieldActivity)
	delete(e, runFieldClaimedAt)
}

// claimedAt is when the claim was taken, in Unix milliseconds; 0 when unset.
func (e runEntry) claimedAt() int64 { return docInt64(e[runFieldClaimedAt]) }

func (e runEntry) setClaimedAt(ms int64) { e[runFieldClaimedAt] = ms }

// explicitContinuation is the one-shot Continue marker (markExplicitContinuation).
func (e runEntry) explicitContinuation() bool {
	v, _ := e[runFieldExplicitContinuation].(bool)
	return v
}

func (e runEntry) setExplicitContinuation() { e[runFieldExplicitContinuation] = true }

func (e runEntry) clearExplicitContinuation() { delete(e, runFieldExplicitContinuation) }

// raiseMaxOutputTokens is the one-shot Max output a retry of a cut-off turn asked
// for (markRaiseMaxOutput); 0 when none is pending.
func (e runEntry) raiseMaxOutputTokens() int { return int(docInt64(e[runFieldRaiseMaxOutputTokens])) }

func (e runEntry) setRaiseMaxOutputTokens(tokens int) { e[runFieldRaiseMaxOutputTokens] = tokens }

func (e runEntry) clearRaiseMaxOutputTokens() { delete(e, runFieldRaiseMaxOutputTokens) }

// setPolitePending marks, or unmarks, the entry as work a pause is waiting on.
// Unmarking removes the key, which is how the client reads "not pending".
func (e runEntry) setPolitePending(pending bool) {
	if pending {
		e[runFieldPolitePending] = true
	} else {
		delete(e, runFieldPolitePending)
	}
}

// status is the run's own processing status; hasStatus reports whether it has
// one at all, which the client reads differently from any status.
func (e runEntry) status() processingStatus { return processingStatus(e.str(runFieldStatus)) }

func (e runEntry) hasStatus() bool { return e.has(runFieldStatus) }

// setStatus stores the status as a plain string: the entry is read back within
// the same transaction, before any round trip, by readers asserting on string.
func (e runEntry) setStatus(status processingStatus) { e[runFieldStatus] = string(status) }

func (e runEntry) setMessage(message string) { e[runFieldMessage] = message }

// setCode stores the status's machine-readable code, or removes it when empty.
func (e runEntry) setCode(code string) {
	if code != "" {
		e[runFieldCode] = code
	} else {
		delete(e, runFieldCode)
	}
}

// setText stores the status line as a translatable message, or removes it.
func (e runEntry) setText(text *msg.Message) {
	if text != nil {
		e[runFieldText] = *text
	} else {
		delete(e, runFieldText)
	}
}

// hasStartedAt reports whether the entry carries the elapsed-timer base; the
// client draws the timer only when it does.
func (e runEntry) hasStartedAt() bool { return e.has(runFieldStartedAt) }

func (e runEntry) setStartedAt(ms int64) { e[runFieldStartedAt] = ms }

func (e runEntry) clearStartedAt() { delete(e, runFieldStartedAt) }

func (e runEntry) setDescription(description string) { e[runFieldDescription] = description }

func (e runEntry) clearDescription() { delete(e, runFieldDescription) }

func (e runEntry) setPhase(phase string) { e[runFieldPhase] = phase }

// mergeTokens records the token counts that are positive, leaving the others
// as the last chunk that reported them left them.
func (e runEntry) mergeTokens(outputTokens, inputTokens, cachedTokens int) {
	if outputTokens > 0 {
		e[runFieldOutputTokens] = outputTokens
	}
	if inputTokens > 0 {
		e[runFieldInputTokens] = inputTokens
	}
	if cachedTokens > 0 {
		e[runFieldCachedTokens] = cachedTokens
	}
}

// phaseProgressFields are the mid-stream progress fields, which belong to the
// phase that produced them: a token count from the last stream means nothing
// beside "Running tools", and a provider activity line describes a call that
// has ended.
var phaseProgressFields = []string{
	runFieldDescription, runFieldPhase, runFieldInputTokens, runFieldOutputTokens, runFieldCachedTokens,
}

// dropPhaseProgress clears the mid-stream progress fields, as every change of
// phase must.
func (e runEntry) dropPhaseProgress() {
	for _, field := range phaseProgressFields {
		delete(e, field)
	}
}

// isSpent reports whether the entry has nothing left worth storing: no
// activity and no pending one-shot marker. Such entries are dropped so an
// idle conversation's runs map is absent entirely, exactly as an idle
// conversation's activity field is.
func (e runEntry) isSpent() bool {
	return e.activity() == ActivityNone && !e.explicitContinuation() && e.raiseMaxOutputTokens() <= 0
}

// isLive reports whether the entry's own status is one that is still working.
// The mid-stream progress writers gate on it, so a chunk that arrives after its
// run rested cannot revive a spinner on that thread.
func (e runEntry) isLive() bool {
	switch e.status() {
	case statusPreparing, statusStreaming, statusProcessingTools, statusRetrying:
		return true
	default:
		return false
	}
}
