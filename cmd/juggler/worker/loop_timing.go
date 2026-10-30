//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"time"
)

// The run() loop is the only consumer of a conversation's inbox, and every
// reply a turn waits on — context, tools, approvals — reaches the turn only
// when the loop dispatches it. A loop that spends long on each event therefore
// shows up far from its cause: as a [roundtrip] reply that took most of its
// time "coming back" while the engine answered in milliseconds. Each slow
// iteration is logged with what it was handling and how its time divided
// between the event and the reducer pass that follows every event, so the
// backlog behind such a timeout can be attributed rather than inferred.

// slowLoopIteration is the duration at which one run() iteration earns a log
// line: far above a healthy iteration's microseconds-to-milliseconds, and low
// enough that a backlog is visible long before it costs a turn.
const slowLoopIteration = 250 * time.Millisecond

// slowIteration is one run() iteration's timing.
type slowIteration struct {
	// event names what the iteration handled.
	event string
	// handled is the time spent on the event, reconcile the time in the
	// reducer drain after it, over passes passes.
	handled, reconcile time.Duration
	passes             int
	// waited is how long the handled message sat in the inbox before the loop
	// took it; zero for an event that does not come through the inbox.
	waited time.Duration
	// depth is how many messages were still queued when the iteration ended.
	depth int
}

// describeSlowIteration reports a run() iteration that took long enough to log,
// naming the event it handled and splitting its time between that event and the
// reducer drain after it, with how long the message had already waited in the
// inbox and how many are still queued behind it. ok is false for an iteration
// under the threshold.
func describeSlowIteration(it slowIteration) (string, bool) {
	total := it.handled + it.reconcile
	if total < slowLoopIteration {
		return "", false
	}
	desc := fmt.Sprintf("%s took %dms: %dms handling it, %dms in %d reconcile pass(es)",
		it.event, total.Milliseconds(), it.handled.Milliseconds(), it.reconcile.Milliseconds(), it.passes)
	if it.waited > 0 {
		desc += fmt.Sprintf("; it waited %dms in the inbox", it.waited.Milliseconds())
	}
	return desc + fmt.Sprintf("; %d queued", it.depth), true
}

// reportSlowIteration logs one run() iteration if it was slow.
func (r *run) reportSlowIteration(it slowIteration) {
	if desc, ok := describeSlowIteration(it); ok {
		r.log.Info("[loop] %s", desc)
	}
}
