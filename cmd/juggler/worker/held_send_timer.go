//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"sync/atomic"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// The held-send timer: how a send scheduled for later is answered when its time
// comes, with or without a client attached.
//
// A busy thread needs nothing from it — the run's own drains promote a send as
// soon as its hold lifts (pending_hold.go). The timer is for the thread with no
// run to drain it: when it fires, every idle thread holding a send that a rest
// drain would now promote has it fired as the user's own send, made at that
// moment (fireHeldSend), and the reducer pass that follows every run-loop event
// dispatches it.
//
// The timer is armed for the earliest time any queue is waiting for. Finding
// that walks every thread's queue, so it is cached and recomputed only once
// something has marked it stale (markHeldStale): a held send queued, a queue
// promoted or cleared, a viewer's edit, an undo or redo. A stale cache errs
// early, never late — an entry removed by a path that did not mark it leaves the
// timer armed for a moment nothing is due at, and that firing finds nothing to
// do and recomputes.

// workerClock is the worker's time source: what a drain reads as now, and how
// the held-send timer is armed. A test installs its own before the worker runs.
type workerClock struct {
	now func() time.Time
	// newTimer arms a one-shot timer for d and returns the channel it fires on
	// and a stop function with time.Timer.Stop's meaning.
	newTimer func(d time.Duration) (<-chan time.Time, func() bool)
}

func realClock() workerClock {
	return workerClock{
		now: time.Now,
		newTimer: func(d time.Duration) (<-chan time.Time, func() bool) {
			t := time.NewTimer(d)
			return t.C, t.Stop
		},
	}
}

// Now is the clock's time; the wall clock for a worker built without one.
func (c workerClock) Now() time.Time {
	if c.now == nil {
		return time.Now()
	}
	return c.now()
}

// heldSendTimer is the run loop's single timer for held sends. Only stale is
// touched off the actor: a turn promotes on its own goroutine.
type heldSendTimer struct {
	stale atomic.Bool

	// Actor only.
	c    <-chan time.Time // nil while unarmed, so the run loop's case never fires
	stop func() bool
	at   time.Time
}

// fired is the run loop's case for the timer.
func (h *heldSendTimer) fired() <-chan time.Time { return h.c }

// disarm stops the timer, if one is armed. Actor only.
func (h *heldSendTimer) disarm() {
	if h.stop != nil {
		h.stop()
	}
	h.c, h.stop, h.at = nil, nil, time.Time{}
}

// markHeldStale asks the run loop to recompute when the held-send timer is due.
// Any goroutine.
func (w *ConversationWorker) markHeldStale() { w.heldTimer.stale.Store(true) }

// fireHeldSends is the timer's run-loop case: on every idle thread, what a rest
// drain now lets out fires (fireHeldSend), and the reducer pass after the event
// dispatches it.
//
// A busy thread is left to its run, whose next drain takes the send in — but
// busy is not always working, and a send now due there gets what a typed send
// into a busy thread gets: a run in a retry backoff is told a message waits, a
// usage cap over the thread is lifted, and a reducer pass is asked for. The
// pass is asked for even when no cap stands any longer: a thread parked on a
// child that rested on a cap is re-offered only by a pass, and a cap that
// expired on its own (as one a send was scheduled to outlast has) asks for
// none. Actor only.
func (r *run) fireHeldSends() {
	r.heldTimer.disarm()
	r.markHeldStale()
	pc := restDrain(r.clock.Now())
	s := r.heldSchedule(pc)
	for _, threadItemID := range s.idleDue {
		r.fireHeldSend(threadItemID, pc)
	}
	for _, threadItemID := range s.busyDue {
		r.offerDueSendToBusyThread(threadItemID)
	}
}

// offerDueSendToBusyThread is what a send now due in a busy thread's queue gets
// (see fireHeldSends): the retry backoff is told, the cap over the thread lifted,
// and a reducer pass asked for. Actor only.
func (r *run) offerDueSendToBusyThread(threadItemID string) {
	r.sched.nudgeRetryWait(threadItemID)
	r.liftRateLimitForSend(threadItemID)
	r.sched.markReconcile(reconcileHeldSend)
}

// fireHeldSend answers what pc lets out of an idle thread's queue as the
// user's send, made now: it lifts the pause over the thread and opens the turn
// the way a typed send does (openIdleSend), promotes, and queues the thread for dispatch, as a finishing
// run's last look does (requestLLMIfQueued). A thread a human has messaged may
// spawn (promoteThreadSpawnCapable), and a conversation not yet named is named
// from the first message this lands. Actor only.
//
// With no model to run on, the send still lands, unanswered, and the user is
// told why: left queued it would be due again at once, and fire forever. The
// warning carries no code — a client's no-model recovery resends the message
// it is holding, and a held send's was handed over long ago.
func (r *run) fireHeldSend(threadItemID string, pc promoteCtx) {
	r.dropPoliteStopsCovering(threadItemID)
	mc := r.openIdleSend(threadItemID)
	if mc == nil {
		if r.promotePendingItems(threadItemID, pc) > 0 {
			r.sendStatusText(string(statusValidationError), noModelWarning(false))
		}
		return
	}
	name := r.autoNameDue(threadItemID)
	if !r.requestLLMIfQueued(threadItemID, pc) {
		return
	}
	r.sched.markReconcile(reconcileHeldSend)
	r.promoteThreadSpawnCapable(threadItemID)
	if text := r.firstRootUserMessageText(); name && strings.TrimSpace(text) != "" {
		r.fireAutoName(text, mc.Provider, mc.Model, mc.Thinking, false)
	}
}

// rearmHeldTimer recomputes when the timer is due, if anything has marked it
// stale, and arms it: at once when an idle thread already holds a send a rest
// drain would promote, else for the earliest future time any queue waits for,
// else not at all. A timer already armed for that moment is left running.
// Actor only.
func (r *run) rearmHeldTimer() {
	if !r.heldTimer.stale.Swap(false) {
		return
	}
	now := r.clock.Now()
	s := r.heldSchedule(restDrain(now))
	r.publishHeld(s)
	var at time.Time
	switch {
	case len(s.idleDue) > 0:
		at = now
	case !s.next.IsZero():
		at = s.next
	default:
		r.heldTimer.disarm()
		return
	}
	if r.heldTimer.c != nil && r.heldTimer.at.Equal(at) {
		return
	}
	r.heldTimer.disarm()
	r.heldTimer.c, r.heldTimer.stop = r.clock.newTimer(at.Sub(now))
	r.heldTimer.at = at
}

// heldSchedule is one walk over every thread's queue.
type heldSchedule struct {
	// idleDue lists the idle threads holding something pc promotes.
	idleDue []string
	// busyDue lists the busy threads holding something their run's next drain
	// would promote at pc.now (a mid-run drain: a run-end hold waits on).
	busyDue []string
	// next is the earliest time-gate after pc.now any queue waits for, or zero.
	next time.Time
	// index is what the held-send index records of the queues; present is
	// false when they hold nothing.
	index   heldIndexEntry
	present bool
}

// heldSchedule walks every thread's pending queue (the root's and each thread
// container's) under one hold of ycrdtMu.
func (w *ConversationWorker) heldSchedule(pc promoteCtx) heldSchedule {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var s heldSchedule
	visit := func(threadItemID string, parent *ycrdt.YMap) {
		queue, ok := yMapArray(parent, keyPendingItems)
		if !ok || queue.GetLength() == 0 {
			return
		}
		g := queueGatesLocked(queue, pc.now)
		if g.hasNext && (s.next.IsZero() || g.next.Before(s.next)) {
			s.next = g.next
		}
		if g.earliest != 0 && (s.index.NotBefore == 0 || g.earliest < s.index.NotBefore) {
			s.index.NotBefore = g.earliest
		}
		s.index.Due = s.index.Due || g.untimed
		s.present = true
		switch {
		case !w.threadBusyLocked(threadItemID):
			if len(promotableIndicesLocked(queue, pc)) > 0 {
				s.idleDue = append(s.idleDue, threadItemID)
			}
		case len(promotableIndicesLocked(queue, midRunDrain(pc.now))) > 0:
			s.busyDue = append(s.busyDue, threadItemID)
		}
	}
	visit("", w.doc.root)
	if arr := w.doc.getItems(); arr != nil {
		walkThreadContainersLocked(arr, visit)
	}
	return s
}

// queueGates is what one queue's sends wait for.
type queueGates struct {
	// next is the earliest time-gate after now, when hasNext.
	next    time.Time
	hasNext bool
	// earliest is the earliest time-gate, passed or not (epoch ms), or zero.
	earliest int64
	// untimed is set when some send waits for no time: queued untimed, or
	// held only for the end of a run.
	untimed bool
}

// queueGatesLocked reads what the sends in queue wait for at now. Caller MUST
// hold ycrdtMu.
func queueGatesLocked(queue *ycrdt.YArray, now time.Time) queueGates {
	raw := queue.ToArray()
	entries := make([]pendingEntry, len(raw))
	for i, v := range raw {
		entries[i] = readPendingEntry(v)
	}
	var g queueGates
	for _, grp := range pendingGroups(entries) {
		h := groupHold(entries[grp[0]:grp[1]])
		if !h.hasNotBefore {
			g.untimed = true
			continue
		}
		if g.earliest == 0 || h.notBefore < g.earliest {
			g.earliest = h.notBefore
		}
		if h.notBefore > now.UnixMilli() && (!g.hasNext || h.notBefore < g.next.UnixMilli()) {
			g.next, g.hasNext = time.UnixMilli(h.notBefore), true
		}
	}
	return g
}

// publishHeld records s in the held-send index, when it differs from what this
// worker last recorded. A conversation being deleted records nothing: Remove
// has withdrawn its entry. Actor only.
func (r *run) publishHeld(s heldSchedule) {
	if r.heldIndex == nil || r.projectPath == "" || r.deleting.Load() {
		return
	}
	p := heldPublication{entry: s.index, present: s.present, valid: true}
	if p == r.heldPublished {
		return
	}
	r.heldPublished = p
	r.heldIndex.publish(r.projectPath, r.conversationID, p.entry, p.present)
}

// walkThreadContainersLocked calls visit for every item map in arr and, through
// each thread's nested items, below it, with the map's item id — the same walk
// collectPendingAssetIDsFromArray makes. Caller MUST hold ycrdtMu.
func walkThreadContainersLocked(arr *ycrdt.YArray, visit func(threadItemID string, m *ycrdt.YMap)) {
	length := int(arr.GetLength())
	for i := 0; i < length; i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		visit(yMapString(m, keyItemID), m)
		if nested, ok := yMapArray(m, keyItems); ok {
			walkThreadContainersLocked(nested, visit)
		}
	}
}
