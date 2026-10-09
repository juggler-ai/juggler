//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package handlers

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
)

// Cancelling a workspace-bound command kills the shell that is really running
// it, not merely the process Juggler started.
//
// The Windows half of the promise its `!windows` twin makes, and it needs its
// own test because the thing that can go wrong here does not exist there. The
// POSIX shell resolved on Windows is normally `Git\bin\bash.exe`, which is a
// launcher: it spawns `Git\usr\bin\bash.exe` and waits on it. Terminating the
// pid we hold takes the launcher and leaves the real shell — and the fifteen
// minutes of `npm ci` it is part-way through — running, orphaned, and out of
// reach of any later attempt to find it by walking down from a parent that is
// no longer there.
//
// Nothing here looks at a pid, because a pid is exactly what is not portable:
// under MSYS `$!` answers in its own numbering rather than Windows', so a
// handle opened on it would be asking about some unrelated process. The command
// is asked instead to do something only a live shell can do.
func TestRouteOperation_CancelKillsTheRealWindowsShell(t *testing.T) {
	project, workspace := projectAndWorkspace(t)
	api := opsAPIForTest(project, map[string]core.Workspace{
		"ws_1": {ID: "ws_1", Kind: core.WorkspaceKindLocal, Root: workspace, State: core.WorkspaceStateReady},
	})

	started := filepath.Join(workspace, "started.txt")
	release := filepath.Join(workspace, "release.txt")
	finished := filepath.Join(workspace, "finished.txt")

	// It waits on a file rather than a clock, so no machine is slow enough to
	// turn this into a race: the wait cannot end until this test ends it, and
	// this test does not end it until the cancel has been and gone.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		_, err := api.routeOperation(ctx, OperationRequest{
			ToolID:      "shell",
			Operation:   "execute",
			Params:      map[string]any{"command": "echo yes > started.txt; while [ ! -e release.txt ]; do sleep 0.1; done; echo yes > finished.txt"},
			WorkspaceID: "ws_1",
		})
		done <- err
	}()

	waitForFile(t, started, 30*time.Second)
	cancel()

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), context.Canceled.Error()) {
			t.Fatalf("cancelled command returned %v, want the cancellation", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("the cancelled command never returned")
	}

	if err := os.WriteFile(release, []byte("go\n"), 0o644); err != nil {
		t.Fatalf("write the release: %v", err)
	}
	// Without this the shell would stay in its loop for a reason that has
	// nothing to do with the cancel, and the check below would pass having
	// proved nothing at all.
	waitForFile(t, release, 10*time.Second)

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(finished); err == nil {
			t.Fatalf("the shell outlived the cancel: it left its wait and finished the command, so only the launcher was killed")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// waitForFile waits for a path to exist, and fails the test if it never does.
func waitForFile(t *testing.T, path string, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never turned up", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
