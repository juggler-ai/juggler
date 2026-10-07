//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "time"

// engineSession is the worker's side of its relationship with the attached
// engine, the one client that executes tool-actions. It holds three things:
//
//   - The request/reply round-trips with the clients and the engine, one reply
//     slot each, named for the request it answers. These are the session's
//     surface: a turn registers a request id on one, and the inbound handler
//     delivers the answer to it. The correlation they need lives in
//     reply_slot.go.
//   - The evidence that the engine is running its tool-command handlers: the two
//     most recent accepted tool-execution reports, the fence that admits them,
//     and when a trace last arrived.
//   - The Yjs state vector the engine is believed to hold, which is the base the
//     next push encodes a delta from.
//
// Who the engine is lives in the callback registry, which routes to it; this
// type is told on each call that needs it. Every field below the reply slots is
// read and written only by the methods in this file
// (TestEngineSessionOwnsItsState). Run goroutine only, apart from the reply
// slots, which are actors of their own.
type engineSession struct {
	// slots holds every reply slot, in construction order, so a test can check
	// the whole set rather than the ones someone thought to list.
	slots             []*replySlot
	contextReply      *replySlot
	toolsReply        *replySlot
	strategyHookReply *replySlot
	// The subthread-delegation round-trip is engine-targeted: the worker asks
	// the engine to build a SubthreadSpec for a delegating tool.
	subthreadSpecReply *replySlot

	// lastReport and prevReport are the two most recent ACCEPTED tool-execution
	// reports. The finalize rule needs a wedge absent from BOTH (the
	// two-consecutive belt). reportSeq fences stale or duplicate reports, per
	// engine. reportClient is the engine those reports came from, so they are
	// dropped when a different engine attaches.
	lastReport   *execReport
	prevReport   *execReport
	reportSeq    int64
	reportClient string

	// lastTraceAt is when an engine-trace for this conversation last arrived.
	// Purely diagnostic: it is the worker's only evidence that the engine is
	// reaching its tool-command handlers at all, so escalateStaleToolCommand
	// reports it. "never" separates an engine that never received a command (or
	// is wedged before its handlers) from one that received it and declined to
	// act, which the trace itself then explains. Zero until the first trace.
	lastTraceAt time.Time

	// docVector is the Yjs state vector the engine is believed to hold, and so
	// the point the next push encodes a delta from. Nil means "the engine holds
	// nothing we can build on", which is the only case that sends full state.
	//
	// It is advanced to the doc's own vector after each push rather than learnt
	// from the engine, because the engine never reports one unprompted. That is
	// safe in both directions: the push carries every op up to that vector
	// through the engine's ordered mailbox, and ops the doc gains afterwards
	// reach the engine on the ordinary broadcast path, so a vector that lags the
	// engine's true one only re-sends a few ops it can already integrate.
	//
	// Two things invalidate it, and both must, because a delta is worthless to a
	// peer without the base it builds on: a different engine attaching, and the
	// engine itself reporting it does not hold this conversation (a
	// conv-not-loaded trace; the engine can release a conversation without
	// dropping its socket, so attachment alone is not evidence it still has the
	// document). Both call forgetDocument.
	docVector []byte
}

// newEngineSession builds the session and its reply slots. The slots share
// done, so a blocked test client is released when the worker stops.
func newEngineSession(done <-chan struct{}) engineSession {
	var e engineSession
	slot := func(name string) *replySlot {
		s := newReplySlot(name, done)
		e.slots = append(e.slots, s)
		return s
	}
	e.contextReply = slot("render-context-items-request")
	e.toolsReply = slot("request-tools")
	e.strategyHookReply = slot("run-strategy-hook")
	e.subthreadSpecReply = slot("build-subthread-spec")
	return e
}

// replySlots returns every reply slot, in construction order.
func (e *engineSession) replySlots() []*replySlot {
	return e.slots
}

// admitReport applies the accept-gate to a report from originClient while
// engineID is the attached engine, and stores it if it passes. A report is
// evidence only if it came from the attached engine (a viewer or a superseded
// engine connection is refused, reason "origin") and carries a seq newer than
// the last accepted one (a duplicate or reordered frame is refused, reason
// "seq", with last the seq it failed to beat). An accepted report returns "".
//
// A different engine than the stored reports came from drops them and restarts
// the seq fence before this one is judged, so a new engine's early report is
// never paired with a dead engine's.
func (e *engineSession) admitReport(originClient, engineID string, r *execReport) (reason string, last int64) {
	if engineID == "" || originClient != engineID {
		return "origin", 0
	}
	if originClient != e.reportClient {
		e.reportClient = originClient
		e.lastReport = nil
		e.prevReport = nil
		e.reportSeq = 0
	}
	// On one ordered channel this shouldn't regress, but it costs one integer
	// compare and closes the door on a replayed frame.
	if r.seq <= e.reportSeq {
		return "seq", e.reportSeq
	}
	e.reportSeq = r.seq
	e.prevReport = e.lastReport
	e.lastReport = r
	return "", 0
}

// reportsCurrent reports whether the stored reports are recent enough to be
// evidence at now: the last within execReportFreshMs, and a second one within
// twice that. A quiet engine's recovery belongs to the reattach path, not to
// this rule. Requiring two converts any future regression of the ordering or
// contiguity assumptions from "wrongly finalize a completed tool" into a no-op,
// because the terminal write lands between the two reports.
func (e *engineSession) reportsCurrent(now time.Time) bool {
	if e.lastReport == nil || now.Sub(e.lastReport.receivedAt) > execReportFreshMs*time.Millisecond {
		return false
	}
	return e.prevReport != nil && now.Sub(e.prevReport.receivedAt) <= 2*execReportFreshMs*time.Millisecond
}

// provesAbsent reports whether BOTH stored reports prove the execution of id
// under epoch, claimed at started, is not running (see absentFromReport). Only
// meaningful once reportsCurrent holds.
func (e *engineSession) provesAbsent(id string, epoch, started int64) bool {
	return absentFromReport(e.lastReport, id, epoch, started) &&
		absentFromReport(e.prevReport, id, epoch, started)
}

// noteTrace records that an engine-trace arrived at now.
func (e *engineSession) noteTrace(now time.Time) {
	e.lastTraceAt = now
}

// lastTrace returns when an engine-trace last arrived, zero if never.
func (e *engineSession) lastTrace() time.Time {
	return e.lastTraceAt
}

// forgetDocument drops the belief about what the engine holds, so the next
// push seeds full state.
func (e *engineSession) forgetDocument() {
	e.docVector = nil
}

// engineDocState is the part of the conversation document a push reads.
type engineDocState interface {
	ToState() []byte
	GetStateVector() []byte
	GetStateUpdate(sinceVector []byte) []byte
}

// nextPush returns the Yjs update that brings the engine from what it is
// believed to hold to what doc holds now, and records doc's vector as what the
// engine will hold once it is sent. The first push to an engine is full state;
// the rest are deltas, possibly empty. ok is false only when the engine holds
// nothing and doc has nothing to seed from yet: then nothing is claimed, and
// the next push tries full state again rather than a delta against a base the
// engine was never given.
//
// The caller must send what it is handed. Both doc reads happen on the run
// goroutine, which is also the only goroutine that mutates the doc, so the
// vector recorded is exactly the one the update brings the engine to.
func (e *engineSession) nextPush(doc engineDocState) (update []byte, ok bool) {
	if e.docVector == nil {
		state := doc.ToState()
		if len(state) == 0 {
			return nil, false
		}
		e.docVector = doc.GetStateVector()
		return state, true
	}
	update = doc.GetStateUpdate(e.docVector)
	e.docVector = doc.GetStateVector()
	return update, true
}
