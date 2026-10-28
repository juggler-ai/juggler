//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Some things are meant to run until they are stopped: a dev server, a patch
// host an extension embeds in a pinboard pin. Every other background task is
// capped at maxExecTimeoutMs; `timeout: -1` is how a caller asks for no
// deadline at all, and these are the properties that has to have.

// stopBudget is how long these tests give a task that is supposed to end, and it
// is far longer than any of them needs: a killed `sleep` is gone in
// milliseconds. The property under test is that the task ends at all, never how
// soon — the suite runs race-instrumented alongside three other packages
// spawning processes of their own, where seconds of scheduling latency say
// nothing about the code.
const stopBudget = 20 * time.Second

// waitForNotRunning polls until the task leaves "running", or fails.
func waitForNotRunning(t *testing.T, id string, deadline time.Duration) TaskSnapshot {
	t.Helper()
	stop := time.After(deadline)
	for {
		s := TaskState(id)
		if s.Status != "running" {
			return s
		}
		select {
		case <-stop:
			t.Fatalf("task %s never stopped running", id)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// startNoDeadlineTask starts a task with the sentinel and waits for it to be up.
func startNoDeadlineTask(t *testing.T) (*ShellOperations, string) {
	t.Helper()
	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	res, err := shellOps.startBackground(map[string]any{
		"command": "echo ready; sleep 30",
		"timeout": float64(noDeadlineTimeoutMs),
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	if id == "" {
		t.Fatalf("startBackground returned no task_id: %+v", res)
	}
	t.Cleanup(func() { KillTask(id) })
	waitForOutput(t, id, "ready", stopBudget)
	return shellOps, id
}

// What this guards is not the twenty-minute cap, which no test can sit through —
// it is that the sentinel never reaches context.WithTimeout, where a negative
// duration is an expired one and the task asking to run forever would be the one
// task that died instantly. Still running a beat later is the whole claim.
func TestStartBackground_NoDeadlineKeepsRunning(t *testing.T) {
	requirePOSIXShell(t)
	_, id := startNoDeadlineTask(t)

	time.Sleep(750 * time.Millisecond)

	if s := TaskState(id); s.Status != "running" {
		t.Fatalf("task with no deadline stopped on its own: status=%q error=%q", s.Status, s.Error)
	}
}

// No deadline must not mean no way out: cancel is still the only thing that ends
// the task, and kill is still what calls it.
func TestStartBackground_NoDeadlineStillKillable(t *testing.T) {
	requirePOSIXShell(t)
	shellOps, id := startNoDeadlineTask(t)

	res, err := shellOps.kill(map[string]any{"shellId": id})
	if err != nil {
		t.Fatalf("kill failed: %v", err)
	}
	if killed, _ := res.(map[string]any)["killed"].(bool); !killed {
		t.Fatalf("kill did not report killing the task: %+v", res)
	}

	waitForNotRunning(t, id, stopBudget)
}

// The sentinel is one exact value, and everything either side of it is still an
// ordinary duration — a task asked to stop soon must still stop soon, and take
// what it started with it.
//
// The command backgrounds a subshell that keeps writing to a file, because the
// deadline is enforced by exec.CommandContext, which kills only the `sh` it
// started. setProcGroup put that shell in its own process group, so a child it
// leaves behind survives the leader — and holds the output pipe's write end open,
// which is what cmd.Wait() waits on. Both halves are asserted here: the task
// reaches a terminal status, and the file stops growing once it has.
func TestStartBackground_OrdinaryTimeoutStillExpires(t *testing.T) {
	requirePOSIXShell(t)
	dir := t.TempDir()
	ticks := filepath.Join(dir, "ticks")
	shellOps := NewShellOperations(NewPathScope(dir, nil))
	res, err := shellOps.startBackground(map[string]any{
		"command": "(while true; do echo tick >> ticks; sleep 0.1; done) & sleep 30",
		"timeout": float64(300),
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	t.Cleanup(func() { KillTask(id) })

	s := waitForNotRunning(t, id, stopBudget)
	if s.Status != "failed" {
		t.Errorf("timed-out task status = %q, want failed", s.Status)
	}

	// Twenty ticks' worth of quiet: a survivor writes every 100ms, so growth here
	// is a child the deadline failed to reach, however loaded the machine is.
	settled := fileSize(t, ticks)
	time.Sleep(2 * time.Second)
	if grown := fileSize(t, ticks); grown != settled {
		t.Errorf("something the task started outlived its deadline: %s grew from %d to %d bytes",
			ticks, settled, grown)
	}
}

// fileSize reports a file's size, treating "not there at all" as empty.
func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info.Size()
}

// And when the deadline cannot reach what the task started — a grandchild that
// left the process group entirely, and holds the output pipe's write end open —
// the task must still end. cmd.Wait() waits on every holder of that pipe, so the
// teardown is bounded by the reap grace and closes the pipe itself rather than
// leaving the task at "running" for as long as the escapee cares to live.
func TestStartBackground_TimeoutEndsTheTaskDespiteEscapedChild(t *testing.T) {
	requirePOSIXShell(t)
	// The escapee outlives the assertion below by a distance, so a teardown that
	// waited on it could not pass by luck.
	escaped := escapeGroupSleep("15")
	if escaped == "" {
		t.Skip("no setsid/perl available to launch a group-escaping child")
	}

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	shellOps.reapGrace = 300 * time.Millisecond // measure boundedness, not the real 7s
	res, err := shellOps.startBackground(map[string]any{
		"command": escaped + " & sleep 30",
		"timeout": float64(300),
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	t.Cleanup(func() { KillTask(id) })

	start := time.Now()
	s := waitForNotRunning(t, id, stopBudget)
	// Generous against the 300ms deadline + 300ms reap grace, and still far short
	// of the escapee's own 15s: an unbounded wait can only land the wrong side.
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("the task waited on the escaped child: took %v to reach a terminal status", elapsed)
	}
	if s.Status != "failed" {
		t.Errorf("timed-out task status = %q, want failed", s.Status)
	}
	if s.Error == "" {
		t.Errorf("timed-out task reported no error: %+v", s)
	}
}

// A caller who types 0 meaning "forever" gets a task that dies at once, which is
// exactly why 0 could not be the sentinel. Pinned so nobody later decides it
// should mean forever after all without noticing what it already means.
func TestStartBackground_ZeroTimeoutIsNotForever(t *testing.T) {
	requirePOSIXShell(t)
	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	res, err := shellOps.startBackground(map[string]any{
		"command": "sleep 30",
		"timeout": float64(0),
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	t.Cleanup(func() { KillTask(id) })

	waitForNotRunning(t, id, stopBudget)
}

// The sentinel is only meaningful where something outlives the call that made
// it. A foreground command must say so rather than read -1 as a duration and
// return instantly, which is the same answer a command that ran and produced
// nothing would give.
func TestExecuteRefusesNoDeadline(t *testing.T) {
	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))

	for _, params := range []map[string]any{
		{"command": "echo hello", "timeout": float64(noDeadlineTimeoutMs)},
		{"code": "print('hello')", "timeout": float64(noDeadlineTimeoutMs)},
	} {
		if _, err := shellOps.execute(context.Background(), params); err == nil {
			t.Errorf("execute(%+v) accepted the no-deadline sentinel", params)
		}
	}
}

func TestWantsNoDeadline(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]any
		want   bool
	}{
		{"sentinel", map[string]any{"timeout": float64(-1)}, true},
		{"absent", map[string]any{}, false},
		{"zero", map[string]any{"timeout": float64(0)}, false},
		{"ordinary", map[string]any{"timeout": float64(5000)}, false},
		{"other negative", map[string]any{"timeout": float64(-2)}, false},
		{"wrong type", map[string]any{"timeout": "-1"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, err := decodeParams[shellParams](tc.params)
			if err != nil {
				t.Fatal(err)
			}
			if got := wantsNoDeadline(p.Timeout); got != tc.want {
				t.Errorf("wantsNoDeadline(%+v) = %v, want %v", tc.params, got, tc.want)
			}
		})
	}
}
