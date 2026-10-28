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

	"juggler/internal/jlog"
	"juggler/internal/logpaths"
	"juggler/internal/srcroot"
	"juggler/tests/helpers"
)

// TestServerWritesNestedProjectLog boots a real headless server WITHOUT
// --log-file, pointing the log directory at a throwaway temp dir via
// JUGGLER_LOG_DIR. It proves the new per-project folder layout end-to-end: a
// server with no log-file override writes its structured log to
// <log-dir>/<slug>/server.log — inside the project's own folder, not flat in
// the log directory — and the derived path resolves identically in-process and
// in the spawned binary.
func TestServerWritesNestedProjectLog(t *testing.T) {
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

	// Point logs at a throwaway dir. t.Setenv also flows into the child via
	// os.Environ() at spawn, so server and test agree on the derived path.
	logDir := t.TempDir()
	t.Setenv("JUGGLER_LOG_DIR", logDir)

	proj := t.TempDir()
	want := logpaths.ServerLogPath(proj) // <logDir>/<slug>/server.log

	// The project log must live in its own sub-folder, not flat in logDir.
	folder := filepath.Dir(want)
	if filepath.Dir(folder) != logDir {
		t.Fatalf("server log %q not in a per-project folder directly under %q", want, logDir)
	}
	if filepath.Base(want) != "server.log" {
		t.Fatalf("server log base = %q, want server.log", filepath.Base(want))
	}

	cmd := exec.Command(binary, "--standalone", "--window=false", "--port", "0", "--project", proj)
	cmd.Env = os.Environ() // includes JUGGLER_LOG_DIR
	helpers.SetProcGroupAttr(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", binary, err)
	}
	defer func() {
		helpers.SignalGroup(cmd, syscall.SIGTERM)
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			helpers.SignalGroup(cmd, syscall.SIGKILL)
		}
	}()

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
	select {
	case <-addrCh:
	case <-time.After(45 * time.Second):
		t.Fatalf("timeout waiting for JUGGLER_ADDR")
	}

	// initLogging runs before the address is printed, so the header is already
	// on disk at the derived nested path.
	content := waitForHeader(t, want)
	assertHeader(t, "nested", content, proj)
}

// TestPerConversationLogsAreSeparate proves the separation seam that the worker
// relies on: two conversations resolve to distinct files under the same
// project's conversations/ folder (logpaths.ConversationLogPath), and writing
// through one jlog.Logger never bleeds into the other's file. This is the
// property that makes per-conversation logs readable in isolation; the worker
// wiring that opens these sinks is exercised end-to-end by the browser suite.
func TestPerConversationLogsAreSeparate(t *testing.T) {
	base := t.TempDir()
	t.Setenv("JUGGLER_LOG_DIR", base)

	const proj = "/tmp/example/myproj"
	const idA, idB = "conv_aaaaaaaaa", "conv_bbbbbbbbb"
	pathA := logpaths.ConversationLogPath(proj, idA, "")
	pathB := logpaths.ConversationLogPath(proj, idB, "")

	if pathA == pathB {
		t.Fatalf("distinct conversations resolved to the same log path %q", pathA)
	}
	if filepath.Dir(pathA) != filepath.Dir(pathB) {
		t.Fatalf("conversation logs not in the same conversations/ folder: %q vs %q", pathA, pathB)
	}
	if filepath.Base(filepath.Dir(pathA)) != "conversations" {
		t.Fatalf("conversation log %q not in a conversations/ folder", pathA)
	}

	la := jlog.NewLogger(pathA, 10, 5)
	lb := jlog.NewLogger(pathB, 10, 5)
	la.Info("alpha activity in %s", idA)
	lb.Info("beta activity in %s", idB)
	la.Close()
	lb.Close()

	readAll := func(p string) string {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %q: %v", p, err)
		}
		return string(b)
	}
	contentA, contentB := readAll(pathA), readAll(pathB)

	if !strings.Contains(contentA, "alpha activity") || !strings.Contains(contentA, idA) {
		t.Errorf("conversation A log missing its own line: %q", contentA)
	}
	if strings.Contains(contentA, "beta activity") || strings.Contains(contentA, idB) {
		t.Errorf("conversation A log leaked conversation B content: %q", contentA)
	}
	if !strings.Contains(contentB, "beta activity") || !strings.Contains(contentB, idB) {
		t.Errorf("conversation B log missing its own line: %q", contentB)
	}
	if strings.Contains(contentB, "alpha activity") || strings.Contains(contentB, idA) {
		t.Errorf("conversation B log leaked conversation A content: %q", contentB)
	}
}
