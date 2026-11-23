//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "time"

// livenessClock measures wall-clock time this process spent frozen. There is no
// OS event for "the wall clock jumped while we weren't running", so the only way
// to notice a suspended process is to observe that an expected tick arrived
// late: a sampler goroutine wakes ~every livenessInterval, and a wake that lands
// far later than that measures the freeze.
//
// The sampler is its own goroutine, not a case of run()'s select, so that a run
// loop busy for a long time — a save on a slow disk, a long reconcile — is not
// mistaken for a suspended process: only the whole process stopping delays it.
//
// It also gives run() a plain tick for its periodic recovery work (ticks).
//
// It measures and decides nothing else. What the freeze is excluded from (the
// spinner's elapsed digit) is detectFrozenGap's business. Every field is read
// and written only by the methods in this file (TestWorkerSeamsOwnTheirState).
// start, stop and takeFreezes are run goroutine only; sample is the sampler's.
type livenessClock struct {
	// ticker fires ~every livenessInterval while run() executes. Created by
	// start, stopped by stop; nil in workers that never run (unit tests).
	ticker *time.Ticker
	// samplerQuit stops the sampler and samplerDone closes once it has
	// returned; both nil before start.
	samplerQuit, samplerDone chan struct{}

	// prevTickMs is the wall-clock millis of the previous sample (0 before the
	// first). The sampler's alone.
	prevTickMs int64
	// freezes carries each measured freeze from the sampler to takeFreezes.
	// Buffered far past the freezes the run loop could leave untaken; a freeze
	// sent to a full buffer is dropped, which costs the digit that freeze's
	// correction and nothing else.
	freezes chan freezeSpan
}

// freezeBacklog is how many measured freezes wait for the run loop to take them.
const freezeBacklog = 16

// freezeSpan is one measured freeze: endMs is the wall-clock millis at which
// the process resumed, and ms how long it had been frozen before that.
type freezeSpan struct {
	endMs, ms int64
}

// newLivenessClock returns a clock ready to start.
func newLivenessClock() livenessClock {
	return livenessClock{freezes: make(chan freezeSpan, freezeBacklog)}
}

// start begins ticking and sampling. Called once, as run() begins.
func (c *livenessClock) start() {
	c.ticker = time.NewTicker(livenessInterval)
	c.samplerQuit, c.samplerDone = make(chan struct{}), make(chan struct{})
	go c.runSampler(c.samplerQuit, c.samplerDone)
}

// runSampler samples the wall clock every livenessInterval until quit closes.
func (c *livenessClock) runSampler(quit <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(livenessInterval)
	defer ticker.Stop()
	for {
		select {
		case <-quit:
			return
		case <-ticker.C:
			c.sample(time.Now().UnixMilli())
		}
	}
}

// stop stops the ticker and the sampler, returning once the sampler has. Safe
// on a clock that never started.
func (c *livenessClock) stop() {
	if c.ticker != nil {
		c.ticker.Stop()
	}
	if c.samplerQuit != nil {
		close(c.samplerQuit)
		<-c.samplerDone
		c.samplerQuit = nil
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

// sample records a sample taken at nowMs, and passes on a freeze ending at
// nowMs when one was measured (frozenFor).
func (c *livenessClock) sample(nowMs int64) {
	ms := c.frozenFor(nowMs)
	if ms == 0 {
		return
	}
	select {
	case c.freezes <- freezeSpan{endMs: nowMs, ms: ms}:
	default:
	}
}

// takeFreezes returns the freezes measured since the last call, oldest first.
func (c *livenessClock) takeFreezes() []freezeSpan {
	var out []freezeSpan
	for {
		select {
		case f := <-c.freezes:
			out = append(out, f)
		default:
			return out
		}
	}
}

// frozenFor records a sample at nowMs and returns how long the process was
// frozen since the previous one: the time past livenessInterval, when that
// excess reaches frozenGapThresholdMs. It returns 0 for the first sample
// (nothing to compare against), for normal cadence and for a backward clock
// step.
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
