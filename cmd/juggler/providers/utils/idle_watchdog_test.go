//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"context"
	"testing"
	"time"

	"juggler/internal/machineload/machineloadtest"
)

// firedCancel returns a CancelFunc that closes done when called, so a test can
// await the watchdog firing deterministically instead of sleeping.
func firedCancel() (context.CancelFunc, <-chan struct{}) {
	done := make(chan struct{})
	var once bool
	return func() {
		if !once {
			once = true
			close(done)
		}
	}, done
}

func TestIdleWatchdog_FiresAfterIdle(t *testing.T) {
	cancel, done := firedCancel()
	w := NewIdleWatchdog(20*time.Millisecond, cancel)
	defer w.Stop()

	select {
	case <-done:
		// Cancel ran — await the observable signal, no fixed sleep.
	case <-time.After(2 * time.Second):
		t.Fatal("watchdog did not fire within the safety bound")
	}
	if !w.Fired() {
		t.Fatal("Fired() should report true after the idle window elapsed")
	}
}

const (
	// windowUnderResets is the idle window TestIdleWatchdog_ResetPreventsFire
	// asks the watchdog to honour, and resetInterval is how often it resets
	// inside that window — ten resets per window.
	windowUnderResets = 500 * time.Millisecond
	resetInterval     = 50 * time.Millisecond
)

func TestIdleWatchdog_ResetPreventsFire(t *testing.T) {
	cancel, done := firedCancel()
	w := NewIdleWatchdog(windowUnderResets, cancel)
	defer w.Stop()

	// The window under test is compressed hundreds of times below the production
	// one and the scheduler is not compressed with it, so a run whose own resets
	// were starved for longer than the window it is asking the watchdog to
	// honour produced that silence itself, and cannot tell a watchdog that
	// ignored a reset from one that was never given the chance to see it. Time
	// the resets and report the starvation instead of a verdict. (The engine
	// liveness tests measure their own beats the same way.)
	lastReset := time.Now()
	var longestGap time.Duration
	// gap is the longest a reset has been outstanding, including the one still
	// open: a run starved right now has not recorded that gap between two
	// resets yet.
	gap := func() time.Duration {
		if open := time.Since(lastReset); open > longestGap {
			return open
		}
		return longestGap
	}
	blameTheFire := func() {
		t.Helper()
		if g := gap(); g >= windowUnderResets {
			machineloadtest.Skip(t, "this test went %v without getting a reset in — longer than the %v "+
				"window it is asking the watchdog to honour — so the fire is unattributable",
				g.Round(time.Millisecond), windowUnderResets)
		}
		t.Fatalf("watchdog fired despite being reset within the idle window "+
			"(longest gap between resets %v, well inside the %v window)",
			gap().Round(time.Millisecond), windowUnderResets)
	}

	ticker := time.NewTicker(resetInterval)
	defer ticker.Stop()
	for i := 0; i < 10; i++ {
		select {
		case <-done:
			blameTheFire()
		case <-ticker.C:
			w.Reset()
			if elapsed := time.Since(lastReset); elapsed > longestGap {
				longestGap = elapsed
			}
			lastReset = time.Now()
		}
	}
	if w.Fired() {
		blameTheFire()
	}
}

func TestIdleWatchdog_StopPreventsFire(t *testing.T) {
	cancel, done := firedCancel()
	w := NewIdleWatchdog(20*time.Millisecond, cancel)
	w.Stop()

	select {
	case <-done:
		t.Fatal("watchdog fired after Stop()")
	case <-time.After(80 * time.Millisecond):
		// Stopped before the window elapsed — cancel must never run.
	}
	if w.Fired() {
		t.Fatal("Fired() should be false after Stop() before the window elapsed")
	}
}

func TestIdleWatchdog_StopIsIdempotent(t *testing.T) {
	cancel, _ := firedCancel()
	w := NewIdleWatchdog(time.Second, cancel)
	w.Stop()
	w.Stop() // must not panic on a double close
}

func TestIdleWatchdog_ResetAfterFireIsSafe(t *testing.T) {
	cancel, done := firedCancel()
	w := NewIdleWatchdog(20*time.Millisecond, cancel)
	defer w.Stop()
	<-done    // let it fire
	w.Reset() // must not block or panic
	if !w.Fired() {
		t.Fatal("Fired() should remain true after firing")
	}
}

func TestEffectiveStreamIdleTimeout_FallsBackToDefault(t *testing.T) {
	// No resolver registered (the default state) ⇒ the package default applies.
	SetStreamIdleTimeoutResolver(nil)
	if got := EffectiveStreamIdleTimeout(); got != StreamIdleTimeout {
		t.Fatalf("with no resolver, got %v, want default %v", got, StreamIdleTimeout)
	}

	// A resolver returning a non-positive value is ignored — the default wins,
	// so a blank/invalid user setting can never shrink the window to zero.
	SetStreamIdleTimeoutResolver(func() time.Duration { return 0 })
	t.Cleanup(func() { SetStreamIdleTimeoutResolver(nil) })
	if got := EffectiveStreamIdleTimeout(); got != StreamIdleTimeout {
		t.Fatalf("with a zero resolver, got %v, want default %v", got, StreamIdleTimeout)
	}
}

func TestEffectiveStreamIdleTimeout_ResolverOverrides(t *testing.T) {
	SetStreamIdleTimeoutResolver(func() time.Duration { return 600 * time.Second })
	t.Cleanup(func() { SetStreamIdleTimeoutResolver(nil) })
	if got := EffectiveStreamIdleTimeout(); got != 600*time.Second {
		t.Fatalf("got %v, want the resolver's 600s override", got)
	}
}
