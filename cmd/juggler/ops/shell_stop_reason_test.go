//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"testing"
	"time"
)

// A stop decides why a task ended, and the spawner's own terminal update always
// lands after it: cancelling the context is what makes the process exit, so
// cmd.Wait returns on a cancelled context and reports "command cancelled" a
// moment after the stop has already recorded who stopped it. The reason a stop
// recorded therefore has to survive the update that the stop itself provoked —
// it is what the user reads on the tool action for as long as the conversation
// lasts, and "command cancelled" names the mechanism rather than the cause.
//
// These drive the registry's ops directly and register no process. What is under
// test is which of two terminal writes the registry keeps, and a real process
// would make the order they arrive in a property of the machine: on a slow
// reaper the stop is read before the update overwrites it and the defect hides.

// registerStoppableShell puts a running task in the registry with no process
// behind it. Cancelling its context is the whole of what signalShellStop can do
// for a task that has not reached cmd.Start, which is exactly this shape.
func registerStoppableShell(t *testing.T, id, root string) {
	t.Helper()
	_, cancel := context.WithCancel(context.Background())
	registerBackgroundShell(&BackgroundShell{
		ID:          id,
		ConvID:      "conv-" + id,
		ToolUseID:   "tool-" + id,
		Command:     "sleep 60",
		ProjectRoot: root,
		cancel:      cancel,
		reaped:      make(chan struct{}),
		status:      "running",
	})
	t.Cleanup(func() { removeBackgroundShell(id) })
}

// TestUserStopKeepsItsReasonThroughTheSpawnersUpdate pins the panel's Stop. The
// spill accounting rides in on the same update and is still the spawner's to
// report, so only the verdict — status, exit code, reason — is pinned.
func TestUserStopKeepsItsReasonThroughTheSpawnersUpdate(t *testing.T) {
	const id = "bg-user-stop-reason"
	registerStoppableShell(t, id, t.TempDir())

	if !KillTask(id) {
		t.Fatalf("KillTask did not stop a running task")
	}

	// What startBackground's goroutine reports once cmd.Wait returns on the
	// context the kill above cancelled.
	updateShellStatus(id, "failed", "", -1, "command cancelled", "/spill/full.log", 4096, true)

	state := TaskState(id)
	if state.Error != "Killed by user" {
		t.Errorf("a task the user stopped ended saying %q, want %q", state.Error, "Killed by user")
	}
	if state.Status != "failed" || state.ExitCode != -1 {
		t.Errorf("stopped task ended as status %q exit %d, want %q exit %d", state.Status, state.ExitCode, "failed", -1)
	}
	if state.OutputFile != "/spill/full.log" || state.OutputBytes != 4096 || !state.OutputTruncated {
		t.Errorf("the spawner's spill accounting was dropped with its verdict: file %q bytes %d truncated %v",
			state.OutputFile, state.OutputBytes, state.OutputTruncated)
	}
}

// TestProjectStopKeepsItsReasonThroughTheSpawnersUpdate is the other stop path:
// shutdown passes its own wording, which the user reads to
// find out why something they never touched is no longer running.
func TestProjectStopKeepsItsReasonThroughTheSpawnersUpdate(t *testing.T) {
	const id = "bg-project-stop-reason"
	root := t.TempDir()
	registerStoppableShell(t, id, root)

	const reason = "Stopped when Juggler quit"
	if stopped := StopBackgroundTasks(root, reason, 0); stopped != 1 {
		t.Fatalf("expected to stop 1 task, stopped %d", stopped)
	}

	updateShellStatus(id, "failed", "", -1, "command cancelled", "", 0, false)

	if state := TaskState(id); state.Error != reason {
		t.Errorf("a task stopped by name ended saying %q, want %q", state.Error, reason)
	}
}

// TestTaskStateTimesTheTaskItself pins the run time a background launch's tool
// action shows: its own call returns the moment the task is spawned, so the
// task's start and end are the only measure of how long it ran. Both terminal
// paths stamp an end, the later spawner update moves neither the end nor the
// stop, and only a stop is reported as one.
func TestTaskStateTimesTheTaskItself(t *testing.T) {
	const stoppedID, exitedID = "bg-timed-stopped", "bg-timed-exited"
	for _, id := range []string{stoppedID, exitedID} {
		_, cancel := context.WithCancel(context.Background())
		registerBackgroundShell(&BackgroundShell{
			ID: id, ConvID: "conv-" + id, ToolUseID: "tool-" + id, Command: "sleep 60",
			StartTime: time.Now().Add(-time.Minute), ProjectRoot: t.TempDir(),
			cancel: cancel, reaped: make(chan struct{}), status: "running",
		})
		t.Cleanup(func() { removeBackgroundShell(id) })
	}

	if running := TaskState(stoppedID); running.StartedAt == 0 || running.EndedAt != 0 || running.Stopped {
		t.Fatalf("a running task reported start %d end %d stopped %v, want a start and no end", running.StartedAt, running.EndedAt, running.Stopped)
	}

	if !KillTask(stoppedID) {
		t.Fatalf("KillTask did not stop a running task")
	}
	endedAt := TaskState(stoppedID).EndedAt
	updateShellStatus(stoppedID, "failed", "", -1, "command cancelled", "", 0, false)
	updateShellStatus(exitedID, "completed", "", 0, "", "", 0, false)

	for _, c := range []struct {
		id      string
		stopped bool
	}{{stoppedID, true}, {exitedID, false}} {
		state := TaskState(c.id)
		if state.EndedAt == 0 || state.EndedAt-state.StartedAt < time.Minute.Milliseconds() {
			t.Errorf("%s: start %d end %d, want an end at least a minute after the start", c.id, state.StartedAt, state.EndedAt)
		}
		if state.Stopped != c.stopped {
			t.Errorf("%s: stopped %v, want %v", c.id, state.Stopped, c.stopped)
		}
	}
	if got := TaskState(stoppedID).EndedAt; got != endedAt {
		t.Errorf("the spawner's update after a stop moved its end from %d to %d", endedAt, got)
	}
}

// TestSpawnersVerdictStandsForATaskNobodyStopped is the guard on the rule above:
// pinning a terminal state must not pin anything else, or a command that failed
// on its own would report whatever it was last seen doing.
func TestSpawnersVerdictStandsForATaskNobodyStopped(t *testing.T) {
	const id = "bg-unstopped-verdict"
	registerStoppableShell(t, id, t.TempDir())

	updateShellStatus(id, "failed", "", 3, "exit code 3", "", 0, false)

	state := TaskState(id)
	if state.Status != "failed" || state.ExitCode != 3 || state.Error != "exit code 3" {
		t.Errorf("a task that ended on its own reported status %q exit %d error %q, want %q exit %d error %q",
			state.Status, state.ExitCode, state.Error, "failed", 3, "exit code 3")
	}
}
