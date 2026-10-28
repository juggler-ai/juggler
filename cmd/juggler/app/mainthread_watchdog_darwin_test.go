//go:build darwin

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"juggler/internal/machineload"
)

// --- main-thread silence accounting (pure) ---

// silenceTick is one watchdog tick fed to mainThreadSilence: how long after the
// previous one it arrived, and whether the main thread had answered by then.
type silenceTick struct {
	after    time.Duration
	answered bool
}

// replaySilence feeds ticks to a fresh mainThreadSilence on a fake clock and
// returns the reading of each.
func replaySilence(tick, budget time.Duration, ticks []silenceTick) []silenceReading {
	now := time.Unix(1_000_000, 0)
	s := newMainThreadSilence(tick, budget, now)
	out := make([]silenceReading, 0, len(ticks))
	for _, tk := range ticks {
		now = now.Add(tk.after)
		out = append(out, s.observe(now, tk.answered, false))
	}
	return out
}

// TestMainThreadSilenceDiscountsUnservedGap: a process that was stopped (a slow
// core, SIGSTOP, a laptop asleep) stopped its watchdog too, so the gap between
// two of its ticks is not time the main thread spent ignoring a ping. Resuming
// must not condemn a main thread that answers once it is run again.
func TestMainThreadSilenceDiscountsUnservedGap(t *testing.T) {
	const tick, budget = time.Second, 12 * time.Second
	cases := []struct {
		name  string
		ticks []silenceTick
	}{
		{"healthy, then stopped a minute", []silenceTick{
			{tick, true}, {tick, true},
			{time.Minute, false}, // first tick after resume: the ping just went out
			{tick, true},
		}},
		{"stopped, then the ticker fires straight away", []silenceTick{
			{tick, true},
			{time.Minute, false},
			{50 * time.Millisecond, false}, // the dropped tick's phase catches up
			{tick, true},
		}},
		{"already silent a while, then stopped", []silenceTick{
			{tick, true},
			{tick, false}, {tick, false}, {tick, false}, {tick, false},
			{tick, false}, {tick, false}, {tick, false}, {tick, false},
			{10 * time.Minute, false},
			{tick, true},
		}},
		{"stopped repeatedly", []silenceTick{
			{tick, true},
			{30 * time.Second, false}, {30 * time.Second, false},
			{30 * time.Second, false}, {30 * time.Second, false},
			{tick, true},
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			for i, r := range replaySilence(tick, budget, c.ticks) {
				if r.wedged {
					t.Fatalf("tick %d (%v after the previous): declared wedged after %v of counted silence; the watchdog was not running for the gap",
						i, c.ticks[i].after, r.silent)
				}
			}
		})
	}
}

// TestMainThreadSilenceDetectsBlockedMainThread: with the watchdog running on
// schedule, a main thread that never answers is a wedge, declared once the
// served silence reaches the budget — and an earlier stop does not delay it
// past the budget of time actually served.
func TestMainThreadSilenceDetectsBlockedMainThread(t *testing.T) {
	const tick, budget = time.Second, 12 * time.Second
	cases := []struct {
		name   string
		prefix []silenceTick
	}{
		{"on schedule throughout", []silenceTick{{tick, true}}},
		{"after a stop", []silenceTick{{tick, true}, {time.Minute, false}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ticks := append([]silenceTick(nil), c.prefix...)
			for range 3 * budget / tick {
				// A little late, as a busy machine delivers ticks.
				ticks = append(ticks, silenceTick{tick + 100*time.Millisecond, false})
			}
			warns := 0
			for i, r := range replaySilence(tick, budget, ticks) {
				if r.warn {
					warns++
				}
				if !r.wedged {
					continue
				}
				served := time.Duration(i-len(c.prefix)+1) * (tick + 100*time.Millisecond)
				if served > budget+2*tick {
					t.Fatalf("declared wedged after %v of served silence; want within the %v budget (+ one tick to confirm)", served, budget)
				}
				if warns != 1 {
					t.Fatalf("warned %d times before the wedge; want exactly once", warns)
				}
				return
			}
			t.Fatalf("a main thread that never answered was never declared wedged")
		})
	}
}

// --- acting on a wedge ---

// fakeMainThread drives a watchdogLoop by hand: every tick the test sends
// advances its clock by one interval, so silence accrues as served time without
// a real clock, and every answer the test grants bumps the pong count. The loop
// owns all of it — its ping, clock and pong reads all run on the loop's
// goroutine — so it needs no locking.
type fakeMainThread struct {
	clock    time.Time
	pong     uint64
	ticks    chan time.Time
	captured *stallSample
	wedged   chan *stallSample
}

func newWatchdogUnderTest(answerWhileSampled bool) (*fakeMainThread, *watchdogLoop) {
	f := &fakeMainThread{
		clock:  time.Unix(1_000_000, 0),
		ticks:  make(chan time.Time),
		wedged: make(chan *stallSample, 1),
	}
	w := &watchdogLoop{
		tick:   watchdogPingInterval,
		budget: watchdogHangThreshold,
		ticks:  f.ticks,
		wake:   func() <-chan struct{} { return nil },
		now:    func() time.Time { return f.clock },
		ping:   func() { f.clock = f.clock.Add(watchdogPingInterval) },
		pongs:  func() uint64 { return f.pong },
		capture: func(time.Time) *stallSample {
			f.captured = &stallSample{path: "/logs/mainthread-stall-1.sample.log"}
			return f.captured
		},
		awaitSample: func(*stallSample) bool {
			if answerWhileSampled {
				f.pong++
			}
			return true
		},
		onWedge: func(s *stallSample, _ bool) { f.wedged <- s },
	}
	return f, w
}

// TestWatchdogSparesAMainThreadThatAnswersWhileSampled: the wedge verdict is
// reached before its sample is written, and writing it — symbolication on a
// saturated machine — took 58s in a CI run whose pool server started up slowly.
// The main thread answered within a second of the verdict, its lanes ran tests
// for the next fifty, and then the watchdog killed it on the stale verdict and
// every lane with it. A main thread that answered meanwhile was busy, not
// wedged.
func TestWatchdogSparesAMainThreadThatAnswersWhileSampled(t *testing.T) {
	f, w := newWatchdogUnderTest(true)
	done := make(chan struct{})
	go func() { defer close(done); w.run() }()
	// Twice the budget of silence: the first stall is declared and answered,
	// and the loop must go on watching rather than act or return.
	for range 2 * watchdogHangThreshold / watchdogPingInterval {
		select {
		case f.ticks <- time.Time{}:
		case s := <-f.wedged:
			t.Fatalf("acted on a wedge (sample %v) although the main thread answered while its sample was written", s)
		case <-done:
			t.Fatal("the watchdog stopped watching after a stall the main thread came back from")
		}
	}
	if f.captured == nil {
		t.Fatal("the stall was never sampled, so its wedge was never declared: the test proved nothing")
	}
}

// TestWatchdogActsOnAWedgeThatOutlastsItsSample: a main thread still silent
// once its sample is written is wedged, and the watchdog acts on it with that
// sample.
func TestWatchdogActsOnAWedgeThatOutlastsItsSample(t *testing.T) {
	f, w := newWatchdogUnderTest(false)
	go w.run()
	for range 2 * watchdogHangThreshold / watchdogPingInterval {
		select {
		case f.ticks <- time.Time{}:
		case s := <-f.wedged:
			if s == nil || s != f.captured {
				t.Fatalf("acted on the wedge with sample %v; want the one its warning started (%v)", s, f.captured)
			}
			return
		}
	}
	t.Fatal("a main thread silent through its own sample was never acted on")
}

// --- crash-loop guard (pure) ---

func TestRelaunchDecision(t *testing.T) {
	cases := []struct {
		name         string
		gen          int
		uptime       time.Duration
		wantNextGen  int
		wantRelaunch bool
	}{
		{"first wedge, fast", 0, 5 * time.Second, 1, true},
		{"second wedge, fast", 1, 5 * time.Second, 2, true},
		{"third wedge, fast", 2, 5 * time.Second, 3, true},
		{"cap reached, fast", 3, 5 * time.Second, 3, false},
		{"over cap, fast", 9, 5 * time.Second, 9, false},
		{"healthy uptime resets streak", 3, 90 * time.Second, 0, true},
		{"healthy uptime at boundary", 0, relaunchHealthyUptime, 0, true},
		{"just under healthy boundary", 0, relaunchHealthyUptime - time.Millisecond, 1, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotGen, gotRelaunch := relaunchDecision(c.gen, c.uptime)
			if gotGen != c.wantNextGen || gotRelaunch != c.wantRelaunch {
				t.Fatalf("relaunchDecision(%d, %v) = (%d, %v); want (%d, %v)",
					c.gen, c.uptime, gotGen, gotRelaunch, c.wantNextGen, c.wantRelaunch)
			}
		})
	}
}

// --- exec retry (a rebuild replaces the image we re-exec) ---

func TestExecRetryable(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"missing image (mid-rebuild)", syscall.ENOENT, true},
		{"image still open for writing", syscall.ETXTBSY, true},
		{"not executable yet", syscall.EACCES, true},
		{"half-written image", syscall.ENOEXEC, true},
		{"wrapped errno still matches", fmt.Errorf("exec %s: %w", "/bin/juggler", syscall.ENOENT), true},
		{"permanent failure", syscall.EPERM, false},
		{"arg list too long", syscall.E2BIG, false},
		{"no error", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := execRetryable(c.err); got != c.want {
				t.Fatalf("execRetryable(%v) = %v; want %v", c.err, got, c.want)
			}
		})
	}
}

func TestExecUntilRunnable(t *testing.T) {
	// A retryable failure that clears (the rebuild lands) is retried until the
	// exec succeeds — success never returns, modelled here by the last attempt
	// blocking forever, so instead assert on the attempt count via a failure
	// that turns permanent.
	t.Run("retries while the image is missing", func(t *testing.T) {
		attempts := 0
		slept := 0
		err := execUntilRunnable(
			func() error {
				attempts++
				if attempts < 4 {
					return syscall.ENOENT
				}
				return syscall.EPERM
			},
			func(time.Duration) { slept++ },
			time.Now().Add(time.Minute),
			nil,
		)
		if attempts != 4 || slept != 3 {
			t.Fatalf("attempts=%d slept=%d; want 4 and 3", attempts, slept)
		}
		if !errors.Is(err, syscall.EPERM) {
			t.Fatalf("returned %v; want EPERM (the failure that ended the retry)", err)
		}
	})

	t.Run("gives up at the deadline", func(t *testing.T) {
		attempts := 0
		err := execUntilRunnable(
			func() error { attempts++; return syscall.ENOENT },
			func(time.Duration) { time.Sleep(time.Millisecond) },
			time.Now().Add(20*time.Millisecond),
			nil,
		)
		if !errors.Is(err, syscall.ENOENT) {
			t.Fatalf("returned %v; want the last exec error", err)
		}
		if attempts < 2 {
			t.Fatalf("attempts=%d; want the exec retried before the deadline", attempts)
		}
	})

	t.Run("reports the wait once", func(t *testing.T) {
		notified := 0
		attempts := 0
		_ = execUntilRunnable(
			func() error {
				attempts++
				if attempts < 5 {
					return syscall.ENOENT
				}
				return syscall.EPERM
			},
			func(time.Duration) {},
			time.Now().Add(time.Minute),
			func(error) { notified++ },
		)
		if notified != 1 {
			t.Fatalf("notify called %d times; want exactly 1", notified)
		}
	})

	t.Run("a permanent failure is not retried", func(t *testing.T) {
		attempts := 0
		_ = execUntilRunnable(
			func() error { attempts++; return syscall.EPERM },
			func(time.Duration) { t.Fatal("slept on a permanent failure") },
			time.Now().Add(time.Minute),
			func(error) { t.Fatal("reported a wait on a permanent failure") },
		)
		if attempts != 1 {
			t.Fatalf("attempts=%d; want 1", attempts)
		}
	})
}

// --- the stderr line a test-mode wedge leaves for the harness ---

// TestStallSampleNote pins the line the browser harness looks for on a dead
// pool server's stderr (tests/integration/browser, stallSampleStderrPrefix):
// the watchdog's jlog lines go only to a log file under the test pool, so this
// line is the one way the harness learns a sample exists.
func TestStallSampleNote(t *testing.T) {
	if got := stallSampleNote(nil, true); got != "" {
		t.Errorf("stallSampleNote(nil) = %q; want nothing, since no sample was taken", got)
	}
	s := &stallSample{path: "/logs/mainthread-stall-1.sample.log"}
	if got, want := stallSampleNote(s, true), "\nMain-thread sample: /logs/mainthread-stall-1.sample.log\n"; got != want {
		t.Errorf("stallSampleNote(settled) = %q; want %q", got, want)
	}
	if got := stallSampleNote(s, false); !strings.Contains(got, "didn't finish") || strings.Contains(got, "Main-thread sample: ") {
		t.Errorf("stallSampleNote(unsettled) = %q; want it to say the sample didn't finish, and not name it as a sample", got)
	}
}

// TestStallSampleFinishNeverKills pins the test-mode wedge's wait: a sample is
// waited for until its sampler exits, never cancelled, because nothing will
// reuse the pid and the sample is the only record of the wedge.
func TestStallSampleFinishNeverKills(t *testing.T) {
	if !(*stallSample)(nil).finish() {
		t.Error("a nil sample did not finish; nothing was started, so there is nothing to wait for")
	}
	done := make(chan struct{})
	s := &stallSample{
		path:   "/logs/mainthread-stall-1.sample.log",
		done:   done,
		cancel: func() { t.Error("finish killed the sampler") },
	}
	finished := make(chan bool, 1)
	go func() { finished <- s.finish() }()
	close(done) // the sampler exits by itself
	if !<-finished {
		t.Error("finish reported a sampler that exited by itself as unfinished")
	}
}

// --- argv / env / addr helpers (pure) ---

func TestRelaunchArgs(t *testing.T) {
	cases := []struct {
		name string
		args []string
		port string
		want []string
	}{
		{
			"no existing port",
			[]string{"juggler", "--window=false", "--project", "/p"},
			"7777",
			[]string{"juggler", "--window=false", "--project", "/p", "--port", "7777"},
		},
		{
			"strips --port N form",
			[]string{"juggler", "--port", "0", "--project", "/p"},
			"7777",
			[]string{"juggler", "--project", "/p", "--port", "7777"},
		},
		{
			"strips --port=N form",
			[]string{"juggler", "--port=0", "--window=false"},
			"7777",
			[]string{"juggler", "--window=false", "--port", "7777"},
		},
		{
			"empty port appends nothing",
			[]string{"juggler", "--window=false"},
			"",
			[]string{"juggler", "--window=false"},
		},
		{
			"preserves argv0 even if it looks like a flag value",
			[]string{"juggler"},
			"9000",
			[]string{"juggler", "--port", "9000"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := relaunchArgs(c.args, c.port)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("relaunchArgs(%v, %q) = %v; want %v", c.args, c.port, got, c.want)
			}
		})
	}
}

func TestEnvWith(t *testing.T) {
	// Replaces an existing key (no duplicates) and appends a new one.
	in := []string{"FOO=1", "JUGGLER_RELAUNCH_GEN=2", "BAR=3"}
	got := envWith(in, "JUGGLER_RELAUNCH_GEN", "5")
	want := []string{"FOO=1", "BAR=3", "JUGGLER_RELAUNCH_GEN=5"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("envWith replace = %v; want %v", got, want)
	}

	got2 := envWith([]string{"FOO=1"}, "JUGGLER_RELAUNCH_GEN", "1")
	want2 := []string{"FOO=1", "JUGGLER_RELAUNCH_GEN=1"}
	if !reflect.DeepEqual(got2, want2) {
		t.Fatalf("envWith append = %v; want %v", got2, want2)
	}

	// No accumulation across repeated calls.
	g := envWith(envWith(in, "JUGGLER_RELAUNCH_GEN", "5"), "JUGGLER_RELAUNCH_GEN", "6")
	n := 0
	for _, e := range g {
		if strings.HasPrefix(e, "JUGGLER_RELAUNCH_GEN=") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("envWith should keep exactly one JUGGLER_RELAUNCH_GEN entry, got %d", n)
	}
}

func TestPortFromAddr(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:7777": "7777",
		"[::1]:8888":     "8888",
		"0.0.0.0:0":      "0",
		"garbage":        "",
	}
	for addr, want := range cases {
		if got := portFromAddr(addr); got != want {
			t.Fatalf("portFromAddr(%q) = %q; want %q", addr, got, want)
		}
	}
}

// --- real syscall.Exec round-trip ---
//
// Proves the mechanism relaunchInPlace depends on: a same-PID syscall.Exec
// (built from juggler's relaunchArgs/envWith) frees a CLOEXEC-bound listener so
// the re-exec'd image re-binds the SAME port, with the relaunch generation
// incremented. The flock the server holds uses the identical CLOEXEC release,
// so this covers the lock handoff too. No production test-hook involved — the
// child is the test binary itself, routed by execRoundtripChild via TestMain.

const (
	envExecChild = "JUGGLER_EXEC_ROUNDTRIP_CHILD"
	envExecOut   = "JUGGLER_EXEC_ROUNDTRIP_OUT"
	envExecFD    = "JUGGLER_EXEC_ROUNDTRIP_FD"
)

// rebindWindow is how long the re-exec'd image keeps trying to take its port
// back. The port is in the ephemeral range, so between the exec closing the
// listener and this bind the kernel is free to hand it to any process opening an
// outbound connection — which, on a machine running this suite, is a great many.
// A few attempts separate that from a handoff that is genuinely broken, where the
// port is held by a socket of ours and never comes back at all.
const rebindWindow = 2 * time.Second

// listenerSurvivedExec reports whether fd is still a socket bound to port, which
// is the definitive statement of a broken handoff: the listening socket outlived
// the execve that was supposed to close it.
//
// Asked of the fd directly rather than inferred from a failed bind, because those
// are different facts. A bind can fail because somebody else holds the port, which
// says nothing about our own socket; only the fd can say whether OUR listener is
// still there. EBADF is the healthy answer. A different port on the same number is
// healthy too — the runtime reuses fd numbers freely after exec, and what matters
// is that our socket is gone, not that the number is unused.
func listenerSurvivedExec(fd int, port string) bool {
	if fd <= 0 {
		return false
	}
	sa, err := syscall.Getsockname(fd)
	if err != nil {
		return false
	}
	var bound int
	switch a := sa.(type) {
	case *syscall.SockaddrInet4:
		bound = a.Port
	case *syscall.SockaddrInet6:
		bound = a.Port
	default:
		return false
	}
	return strconv.Itoa(bound) == port
}

func TestMain(m *testing.M) {
	if os.Getenv(envExecChild) != "" {
		execRoundtripChild() // never returns
	}
	os.Exit(m.Run())
}

// execRoundtripChild runs in the spawned child (and again after it re-execs
// itself). Phase gen=0: bind the --port, record pid+port, then re-exec via
// juggler's helpers (CLOEXEC closes the listener on exec, freeing the port).
// Phase gen=1: same PID, re-bind the same port (proving the handoff), append a
// result line, exit.
func execRoundtripChild() {
	out := os.Getenv(envExecOut)
	port := portFromArgs(os.Args)
	gen, _ := strconv.Atoi(os.Getenv(relaunchGenEnv))

	if gen == 0 {
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", port))
		if err != nil {
			appendLine(out, fmt.Sprintf("ERR phase0 bind: %v", err))
			os.Exit(2)
		}
		_ = ln // keep open across exec; CLOEXEC frees it on execve
		appendLine(out, fmt.Sprintf("pid0=%d port=%s", os.Getpid(), port))

		// The listener's own descriptor number, carried to the next image so it can
		// ask whether the socket survived. Read through SyscallConn rather than
		// File(), which would hand back a duplicate and put the original into
		// blocking mode.
		listenFD := 0
		if raw, err := ln.(*net.TCPListener).SyscallConn(); err == nil {
			_ = raw.Control(func(fd uintptr) { listenFD = int(fd) })
		}

		exe, err := os.Executable()
		if err != nil {
			appendLine(out, fmt.Sprintf("ERR phase0 exe: %v", err))
			os.Exit(2)
		}
		argv := relaunchArgs(os.Args, port)
		env := envWith(os.Environ(), relaunchGenEnv, "1")
		env = envWith(env, envExecFD, strconv.Itoa(listenFD))
		if err := syscall.Exec(exe, argv, env); err != nil {
			appendLine(out, fmt.Sprintf("ERR phase0 exec: %v", err))
			os.Exit(2)
		}
		return // unreachable
	}

	// gen >= 1: the re-exec'd image. The handoff is proven by the listening socket
	// being gone, which is asked of the descriptor; taking the port back is the
	// visible consequence and is attempted second, because it depends on the rest
	// of the machine leaving an ephemeral port alone for a moment.
	inheritedFD, _ := strconv.Atoi(os.Getenv(envExecFD))
	if listenerSurvivedExec(inheritedFD, port) {
		appendLine(out, fmt.Sprintf("ERR phase1 handoff: fd %d is still bound to port %s after execve, so CLOEXEC did not close the listener", inheritedFD, port))
		os.Exit(3)
	}

	deadline := time.Now().Add(rebindWindow)
	var lastErr error
	for {
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", port))
		if err == nil {
			_ = ln.Close()
			appendLine(out, fmt.Sprintf("pid1=%d gen=%d rebound=ok", os.Getpid(), gen))
			os.Exit(0)
		}
		lastErr = err
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Our listener is provably gone, so the port is held by something that is not
	// ours and there is nothing here to fail: the property under test held, and the
	// machine took the port in the gap. Said plainly so the parent reports a skip
	// rather than a fault nobody can act on.
	appendLine(out, fmt.Sprintf("SKIP phase1 rebind: port %s taken by another process after the handoff: %v", port, lastErr))
	os.Exit(0)
}

func portFromArgs(args []string) string {
	for i, a := range args {
		if a == "--port" && i+1 < len(args) {
			return args[i+1]
		}
		if v, ok := strings.CutPrefix(a, "--port="); ok {
			return v
		}
	}
	return ""
}

func appendLine(path, line string) {
	if path == "" {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line + "\n")
}

func TestRelaunchExecRoundTrip(t *testing.T) {
	// Pick a free port, then release it so the child can bind it.
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	port := portFromAddr(probe.Addr().String())
	_ = probe.Close()

	out := t.TempDir() + "/roundtrip.txt"

	cmd := exec.Command(os.Args[0], "--port", port)
	cmd.Env = append(os.Environ(),
		envExecChild+"=1",
		envExecOut+"="+out,
		relaunchGenEnv+"=", // start clean: gen 0
	)
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child exec round-trip failed: %v\noutput:\n%s\nresult file:\n%s",
			err, outBytes, readFileBestEffort(out))
	}

	data := readFileBestEffort(out)
	pid0 := fieldValue(data, "pid0=")
	pid1 := fieldValue(data, "pid1=")
	if pid0 == "" || pid1 == "" {
		t.Fatalf("missing phase markers; result file:\n%s", data)
	}
	if pid0 != pid1 {
		t.Fatalf("same-PID re-exec violated: pid0=%s pid1=%s\n%s", pid0, pid1, data)
	}
	// The child proves the handoff from its own descriptor before it tries the
	// port, so a port it could not take back — with the socket provably closed — is
	// the machine's doing and not a fault. Skipping says so; failing would put a
	// name in the flaky queue that belongs to whatever else was opening sockets.
	if strings.Contains(data, "SKIP phase1 rebind:") {
		machineload.Skip(t, "the handoff held, but the port could not be taken back:\n%s", data)
	}
	if !strings.Contains(data, "rebound=ok") {
		t.Fatalf("port was not re-bound after exec (CLOEXEC handoff failed):\n%s", data)
	}
	if !strings.Contains(data, "gen=1") {
		t.Fatalf("relaunch generation did not increment to 1:\n%s", data)
	}
}

func readFileBestEffort(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

// fieldValue returns the token following the first occurrence of key in a
// whitespace-separated dump (e.g. fieldValue("pid0=12 port=7", "pid0=") → "12").
func fieldValue(data, key string) string {
	for _, tok := range strings.Fields(data) {
		if v, ok := strings.CutPrefix(tok, key); ok {
			return v
		}
	}
	return ""
}
