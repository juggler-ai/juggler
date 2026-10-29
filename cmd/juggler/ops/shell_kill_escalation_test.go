//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/internal/machineload/machineloadtest"
)

// A force-kill names a whole process TREE by one pid, and that pid means what
// the killer thinks only until the process is reaped: cmd.Wait releases the
// handle reserving the number, and the OS is then free to hand the same number
// to something else — Windows recycles pids within seconds. Each of the three
// escalations here runs on a timer, seconds after the polite stop, so each must
// establish that its target is still un-reaped before taking its group.
//
// These tests count escalations rather than their effect: an escalation aimed at
// a reaped pid is indistinguishable from a correct one once it has landed, and
// its victim is whatever inherited the number.
//
// What is asserted throughout is the ORDER of the two events, never how far
// apart the machine put them. An escalation is only wrong once the reap has
// happened, so every "must not escalate" test below waits for the reap and says
// so; one that arrives after its escalation was due leaves nothing to assert,
// because taking the group there is exactly right. The suite runs
// race-instrumented alongside three other packages spawning processes of their
// own, where a reap that lost a race by milliseconds says nothing about the
// code.

// countEscalations installs a hook that counts force-kill escalations and
// deliberately does not perform them — provoking the defect for real would kill
// whatever process on this machine now holds the recycled pid. Returns the count
// so far.
func countEscalations(t *testing.T) func() int {
	t.Helper()
	var count atomic.Int64
	killGroupHook.Store(func(*exec.Cmd) { count.Add(1) })
	t.Cleanup(func() { killGroupHook.Store((func(*exec.Cmd))(nil)) })
	return func() int { return int(count.Load()) }
}

// reapedChan hands back the channel a task's spawner closes the moment cmd.Wait
// returns, which is the instant the task's pid stops naming it.
func reapedChan(t *testing.T, taskID string) <-chan struct{} {
	t.Helper()
	shell := getBackgroundShell(taskID)
	if shell == nil {
		t.Fatalf("task %s is not in the registry", taskID)
	}
	return shell.reaped
}

// waitForEscalation blocks until a force-kill escalation has been counted, or
// fails with why one was owed. Escalations run on timers, so how soon one lands
// after it falls due is a property of the machine.
func waitForEscalation(t *testing.T, escalations func() int, owed string) {
	t.Helper()
	deadline := time.After(stopBudget)
	for escalations() < 1 {
		select {
		case <-deadline:
			t.Fatalf("%s (0 escalations in %v)", owed, stopBudget)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestStreamingCancelDoesNotForceKillAReapedPid covers ExecuteStreaming's
// cancel path. `exec` replaces the shell, so the command's whole tree is a
// single process: it dies with the context and nothing is left holding the
// output pipe, so cmd.Wait returns at once and by the time the escalation is due
// there is nothing of ours left to take.
func TestStreamingCancelDoesNotForceKillAReapedPid(t *testing.T) {
	requirePOSIXShell(t)

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	// The kill grace is what the reap has to beat, so give it seconds rather
	// than the milliseconds a loaded runner can spend on scheduling alone. The
	// reap grace is longer still, so the return below is always cmd.Wait and
	// never the cap that gives up on it.
	shellOps.killGrace = 2 * time.Second
	shellOps.reapGrace = stopBudget
	escalations := countEscalations(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	out := make(chan ShellStreamChunk, 64)
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range out { //nolint:revive // draining is the point
		}
	}()

	cancelled := make(chan time.Time, 1)
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancelled <- time.Now()
		cancel()
	}()
	shellOps.ExecuteStreaming(ctx, "shell-cancel", "", "exec sleep 5", "", 10000, out)
	<-drained

	// ExecuteStreaming returns once cmd.Wait has, so this is what the reap took.
	reapTook := time.Since(<-cancelled)
	if reapTook >= shellOps.killGrace {
		machineloadtest.Skip(t, "the process was still un-reaped %v after the cancel, with its escalation due at %v: taking the group there is correct, so there is nothing to assert",
			reapTook, shellOps.killGrace)
	}

	// Well past the kill grace the escalation was armed for.
	time.Sleep(shellOps.killGrace - reapTook + 400*time.Millisecond)
	if n := escalations(); n != 0 {
		t.Fatalf("cancelled command was force-killed %d time(s) after its process had been reaped; that pid can name something else by then", n)
	}
}

// TestStreamingCancelStillForceKillsWhatOutlivesTheGrace is the other half: a
// child that stays in the leader's group holds the output pipe open, so cmd.Wait
// has not returned when the grace expires and the group still has to be taken.
// Without this, "never escalate" would pass the test above by doing nothing.
func TestStreamingCancelStillForceKillsWhatOutlivesTheGrace(t *testing.T) {
	requireGracefulStop(t)

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	shellOps.killGrace = 100 * time.Millisecond
	shellOps.reapGrace = 300 * time.Millisecond
	escalations := countEscalations(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Cancelled the moment the command says its child exists — never on a timer,
	// which a slow fork outran: the cancel then found a lone shell, and with
	// nothing left to hold the pipe there was correctly nothing to escalate.
	out := make(chan ShellStreamChunk, 64)
	drained := make(chan struct{})
	var sawReady atomic.Bool
	go func() {
		defer close(drained)
		var seen strings.Builder
		for chunk := range out {
			seen.WriteString(chunk.Data)
			if !sawReady.Load() && strings.Contains(seen.String(), "ready") {
				sawReady.Store(true)
				cancel()
			}
		}
	}()

	// The backgrounded child inherits the leader's process group and the pipe's
	// write end, so killing the leader alone leaves cmd.Wait blocked.
	shellOps.ExecuteStreaming(ctx, "shell-cancel-child", "", "sleep 5 & echo ready; wait", "", 10000, out)
	<-drained
	if !sawReady.Load() {
		t.Fatalf("the command never said its child was up, so it was never cancelled")
	}

	waitForEscalation(t, escalations, "a process group still holding the pipe past the kill grace was never force-killed")
}

// startLoneProcessTask spawns a background task whose whole tree is a single
// process: `exec` replaces the shell, so cancelling the context leaves nothing
// behind to hold the output pipe and the spawner reaps the task at once. That is
// the ordinary shape of a monitored command — one process that has already
// finished by the time any escalation is due.
func startLoneProcessTask(t *testing.T, root, convID string) string {
	t.Helper()
	shellOps := NewShellOperations(NewPathScope(root, nil))
	res, err := shellOps.startBackground(map[string]any{
		"command": "echo ready; exec sleep 30",
		"convId":  convID,
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
	return id
}

// TestKilledBackgroundTaskIsNotForceKilledAfterItIsReaped covers the registry's
// delayed escalation behind a user's Stop. The task's process dies with its
// cancelled context immediately and its spawner reaps it, so the escalation
// scheduled for killEscalationGrace later has no target of ours.
func TestKilledBackgroundTaskIsNotForceKilledAfterItIsReaped(t *testing.T) {
	requirePOSIXShell(t)

	id := startLoneProcessTask(t, t.TempDir(), "conv-kill")
	escalations := countEscalations(t)
	reaped := reapedChan(t, id)

	if !KillTask(id) {
		t.Fatalf("KillTask did not stop a running task")
	}
	killedAt := time.Now()

	select {
	case <-reaped:
	case <-time.After(killEscalationGrace):
		machineloadtest.Skip(t, "the killed task was still un-reaped when its escalation fell due after %v: taking the group there is correct, so there is nothing to assert",
			killEscalationGrace)
	}

	// Past the registry's escalation, timed from the kill that armed it.
	time.Sleep(killEscalationGrace + 500*time.Millisecond - time.Since(killedAt))
	if n := escalations(); n != 0 {
		t.Fatalf("killed task was force-killed %d time(s) after its process had been reaped; that pid can name something else by then", n)
	}
}

// TestKilledBackgroundTaskStillForceKillsSurvivors is the other half: a child
// left in the task's process group outlives the leader and holds the output pipe
// open, so the task is not reaped and its group still has to be taken.
func TestKilledBackgroundTaskStillForceKillsSurvivors(t *testing.T) {
	requireGracefulStop(t)

	// startTestTask returns once its `sleep 30` child exists, so the polite
	// stop — which signals only the shell — always leaves it behind.
	id := startTestTask(t, t.TempDir(), "conv-survivor")
	escalations := countEscalations(t)

	if !KillTask(id) {
		t.Fatalf("KillTask did not stop a running task")
	}

	waitForEscalation(t, escalations, "a task whose child survived the polite stop was never force-killed")
}

// TestStopBackgroundTasksDoesNotForceKillReapedPids covers the project-switch
// and shutdown stop, which signals every task and then takes the groups of any
// that ignored it after one shared grace.
func TestStopBackgroundTasksDoesNotForceKillReapedPids(t *testing.T) {
	requirePOSIXShell(t)

	root := t.TempDir()
	id := startLoneProcessTask(t, root, "conv-stop")
	escalations := countEscalations(t)
	reaped := reapedChan(t, id)

	if stopped := StopBackgroundTasks(root, "Stopped when the project changed", time.Second); stopped != 1 {
		t.Fatalf("expected to stop 1 task, stopped %d", stopped)
	}
	select {
	case <-reaped:
	default:
		machineloadtest.Skip(t, "the task was still un-reaped when the stop's grace expired: taking its group there is correct, so there is nothing to assert")
	}
	if n := escalations(); n != 0 {
		t.Fatalf("stopped task was force-killed %d time(s) after its process had been reaped; that pid can name something else by then", n)
	}
}
