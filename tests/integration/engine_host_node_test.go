//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"juggler/internal/enginehost"
	"juggler/internal/srcroot"
	"juggler/tests/helpers"
)

// TestNodeEngineHostBootsAndConnects is the node-engine-host conformance test.
// It boots the shipped server binary with JUGGLER_ENGINE_HOST=node and proves,
// end-to-end on the real binary, that the alternative (webview-free) host works:
//
//   - Choose picks the node host and logs the §3.2 boot one-liner naming it.
//   - the server snapshots the engine graph, spawns node, and the node-hosted
//     engine connects its WebSocket back within the readiness window.
//   - dynamically-loaded extension plugins load in node mode — i.e. the
//     asset-url.js `/worker-module` seam resolves — so the log carries none of
//     the "Cannot find module '/worker-module'" / "plugin(s) failed to load"
//     failures that the pre-fix node host produced.
//   - clean shutdown.
//
// It runs on every `make test` where node is present; when node is missing (or
// too old for the host, which the binary reports itself), it skips loudly so a
// node-less CI leg never silently drops node-mode coverage. This is also the
// diagnostics test bed: it asserts the boot log line names the right mode.
func TestNodeEngineHostBootsAndConnects(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns the juggler binary; skipped in -short mode")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found on PATH — skipping node engine-host conformance test " +
			"(install Node.js 22+ to exercise the headless engine host)")
	}
	out, err := exec.Command(node, "--version").Output()
	if err != nil {
		t.Skipf("node --version failed (%v) — skipping node engine-host conformance test", err)
	}
	version := strings.TrimSpace(string(out))
	major := 0
	if _, err := fmt.Sscanf(strings.TrimPrefix(version, "v"), "%d", &major); err != nil || major < enginehost.MinNodeMajor {
		t.Skipf("Node %s is too old — skipping node engine-host conformance test (need Node.js %d+)", version, enginehost.MinNodeMajor)
	}

	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("find project root: %v", err)
	}
	binary := helpers.ServerBinary(root)
	if _, err := os.Stat(binary); err != nil {
		t.Fatalf("server binary not built at %s (run make go-build): %v", binary, err)
	}

	proj := t.TempDir()
	logFile := t.TempDir() + "/node-engine.log"

	srv := startNodeEngineServer(t, binary, proj, logFile)
	defer srv.stop()

	// The node engine connects asynchronously after the server binds. Poll the
	// log for the readiness marker; node mode connected in well under a second
	// live, but allow generous slack for a cold CI runner (snapshot write + node
	// cold start + connect all happen here).
	logContent := waitForLogContains(t, logFile, "[engine] connected", 60*time.Second)

	// §3.2 boot one-liner must name node mode (the support-thread starting point,
	// and the reason we skip when node is absent — this must not rot).
	if !strings.Contains(logContent, "[engine] host: node") {
		t.Errorf("boot log did not name the node host; want a `[engine] host: node (...)` line.\n%s",
			tailLog(logContent))
	}

	// The node child's stdout/stderr is piped to jlog with an [engine-node]
	// prefix (§3.4); its WebSocket-connected line proves the hosted engine came
	// up, not merely that the process spawned.
	if !strings.Contains(logContent, "[engine-node]") {
		t.Errorf("no [engine-node] output in the log — node child stdout was not captured.\n%s",
			tailLog(logContent))
	}

	// Extension loading in node mode: the pre-fix host failed every dynamically
	// loaded plugin with a "/worker-module" resolution error. Assert those are
	// gone — the engine-loader-hooks seam is what makes node mode run every tool,
	// not just built-ins.
	for _, bad := range []string{
		"Cannot find module '/worker-module'",
		"plugin(s) failed to load",
	} {
		if strings.Contains(logContent, bad) {
			t.Errorf("node-mode log contains %q — extension loading regressed.\n%s", bad, tailLog(logContent))
		}
	}
}

// startNodeEngineServer spawns the headless server with JUGGLER_ENGINE_HOST=node
// and returns once it prints JUGGLER_ADDR (bound and serving). It mirrors
// startHeadlessServer but forces the node engine host via the environment.
func startNodeEngineServer(t *testing.T, binary, proj, logFile string) *headlessServer {
	t.Helper()
	cmd := exec.Command(binary,
		"--standalone", "--window=false", "--port", "0",
		"--project", proj, "--log-file", logFile)
	cmd.Env = append(os.Environ(), "JUGGLER_ENGINE_HOST=node")
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
		t.Fatalf("timeout waiting for JUGGLER_ADDR from node-mode server for %s", proj)
		return nil
	}
}

// waitForLogContains polls path until it contains marker, returning the file's
// content, or fails after timeout.
func waitForLogContains(t *testing.T, path, marker string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		b, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(b), marker) {
			return string(b)
		}
		if time.Now().After(deadline) {
			t.Fatalf("log %s never contained %q within %v (err=%v)\n%s",
				path, marker, timeout, err, tailLog(string(b)))
			return ""
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// tailLog returns the last ~40 lines of a log for failure context.
func tailLog(s string) string {
	lines := strings.Split(s, "\n")
	if len(lines) > 40 {
		lines = lines[len(lines)-40:]
	}
	return "--- log tail ---\n" + strings.Join(lines, "\n")
}
