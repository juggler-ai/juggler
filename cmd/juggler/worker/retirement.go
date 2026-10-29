//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"errors"
	"sort"
)

// ErrRetired means this manager has committed to retirement and admits no work.
var ErrRetired = errors.New("worker manager retired")

var errWorkerStopped = errors.New("worker stopped during retirement probe")

// retirementDecision is resolved only by the manager actor, once every probe
// it sent has been answered or the decision has failed. commit is immutable
// once done closes.
type retirementDecision struct {
	done   chan struct{}
	commit bool
}

// workerProbe travels on the same FIFO as viewer messages, so it is answered
// only after everything the worker had already accepted. An idle voter parks
// until decision is resolved.
type workerProbe struct {
	answer   chan bool
	decision *retirementDecision
}

type retirementResult struct {
	accepted bool
	err      error
}

// TryRetire asks every worker whether it holds the session and, if none does,
// commits: from its true answer on, the manager admits no work. The decision
// runs to its end whatever the caller does — the session child's supervisor
// learns it from the answer or, gone, from the child's exit — and its waits
// are bounded by the workers' progress, never by a clock. An error (the
// manager or a worker stopping meanwhile) commits nothing.
func (m *Manager) TryRetire() (bool, error) {
	result := make(chan retirementResult, 1)
	select {
	case m.ops <- managerOp{kind: mgrTryRetire, retireResult: result}:
	case <-m.ctx.Done():
		return false, m.ctx.Err()
	}
	// The actor answers every retirement op, whether it decides it or finds
	// the manager retired or shutting down.
	r := <-result
	return r.accepted, r.err
}

// probeWorkers runs on the manager actor, so no Manager-routed admission is
// processed for the whole decision, and the commit and the closing of
// admission (the caller's retired flag) are one step of that actor. It asks
// each worker in turn, behind everything already in its inbox.
//
// Each idle voter parks until the decision is resolved, because a worker can
// start work the manager never routes: its own timer promoting a scheduled
// send as it falls due, or a message sent straight to it by a holder of its
// pointer. Left running while later workers are asked, a voter could start a
// turn after voting idle, and the commit would then kill that turn. Parked, it
// runs nothing until the decision: on a refusal it resumes, on a commit it
// stays parked until it is stopped, and whatever was due waits in its
// document for the next session.
func (m *Manager) probeWorkers(workers map[string]*ConversationWorker) (held bool, err error) {
	decision := &retirementDecision{done: make(chan struct{})}
	defer func() {
		decision.commit = !held && err == nil
		close(decision.done)
	}()
	ids := make([]string, 0, len(workers))
	for id := range workers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := &workerProbe{answer: make(chan bool, 1), decision: decision}
		workers[id].inbox.push(workerMessage{Probe: p})
		select {
		case held := <-p.answer:
			if held {
				return true, nil
			}
		case <-m.ctx.Done():
			return false, m.ctx.Err()
		case <-workers[id].stopped:
			return false, errWorkerStopped
		}
	}
	return false, m.ctx.Err()
}

// handleProbe runs at the FIFO actor boundary, not inside a wire handler. It
// settles preceding document notifications and reducer work before voting. A
// capped drain or an internal producer with pending work refuses conservatively.
// It reports whether the actor goes on running.
func (r *run) handleProbe(ctx context.Context, p *workerProbe) bool {
	select {
	case <-r.docChangeChan:
		r.handleItemsChange()
	default:
	}
	r.drainReconcile()
	r.rearmHeldTimer()
	// Only promotable sends hold the session; future notBefore entries remain
	// queued without holding a turn.
	schedule := r.heldSchedule(restDrain(r.clock.Now()))
	held := r.sessionHeld() || r.sched.reconcilePending() || len(r.docChangeChan) > 0 ||
		len(schedule.idleDue) > 0 || len(schedule.busyDue) > 0 || r.pumps.any()
	p.answer <- held
	if held {
		return true
	}
	select {
	case <-p.decision.done:
		if !p.decision.commit {
			return true
		}
	case <-ctx.Done():
		return false
	case <-r.done:
		return false
	}
	// No select on inbox, timers, doc changes after commitment. Only the
	// worker's own shutdown can release a committed actor.
	select {
	case <-ctx.Done():
	case <-r.done:
	}
	return false
}

// rejectRetired answers every synchronous op without admitting or mutating work.
// The manager actor stays available to join Shutdown and answer health callers.
func rejectRetired(op managerOp) {
	if op.workerResult != nil {
		op.workerResult <- nil
	}
	if op.boolResult != nil {
		op.boolResult <- false
	}
	if op.intResult != nil {
		op.intResult <- 0
	}
	if op.idsResult != nil {
		op.idsResult <- []string{}
	}
	if op.seedResult != nil {
		op.seedResult <- seedStarted{err: ErrRetired}
	}
	if op.done != nil {
		op.done <- struct{}{}
	}
	// Only a retirement carries a retireResult, and a repeated one finds the
	// commit already made.
	if op.retireResult != nil {
		op.retireResult <- retirementResult{accepted: true}
	}
}
