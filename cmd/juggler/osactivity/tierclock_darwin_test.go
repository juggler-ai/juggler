//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package osactivity

import (
	"testing"
	"time"
)

// tierLateAfter mirrors TIER_LATE_AFTER_NS: the most one stretch can count, and
// so the most a reading can run ahead of the wall time between two reads.
const tierLateAfter = 750 * time.Millisecond

// The server counts the engine's silence in this clock (engine_liveness.go). A
// clock that never starts, or never advances, silently stops every wedged
// engine from being evicted; one that runs ahead of the wall clock makes a
// starved engine look silent. The wait is bounded by the test binary's
// deadline, not by a span of its own: a saturated machine may leave the tier
// unrun for seconds, and that is what the clock exists to measure.
func TestBackgroundTierClock(t *testing.T) {
	served := BackgroundTierClock()
	if served == nil {
		t.Fatal("the background-tier clock did not start at the background tier")
	}
	if again := BackgroundTierClock(); again == nil {
		t.Fatal("a second caller was refused the clock")
	}

	start, from := time.Now(), served()
	deadline, ok := t.Deadline()
	if !ok {
		deadline = start.Add(10 * time.Minute)
	}
	for served()-from < 2*tierLateAfter {
		if time.Until(deadline) < 5*time.Second {
			t.Fatalf("the clock advanced %v in %v and the test binary is out of time: "+
				"either the tier was never run in all that time, or the clock is not counting",
				served()-from, time.Since(start).Round(time.Millisecond))
		}
		time.Sleep(50 * time.Millisecond)
	}

	if got, wall := served()-from, time.Since(start); got > wall+tierLateAfter {
		t.Fatalf("the clock counted %v in %v of wall time: it may count at most the wall time, "+
			"plus the one stretch that began before it was first read", got, wall)
	}
}
