//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package handlers

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
)

// Cancelling a workspace-bound command kills the whole process group, not just
// the shell that was started.
//
// This is existing behaviour, asserted here against a scope that is NOT the
// project because the entire cancel story rests on it: a provider provisioning
// a workspace runs its setup in that workspace, and the Cancel button offered
// during a fifteen-minute `npm ci` is a promise that the `npm ci` stops. A
// cancel that killed the shell and left the build running would be a lie the
// user only discovers through a fan whirring and a lock file mysteriously
// changing.
func TestRouteOperation_CancelKillsTheWorkspaceProcessGroup(t *testing.T) {
	project, workspace := projectAndWorkspace(t)
	api := opsAPIForTest(project, map[string]core.Workspace{
		"ws_1": {ID: "ws_1", Kind: core.WorkspaceKindLocal, Root: workspace, State: core.WorkspaceStateReady},
	})

	// A child of the shell, in the shell's process group. Killing only the
	// leader leaves it running; killing the group takes it too.
	pidFile := filepath.Join(workspace, "child.pid")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		_, err := api.routeOperation(ctx, OperationRequest{
			ToolID:      "shell",
			Operation:   "execute",
			Params:      map[string]any{"command": "sleep 30 & echo $! > child.pid; wait"},
			WorkspaceID: "ws_1",
		})
		done <- err
	}()

	childPID := waitForPID(t, pidFile)
	if !processAlive(childPID) {
		t.Fatalf("the child was not running before the cancel; the test proves nothing")
	}

	cancel()

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), context.Canceled.Error()) {
			t.Fatalf("cancelled command returned %v, want the cancellation", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("the cancelled command never returned")
	}

	deadline := time.Now().Add(5 * time.Second)
	for processAlive(childPID) {
		if time.Now().After(deadline) {
			t.Fatalf("child %d outlived the cancel: the shell was killed but its process group was not", childPID)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitForPID waits for the shell to record its child's pid and returns it.
func waitForPID(t *testing.T, pidFile string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		data, err := os.ReadFile(pidFile)
		if err == nil {
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(data))); convErr == nil && pid > 0 {
				return pid
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the command never wrote its child pid to %s", pidFile)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// processAlive reports whether a pid still names a live process. Signal 0 is the
// existence check: it validates the target without delivering anything.
func processAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}
