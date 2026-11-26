//go:build darwin

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"juggler/internal/logpaths"
)

// --- where the sample lands (pure) ---

func TestStallSamplePath(t *testing.T) {
	at := time.Date(2026, 8, 30, 7, 29, 6, 0, time.UTC)

	if got := stallSamplePath("", at); got != "" {
		t.Fatalf("stallSamplePath with logging disabled = %q; want \"\" — no log, no sample", got)
	}

	got := stallSamplePath(filepath.Join("/logs", "myproj-a1b2", "server.log"), at)
	want := filepath.Join("/logs", "myproj-a1b2", "mainthread-stall-20260830-072906.sample.log")
	if got != want {
		t.Fatalf("stallSamplePath = %q; want %q", got, want)
	}
}

// TestStallSampleIsSweptWithTheLogs pins the reason the sample file is named
// "*.log" rather than "*.txt": the startup sweep in internal/logpaths deletes
// Juggler's own log files once they age out, and the sample is meant to age out
// with the log that explains it. A name the sweep does not recognise would sit
// in the log folder forever, one file per wedge, with nothing to collect it.
func TestStallSampleIsSweptWithTheLogs(t *testing.T) {
	dir := t.TempDir()
	path := stallSamplePath(filepath.Join(dir, "server.log"), time.Now())
	if err := os.WriteFile(path, []byte("stacks"), 0o644); err != nil {
		t.Fatalf("write sample: %v", err)
	}
	old := time.Now().Add(-30 * 24 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatalf("age sample: %v", err)
	}

	if n := logpaths.SweepOldLogs(dir, 14*24*time.Hour, time.Now()); n != 1 {
		t.Fatalf("SweepOldLogs removed %d files; want 1 — the sample is not swept with the logs", n)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stale sample survived the sweep: %v", err)
	}
}

// --- settling before the image is replaced ---

func TestSettleOnNilSampleIsImmediate(t *testing.T) {
	var s *stallSample
	if !s.settle(time.Hour) {
		t.Fatal("settle on a nil sample reported failure — nothing was started, so there is nothing to wait for")
	}
}

func TestSettleWaitsForACompletedSample(t *testing.T) {
	done := make(chan struct{})
	close(done)
	killed := false
	s := &stallSample{done: done, cancel: func() { killed = true }}

	if !s.settle(time.Hour) {
		t.Fatal("settle reported failure on a finished sample")
	}
	if killed {
		t.Fatal("settle killed a sampler that had already finished")
	}
}

// TestSettleKillsAnOverrunningSampler is the guard on the misleading-artifact
// hazard. The re-exec that follows keeps this pid, so a sampler still running
// when the image is replaced goes on sampling the same number — by then a
// healthy new server — and writes a file that reads like the wedge but is half
// its replacement. The wait is bounded and the sampler dies with it.
func TestSettleKillsAnOverrunningSampler(t *testing.T) {
	killed := make(chan struct{})
	s := &stallSample{
		done:   make(chan struct{}), // never closed: the sampler is still going
		cancel: func() { close(killed) },
	}

	if s.settle(10 * time.Millisecond) {
		t.Fatal("settle claimed an unfinished sample had landed")
	}
	select {
	case <-killed:
	default:
		t.Fatal("settle gave up waiting but left the sampler running into the re-exec")
	}
}

// --- the sampler itself ---

// TestCaptureStallSampleWritesTheMainThread runs the real /usr/bin/sample
// against this test binary and checks the artifact actually names the thread
// the watchdog cares about. Sampling needs no privileges for a process the same
// user owns, but a hardened-runtime binary without get-task-allow refuses —
// which is exactly the difference this test would catch, so a refusal is
// reported rather than skipped.
func TestCaptureStallSampleWritesTheMainThread(t *testing.T) {
	if _, err := os.Stat(samplePath); err != nil {
		t.Skipf("no %s on this machine: %v", samplePath, err)
	}

	dir := t.TempDir()
	logPath := filepath.Join(dir, "server.log")
	s := captureStallSample(logPath, os.Getpid(), time.Now())
	if s == nil {
		t.Fatal("captureStallSample returned nothing with a writable log directory")
	}
	if !s.settle(stallSampleDuration + 30*time.Second) {
		t.Fatal("sample did not finish")
	}

	body, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatalf("read sample: %v", err)
	}
	if !strings.Contains(string(body), "com.apple.main-thread") {
		t.Fatalf("sample does not identify the main thread, so a wedge could not be read from it:\n%s",
			head(string(body), 400))
	}
}

// TestCaptureStallSampleSamplesThePeersToo: a stall sample covers the WebKit
// processes behind this one's pages, not only this one. The wedged main thread
// waits on rendering those processes commit, so its own stacks cannot say
// whether they are busy, blocked, or never asked. A stand-in process plays the
// web process, and the note on stderr has to name its sample, because that note
// is the only way the harness finds the file.
func TestCaptureStallSampleSamplesThePeersToo(t *testing.T) {
	if _, err := os.Stat(samplePath); err != nil {
		t.Skipf("no %s on this machine: %v", samplePath, err)
	}
	peer := exec.Command("/bin/sleep", "60")
	if err := peer.Start(); err != nil {
		t.Fatalf("start the stand-in web process: %v", err)
	}
	t.Cleanup(func() {
		_ = peer.Process.Kill()
		_ = peer.Wait()
	})

	logPath := filepath.Join(t.TempDir(), "server.log")
	s := captureStallSample(logPath, os.Getpid(), time.Now(), peer.Process.Pid)
	if s == nil {
		t.Fatal("captureStallSample returned nothing with a writable log directory")
	}
	if !s.settle(stallSampleDuration + 30*time.Second) {
		t.Fatal("sample did not finish")
	}
	if len(s.peers) != 1 {
		t.Fatalf("sampled %d peer processes; want the one it was given", len(s.peers))
	}
	body, err := os.ReadFile(s.peers[0])
	if err != nil {
		t.Fatalf("read the peer's sample: %v", err)
	}
	if !strings.Contains(string(body), "sleep") {
		t.Fatalf("the peer's sample is not of the peer:\n%s", head(string(body), 400))
	}
	if note := stallSampleNote(s, true); !strings.Contains(note, webKitSampleNotePrefix+s.peers[0]) {
		t.Fatalf("the stderr note does not name the peer's sample %s:\n%s", s.peers[0], note)
	}
}

func TestCaptureStallSampleIsSilentWithLoggingDisabled(t *testing.T) {
	if s := captureStallSample("", os.Getpid(), time.Now()); s != nil {
		t.Fatal("captureStallSample started a sampler with on-disk logging off")
	}
}

// TestSamplerArgsAreAccepted pins the argv shape against the installed sample(1)
// — a rejected flag would leave every future wedge with an empty file and a line
// in the log, discovered only when someone went looking for stacks that were
// never captured.
func TestSamplerArgsAreAccepted(t *testing.T) {
	if _, err := os.Stat(samplePath); err != nil {
		t.Skipf("no %s on this machine: %v", samplePath, err)
	}
	out, err := exec.Command(samplePath).CombinedOutput()
	// Bare `sample` exits non-zero with its usage; that usage is what we check.
	_ = err
	usage := string(out)
	for _, flag := range []string{"-file"} {
		if !strings.Contains(usage, flag) {
			t.Errorf("sample(1) usage no longer mentions %q:\n%s", flag, usage)
		}
	}
}

// --- the log path the sample hangs off ---

func TestStallSampleNameSortsBesideItsLog(t *testing.T) {
	// The stem must stay sortable and greppable: a wedge is found by listing
	// the project's log folder, not by knowing the filename in advance.
	name := filepath.Base(stallSamplePath("/logs/p/server.log", time.Now()))
	if !regexp.MustCompile(`^mainthread-stall-\d{8}-\d{6}\.sample\.log$`).MatchString(name) {
		t.Fatalf("sample filename %q does not match the documented shape", name)
	}
}

// head returns the first n bytes of s, for failure messages that would otherwise
// paste a thousand-line sample into the test log.
func head(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
