//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"juggler/internal/logpaths"
	"juggler/internal/srcroot"
	"juggler/tests/helpers"
)

// TestServerHonorsLogFileFlagPerInstance boots two real headless servers on two
// distinct projects, each with its own --log-file, and proves the production
// logging contract end-to-end:
//
//   - --log-file is honored: each server's structured log lands at the path it
//     was given, and the centrally-derived default path is left untouched.
//   - One process → one file: each file carries exactly one instance header
//     with its own project, and neither file contains the other server's
//     project path — so two concurrent instances never interleave.
//
// The path-derivation and rotation logic themselves are covered by unit tests
// (internal/logpaths, internal/jlog); this test covers the live wiring those
// units can't: that a spawned binary actually routes jlog through the flag.
func TestServerHonorsLogFileFlagPerInstance(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns the juggler binary; skipped in -short mode")
	}

	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("find project root: %v", err)
	}
	binary := helpers.ServerBinary(root)
	if _, err := os.Stat(binary); err != nil {
		t.Fatalf("server binary not built at %s (run make go-build): %v", binary, err)
	}

	projA, projB := t.TempDir(), t.TempDir()
	logA := filepath.Join(t.TempDir(), "a", "server.log")
	logB := filepath.Join(t.TempDir(), "b", "server.log")

	srvA := startHeadlessServer(t, binary, projA, logA)
	defer srvA.stop()
	srvB := startHeadlessServer(t, binary, projB, logB)
	defer srvB.stop()

	// Both reached the JUGGLER_ADDR phase, which runs after initLogging — so the
	// instance header is already on disk. A short poll absorbs file-flush jitter.
	contentA := waitForHeader(t, logA)
	contentB := waitForHeader(t, logB)

	// Flag honored: the override path was written, the derived default was not.
	if got := logpaths.ServerLogPath(projA); fileHasContent(got) {
		t.Errorf("derived default %s was written despite --log-file override", got)
	}

	// Each file self-describes as a server instance for its own project.
	assertHeader(t, "A", contentA, projA)
	assertHeader(t, "B", contentB, projB)

	// No interleave: neither instance's file mentions the other's project.
	if strings.Contains(contentA, projB) {
		t.Errorf("log A unexpectedly contains project B path %q (interleave)", projB)
	}
	if strings.Contains(contentB, projA) {
		t.Errorf("log B unexpectedly contains project A path %q (interleave)", projA)
	}
}

type headlessServer struct {
	t   *testing.T
	cmd *exec.Cmd
}

// startHeadlessServer spawns `juggler --standalone --window=false --port 0
// --project <proj> --log-file <logFile>` — one project's server in its own
// process — and returns once it prints JUGGLER_ADDR (its deterministic "bound
// and serving" signal — the same channel the desktop app reads on spawn).
func startHeadlessServer(t *testing.T, binary, proj, logFile string) *headlessServer {
	t.Helper()
	cmd := exec.Command(binary,
		"--standalone", "--window=false", "--port", "0",
		"--project", proj, "--log-file", logFile)
	cmd.Env = os.Environ()
	helpers.SetProcGroupAttr(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", binary, err)
	}

	addrCh := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if after, ok := strings.CutPrefix(sc.Text(), "JUGGLER_ADDR="); ok {
				addrCh <- after
				return
			}
		}
	}()

	hs := &headlessServer{t: t, cmd: cmd}
	select {
	case <-addrCh:
		return hs
	case <-time.After(45 * time.Second):
		hs.stop()
		t.Fatalf("timeout waiting for JUGGLER_ADDR from server for %s", proj)
		return nil
	}
}

func (s *headlessServer) stop() {
	if s == nil || s.cmd == nil || s.cmd.Process == nil {
		return
	}
	helpers.SignalGroup(s.cmd, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		_ = s.cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		helpers.SignalGroup(s.cmd, syscall.SIGKILL)
	}
}

// waitForHeader polls path until it contains the jlog instance banner, returning
// the file's content. The banner is written synchronously in jlog.Init, before
// the server binds, so this resolves almost immediately after readiness.
func waitForHeader(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		b, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(b), "===== juggler ") {
			return string(b)
		}
		if time.Now().After(deadline) {
			t.Fatalf("log file %s never got an instance header (err=%v, content=%q)", path, err, string(b))
			return ""
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func assertHeader(t *testing.T, label, content, proj string) {
	t.Helper()
	if !strings.Contains(content, "component=server") {
		t.Errorf("log %s header missing component=server: %q", label, firstLine(content))
	}
	if !strings.Contains(content, "project="+proj) {
		t.Errorf("log %s header missing project=%s: %q", label, proj, firstLine(content))
	}
}

func fileHasContent(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Size() > 0
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
