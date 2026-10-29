//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Stall detector for the process-wide y-crdt lock.
//
// ycrdtMu is the single global lock in the server and every conversation
// worker's doc access goes through it, so one goroutine that stops releasing
// it takes down the whole app: every conversation freezes mid-turn and nothing
// persists, while the layers that never touch a doc (HTTP, session manager,
// auto-naming) keep answering — which makes the server look alive and hides
// the cause. The lock is not reentrant, so the cheapest way to reach that
// state is a path that takes it and then calls a helper that takes it again
// instead of the helper's ...Locked variant.
//
// That failure leaves no trace of its own: the process simply goes quiet.
// This watchdog exists to turn it into evidence. It samples how long the
// current acquisition has been held and, past ycrdtStallThreshold, logs one
// full goroutine dump. The blocked stacks name the offending path directly,
// and every other worker is visible parked on the same lock.
//
// Diagnosis only: it never releases the lock or intervenes. A false positive
// costs one noisy log entry, so the threshold is set well above any legitimate
// hold (doc mutations are microseconds; the longest are bulk compaction
// splices).

package worker

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"juggler/internal/jlog"
)

const (
	// ycrdtStallThreshold is how long one uninterrupted hold of ycrdtMu must
	// last before it is treated as a deadlock rather than slow work.
	ycrdtStallThreshold = 30 * time.Second
	// ycrdtStallCheckInterval is how often the watchdog samples the lock.
	ycrdtStallCheckInterval = 5 * time.Second
	// ycrdtStallDumpMax bounds the goroutine dump buffer. A wedged server has
	// a few hundred goroutines; this is far above that and stops a runaway
	// dump from being the thing that kills the process.
	ycrdtStallDumpMax = 16 << 20
)

// watchedMutex is a sync.Mutex that records when its current holder acquired
// it, so watchYcrdtStalls can spot a hold that never ends. Lock/Unlock keep
// the sync.Locker signature, so call sites are unchanged and the two atomic
// stores are all the added cost on the hot path.
type watchedMutex struct {
	mu sync.Mutex //nolint:forbidigo // Required for y-crdt library thread safety
	// heldSince is the acquiring time in Unix nanoseconds, or 0 when free.
	heldSince atomic.Int64
	// generation increments on every acquisition, so the watchdog can tell a
	// single stuck hold from a rapid series of short ones, and report a given
	// stall exactly once.
	generation atomic.Uint64
}

func (m *watchedMutex) Lock() {
	m.mu.Lock()
	m.generation.Add(1)
	m.heldSince.Store(time.Now().UnixNano())
}

func (m *watchedMutex) Unlock() {
	m.heldSince.Store(0)
	m.mu.Unlock()
}

// acquirableWithin reports whether the lock can be taken within grace. It takes
// and releases it at once, holding nothing on return. Polls rather than blocks,
// because the question is asked after a panic, when the holder may be the very
// goroutine that is asking, and then a blocking Lock never returns.
func (m *watchedMutex) acquirableWithin(grace time.Duration) bool {
	deadline := time.Now().Add(grace)
	for {
		if m.mu.TryLock() {
			m.mu.Unlock()
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(time.Millisecond)
	}
}

// sample reports the current hold's age and generation. ok is false when the
// lock is free, or when an acquisition happened mid-read and the pair might be
// torn — the next tick re-reads a consistent pair, and a genuine stall is
// still there to find.
func (m *watchedMutex) sample(now time.Time) (age time.Duration, generation uint64, ok bool) {
	before := m.generation.Load()
	since := m.heldSince.Load()
	after := m.generation.Load()
	if since == 0 || before != after {
		return 0, 0, false
	}
	return now.Sub(time.Unix(0, since)), after, true
}

// watchYcrdtStalls samples the lock on every tick, calling report at most once
// per stalled acquisition, until ticks is closed. Each tick carries the time the sample is taken at, so a tick
// delayed behind a busy scheduler measures the hold as it was when the sample
// fell due — which can only under-state a stall, never invent one. The tick
// channel and report are parameters so the detection rule can be driven from a
// test by hand, without a real clock or captured log output.
func watchYcrdtStalls(m *watchedMutex, ticks <-chan time.Time, threshold time.Duration, report func(age time.Duration)) {
	var reported uint64
	for now := range ticks {
		age, generation, ok := m.sample(now)
		if !ok || age < threshold {
			continue
		}
		if generation == reported {
			continue // this stall has already been reported
		}
		reported = generation
		report(age)
	}
}

// reportYcrdtStall is the production reporter: one error line naming the
// symptom, followed by every goroutine's stack.
func reportYcrdtStall(age time.Duration) {
	jlog.Error("[ycrdt watchdog] the process-wide y-crdt lock has been held for %s by a single acquisition — every conversation is blocked on it and nothing is persisting. This is a deadlock, most likely a path that took ycrdtMu and then called a helper that takes it again instead of the ...Locked variant. Full goroutine dump follows; the holder is the goroutine NOT parked in watchedMutex.Lock.\n%s",
		age.Round(time.Second), goroutineDump())
}

// goroutineDump returns the stacks of all goroutines, growing the buffer until
// the dump fits or ycrdtStallDumpMax is reached.
func goroutineDump() string {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) || len(buf) >= ycrdtStallDumpMax {
			return string(buf[:n])
		}
		buf = make([]byte, min(2*len(buf), ycrdtStallDumpMax))
	}
}

// ycrdtWatchdog is the running watchdog's bookkeeping. It runs while any worker
// does: each running worker holds it (holdYcrdtWatchdog), the first hold starts
// it and the last release stops it, so a process that never runs a worker — a
// CLI subcommand, another package's tests — carries no ticker and no goroutine
// for it.
var ycrdtWatchdog = struct {
	// lock is a one-slot semaphore over the two fields below: a send takes it,
	// a receive gives it back.
	lock    chan struct{}
	holders int
	// stop ends the running watchdog; nil while none runs.
	stop chan struct{}
}{lock: make(chan struct{}, 1)}

// holdYcrdtWatchdog keeps the watchdog running until the returned release is
// called, starting it if nothing held it. Release is idempotent.
func holdYcrdtWatchdog() (release func()) {
	g := &ycrdtWatchdog
	g.lock <- struct{}{}
	g.holders++
	if g.holders == 1 {
		g.stop = make(chan struct{})
		go runYcrdtWatchdog(g.stop)
	}
	<-g.lock

	var once sync.Once
	return func() {
		once.Do(func() {
			g.lock <- struct{}{}
			g.holders--
			if g.holders == 0 {
				close(g.stop)
				g.stop = nil
			}
			<-g.lock
		})
	}
}

// runYcrdtWatchdog samples the real lock on the real clock until stop closes,
// then stops its ticker and waits for the sampler to return.
func runYcrdtWatchdog(stop <-chan struct{}) {
	ticker := time.NewTicker(ycrdtStallCheckInterval)
	defer ticker.Stop()
	ticks := make(chan time.Time)
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		watchYcrdtStalls(&ycrdtMu, ticks, ycrdtStallThreshold, reportYcrdtStall)
	}()
	defer func() {
		close(ticks)
		<-sampled
	}()
	for {
		select {
		case <-stop:
			return
		case now := <-ticker.C:
			select {
			case ticks <- now:
			case <-stop:
				return
			}
		}
	}
}
