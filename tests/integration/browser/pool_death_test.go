//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/tests/helpers"
)

// deadProc builds the liveness record of a subprocess that has already exited,
// with the given stderr contents on disk.
func deadProc(t *testing.T, stderr string, waitErr error) *poolProc {
	t.Helper()
	path := filepath.Join(t.TempDir(), "juggler-stderr-fake.log")
	if err := os.WriteFile(path, []byte(stderr), 0o644); err != nil {
		t.Fatal(err)
	}
	p := &poolProc{
		pid:        4242,
		stderrPath: path,
		started:    time.Now().Add(-90 * time.Second),
		exited:     make(chan struct{}),
		waitErr:    waitErr,
		exitedAt:   time.Now(),
	}
	close(p.exited)
	return p
}

// TestPoolDeathQuotesTheStderrTail guards the diagnostic that a pool subprocess
// death is otherwise invisible: its stderr goes to a file under the platform
// temp dir that no CI job reads, so unless the failing test quotes the tail,
// "connection refused" is the only evidence a reader ever gets — and that reads
// the same whether the server force-exited on the main-thread watchdog, quit
// gracefully, or was killed.
func TestPoolDeathQuotesTheStderrTail(t *testing.T) {
	var lines []string
	for i := 0; i < poolStderrTailLines+20; i++ {
		lines = append(lines, fmt.Sprintf("noise line %d", i))
	}
	lines = append(lines, "FATAL: main thread wedged — force-exiting so the next launch can recover.")
	srv := testServerEntry{addr: "127.0.0.1:1", proc: deadProc(t, strings.Join(lines, "\n"), errors.New("exit status 1"))}

	report := poolDeath(srv)
	for _, want := range []string{"4242", "exit status 1", "FATAL: main thread wedged"} {
		if !strings.Contains(report, want) {
			t.Errorf("post-mortem omits %q:\n%s", want, report)
		}
	}
	if strings.Contains(report, "noise line 0") {
		t.Errorf("post-mortem quoted the whole log instead of the last %d lines:\n%s", poolStderrTailLines, report)
	}

	// One post-mortem per subprocess: a dead pool fails every remaining test,
	// and a hundred copies of the same stderr tail buries it.
	again := poolDeath(srv)
	if strings.Contains(again, "FATAL: main thread wedged") {
		t.Errorf("second report repeated the full post-mortem:\n%s", again)
	}
	if !strings.Contains(again, "already dead") {
		t.Errorf("second report doesn't point at the first:\n%s", again)
	}
}

// stallSampleFixture is the shape /usr/bin/sample writes: a header, then a call
// graph in which each thread is a heading line followed by its "+" frames.
const stallSampleFixture = `Analysis of sampling juggler-testsrv (pid 4242) every 10 milliseconds
Process:         juggler-testsrv [4242]

Call graph:
    190 Thread_6908   DispatchQueue_1: com.apple.main-thread  (serial)
    + 190 start  (in dyld) + 6688  [0x18298be80]
    +   190 -[NSApplication run]  (in AppKit) + 396  [0x1873cb90c]
    +     190 -[WKWebView _wedgedHere]  (in WebKit) + 40  [0x1a0000000]
    190 Thread_7066: com.apple.NSEventThread
    + 190 thread_start  (in libsystem_pthread.dylib) + 8  [0x182d5ccec]
    +   190 _NSEventThread  (in AppKit) + 184  [0x1874fc844]

Total number in stack (recursive counted multiple times):
Binary Images:
       0x100000000 -        0x100ffffff +juggler-testsrv (0) <UUID> /bin/juggler-testsrv
`

// TestPoolDeathQuotesTheMainThreadSample guards the only record of what a
// wedged pool server's main thread was doing: the watchdog samples it before
// force-exiting and names the sample on stderr, but the sample lives in the
// pool's throwaway log dir, which is deleted when the run ends. The failing
// test must quote the main thread's stack, and the whole sample must be copied
// beside the stderr logs, which CI prints in full.
func TestPoolDeathQuotesTheMainThreadSample(t *testing.T) {
	samplePath := filepath.Join(t.TempDir(), "mainthread-stall-20261027-090139.sample.log")
	if err := os.WriteFile(samplePath, []byte(stallSampleFixture), 0o644); err != nil {
		t.Fatal(err)
	}
	stderr := "8:58AM INF Platform Info: MacOS\n" +
		stallSampleStderrPrefix + samplePath + "\n" +
		"\nFATAL: main thread wedged — force-exiting so the next launch can recover.\n"
	p := deadProc(t, stderr, errors.New("exit status 1"))

	report := poolDeath(testServerEntry{addr: "127.0.0.1:1", proc: p})
	for _, want := range []string{"com.apple.main-thread", "-[WKWebView _wedgedHere]"} {
		if !strings.Contains(report, want) {
			t.Errorf("post-mortem omits the main thread's %q:\n%s", want, report)
		}
	}
	for _, unwanted := range []string{"_NSEventThread", "Binary Images"} {
		if strings.Contains(report, unwanted) {
			t.Errorf("post-mortem quoted %q, beyond the main thread:\n%s", unwanted, report)
		}
	}

	kept := filepath.Join(filepath.Dir(p.stderrPath), "juggler-stall-sample-4242.log")
	data, err := os.ReadFile(kept)
	if err != nil {
		t.Fatalf("the full sample was not kept beside the stderr logs: %v\n%s", err, report)
	}
	if string(data) != stallSampleFixture {
		t.Errorf("the kept sample differs from the original:\n%s", data)
	}
	if !strings.Contains(report, kept) {
		t.Errorf("post-mortem doesn't say where the full sample is kept (%s):\n%s", kept, report)
	}
}

// TestPoolDeathIsSilentWhileTheServerLives keeps the report out of ordinary
// failures: a test that fails with its server running must not be told the pool
// died.
func TestPoolDeathIsSilentWhileTheServerLives(t *testing.T) {
	live := &poolProc{pid: 1, started: time.Now(), exited: make(chan struct{})}
	if got := poolDeath(testServerEntry{addr: "127.0.0.1:1", proc: live}); got != "" {
		t.Errorf("poolDeath spoke up for a living server: %q", got)
	}
	if got := poolDeath(testServerEntry{addr: "127.0.0.1:1"}); got != "" {
		t.Errorf("poolDeath spoke up for an entry with no liveness record: %q", got)
	}
}

// TestHarnessFailsFastAgainstAnExitedServer guards the cascade cost: the
// connect-window retry exists for a server that is not listening YET. Once the
// subprocess has exited it will never listen again, and paying the full window
// per test turned one death into minutes of CI time before anything was said.
func TestHarnessFailsFastAgainstAnExitedServer(t *testing.T) {
	// A port nothing is listening on: bind, read the address, close.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	srv := testServerEntry{addr: addr, proc: deadProc(t, "", errors.New("exit status 1"))}

	start := time.Now()
	if err := postToServer(srv, "/api/test/run", map[string]any{"name": "whatever"}); err == nil {
		t.Fatal("postToServer succeeded against a closed port")
	}
	if elapsed := time.Since(start); elapsed > helpers.PostConnectWindow/2 {
		t.Errorf("postToServer waited %s against an exited server; it should give up at once", elapsed)
	}

	start = time.Now()
	var out struct{ Passed bool }
	if err := pollServer(srv, "/api/test/result", 30*time.Second, &out); err == nil {
		t.Fatal("pollServer succeeded against a closed port")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("pollServer waited %s against an exited server; it should give up at once", elapsed)
	}
}
