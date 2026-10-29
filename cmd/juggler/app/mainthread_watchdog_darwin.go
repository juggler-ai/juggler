//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package app

// #cgo LDFLAGS: -framework AppKit
// extern void juggler_mainthread_ping(void);
// extern unsigned long long juggler_mainthread_pong_counter(void);
// extern void juggler_register_sleepwake_observers(void);
import "C"

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"juggler/cmd/juggler/syswake"
	"juggler/internal/jlog"
)

const (
	// relaunchGenEnv carries the relaunch generation across re-execs so a wedge
	// during startup can't loop forever.
	relaunchGenEnv = "JUGGLER_RELAUNCH_GEN"
	// relaunchHealthyUptime: a process that ran at least this long before
	// wedging is treated as a fresh streak (generation resets) — a genuine
	// mid-session deadlock, not a crash loop.
	relaunchHealthyUptime = 60 * time.Second
	// relaunchMaxGen caps consecutive fast (sub-healthy) relaunches before we
	// give up and exit for real.
	relaunchMaxGen = 3
	// relaunchExecRetryWindow: how long to keep re-trying an exec that fails
	// because the image isn't runnable at this instant. Rebuilding this tree
	// replaces the very binary a running server was launched from, and the
	// path is empty for the length of the compile — so a wedge that lands
	// mid-build has nothing to exec. Waiting it out is the difference between
	// recovering and dying, and a wedged process is no use to anyone meanwhile.
	relaunchExecRetryWindow = 90 * time.Second
	// relaunchExecRetryInterval: gap between those attempts.
	relaunchExecRetryInterval = 500 * time.Millisecond
)

// wakeNudge is closed-and-recreated whenever the OS reports DidWake; the
// watchdog loop selects on it to expedite the next probe. Using a
// pointer-to-channel with atomic swap avoids a mutex (per project rules:
// goroutines + channels).
var wakeNudge atomic.Pointer[chan struct{}]

func init() {
	ch := make(chan struct{})
	wakeNudge.Store(&ch)
}

// jugglerOnWillSleep and jugglerOnDidWake are invoked from Objective-C
// blocks registered with NSWorkspace (see mainthread_watchdog_darwin.m).
// The deadcode analyser can't follow cgo //export edges; reference them
// here so it knows they're reachable.
var _ = []func(){jugglerOnWillSleep, jugglerOnDidWake}

//export jugglerOnWillSleep
func jugglerOnWillSleep() {
	// The hidden engine stays alive across sleep. KeepRunningWhenHidden=Disabled
	// keeps it off the CVDisplayLink path that deadlocks on a sleep/wake display
	// reconfiguration, and the main-thread watchdog re-exec is the backstop if a
	// wedge strikes anyway.
	jlog.Info("💤 System will sleep.")
}

//export jugglerOnDidWake
func jugglerOnDidWake() {
	jlog.Info("☀️  System did wake — expediting main-thread liveness check.")
	// Replace the nudge channel with a fresh one and close the old one to
	// wake every selector. Atomic swap, no locks.
	newCh := make(chan struct{})
	old := wakeNudge.Swap(&newCh)
	if old != nil {
		close(*old)
	}
	// Notify subsystems that registered for wake events (the worker Manager
	// cancels LLM requests whose connection the sleep likely dropped).
	// Subscribers run on their own goroutines, so this never blocks the
	// main-thread wake callback.
	syswake.Fire()
}

// startMainThreadWatchdog runs a background goroutine that pings the macOS
// main thread every pingInterval and recovers if no ping round-trips for
// hangThreshold of served time — time in which the watchdog itself was run, so
// a process that was stopped or starved is not condemned for the gap (see
// mainThreadSilence). This
// catches the WebKit DisplayLink lock-ordering deadlock that happens
// across sleep/wake (see mainthread_watchdog_darwin.m for the full story).
//
// On a wedge the watchdog re-execs a fresh server image IN PLACE
// (relaunchInPlace) when allowRelaunch is true: same PID, same bound port, so
// a terminal shell keeps its foreground job and an app-spawned server keeps its
// parent's child handle — the viewer's WebSocket simply drops and reconnects to
// the same address. allowRelaunch is false in test mode (a wedge there is a
// test signal, not something to silently restart), where it falls back to
// os.Exit(1).
//
// addr is the address the server actually bound to (host:port); its port is
// pinned on the re-exec so the new image re-binds exactly where the viewer is
// retrying.
//
// logPath is the process log file (jlog.FilePath()) that a stall sample is
// written beside, empty when on-disk logging is off — which suppresses sampling
// too. It is taken here rather than read at stall time: the file sink is
// configured once at startup, and the moment the watchdog needs it is the one
// moment the logging package may itself be stuck behind the wedge.
//
// relaunchEnv is added to the re-exec's environment: what this launch's
// spawner handed it and startup took out of the process environment
// (spawnerEnv.environ), which the replacement image needs as much as this one
// did — a session child refuses to start without its token.
func startMainThreadWatchdog(addr string, allowRelaunch bool, logPath string, relaunchEnv []string) {
	procStart := time.Now()
	// Say so, once. The watchdog is silent while the main thread is healthy,
	// which is indistinguishable from a watchdog that was never armed — and a
	// wedge nothing is watching for is the failure this exists to prevent.
	jlog.Debug("Main-thread watchdog armed (relaunch on wedge: %v).", allowRelaunch)
	// App Nap is allowed when we're idle (energy savings). It's blocked on a
	// per-request basis via the osactivity package, wrapping each LLM call
	// (and any other in-flight HTTP work) so the OS knows when we're
	// actually doing something. KeepRunningWhenHidden handles the
	// per-WebView throttle; osactivity handles the process-level one. Both
	// are necessary and they compose.
	C.juggler_register_sleepwake_observers()

	ticker := time.NewTicker(watchdogPingInterval)
	w := &watchdogLoop{
		tick:   watchdogPingInterval,
		budget: watchdogHangThreshold,
		ticks:  ticker.C,
		wake:   func() <-chan struct{} { return *wakeNudge.Load() },
		now:    time.Now,
		ping:   func() { C.juggler_mainthread_ping() },
		pongs:  func() uint64 { return uint64(C.juggler_mainthread_pong_counter()) },
		capture: func(now time.Time) *stallSample {
			return captureStallSample(logPath, os.Getpid(), now)
		},
		allowRelaunch: allowRelaunch,
		awaitSample: func(s *stallSample) bool {
			if !allowRelaunch {
				// Test mode exits rather than re-execs: nothing will reuse
				// this pid, and the sample is the only record of the wedge,
				// so it is waited for in full.
				return s.finish()
			}
			settled := s.settle(stallSampleGrace)
			if !settled {
				jlog.Error("Main-thread sample didn't finish within %v; killed it rather than let it sample the replacement server.",
					stallSampleGrace)
			}
			return settled
		},
		onWedge: func(s *stallSample, settled bool) {
			// Bypass deferred cleanups (they'd try to use the wedged main
			// thread). Write directly to stderr — jlog might be blocked
			// behind something.
			if allowRelaunch {
				// Re-exec a fresh image in place; does not return on success.
				// Falls through to os.Exit only if exec fails or the
				// crash-loop guard refuses.
				relaunchInPlace(addr, relaunchEnv, time.Since(procStart))
			}
			_, _ = os.Stderr.WriteString(stallSampleNote(s, settled) +
				"\nFATAL: main thread wedged — force-exiting so the next launch can recover.\n")
			os.Exit(1)
		},
	}
	go func() {
		defer ticker.Stop()
		w.run()
	}()
}

const (
	// watchdogPingInterval is also the resolution at which mainThreadSilence
	// tells a stopped process from a silent main thread, so it is short; a ping
	// is one dispatch onto the main queue.
	watchdogPingInterval = time.Second
	// watchdogHangThreshold: main thread unresponsive this long, counted in
	// time the watchdog was actually run (mainThreadSilence) → recover. Short
	// because recovery is a same-PID re-exec blip (the viewer just reconnects)
	// rather than a process death — a shorter freeze for the user, still well
	// clear of any legitimate main-thread work (window create/destroy + theme
	// ops are all sub-second; the engine-connect wait runs off the main thread).
	watchdogHangThreshold = 12 * time.Second
	// watchdogPostWakeGrace gives the system time to settle after wake.
	watchdogPostWakeGrace = 15 * time.Second
)

// watchdogLoop is the main-thread watchdog's loop, with everything it touches
// outside itself — the main-thread probe, the clock, the sampler and the exit —
// supplied by startMainThreadWatchdog, so it can be run against a fake main
// thread.
type watchdogLoop struct {
	tick, budget time.Duration
	ticks        <-chan time.Time
	// wake returns the channel the next system wake closes.
	wake func() <-chan struct{}
	now  func() time.Time
	// ping asks the main thread to answer; pongs counts its answers so far.
	ping  func()
	pongs func() uint64
	// capture starts a stall sample at the warning; nil when none was started.
	capture       func(now time.Time) *stallSample
	allowRelaunch bool
	// awaitSample waits for a wedge's sample and reports whether it was written.
	awaitSample func(*stallSample) bool
	// onWedge acts on a wedge that still stands once its sample is written. It
	// does not return in production; run returns if it does.
	onWedge func(s *stallSample, settled bool)
}

// run watches until it acts on a wedge.
func (w *watchdogLoop) run() {
	lastPongSeen := w.pongs()
	silence := newMainThreadSilence(w.tick, w.budget, w.now())
	postWakeIgnoreUntil := w.now()
	// The sample started by the current stall, if any. Only ever touched from
	// this goroutine, so it needs no synchronisation of its own.
	var sample *stallSample

	for {
		// Wait one tick, but break out early on a wake nudge so we can reset
		// the grace window before the next ping.
		select {
		case <-w.ticks:
		case <-w.wake():
			postWakeIgnoreUntil = w.now().Add(watchdogPostWakeGrace)
			silence.reset(w.now()) // don't count the sleep as a hang
			continue
		}

		// Send a ping. If the main thread is healthy, the block runs inside a
		// few ms and bumps the counter.
		w.ping()

		// Look for progress since last tick. During the post-wake grace window
		// silence is still accounted but never acted on — many macOS
		// subsystems take several seconds to wake up and a brief stall is
		// normal.
		now := w.now()
		cur := w.pongs()
		answered := cur != lastPongSeen
		lastPongSeen = cur
		r := silence.observe(now, answered, now.Before(postWakeIgnoreUntil))
		if r.recovered {
			jlog.Info("Main thread recovered.")
			// Let the sample finish and keep its file. A stall that came back
			// on its own is the more informative of the two outcomes: it says
			// the deadlock has a way out, and the stacks are the only record of
			// what it was waiting on.
			sample = nil
		}
		if r.warn {
			action := "force-exit"
			if w.allowRelaunch {
				action = "re-exec a fresh server in place"
			}
			jlog.Error("Main thread unresponsive for %v (likely WebKit DisplayLink deadlock). Will %s at %v.",
				r.silent.Round(time.Second), action, w.budget)
			// Capture native stacks while the stall is still on — under the
			// test pool too, where a wedge kills every lane at once and the
			// sample is the only record of what the main thread was waiting on.
			sample = w.capture(now)
		}
		if !r.wedged {
			continue
		}
		settled := w.awaitSample(sample)
		// The verdict is as old as the wait for the sample, which on a
		// saturated machine — where stalls are seen — runs to a minute. Act on
		// it only if the main thread is still silent now: one that answered
		// meanwhile was busy, not wedged, and killing it takes down a server
		// that is working.
		if cur := w.pongs(); cur != lastPongSeen {
			lastPongSeen = cur
			jlog.Info("Main thread answered while its stall sample was written — busy, not wedged; carrying on.")
			silence.reset(w.now())
			sample = nil
			continue
		}
		w.onWedge(sample, settled)
		return
	}
}

// silenceLateSlack is how far past twice its interval a tick may arrive and
// still count as on schedule — scheduler jitter on a busy machine, not a stop.
const silenceLateSlack = 250 * time.Millisecond

// mainThreadSilence accounts how long the main thread has gone without
// answering a ping, and decides when that silence is a wedge.
//
// Only served time counts: time in which the watchdog itself ran on schedule.
// A tick that arrives more than 2×tick + silenceLateSlack after the previous
// one means the whole process was not run for the gap (a slow core, a stopped
// process, a machine asleep) — the main thread had no chance to answer, so the
// gap counts as one tick and the excess is discarded. Such a tick also starts
// a resume: no wedge is declared until a full tick has been served since, so
// the ping sent on resuming gets one fresh interval to be answered in.
type mainThreadSilence struct {
	tick, budget time.Duration
	lastTick     time.Time
	silent       time.Duration // served silence in the current stall
	sinceResume  time.Duration // served time since the last unserved gap
	warned       bool
}

// silenceReading is what one observation concluded.
type silenceReading struct {
	silent    time.Duration // served silence counted so far in this stall
	warn      bool          // first observation past the warning mark this stall
	recovered bool          // the main thread answered after a warned stall
	wedged    bool          // the silence is a wedge: act on it
}

// newMainThreadSilence starts the count at now. tick is the interval the
// watchdog observes at; budget is the served silence that makes a wedge.
func newMainThreadSilence(tick, budget time.Duration, now time.Time) *mainThreadSilence {
	return &mainThreadSilence{tick: tick, budget: budget, lastTick: now, sinceResume: tick}
}

// reset starts a fresh count at now, discarding the current stall, and treats
// now as a resume.
func (s *mainThreadSilence) reset(now time.Time) {
	s.lastTick = now
	s.silent = 0
	s.sinceResume = 0
	s.warned = false
}

// observe records one watchdog tick at now. answered reports whether the main
// thread answered a ping since the previous tick; quiet accounts the tick but
// suppresses any warning or wedge.
func (s *mainThreadSilence) observe(now time.Time, answered, quiet bool) silenceReading {
	served := now.Sub(s.lastTick)
	s.lastTick = now
	if served > 2*s.tick+silenceLateSlack {
		served = s.tick
		s.sinceResume = 0
	} else {
		s.sinceResume += served
	}
	if answered {
		r := silenceReading{recovered: s.warned}
		s.silent = 0
		s.warned = false
		return r
	}
	s.silent += served
	r := silenceReading{silent: s.silent}
	if quiet {
		return r
	}
	if !s.warned && s.silent > s.budget/2 {
		s.warned = true
		r.warn = true
	}
	r.wedged = s.silent >= s.budget && s.sinceResume >= s.tick
	return r
}

// relaunchDecision decides whether to re-exec after a wedge, given the current
// relaunch generation and how long this process had been alive when it wedged.
// A process that lived past relaunchHealthyUptime is a fresh streak (generation
// resets to 0); a tight crash-loop of fast wedges is capped at relaunchMaxGen,
// after which we give up. Pure function — unit-tested.
func relaunchDecision(gen int, uptime time.Duration) (nextGen int, relaunch bool) {
	if uptime >= relaunchHealthyUptime {
		return 0, true
	}
	if gen >= relaunchMaxGen {
		return gen, false
	}
	return gen + 1, true
}

// portFromAddr extracts the port from a host:port address, or "" if it can't.
func portFromAddr(addr string) string {
	if _, p, err := net.SplitHostPort(addr); err == nil {
		return p
	}
	return ""
}

// relaunchArgs returns args with any existing --port/-port (both "--port N" and
// "--port=N" forms) removed and an explicit --port <port> appended, so the
// re-exec'd image re-binds the SAME address the viewer is retrying. argv[0] is
// preserved.
func relaunchArgs(args []string, port string) []string {
	out := make([]string, 0, len(args)+2)
	skipNext := false
	for i, a := range args {
		if i == 0 {
			out = append(out, a)
			continue
		}
		if skipNext {
			skipNext = false
			continue
		}
		if a == "--port" || a == "-port" {
			skipNext = true
			continue
		}
		if strings.HasPrefix(a, "--port=") || strings.HasPrefix(a, "-port=") {
			continue
		}
		out = append(out, a)
	}
	if port != "" {
		out = append(out, "--port", port)
	}
	return out
}

// envWith returns environ with any existing key entries removed and key=val
// appended (so a relaunch generation set across multiple re-execs doesn't
// accumulate duplicate entries).
func envWith(environ []string, key, val string) []string {
	prefix := key + "="
	out := make([]string, 0, len(environ)+1)
	for _, e := range environ {
		if !strings.HasPrefix(e, prefix) {
			out = append(out, e)
		}
	}
	return append(out, prefix+val)
}

// relaunchEnviron returns the environment a re-exec runs under: environ with
// carried's entries and the relaunch generation set in it, each replacing any
// entry of the same name. The process's own environment is left as it is, so
// what carried holds reaches the new image alone, never anything this process
// spawns meanwhile.
func relaunchEnviron(environ, carried []string, gen int) []string {
	env := environ
	for _, kv := range carried {
		name, val, _ := strings.Cut(kv, "=")
		env = envWith(env, name, val)
	}
	return envWith(env, relaunchGenEnv, strconv.Itoa(gen))
}

// execRetryable reports whether an exec failure is one a moment's wait can
// clear: the image is missing, still open for writing, or not executable yet —
// the states a rebuild of this tree passes through. Pure function — unit-tested.
func execRetryable(err error) bool {
	return errors.Is(err, syscall.ENOENT) ||
		errors.Is(err, syscall.ETXTBSY) ||
		errors.Is(err, syscall.EACCES) ||
		errors.Is(err, syscall.ENOEXEC)
}

// execUntilRunnable calls execFn until it fails for a reason waiting can't fix
// (execRetryable) or deadline passes, sleeping via sleep between attempts and
// handing the first retryable failure to notify (so the wait is reported once,
// not twice a second). execFn returns ONLY on failure, so the returned error is
// always non-nil. sleep and deadline are parameters so the retry can be tested
// without waiting on the real clock.
func execUntilRunnable(execFn func() error, sleep func(time.Duration), deadline time.Time, notify func(error)) error {
	for attempt := 0; ; attempt++ {
		err := execFn()
		if !execRetryable(err) || !time.Now().Before(deadline) {
			return err
		}
		if attempt == 0 && notify != nil {
			notify(err)
		}
		sleep(relaunchExecRetryInterval)
	}
}

// relaunchInPlace re-execs a fresh server image in place (same PID), pinning the
// port the viewer is retrying so it reconnects transparently. It does NOT return
// on success (the process image is replaced). On the crash-loop guard refusing,
// or an exec failure that outlasts relaunchExecRetryWindow, it os.Exit(1)s so
// the caller's fallback is unreachable.
//
// Same-PID re-exec is what makes recovery work for both launch paths with no
// app-side changes: a terminal shell keeps its foreground job, and an
// app-spawned server keeps its parent's *exec.Cmd handle valid (no Wait()
// returns, --exit-with-parent PPID is unchanged). Go opens the instance-lock
// and listener fds O_CLOEXEC, so execve frees them before the new image
// re-acquires the lock and re-binds the same port. A session child spawned with
// --port 0 is re-exec'd with the port it bound, so its machine server's proxy,
// which learned that address from the child's JUGGLER_ADDR line, still reaches
// it. carried is added to the new image's environment (relaunchEnviron).
func relaunchInPlace(addr string, carried []string, uptime time.Duration) {
	gen, _ := strconv.Atoi(os.Getenv(relaunchGenEnv))
	nextGen, ok := relaunchDecision(gen, uptime)
	if !ok {
		_, _ = os.Stderr.WriteString(
			"\nFATAL: main thread wedged repeatedly soon after launch — giving up to avoid a crash loop.\n")
		os.Exit(1)
	}
	exe, err := os.Executable()
	if err != nil {
		_, _ = os.Stderr.WriteString(
			"\nFATAL: main thread wedged — cannot locate executable to re-exec; force-exiting.\n")
		os.Exit(1)
	}
	argv := relaunchArgs(os.Args, portFromAddr(addr))
	env := relaunchEnviron(os.Environ(), carried, nextGen)
	_, _ = fmt.Fprintf(os.Stderr,
		"\nFATAL: main thread wedged — re-exec'ing a fresh server (same port, gen=%d) so it recovers in place.\n", nextGen)
	err = execUntilRunnable(
		func() error { return syscall.Exec(exe, argv, env) },
		time.Sleep,
		time.Now().Add(relaunchExecRetryWindow),
		func(waitErr error) {
			_, _ = fmt.Fprintf(os.Stderr,
				"Can't exec %s yet: %v — retrying for up to %v.\n", exe, waitErr, relaunchExecRetryWindow)
		},
	)
	// Only reached if exec failed for good.
	_, _ = fmt.Fprintf(os.Stderr, "\nFATAL: re-exec failed: %v — force-exiting.\n", err)
	os.Exit(1)
}
