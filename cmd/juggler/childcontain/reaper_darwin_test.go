//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package childcontain_test

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// helperModeEnv selects the behaviour of the helper process the reaper tests
// spawn. Empty means "this is an ordinary test run", so TestHelperProcess skips.
const helperModeEnv = "JUGGLER_CHILDCONTAIN_HELPER"

// TestHelperProcess is not a test. It is the body of the short-lived helper
// process the reaper tests spawn: it contains a child, then dies by SIGKILL
// without unwinding — the crash / force-quit / kill -9 case that runs no
// cleanup code. The sentinel child is `sleep`, which has no stdio pipes to
// break and no reason to notice its parent is gone, so it survives
// indefinitely unless something explicitly kills it.
func TestHelperProcess(t *testing.T) {
	mode := os.Getenv(helperModeEnv)
	if mode == "" {
		t.Skip("not a helper invocation")
	}

	cmd := exec.Command("sleep", "600")
	child, err := start(cmd)
	if err != nil {
		fmt.Fprintf(os.Stderr, "helper: start: %v\n", err)
		os.Exit(2)
	}
	if mode == "release" {
		// Deregister without killing: the reaper must then leave this pid
		// alone, because by the time the parent dies the pid may belong to
		// something else entirely.
		child.Cleanup()
	}
	fmt.Printf("SENTINEL %d\n", cmd.Process.Pid)

	_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
	select {} // unreachable; keeps the helper from exiting cleanly if the kill races
}

var sentinelRE = regexp.MustCompile(`SENTINEL (\d+)`)

// runHelper starts the helper process in the given mode, waits for it to die,
// and returns the pid of the sentinel child it left behind.
func runHelper(t *testing.T, mode string) int {
	t.Helper()

	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperProcess$")
	cmd.Env = append(os.Environ(), helperModeEnv+"="+mode)
	// The helper SIGKILLs itself, so a non-nil error is the expected outcome;
	// what matters is the sentinel pid it printed before dying.
	out, _ := cmd.Output()

	m := sentinelRE.FindSubmatch(out)
	if m == nil {
		t.Fatalf("helper (mode=%s) printed no sentinel pid; output: %s", mode, out)
	}
	pid, err := strconv.Atoi(string(m[1]))
	if err != nil {
		t.Fatalf("unparsable sentinel pid %q: %v", m[1], err)
	}
	t.Cleanup(func() {
		// Never leave a stray sleep behind, whatever the test concluded.
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = syscall.Kill(pid, syscall.SIGKILL)
	})
	return pid
}

// processAlive reports whether pid still exists. Signal 0 performs the
// permission and existence checks without delivering anything.
func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// waitForExit polls until pid is gone or the deadline passes.
func waitForExit(pid int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return !processAlive(pid)
}

// TestReaper_KillsContainedChildWhenParentIsHardKilled is the macOS stand-in
// for Linux's Pdeathsig and Windows' kill-on-job-close: a parent that dies
// without running any cleanup must not leave its contained children behind.
func TestReaper_KillsContainedChildWhenParentIsHardKilled(t *testing.T) {
	pid := runHelper(t, "contain")

	if !waitForExit(pid, 10*time.Second) {
		t.Fatalf("contained child %d survived the parent's SIGKILL", pid)
	}
}

// TestReaper_LeavesReleasedChildAlone guards the one genuinely dangerous
// failure mode: killing a pid we no longer own. Once a child has been released
// via Cleanup, its pid may be recycled by an unrelated process, so the reaper
// must have forgotten it by the time the parent dies.
func TestReaper_LeavesReleasedChildAlone(t *testing.T) {
	pid := runHelper(t, "release")

	// Give the reaper the same window it gets in the contain case; a wrongly
	// remembered pid would be killed well inside it.
	if waitForExit(pid, 3*time.Second) {
		t.Fatalf("released child %d was killed; the reaper must forget released pids", pid)
	}
}
