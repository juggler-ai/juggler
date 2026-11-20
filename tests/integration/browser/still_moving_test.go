//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

import (
	"testing"
	"time"
)

// A test still waiting for a lane has no progress of its own to report, so the
// harness reads its server's lanes instead: a lane still booting or polling is
// a pool being served slowly, and the wait goes on; lanes silent for the whole
// window are a pool that has stopped. Once a lane has taken the test, only that
// test's own progress counts. Seen 11-20 under `test-all`: two queued suites
// were given up on after 120s while two lanes of their server, starved by a
// sibling's 137s suite in the content process they share, sent a boot ping
// every few seconds.
func TestStillMovingFollowsTheLanesUntilOneTakesTheTest(t *testing.T) {
	const window = 120 * time.Second
	type lane = struct {
		Lane       string   `json:"lane"`
		PageServed laneMark `json:"pageServed"`
		Booting    laneMark `json:"booting"`
		Polled     laneMark `json:"polled"`
		Refused    int      `json:"refused"`
	}
	silent := laneMark{Count: 3, AgoMs: 121_000}
	recent := laneMark{Count: 13, AgoMs: 7_600}
	never := laneMark{AgoMs: -1}
	trace := func(ls ...lane) laneTrace { return laneTrace{Lanes: ls} }
	queued := testAudit{Queued: 1, Dispatched: 0, ProgressAgeMs: -1}
	taken := testAudit{Queued: 1, Dispatched: 1, ProgressAgeMs: 130_000}

	for _, c := range []struct {
		name  string
		audit testAudit
		lanes laneTrace
		want  bool
	}{
		{"queued, a lane still booting", queued, trace(lane{Booting: recent, Polled: silent}, lane{Booting: silent, Polled: silent}), true},
		{"queued, a lane still polling", queued, trace(lane{Booting: never, Polled: recent}), true},
		{"queued, every lane silent", queued, trace(lane{Booting: silent, Polled: silent}), false},
		{"queued, no lane trace", queued, laneTrace{}, false},
		{"taken, its lane silent though siblings boot", taken, trace(lane{Booting: recent, Polled: recent}), false},
		{"taken, its lane reporting", testAudit{Dispatched: 1, ProgressAgeMs: 3_000}, laneTrace{}, true},
	} {
		if got := stillMoving(c.audit, c.lanes, window); got != c.want {
			t.Errorf("%s: stillMoving = %v, want %v", c.name, got, c.want)
		}
	}
}
