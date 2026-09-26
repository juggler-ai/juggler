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
)

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
		t.Skipf("the handoff held, but the port could not be taken back:\n%s", data)
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
