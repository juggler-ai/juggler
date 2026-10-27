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

// describeSlowIteration reports a run() iteration that took long enough to log,
// naming the event it handled and splitting its time between that event and the
// reducer drain after it. ok is false for an iteration under the threshold.
func describeSlowIteration(event string, handled, reconcile time.Duration, passes int) (string, bool) {
	total := handled + reconcile
	if total < slowLoopIteration {
		return "", false
	}
	return fmt.Sprintf("%s took %dms: %dms handling it, %dms in %d reconcile pass(es)",
		event, total.Milliseconds(), handled.Milliseconds(), reconcile.Milliseconds(), passes), true
}

// reportSlowIteration logs one run() iteration if it was slow.
func (r *run) reportSlowIteration(event string, handled, reconcile time.Duration, passes int) {
	if desc, ok := describeSlowIteration(event, handled, reconcile, passes); ok {
		r.log.Info("[loop] %s", desc)
	}
}
