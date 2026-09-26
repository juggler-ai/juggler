//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package machineload reports how busy the machine is, for tests to record when
// they fail.
//
// A test that waited a fixed number of seconds and did not get what it wanted
// has two explanations — the code is wrong, or nothing ran — and a failure
// message that carries neither reading cannot tell them apart. Reconstructing it
// afterwards does not work: by the time anyone reads the log the load is gone,
// and wall-clock time for the whole suite is too coarse to attribute to one
// subtest. So a failing test asks the machine directly, and the answer goes in
// the block next to the assertion.
//
// PerCPU is the figure to read. A load average of 12 is idle on a 64-core
// machine and hopeless on a 4-vCPU runner, and the same suite runs on both.
package machineload

import (
	"fmt"
	"runtime"
)

// Reading is one sample of the machine's run-queue length, averaged by the
// kernel over the last minute, five minutes and fifteen minutes.
type Reading struct {
	One     float64
	Five    float64
	Fifteen float64
	// CPUs is what the load is being shared between.
	CPUs int
}

// PerCPU is the one-minute average divided by the number of CPUs: runnable work
// per core, which compares across machines where the raw average does not. At or
// under 1 the machine is keeping up; a test starved of a core for seconds needs
// a figure well above that.
func (r Reading) PerCPU() float64 {
	if r.CPUs <= 0 {
		return 0
	}
	return r.One / float64(r.CPUs)
}

// Read samples the load average. ok is false on platforms with no such number
// (Windows keeps no run-queue average), where callers say so rather than
// printing a zero that reads like an idle machine.
func Read() (r Reading, ok bool) {
	one, five, fifteen, ok := readLoadAverage()
	if !ok {
		return Reading{}, false
	}
	return Reading{One: one, Five: five, Fifteen: fifteen, CPUs: runtime.NumCPU()}, true
}

// Line renders a reading for a failure block: the three averages, the cores
// they are spread over, and the per-core figure that decides whether this run is
// evidence of anything.
//
// Best-effort by design — it is called while assembling a failure message, and a
// diagnostic must never be the reason a test reports nothing.
func Line() string {
	r, ok := Read()
	if !ok {
		return fmt.Sprintf("MACHINE LOAD: unavailable on %s (no run-queue average), %d CPUs", runtime.GOOS, runtime.NumCPU())
	}
	return fmt.Sprintf("MACHINE LOAD: %.2f %.2f %.2f over %d CPUs — %.2f per CPU%s",
		r.One, r.Five, r.Fifteen, r.CPUs, r.PerCPU(), verdict(r))
}

// verdict names what the number means, so a reader who has never had to care
// about load averages still gets the point. The thresholds are deliberately
// coarse: this decides whether a sighting is worth investigating, not what is
// wrong with it.
func verdict(r Reading) string {
	switch p := r.PerCPU(); {
	case p >= 2:
		return " (SATURATED — this run is not evidence of anything; re-run it on a quiet machine)"
	case p >= 1:
		return " (busy — a timeout here is as likely to be the machine as the code)"
	default:
		return " (quiet — a timeout here is worth investigating)"
	}
}
