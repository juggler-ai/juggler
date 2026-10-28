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
// fast (a normal stat of the temp dir), so the awaiting-permission path must
// NOT fire.
func TestExecuteStreaming_NeutralHeartbeat(t *testing.T) {
	requirePOSIXShell(t)

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))
	// probeDeadline < heartbeatInterval, both tiny so the test is fast.
	shellOps.probeDeadline = 20 * time.Millisecond
	shellOps.heartbeatInterval = 80 * time.Millisecond

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

// TestExecuteStreaming_NoStatusWhenChatty verifies the negative case: a command
// that emits output promptly produces NO status chunk at all — the watchdog
// stands down on the first byte.
func TestExecuteStreaming_NoStatusWhenChatty(t *testing.T) {
	requirePOSIXShell(t)

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))
	// Probe deadline tiny (the probe still returns fast → never claims
	// permission); heartbeat generous so the only thing that can suppress a
	// status chunk is the first output byte, which a chatty command delivers.
	shellOps.probeDeadline = 20 * time.Millisecond
	shellOps.heartbeatInterval = 2 * time.Second

	out := make(chan ShellStreamChunk, 64)
	go shellOps.ExecuteStreaming(context.Background(), "shell-chatty", "", "printf 'hello world\\n'", "", 30000, out)

	for _, c := range drain(out) {
		if c.Status != "" {
			t.Fatalf("chatty command must not emit a status chunk, got %+v", c)
		}
	}
}
