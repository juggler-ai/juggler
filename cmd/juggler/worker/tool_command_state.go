//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "time"

// toolCommandState is the per-toolUseId bookkeeping for the level-based
// command-driven tool lifecycle. driveToolActions re-dispatches a tool's command
// (evaluate-tool for "", execute-tool for approved) whenever the doc state still
// demands one and it has not been dispatched at that state within redriveInterval.
//
// Doc-state progression is the "engine acted" signal — the idempotent engine
// handlers (handleNewToolAction's ifState CAS, claimRunning's compare-and-set)
// make a redundant command a harmless no-op — so there is no ack, in-flight latch,
// or watchdog timer. The age test is BOTH the per-tick anti-spam dedup and the
// recovery for a silently-dropped command, and one attempts cap escalates a
// permanently-unhandled command to a terminal error instead of waiting forever.
type toolCommandState struct {
	// dispatchedState is the state the last command for this id was sent at.
	// dispatchedStateSet distinguishes a real "" (StateUnevaluated) dispatch from
	// "never dispatched", so a never-dispatched tool still gets its first command.
	dispatchedState    string
	dispatchedStateSet bool

	// lastDispatchedAt stamps the last dispatch so shouldRedrive can suppress a
	// re-dispatch at the same state until redriveInterval has elapsed. Tests force
	// staleness by shrinking the worker's redriveInterval, not by poking this.
	lastDispatchedAt time.Time

	// dispatches counts every command sent for this id, across delivery phases. It
	// is the ordering the "did the engine answer" tests are expressed in, and it
	// is a count rather than a clock reading on purpose: time.Now() is only as
	// fine as the platform tick — on Windows it comes from a counter updated every
	// ~1-15ms — so a trace answering a dispatch at once carries the SAME instant
	// as the dispatch it answers, and no comparison of stamps can separate an
	// engine replying immediately from one that never replied at all. Counting
	// dispatches asks the question directly: which commands had gone out by the
	// time the trace arrived.
	dispatches int

	// lastTracedAt stamps when an engine-trace naming THIS toolUseId last arrived
	// (recordTrace, from handleEngineTrace). Every engine-side handler traces with
	// the toolUseId it acted on — the acting paths (execute-claim/start/done) and
	// the declining ones (evaluate-noact/execute-noact) alike — so a trace here is
	// the only evidence that a command for this tool reached a handler at all.
	// Zero until the first trace for the id. Diagnostic: the escalation verdict
	// reads the two classified counters below.
	lastTracedAt time.Time

	// engagedAtDispatch records the dispatch count as of the last trace that
	// proves the engine reached THIS tool — it claimed it, ran it, or declined for
	// a reason about the tool itself. This, not lastTracedAt, is what
	// answeredSincePrevDispatch weighs, because a decline about the engine's own
	// readiness proves the opposite of engagement. Zero until such a trace lands.
	engagedAtDispatch int

	// unreachableAtDispatch / lastUnreachableReason record the dispatch count as
	// of the last trace declining the command because the engine could not reach
	// the tool at all (engineUnreachableReasons), and the reason it gave. Kept
	// apart from engagedAtDispatch so a tool waiting on an engine that is still
	// loading its conversation is held rather than blamed, and so the escalation
	// message can name the reason it was given.
	unreachableAtDispatch int
	lastUnreachableReason string

	// firstDispatchedAt stamps when the CURRENT delivery phase began — the first
	// dispatch at this state. It bounds how long an unproven engine is waited out
	// (engineUnprovenHold), so a tool is never held indefinitely no matter how
	// long the engine stays unreachable.
	firstDispatchedAt time.Time

	// attempts counts consecutive dispatches at the current dispatchedState; past
	// maxToolCommandAttempts the tool is escalated to a terminal error. Reset to 1
	// whenever the demanded state changes (a fresh delivery phase).
	attempts int

	// heldNoted records that this delivery phase has already announced itself as
	// held past the attempts cap, so the announcement is made once rather than on
	// every re-drive. Cleared with the phase.
	heldNoted bool
}

// toolCommandTracker owns the tool-command bookkeeping. Every access happens on
// the worker's run goroutine (driveToolActions and the reattach/reset paths all
// run there), so it carries no lock of its own.
type toolCommandTracker struct {
	byID map[string]*toolCommandState
}

func newToolCommandTracker() *toolCommandTracker {
	return &toolCommandTracker{byID: map[string]*toolCommandState{}}
}

// entry returns the mutable state for id, creating a zero entry if absent.
func (t *toolCommandTracker) entry(id string) *toolCommandState {
	s := t.byID[id]
	if s == nil {
		s = &toolCommandState{}
		t.byID[id] = s
	}
	return s
}

// resetAll drops bookkeeping for every tool. Used on engine reattach: the new
// engine has observed none of this conversation's commands, so every non-terminal
// tool-action must be dispatched afresh against it.
func (t *toolCommandTracker) resetAll() {
	t.byID = map[string]*toolCommandState{}
}

// clear drops all bookkeeping for id (the full-reset sites: escalation-to-failed,
// user-triggered retry, per-tool reattach reset). The next drive treats the id as
// never-dispatched.
func (t *toolCommandTracker) clear(id string) { delete(t.byID, id) }

// noteHeld reports whether this is the first time in the current delivery phase
// that id has been found held past the attempts cap, so the hold is announced
// once rather than on every re-drive.
func (t *toolCommandTracker) noteHeld(id string) bool {
	s := t.entry(id)
	if s.heldNoted {
		return false
	}
	s.heldNoted = true
	return true
}

// shouldRedrive reports whether id needs a command dispatched for state now. A
// never-dispatched id — or one whose demanded state changed since its last
// dispatch — is dispatched immediately; a re-dispatch at the SAME state is
// suppressed until interval has elapsed since the last dispatch (the anti-spam
// dedup that also recovers a silently-dropped command once it goes stale).
func (t *toolCommandTracker) shouldRedrive(id, state string, now time.Time, interval time.Duration) bool {
	s := t.byID[id]
	if s == nil || !s.dispatchedStateSet || s.dispatchedState != state {
		return true
	}
	return now.Sub(s.lastDispatchedAt) >= interval
}

// recordDispatch records a just-sent command for id at state, stamped now, and
// returns the resulting attempt count at that state. Attempts reset to 1 when the
// state differs from the last dispatch (a new delivery phase), else increment.
// The dispatch count spans phases, since it orders traces against commands rather
// than measuring a phase.
func (t *toolCommandTracker) recordDispatch(id, state string, now time.Time) int {
	s := t.entry(id)
	if !s.dispatchedStateSet || s.dispatchedState != state {
		s.dispatchedState, s.dispatchedStateSet, s.attempts = state, true, 1
		s.firstDispatchedAt = now
		s.heldNoted = false
	} else {
		s.attempts++
	}
	s.dispatches++
	s.lastDispatchedAt = now
	return s.attempts
}

// engineUnreachableReasons are the `reason` values an engine no-act trace
// carries when the engine could not reach the tool AT ALL: it holds no loaded
// copy of the conversation, no thread in the copy it holds owns the tool, or the
// tool-action map is missing. Every other reason ('in-flight',
// 'already-executing') means the engine did reach the tool and is working on it.
//
// The distinction decides who is blamed. All of these are declines, so they all
// prove the engine is alive and running handlers — but they are declines about
// the ENGINE's own readiness, not about the tool, and the identical command
// re-driven once it finishes loading succeeds. Counting them as answers makes
// the engine's loading window read as a tool that "never carried out" its
// command, and fails a tool that was about to run.
//
// This is a wire contract with the engine: the strings are the `reason` fields
// of the evaluate-noact/execute-noact traces in
// web/js/services/worker-manager-protocols.js (handleEvaluateTool,
// handleExecuteTool). TestEngineNoActReasons_AreAllClassified reads that file
// and fails if a reason appears there that this table has never heard of, so a
// new no-act exit cannot silently default to "the tool's fault".
var engineUnreachableReasons = map[string]bool{
	engineReasonConvNotLoaded: true,
	"no-thread":               true,
	"no-ymap":                 true,
}

// engineReasonConvNotLoaded is the one no-act reason that is about the
// CONVERSATION rather than the tool: the engine holds no loaded copy of it. The
// other unreachable reasons say the engine has the document but could not find
// the tool within it, so only this one invalidates what the worker believes the
// engine's document contains (handleEngineTrace → engineDocVector).
const engineReasonConvNotLoaded = "conv-not-loaded"

// recordTrace stamps the arrival of an engine-trace naming id, classifying it by
// the trace's `reason` field ("" for the acting traces, which carry none). Only
// ids already under command are stamped: a trace for anything else is
// diagnostic-only, and creating an entry for it would leak one map entry per
// tool ever traced.
func (t *toolCommandTracker) recordTrace(id, reason string, now time.Time) {
	s := t.byID[id]
	if s == nil {
		return
	}
	s.lastTracedAt = now
	if engineUnreachableReasons[reason] {
		s.unreachableAtDispatch, s.lastUnreachableReason = s.dispatches, reason
		return
	}
	s.engagedAtDispatch = s.dispatches
}

// answeredSincePrevDispatch reports whether the engine ENGAGED with THIS tool
// since the dispatch before the most recent one — i.e. whether the engine is
// still answering for this tool right now, rather than having answered once
// early in the phase and gone silent since.
//
// "Since the dispatch before the most recent one" has to be the previous one:
// driveToolActions calls recordDispatch before deciding whether to escalate, so
// at the decision point the latest dispatch is the one just sent, which nothing
// could have answered yet. The previous dispatch is the most recent one the
// engine has had a full redriveInterval to answer, so a trace that arrived once
// dispatches had reached at least that count is an answer to it.
//
// This is the difference between the escalation verdicts, so it is deliberately
// per-tool, deliberately recent, and deliberately blind to the unreachable
// declines. A conversation-wide "has the engine said anything" test is satisfied
// by a sibling tool in the same parallel batch; an "anything since the phase
// began" test is satisfied by one trace in the first millisecond of a 30-second
// phase, which is exactly what a suspended engine leaves behind; and a test that
// counts any trace at all is satisfied by an engine repeating that it cannot
// find the conversation, which is a statement about the engine, not the tool.
func (t *toolCommandTracker) answeredSincePrevDispatch(id string) bool {
	s := t.byID[id]
	if s == nil || s.engagedAtDispatch == 0 {
		return false
	}
	return s.engagedAtDispatch >= s.dispatches-1
}

// unreachableSincePrevDispatch reports whether the engine's most recent word on
// THIS tool, since the dispatch before the last, was that it could not reach it
// (engineUnreachableReasons), along with the reason it gave. An engine that
// declined that way and has since fallen silent is not "currently unreachable" —
// it is mute, and the shorter mute hold applies.
func (t *toolCommandTracker) unreachableSincePrevDispatch(id string) (bool, string) {
	s := t.byID[id]
	if s == nil || s.unreachableAtDispatch == 0 {
		return false, ""
	}
	if s.unreachableAtDispatch < s.dispatches-1 {
		return false, ""
	}
	return true, s.lastUnreachableReason
}

// lastTracedAt returns when an engine-trace naming id last arrived, or the zero
// time if none ever has. Diagnostic only — the escalation verdict uses
// answeredSincePrevDispatch, which also weighs recency.
func (t *toolCommandTracker) lastTracedAt(id string) time.Time {
	if s := t.byID[id]; s != nil {
		return s.lastTracedAt
	}
	return time.Time{}
}

// phaseStartedAt returns when the current delivery phase for id began, or the
// zero time if id has never been dispatched.
func (t *toolCommandTracker) phaseStartedAt(id string) time.Time {
	if s := t.byID[id]; s != nil {
		return s.firstDispatchedAt
	}
	return time.Time{}
}
