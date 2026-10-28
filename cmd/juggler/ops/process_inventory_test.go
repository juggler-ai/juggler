//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"testing"
	"time"
)

// waitForProcess polls the inventory until want reports true for the project's
// listing, failing the test at the deadline with what was listed instead.
func waitForProcess(t *testing.T, root string, want func([]ProcessInfo) bool) []ProcessInfo {
	t.Helper()
	stop := time.After(5 * time.Second)
	for {
		list := ListProcesses(root)
		if want(list) {
			return list
		}
		select {
		case <-stop:
			t.Fatalf("timed out waiting on the process inventory; listed %+v", list)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func hasProcess(id string) func([]ProcessInfo) bool {
	return func(list []ProcessInfo) bool {
		for _, p := range list {
			if p.ID == id {
				return true
			}
		}
		return false
	}
}

func hasNoProcess(id string) func([]ProcessInfo) bool {
	return func(list []ProcessInfo) bool { return !hasProcess(id)(list) }
}

func findProcess(list []ProcessInfo, kind string) (ProcessInfo, bool) {
	for _, p := range list {
		if p.Kind == kind {
			return p, true
		}
	}
	return ProcessInfo{}, false
}

// A background task is listed, with the conversation, thread and tool call that
// started it, for exactly as long as its process runs; a stop through the
// inventory ends it.
func TestProcessInventory_BackgroundListedUntilStopped(t *testing.T) {
	requirePOSIXShell(t)
	root := t.TempDir()
	res, err := NewShellOperations(NewPathScope(root, nil)).startBackground(map[string]any{
		"command": "sleep 30", "convId": "conv-a", "threadId": "thread-a", "toolUseId": "call_1",
	})
	if err != nil {
		t.Fatalf("startBackground: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	defer KillTask(id)

	list := waitForProcess(t, root, hasProcess(id))
	p := list[0]
	if p.Kind != ProcessBackground || p.Command != "sleep 30" || p.ConvID != "conv-a" ||
		p.ThreadID != "thread-a" || p.ToolUseID != "call_1" || p.StartedAt == 0 {
		t.Fatalf("background entry carries the wrong identity: %+v", p)
	}

	if !StopProcess(root, id) {
		t.Fatal("StopProcess refused a running background task")
	}
	waitForProcess(t, root, hasNoProcess(id))
	if state := TaskState(id); state.Error != "Killed by user" {
		t.Fatalf("a stop from the inventory should read as a user kill, got %+v", state.TaskOutputState)
	}
}

// The inventory is per project: another project neither lists nor stops it.
func TestProcessInventory_ScopedToProject(t *testing.T) {
	requirePOSIXShell(t)
	root, other := t.TempDir(), t.TempDir()
	res, err := NewShellOperations(NewPathScope(root, nil)).startBackground(map[string]any{"command": "sleep 30"})
	if err != nil {
		t.Fatalf("startBackground: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	defer KillTask(id)
	waitForProcess(t, root, hasProcess(id))

	if hasProcess(id)(ListProcesses(other)) {
		t.Fatal("another project's listing shows this project's task")
	}
	if StopProcess(other, id) {
		t.Fatal("another project stopped this project's task")
	}
}

// A workspace's processes belong to the project it was made from.
func TestProcessInventory_WorkspaceListedUnderItsProject(t *testing.T) {
	requirePOSIXShell(t)
	project, tree := t.TempDir(), t.TempDir()
	scope := NewPathScope(tree, nil).WithProjectRoot(project)
	res, err := NewShellOperations(scope).startBackground(map[string]any{"command": "sleep 30"})
	if err != nil {
		t.Fatalf("startBackground: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	defer KillTask(id)
	waitForProcess(t, project, hasProcess(id))
}

// A foreground streaming command is listed while it runs and can be stopped from
// the inventory, which ends the stream with a user-kill verdict.
func TestProcessInventory_ForegroundStreamingListedAndStoppable(t *testing.T) {
	requirePOSIXShell(t)
	root := t.TempDir()
	out := make(chan ShellStreamChunk, 64)
	owner := ProcessOwner{ConvID: "conv-b", ThreadID: "thread-b", ToolUseID: "call_2"}
	go NewShellOperations(NewPathScope(root, nil)).ExecuteStreamingFor(
		context.Background(), owner, "shell-inv", "sleep 30", "", 60000, out)

	list := waitForProcess(t, root, func(l []ProcessInfo) bool { _, ok := findProcess(l, ProcessForeground); return ok })
	p, _ := findProcess(list, ProcessForeground)
	if p.ID != "shell-inv" || p.Command != "sleep 30" || p.ConvID != "conv-b" ||
		p.ThreadID != "thread-b" || p.ToolUseID != "call_2" {
		t.Fatalf("foreground entry carries the wrong identity: %+v", p)
	}

	if !StopProcess(root, p.ID) {
		t.Fatal("StopProcess refused a running foreground command")
	}
	var last ShellStreamChunk
	deadline := time.After(10 * time.Second)
	for done := false; !done; {
		select {
		case chunk, ok := <-out:
			if !ok {
				done = true
				break
			}
			last = chunk
		case <-deadline:
			t.Fatal("the stream did not end after a stop")
		}
	}
	if !last.Done || last.Error != "Killed by user" {
		t.Fatalf("expected a done chunk reading as a user kill, got %+v", last)
	}
	waitForProcess(t, root, hasNoProcess(p.ID))
}

// The one-shot execute op is listed too, and a stop ends the call.
func TestProcessInventory_ExecuteListedAndStoppable(t *testing.T) {
	requirePOSIXShell(t)
	root := t.TempDir()
	errCh := make(chan error, 1)
	go func() {
		_, err := NewShellOperations(NewPathScope(root, nil)).execute(context.Background(), map[string]any{
			"command": "sleep 30", "convId": "conv-c", "toolUseId": "call_3", "timeout": float64(60000),
		})
		errCh <- err
	}()

	list := waitForProcess(t, root, func(l []ProcessInfo) bool { _, ok := findProcess(l, ProcessForeground); return ok })
	p, _ := findProcess(list, ProcessForeground)
	if p.ConvID != "conv-c" || p.ToolUseID != "call_3" {
		t.Fatalf("execute entry carries the wrong identity: %+v", p)
	}
	if !StopProcess(root, p.ID) {
		t.Fatal("StopProcess refused a running execute")
	}
	select {
	case err := <-errCh:
		if err == nil || err.Error() != "killed by user" {
			t.Fatalf("expected the stopped execute to report a user kill, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("execute did not return after a stop")
	}
	waitForProcess(t, root, hasNoProcess(p.ID))
}

// Python code run through execute is listed as python.
func TestProcessInventory_PythonListed(t *testing.T) {
	requirePython(t)
	root := t.TempDir()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = NewShellOperations(NewPathScope(root, nil)).execute(context.Background(), map[string]any{
			"code": "import time; time.sleep(30)", "convId": "conv-d", "timeout": float64(60000),
		})
	}()
	list := waitForProcess(t, root, func(l []ProcessInfo) bool { _, ok := findProcess(l, ProcessPython); return ok })
	p, _ := findProcess(list, ProcessPython)
	if !StopProcess(root, p.ID) {
		t.Fatal("StopProcess refused running python")
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("python did not return after a stop")
	}
}

// The shell ops list and stop through the inventory, within the caller's project.
func TestProcessInventory_ShellOps(t *testing.T) {
	requirePOSIXShell(t)
	root := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(root, nil))
	res, err := shellOps.Execute(context.Background(), "startBackground", map[string]any{"command": "sleep 30"})
	if err != nil {
		t.Fatalf("startBackground: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	defer KillTask(id)
	waitForProcess(t, root, hasProcess(id))

	listed, err := shellOps.Execute(context.Background(), "listProcesses", nil)
	if err != nil {
		t.Fatalf("listProcesses: %v", err)
	}
	if procs, _ := listed.(map[string]any)["processes"].([]ProcessInfo); !hasProcess(id)(procs) {
		t.Fatalf("listProcesses did not list the task: %+v", listed)
	}

	other := NewShellOperations(NewPathScope(t.TempDir(), nil))
	if res, _ := other.Execute(context.Background(), "stopProcess", map[string]any{"id": id}); res.(map[string]any)["stopped"] != false {
		t.Fatalf("another project's stopProcess reached this task: %+v", res)
	}
	if res, _ := shellOps.Execute(context.Background(), "stopProcess", map[string]any{"id": id}); res.(map[string]any)["stopped"] != true {
		t.Fatalf("stopProcess did not stop the task: %+v", res)
	}
	waitForProcess(t, root, hasNoProcess(id))
}

// Every change to the table is announced, with the project it happened in.
func TestProcessInventory_AnnouncesChanges(t *testing.T) {
	requirePOSIXShell(t)
	root := t.TempDir()
	changed := make(chan string, 16)
	remove := OnProcessesChanged(func(projectRoot string) {
		if sameProject(projectRoot, root) {
			changed <- projectRoot
		}
	})
	defer remove()

	res, err := NewShellOperations(NewPathScope(root, nil)).startBackground(map[string]any{"command": "sleep 30"})
	if err != nil {
		t.Fatalf("startBackground: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	defer KillTask(id)

	for _, what := range []string{"start", "exit"} {
		select {
		case <-changed:
		case <-time.After(5 * time.Second):
			t.Fatalf("no change announced on %s", what)
		}
		if what == "start" {
			StopProcess(root, id)
		}
	}
}
