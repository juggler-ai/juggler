//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"time"

	"juggler/internal/jlog"
)

// A turn opens by asking the engine for its context and its tool list, and
// waits for both while the engine stays attached (ContextTimeout). Three stages
// can spend that wait and they
// call for three different fixes: the request queueing behind other traffic on
// the way out, the engine's own work (its fetches share a six-connection
// browser pool with every tool call), and the reply's trip back. The worker
// times the whole thing and can separate them only because the engine stamps
// the reply — see beginRoundTrip in worker-manager-protocols.js. Both realms
// run on one machine and one wall clock, so the marks subtract directly.
//
// This matters most for the round-trip that never finishes in time: the reply
// usually does arrive, just too late to be wanted, and it carries the only
// account of where the time went.

// slowRoundTripMS is the elapsed time at which a completed round-trip is worth
// a line in the log. Well clear of a healthy turn's few milliseconds, so the
// log shows a slow engine's approach as well as its arrival.
const slowRoundTripMS = int64(5 * time.Second / time.Millisecond)

// roundTripIsSlow reports whether an elapsed round-trip earns a log line.
func roundTripIsSlow(elapsedMS int64) bool {
	return elapsedMS >= slowRoundTripMS
}

// roundTripStamps are the marks a client reply carries: when the worker sent
// the request, when the engine picked it up, and when the engine answered.
type roundTripStamps struct {
	SentAt     int64 `json:"sentAt"`
	ReceivedAt int64 `json:"receivedAt"`
	RepliedAt  int64 `json:"repliedAt"`
}

// describeRoundTrip splits a reply's elapsed time into the three stages that
// can each consume it. Reports false when the reply carries no usable stamps —
// an unstamped slot (strategy hooks, subthread specs), or marks that do not run
// forwards. Half a measurement would read like a finding and point at a stage
// that never happened, so none is offered instead.
func describeRoundTrip(payload json.RawMessage, nowMS int64) (string, bool) {
	var stamps roundTripStamps
	if json.Unmarshal(payload, &stamps) != nil {
		return "", false
	}
	if stamps.SentAt <= 0 || stamps.ReceivedAt < stamps.SentAt || stamps.RepliedAt < stamps.ReceivedAt {
		return "", false
	}

	toEngine := stamps.ReceivedAt - stamps.SentAt
	inEngine := stamps.RepliedAt - stamps.ReceivedAt
	back := nowMS - stamps.RepliedAt
	if back < 0 {
		back = 0
	}

	return fmt.Sprintf("%dms total: %dms reaching the engine, %dms in the engine, %dms coming back",
		toEngine+inEngine+back, toEngine, inEngine, back), true
}

// reportRoundTrip logs a completed context/tools round-trip that took long
// enough to be worth knowing about. Silent on a healthy turn, so the only lines
// in the log are the ones approaching the timeout that ends a turn.
func reportRoundTrip(name string, payload json.RawMessage) {
	now := time.Now().UnixMilli()
	desc, ok := describeRoundTrip(payload, now)
	if !ok {
		return
	}
	var stamps roundTripStamps
	if json.Unmarshal(payload, &stamps) != nil || !roundTripIsSlow(now-stamps.SentAt) {
		return
	}
	jlog.Info("[roundtrip] %s was slow — %s", name, desc)
}

// reportDroppedReply logs a reply that arrived for a request no longer waiting
// for it: the turn that asked has ended — its engine went away, it reached
// ContextCeiling, or it was cancelled — so nothing can use the answer. Its stamps are the only account of
// where that budget went, so they are worth a line anyway. Read the elapsed
// time before concluding anything: near the timeout is the round-trip that lost
// the turn; a fast one means the request was abandoned, or answered twice.
func reportDroppedReply(name string, payload json.RawMessage) {
	if desc, ok := describeRoundTrip(payload, time.Now().UnixMilli()); ok {
		jlog.Info("[roundtrip] %s answered a request nothing was waiting for — %s", name, desc)
	}
}
