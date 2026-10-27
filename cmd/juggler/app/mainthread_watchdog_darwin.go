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
// main thread every pingInterval and force-exits if the ping fails to
// round-trip within tolerance for too many consecutive cycles. This
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
func startMainThreadWatchdog(addr string, allowRelaunch bool, logPath string) {
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

	go func() {
		const (
			pingInterval = 2 * time.Second
			// hangThreshold: main thread unresponsive this long → recover.
			// Short because recovery is a same-PID re-exec blip (the viewer
			// just reconnects) rather than a process death — a shorter freeze
			// for the user, still well clear of any legitimate main-thread work
			// (window create/destroy + theme ops are all sub-second; the
			// engine-connect wait runs off the main thread).
			hangThreshold = 12 * time.Second
			postWakeGrace = 15 * time.Second // give the system time to settle after wake
		)

		lastPongSeen := uint64(C.juggler_mainthread_pong_counter())
		lastProgress := time.Now()
		postWakeIgnoreUntil := time.Now()
		warned := false
		// The sample started by the current stall, if any. Only ever touched
		// from this goroutine, so it needs no synchronisation of its own.
		var sample *stallSample

		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()

		for {
			// Wait one tick, but break out early on a wake nudge so we can
			// reset the grace window before the next ping.
			ch := *wakeNudge.Load()
			select {
			case <-ticker.C:
			case <-ch:
				postWakeIgnoreUntil = time.Now().Add(postWakeGrace)
				lastProgress = time.Now() // don't count the sleep as a hang
				warned = false
				continue
			}

			// Send a ping. If the main thread is healthy, the block runs
			// inside a few ms and bumps the counter.
			C.juggler_mainthread_ping()

			// Look for progress since last tick.
			now := time.Now()
			cur := uint64(C.juggler_mainthread_pong_counter())
			if cur != lastPongSeen {
				lastPongSeen = cur
				lastProgress = now
				if warned {
					jlog.Info("Main thread recovered.")
					warned = false
					// Let the sample finish and keep its file. A stall that
					// came back on its own is the more informative of the two
					// outcomes: it says the deadlock has a way out, and the
					// stacks are the only record of what it was waiting on.
					sample = nil
				}
				continue
			}

			// No progress. Ignore during the post-wake grace window — many
			// macOS subsystems take several seconds to wake up and a brief
			// stall is normal.
			if now.Before(postWakeIgnoreUntil) {
				continue
			}

			stalled := now.Sub(lastProgress)
			if !warned && stalled > pingInterval*3 {
				action := "force-exit"
				if allowRelaunch {
					action = "re-exec a fresh server in place"
				}
				jlog.Error("Main thread unresponsive for %v (likely WebKit DisplayLink deadlock). Will %s at %v.",
					stalled.Round(time.Second), action, hangThreshold)
				warned = true
				// Capture native stacks while the stall is still on — under
				// the test pool too, where a wedge kills every lane at once and
				// the sample is the only record of what the main thread was
				// waiting on.
				sample = captureStallSample(logPath, os.Getpid(), now)
			}
			if stalled >= hangThreshold {
				// Bypass deferred cleanups (they'd try to use the wedged
				// main thread). Write directly to stderr — jlog might be
				// blocked behind something.
				settled := sample.settle(stallSampleGrace)
				if allowRelaunch {
					if !settled {
						jlog.Error("Main-thread sample didn't finish within %v; killed it rather than let it sample the replacement server.",
							stallSampleGrace)
					}
					// Re-exec a fresh image in place; does not return on
					// success. Falls through to os.Exit only if exec fails or
					// the crash-loop guard refuses.
					relaunchInPlace(addr, time.Since(procStart))
				}
				_, _ = os.Stderr.WriteString(stallSampleNote(sample, settled) +
					"\nFATAL: main thread wedged — force-exiting so the next launch can recover.\n")
				os.Exit(1)
			}
		}
	}()
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
// re-acquires the lock and re-binds the same port.
func relaunchInPlace(addr string, uptime time.Duration) {
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
	env := envWith(os.Environ(), relaunchGenEnv, strconv.Itoa(nextGen))
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
