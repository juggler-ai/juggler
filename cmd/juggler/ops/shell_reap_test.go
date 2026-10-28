//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

// escapeGroupPrefix returns a shell prefix that runs its argument in a NEW
// session (hence a new process group), so a child launched through it is not
// reaped by a SIGKILL aimed at the leader's process group. Linux ships setsid(1);
// macOS does not, but its perl has POSIX::setsid. Returns "" if neither exists.
func escapeGroupSleep(seconds string) string {
	if _, err := exec.LookPath("setsid"); err == nil {
		return "setsid sleep " + seconds
	}
	if _, err := exec.LookPath("perl"); err == nil {
		return "perl -e 'use POSIX; POSIX::setsid(); sleep " + seconds + "'"
	}
	return ""
}

// TestExecuteStreaming_TimeoutReturnsDespiteEscapedChild guards the fix for the
// unbounded-wait defect on the cancel/timeout branch. A command can spawn a
// grandchild that escapes its process group and inherits the output pipe's write
// end. On timeout, killProcessGroup only reaches the leader's group, so that
// grandchild survives and keeps the pipe open — which used to wedge `<-cmdDone`
// (cmd.Wait blocks until every pipe-fd holder exits) and `readerWG.Wait()` until
// the grandchild exited on its own, long past the deadline. The teardown must
// instead be bounded by killGrace + reapGrace and return promptly, well before
// the grandchild's own lifetime elapses.
func TestExecuteStreaming_TimeoutReturnsDespiteEscapedChild(t *testing.T) {
	requirePOSIXShell(t)
	// The escaped grandchild sleeps far longer than the test's own bound, so if
	// teardown ever waited on it the test would blow past the assertion below.
	escaped := escapeGroupSleep("15")
	if escaped == "" {
		t.Skip("no setsid/perl available to launch a group-escaping child")
	}

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))
	// Tiny teardown grace so the test measures boundedness, not the real 5s+7s.
	shellOps.killGrace = 50 * time.Millisecond
	shellOps.reapGrace = 300 * time.Millisecond

	// Leader is silent and outlives its 200ms timeout; before its own sleep it
	// launches the group-escaping grandchild, which inherits (and holds open) the
	// stdout pipe. The foreground `sleep 5` stays in the leader's group and is
	// reaped normally; only the escaped child lingers, and it must NOT gate return.
	command := escaped + " & sleep 5"

	out := make(chan ShellStreamChunk, 64)
	returned := make(chan ShellStreamChunk, 1)
	go func() {
		var last ShellStreamChunk
		for c := range out {
			if c.Done {
				last = c
			}
		}
		returned <- last
	}()

	start := time.Now()
	shellOps.ExecuteStreaming(context.Background(), "shell-reap", "", command, "", 200, out)
	elapsed := time.Since(start)

	// Bound: 200ms timeout + 50ms kill grace + 300ms reap grace + generous slack.
	// The pre-fix code returned only after the escaped `sleep 15` exited (~15s).
	if elapsed > 5*time.Second {
		t.Fatalf("ExecuteStreaming did not return promptly on timeout with an escaped child: took %v", elapsed)
	}

	done := <-returned
	if done.ShellID != "shell-reap" || !done.Done {
		t.Fatalf("expected a terminal Done chunk, got %+v", done)
	}
	if done.Error == "" {
		t.Fatalf("timed-out command must report an error, got clean completion: %+v", done)
	}
}

// TestExecute_TimeoutReturnsDespiteEscapedChild is the foreground twin of the
// test above, and the promise matters more here: this is the path a user is
// waiting on when they press Escape, and the handler goroutine serving them is
// what a wedged teardown holds. The mechanism is the same — cmd.Stdout is a
// cappedBuffer rather than an *os.File, so os/exec's copier and cmd.Wait() stay
// blocked until every holder of the internal pipe has gone, and a grandchild
// that escaped the process group is not reached by the kill.
func TestExecute_TimeoutReturnsDespiteEscapedChild(t *testing.T) {
	requirePOSIXShell(t)
	escaped := escapeGroupSleep("15")
	if escaped == "" {
		t.Skip("no setsid/perl available to launch a group-escaping child")
	}

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))
	// Tiny grace so the test measures boundedness, not the real 7s.
	shellOps.reapGrace = 300 * time.Millisecond

	start := time.Now()
	_, err := shellOps.execute(context.Background(), map[string]any{
		"command": escaped + " & sleep 5",
		"timeout": float64(200),
	})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("a command killed by its deadline must report an error, not a clean result")
	}
	// Bound: 200ms timeout + 300ms reap grace + generous slack. Unbounded, this
	// returned only once the escaped `sleep 15` had gone.
	if elapsed > 5*time.Second {
		t.Fatalf("execute did not return promptly on timeout with an escaped child: took %v", elapsed)
	}
}
