//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"testing"
	"time"
)

// awaitChunk drains the output channel until it receives a chunk for which
// match returns true, or fails the test on timeout / channel close. Asserting
// by *receiving the expected chunk* (rather than sleeping then checking) keeps
// the test deterministic.
func awaitChunk(t *testing.T, out <-chan ShellStreamChunk, what string, match func(ShellStreamChunk) bool) ShellStreamChunk {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case c, ok := <-out:
			if !ok {
				t.Fatalf("output channel closed before %s arrived", what)
			}
			if match(c) {
				return c
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// drain consumes the rest of the channel until it closes, returning all chunks.
func drain(out <-chan ShellStreamChunk) []ShellStreamChunk {
	var chunks []ShellStreamChunk
	for c := range out {
		chunks = append(chunks, c)
	}
	return chunks
}

// TestExecuteStreaming_NeutralHeartbeat verifies that a command which stays
// silent without exiting emits a neutral Status:"running" chunk (no permission
// claim), driven by the injectable short heartbeat interval. The probe returns
// at once, so the awaiting-permission path must NOT fire. It is injected rather
// than the real stat, which a busy disk can hold past any short deadline.
func TestExecuteStreaming_NeutralHeartbeat(t *testing.T) {
	requirePOSIXShell(t)

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))
	shellOps.probeFn = func(string) {}
	// probeDeadline < heartbeatInterval, both well inside the command's sleep.
	shellOps.probeDeadline = 300 * time.Millisecond
	shellOps.heartbeatInterval = 600 * time.Millisecond

	// The command is stopped and drained before the test returns: it runs in
	// the temp dir, which Windows will not remove while a process works in it.
	ctx, cancel := context.WithCancel(context.Background())
	out := make(chan ShellStreamChunk, 64)
	go shellOps.ExecuteStreaming(ctx, "shell-hb", "", "sleep 2", "", 30000, out)
	defer func() {
		cancel()
		for range out {
		}
	}()

	c := awaitChunk(t, out, `Status:"running"`, func(c ShellStreamChunk) bool {
		return c.Status != ""
	})
	if c.Status != "running" {
		t.Fatalf("expected neutral Status \"running\", got %q (hint %q)", c.Status, c.Hint)
	}
	if c.Done || c.Data != "" {
		t.Fatalf("status chunk must be non-done with empty data, got %+v", c)
	}
}

// TestExecuteStreaming_AwaitingPermission verifies the permission-specific
// signal: when the filesystem-access probe BLOCKS while the command is silent,
// a Status:"awaiting-permission" chunk is emitted. We inject a probe that
// blocks on a channel the test controls (a real macOS TCC consent dialog can't
// be simulated through the stack, so a Go-level injectable blocking probe is
// the correct way to exercise this path). Once released, the command completes
// normally.
func TestExecuteStreaming_AwaitingPermission(t *testing.T) {
	requirePOSIXShell(t)

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))
	shellOps.probeDeadline = 20 * time.Millisecond
	shellOps.heartbeatInterval = 5 * time.Second // long: must not fire first

	release := make(chan struct{})
	shellOps.probeFn = func(string) { <-release }

	out := make(chan ShellStreamChunk, 64)
	// Command is silent long enough for the probe to block past its deadline.
	go shellOps.ExecuteStreaming(context.Background(), "shell-perm", "", "sleep 0.5", "", 30000, out)

	c := awaitChunk(t, out, `Status:"awaiting-permission"`, func(c ShellStreamChunk) bool {
		return c.Status != ""
	})
	if c.Status != "awaiting-permission" {
		t.Fatalf("expected Status \"awaiting-permission\", got %q (hint %q)", c.Status, c.Hint)
	}
	if c.Done || c.Data != "" {
		t.Fatalf("status chunk must be non-done with empty data, got %+v", c)
	}

	// Release the blocked probe and assert the command still completes cleanly.
	close(release)
	done := awaitChunk(t, out, "completion chunk", func(c ShellStreamChunk) bool {
		return c.Done
	})
	if done.Error != "" || done.ExitCode != 0 {
		t.Fatalf("expected clean completion, got error=%q exitCode=%d", done.Error, done.ExitCode)
	}
}

// TestExecuteStreaming_NoStatusWhenChatty verifies the negative case: once a
// command has written output the watchdog stands down for good, so no status
// chunk ever follows a data chunk. The probe blocks for the whole run and the
// command outlives both deadlines after it prints, so a watchdog still running
// would certainly claim permission. What is asserted is the order, never a
// race against the shell's start-up: a shell slow enough to print after a
// deadline earns that status first, which is the watchdog working, not
// failing.
func TestExecuteStreaming_NoStatusWhenChatty(t *testing.T) {
	requirePOSIXShell(t)

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))
	release := make(chan struct{})
	shellOps.probeFn = func(string) { <-release }
	shellOps.probeDeadline = 300 * time.Millisecond
	shellOps.heartbeatInterval = 600 * time.Millisecond

	out := make(chan ShellStreamChunk, 64)
	go shellOps.ExecuteStreaming(context.Background(), "shell-chatty", "", "printf 'hello world\\n'; sleep 1.5", "", 30000, out)

	chunks := drain(out)
	close(release)
	sawData := false
	for _, c := range chunks {
		switch {
		case c.Data != "":
			sawData = true
		case c.Status != "" && sawData:
			t.Fatalf("a status chunk followed the command's output: %+v", c)
		}
	}
	if !sawData {
		t.Fatalf("the command's output never arrived: %+v", chunks)
	}
}
