//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "time"

// livenessClock measures wall-clock time this process spent frozen. There is no
// OS event for "the wall clock jumped while we weren't running", so the only way
// to notice a suspended process is to observe that an expected tick arrived
// late: the clock ticks ~every livenessInterval while run() executes, and a tick
// that lands far later than that measures the freeze.
//
// It measures and decides nothing else. What the freeze is excluded from (the
// spinner's elapsed digit) is detectFrozenGap's business. Every field is read
// and written only by the methods in this file (TestWorkerSeamsOwnTheirState).
// Run goroutine only.
type livenessClock struct {
	// ticker fires ~every livenessInterval while run() executes. Created by
	// start, stopped by stop; nil in workers that never run (unit tests).
	ticker *time.Ticker
	// prevTickMs is the wall-clock millis of the previous tick (0 before the
	// first).
	prevTickMs int64
}

// start begins ticking. Called once, as run() begins.
func (c *livenessClock) start() { c.ticker = time.NewTicker(livenessInterval) }

// stop stops the ticker. Safe on a clock that never started.
func (c *livenessClock) stop() {
	if c.ticker != nil {
		c.ticker.Stop()
	}
}

// ticks returns the ticker's channel, or nil when there is no ticker (a worker
// that never entered run(), e.g. a unit test driving callLLM directly). A nil
// channel never fires, so the run loop's select case degrades to a no-op.
func (c *livenessClock) ticks() <-chan time.Time {
	if c.ticker == nil {
		return nil
	}
	return c.ticker.C
}

// frozenFor records a tick at nowMs and returns how long the process was frozen
// since the previous one: the time past livenessInterval, when that excess
// reaches frozenGapThresholdMs. It returns 0 for the first tick (nothing to
// compare against), for normal cadence and for a backward clock step.
func (c *livenessClock) frozenFor(nowMs int64) int64 {
	last := c.prevTickMs
	c.prevTickMs = nowMs
	if last == 0 {
		return 0
	}
	excess := nowMs - last - livenessInterval.Milliseconds()
	if excess < frozenGapThresholdMs {
		return 0
	}
	return excess
}
