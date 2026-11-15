//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Y-CRDT outbound update debouncer: coalesces a burst of small Yjs updates
// (e.g. one per character of a streamed message) into one merged broadcast
// per SyncThrottleMs window.

package worker

import "time"

// syncBatcher owns the pending update batch and the throttle timer on its own
// goroutine, so any goroutine may Schedule or Flush it. It is an actor rather
// than a plain struct because a turn no longer runs on the worker's run() loop:
// the turn writes the document and flushes at its own boundaries while the run()
// loop is still pumping messages and flushing at its, and two goroutines sharing
// a *time.Timer and a slice is a data race. Serializing through one goroutine
// keeps the batch coherent without a mutex, which the package forbids.
//
// The timer fires inside the actor, so callers no longer select on it — this is
// why there is no TimerChan: a wait loop that wanted the batch flushed on time
// had to service that timer itself, and none of them own it any more.
type syncBatcher struct {
	commands chan batchCommand
	// retired is closed when the actor has returned, so a caller that arrives
	// after the last flush is turned away instead of parking forever on the
	// unbuffered command channel. A turn on its own goroutine can still be
	// unwinding — flushing at its own boundaries — when shutdown retires the
	// batcher, and there is nothing left to broadcast to by then anyway.
	retired  chan struct{}
	doc      *ConversationDocument // for drain + broadcast resolution at flush time
	throttle time.Duration
}

type batchCommandKind int

const (
	batchSchedule batchCommandKind = iota
	batchFlush
	batchStop
)

// batchCommand is one instruction to the batcher actor. ack is non-nil for the
// commands a caller waits on (flush, stop) and is closed once the work is done,
// so Flush keeps its synchronous "the batch is out" contract.
type batchCommand struct {
	kind batchCommandKind
	ack  chan struct{}
}

func newSyncBatcher(doc *ConversationDocument, throttle time.Duration) *syncBatcher {
	b := &syncBatcher{
		commands: make(chan batchCommand),
		retired:  make(chan struct{}),
		doc:      doc,
		throttle: throttle,
	}
	go b.run()
	return b
}

// run is the batcher's actor loop. It owns pending and timer outright; nothing
// else in the package may touch them.
//
// It deliberately does NOT stop on the worker's done channel. onShutdown flushes
// the last batch after done is already closed — that final broadcast is the only
// one a mid-turn conversation gets — so the actor lives until it is told to stop.
func (b *syncBatcher) run() {
	defer close(b.retired)
	var pending []pendingUpdate
	var timer *time.Timer
	var timerC <-chan time.Time

	stopTimer := func() {
		if timer != nil {
			timer.Stop()
			timer, timerC = nil, nil
		}
	}

	// flush drains any updates still buffered in the doc, merges the pending
	// batch, and broadcasts it — one combined update per run of deltas with the
	// same audience, in order (takeBatchForBroadcast). The drain, the merge and
	// the sink lookup happen under one hold inside the document; the broadcasts
	// themselves run out here, off the lock.
	flush := func() {
		stopTimer()
		remaining, runs, sink := b.doc.takeBatchForBroadcast(pending)
		pending = remaining
		if sink != nil {
			for _, run := range runs {
				sink(run.update, run.except)
			}
		}
	}

	for {
		select {
		case cmd := <-b.commands:
			switch cmd.kind {
			case batchSchedule:
				if timer == nil {
					timer = time.NewTimer(b.throttle)
					timerC = timer.C
				}
			case batchFlush:
				flush()
				close(cmd.ack)
			case batchStop:
				flush()
				close(cmd.ack)
				return
			}
		case <-timerC:
			timer, timerC = nil, nil
			flush()
		}
	}
}

// Schedule arms the flush timer if it isn't already running, so any updates the
// doc has buffered are broadcast within one throttle window. It deliberately
// does NOT drain the doc: draining takes the global ycrdtMu, so doing it here
// (once per update signal, per worker) would pile contention onto that shared
// lock. Flush drains instead — once per broadcast window.
//
// Asynchronous: arming a timer has nothing to report back. A no-op once the
// actor has retired — a window with nothing left to broadcast in it.
func (b *syncBatcher) Schedule() {
	select {
	case b.commands <- batchCommand{kind: batchSchedule}:
	case <-b.retired:
	}
}

// Flush broadcasts the pending batch and returns once it is out. Safe to call
// when nothing is pending, safe from any goroutine, and a no-op once the actor
// has retired — a turn unwinding past shutdown flushes into a conversation with
// no clients left rather than parking on a channel nobody reads.
//
// It cannot be called while holding ycrdtMu: the actor takes that lock to drain
// the doc. That was already true when Flush ran inline — the same call would
// have self-deadlocked on a non-reentrant lock — so no existing caller does.
func (b *syncBatcher) Flush() {
	ack := make(chan struct{})
	select {
	case b.commands <- batchCommand{kind: batchFlush, ack: ack}:
	case <-b.retired:
		return
	}
	select {
	case <-ack:
	case <-b.retired:
	}
}

// stop flushes one last time and retires the actor. Called once, from
// onShutdown, after every other flush has had its chance.
func (b *syncBatcher) stop() {
	ack := make(chan struct{})
	select {
	case b.commands <- batchCommand{kind: batchStop, ack: ack}:
	case <-b.retired:
		return
	}
	select {
	case <-ack:
	case <-b.retired:
	}
}
