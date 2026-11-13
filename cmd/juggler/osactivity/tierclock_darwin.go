//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package osactivity

// #include <stdint.h>
// extern int juggler_tier_clock_start(void);
// extern int64_t juggler_tier_clock_served(void);
import "C"

import "time"

// BackgroundTierClock starts, once per process, a clock of how much macOS is
// running the background scheduling tier, and returns its reader: the time the
// tier has been run in all, which advances with wall time while the tier is run
// and stands still while it is not (tierclock_darwin.c). It is the tier WebKit
// runs a hidden page's web process at, so it measures whether a hidden page has
// been given the chance to run. Nil when the clock could not be started.
func BackgroundTierClock() func() time.Duration {
	if C.juggler_tier_clock_start() == 0 {
		return nil
	}
	return func() time.Duration { return time.Duration(C.juggler_tier_clock_served()) }
}
