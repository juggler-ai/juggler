//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"testing"
	"time"
)

// The registry is process-global, spanning every tree the process works in, so
// a bare task id used to reach any task in the process. These tests pin the two checks that
// close that — the project a task was spawned in, and the conversation that owns
// it — plus the deliberate stop of every task whose handle is about to become
// unreachable.

// startTestTask spawns a long-running background task in the given project and
// conversation, and guarantees it is stopped when the test ends. It waits for
// the command to say it is up, so the process really exists by the time a test
// acts on it — otherwise a stop would be exercising only the pre-start context
// cancellation and never the process group.
//
// `ready` is printed after `sleep` is forked, so it also proves the child
// exists: the shell's tree is then two processes, and a stop that signals only
// the shell leaves `sleep` holding the output pipe. Printed before the fork, a
// stop landing between the two found a lone shell with nothing to survive it.
func startTestTask(t *testing.T, root, convID string) string {
	t.Helper()
	shellOps := NewShellOperations(NewPathScope(root, nil))
	res, err := shellOps.startBackground(map[string]any{
		"command": "sleep 30 & echo ready; wait",
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
	waitForOutput(t, id, "ready", 5*time.Second)
	return id
}

// statusOf reads the "status" field out of an op result.
func statusOf(t *testing.T, res any) string {
	t.Helper()
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("expected a map result, got %T", res)
	}
	status, _ := m["status"].(string)
	return status
}

// TestTaskFromAnotherProjectIsUnreachable is the leak this phase closes: the
// registry spans every tree the process works in, so without the project stamp
// a task started in one stayed readable and killable from another. All three
// id-addressed ops must refuse it, and refuse it as "not found" — saying
// anything more would confirm the task exists somewhere the caller cannot see.
func TestTaskFromAnotherProjectIsUnreachable(t *testing.T) {
	requirePOSIXShell(t)

	projectA, projectB := t.TempDir(), t.TempDir()
	id := startTestTask(t, projectA, "conv-a")
	fromB := NewShellOperations(NewPathScope(projectB, nil))

	res, err := fromB.getOutput(map[string]any{"taskId": id})
	if err != nil {
		t.Fatalf("getOutput errored: %v", err)
	}
	if got := statusOf(t, res); got != "not_found" {
		t.Fatalf("getOutput from another project: expected not_found, got %q", got)
	}

	res, err = fromB.getOutputDelta(map[string]any{"taskId": id})
	if err != nil {
		t.Fatalf("getOutputDelta errored: %v", err)
	}
	if got := statusOf(t, res); got != "not_found" {
		t.Fatalf("getOutputDelta from another project: expected not_found, got %q", got)
	}

	res, err = fromB.kill(map[string]any{"shellId": id})
	if err != nil {
		t.Fatalf("kill errored: %v", err)
	}
	if killed, _ := res.(map[string]any)["killed"].(bool); killed {
		t.Fatal("kill from another project reported the task killed")
	}

	// And the task itself is untouched by the attempt.
	if s := TaskState(id); s.Status != "running" {
		t.Fatalf("task should still be running after a foreign kill, got %q", s.Status)
	}
}

// TestConversationIsCheckedWhenGiven pins convId as opt-in strictness: naming
// the wrong conversation is refused, naming the right one works, and omitting it
// falls back to the project check alone so a third-party caller that never knew
// about convId keeps working.
func TestConversationIsCheckedWhenGiven(t *testing.T) {
	requirePOSIXShell(t)

	root := t.TempDir()
	id := startTestTask(t, root, "conv-owner")
	shellOps := NewShellOperations(NewPathScope(root, nil))

	res, err := shellOps.getOutput(map[string]any{"taskId": id, "convId": "conv-other"})
	if err != nil {
		t.Fatalf("getOutput errored: %v", err)
	}
	if got := statusOf(t, res); got != "not_found" {
		t.Fatalf("wrong conversation: expected not_found, got %q", got)
	}

	res, err = shellOps.getOutput(map[string]any{"taskId": id, "convId": "conv-owner"})
	if err != nil {
		t.Fatalf("getOutput errored: %v", err)
	}
	if got := statusOf(t, res); got != "running" {
		t.Fatalf("owning conversation: expected running, got %q", got)
	}

	res, err = shellOps.getOutput(map[string]any{"taskId": id})
	if err != nil {
		t.Fatalf("getOutput errored: %v", err)
	}
	if got := statusOf(t, res); got != "running" {
		t.Fatalf("omitted conversation: expected running, got %q", got)
	}
}

// TestListBackgroundShellsRequiresConversation guards the shape that made the
// old list op dangerous: an omitted convId meant "every task in the process",
// and each row carried the task's full output.
func TestListBackgroundShellsRequiresConversation(t *testing.T) {
	requirePOSIXShell(t)

	root := t.TempDir()
	startTestTask(t, root, "conv-a")
	shellOps := NewShellOperations(NewPathScope(root, nil))

	if _, err := shellOps.listBackgroundShells(map[string]any{}); err == nil {
		t.Fatal("expected listBackgroundShells to refuse an absent convId")
	}

	res, err := shellOps.listBackgroundShells(map[string]any{"convId": "conv-a"})
	if err != nil {
		t.Fatalf("listBackgroundShells errored: %v", err)
	}
	shells, _ := res.(map[string]any)["shells"].([]map[string]any)
	if len(shells) != 1 {
		t.Fatalf("expected exactly the one task for conv-a, got %d", len(shells))
	}
	if _, present := shells[0]["output"]; present {
		t.Fatal("a listing must not carry task output")
	}
}

// TestListBackgroundShellsIsScopedToProject: two conversations with the same id
// in different projects are different conversations.
func TestListBackgroundShellsIsScopedToProject(t *testing.T) {
	requirePOSIXShell(t)

	projectA, projectB := t.TempDir(), t.TempDir()
	startTestTask(t, projectA, "shared-conv-id")
	fromB := NewShellOperations(NewPathScope(projectB, nil))

	res, err := fromB.listBackgroundShells(map[string]any{"convId": "shared-conv-id"})
	if err != nil {
		t.Fatalf("listBackgroundShells errored: %v", err)
	}
	if shells, _ := res.(map[string]any)["shells"].([]map[string]any); len(shells) != 0 {
		t.Fatalf("another project's task must not be listed, got %d", len(shells))
	}
}

// TestTaskStatusAnswersOnlyLiveness is the probe the board runs on: it reports
// which of the ids the caller already holds are still running, and nothing else
// — no output, no command. A task the caller does not own reads exactly like one
// that never existed.
func TestTaskStatusAnswersOnlyLiveness(t *testing.T) {
	requirePOSIXShell(t)

	projectA, projectB := t.TempDir(), t.TempDir()
	mine := startTestTask(t, projectA, "conv-a")
	otherConv := startTestTask(t, projectA, "conv-b")
	otherProject := startTestTask(t, projectB, "conv-a")

	shellOps := NewShellOperations(NewPathScope(projectA, nil))
	res, err := shellOps.taskStatus(map[string]any{
		"convId":  "conv-a",
		"taskIds": []any{mine, otherConv, otherProject, "bg-does-not-exist"},
	})
	if err != nil {
		t.Fatalf("taskStatus errored: %v", err)
	}
	tasks, _ := res.(map[string]any)["tasks"].([]map[string]any)
	if len(tasks) != 4 {
		t.Fatalf("expected an answer per requested id, got %d", len(tasks))
	}

	byID := map[string]map[string]any{}
	for _, task := range tasks {
		id, _ := task["task_id"].(string)
		byID[id] = task
	}

	if running, _ := byID[mine]["running"].(bool); !running {
		t.Fatal("the caller's own running task should report running")
	}
	for _, id := range []string{otherConv, otherProject, "bg-does-not-exist"} {
		if running, _ := byID[id]["running"].(bool); running {
			t.Fatalf("task %q should not report running to this caller", id)
		}
		if status, _ := byID[id]["status"].(string); status != "not_found" {
			t.Fatalf("task %q: expected not_found, got %q", id, status)
		}
	}

	// Liveness and nothing else: no route to output or the command through here.
	for _, field := range []string{"output", "command", "exit_code"} {
		if _, present := byID[mine][field]; present {
			t.Fatalf("taskStatus must not carry %q", field)
		}
	}

	if _, err := shellOps.taskStatus(map[string]any{"taskIds": []any{mine}}); err == nil {
		t.Fatal("expected taskStatus to refuse an absent convId")
	}
}

// TestStopBackgroundTasksIsScopedToProject: naming a root stops that root's
// tasks, and nothing else.
func TestStopBackgroundTasksIsScopedToProject(t *testing.T) {
	requirePOSIXShell(t)

	leaving, staying := t.TempDir(), t.TempDir()
	doomed := startTestTask(t, leaving, "conv-a")
	spared := startTestTask(t, staying, "conv-b")

	if stopped := StopBackgroundTasks(leaving, "Stopped for the test", 10*time.Millisecond); stopped != 1 {
		t.Fatalf("expected to stop exactly the leaving project's task, stopped %d", stopped)
	}

	if s := TaskState(doomed); s.Status != "failed" {
		t.Fatalf("the leaving project's task should be stopped, got %q", s.Status)
	} else if s.Error != "Stopped for the test" {
		t.Fatalf("the reason should say what happened, got %q", s.Error)
	}
	if s := TaskState(spared); s.Status != "running" {
		t.Fatalf("another project's task must keep running, got %q", s.Status)
	}
}

// TestStopBackgroundTasksStopsEveryProject is the shutdown path: no root named,
// so nothing is left behind to be reparented to init.
func TestStopBackgroundTasksStopsEveryProject(t *testing.T) {
	requirePOSIXShell(t)

	first := startTestTask(t, t.TempDir(), "conv-a")
	second := startTestTask(t, t.TempDir(), "conv-b")

	if stopped := StopBackgroundTasks("", "Stopped when Juggler quit", 10*time.Millisecond); stopped < 2 {
		t.Fatalf("expected both tasks stopped, stopped %d", stopped)
	}
	for _, id := range []string{first, second} {
		if s := TaskState(id); s.Status != "failed" {
			t.Fatalf("task %q should be stopped, got %q", id, s.Status)
		}
	}

	// Idempotent: a second sweep finds nothing running and reports so, rather
	// than re-signalling a process that has already gone.
	if stopped := StopBackgroundTasks("", "Stopped when Juggler quit", 10*time.Millisecond); stopped != 0 {
		t.Fatalf("a repeat sweep should stop nothing, stopped %d", stopped)
	}
}

// TestSameProject reads a trailing separator as the non-difference it is: taking
// it for a real one would make every task in the project unreachable at once.
func TestSameProject(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"/tmp/project", "/tmp/project", true},
		{"/tmp/project/", "/tmp/project", true},
		{"/tmp/project", "/tmp/project/", true},
		{"/tmp/project", "/tmp/other", false},
		{"", "/tmp/project", false},
		{"/", "/", true},
	}
	for _, tc := range cases {
		if got := sameProject(tc.a, tc.b); got != tc.want {
			t.Errorf("sameProject(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}
