//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"juggler/cmd/juggler/gitattr"
	"juggler/cmd/juggler/ops"
)

// A file a shell command writes in the project is put down to the command's
// conversation whether or not anything is watching the tree's git state: the
// server records it from the project's file watcher alone.
func TestShellWritesAreAttributedWithNoGitWatch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	s := newTestServerStateWithProject(t)
	project := s.ProjectPath()
	gitIn(t, project, "init", "-q")
	s.startProjectWatchers()
	t.Cleanup(s.stopProjectWatchers)

	// The command writes its file, then waits for the test to have seen the
	// record, so it is still running whenever the write is heard.
	release := filepath.ToSlash(filepath.Join(t.TempDir(), "release"))
	res, err := ops.NewShellOperations(ops.NewPathScope(project, nil)).Execute(context.Background(), "startBackground", map[string]any{
		"command":   `echo from-the-shell > shell.txt && while [ ! -f "` + release + `" ]; do sleep 0.05; done`,
		"convId":    "c_shell",
		"threadId":  "th_shell",
		"toolUseId": "tu_shell",
	})
	if err != nil {
		t.Fatalf("startBackground: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	t.Cleanup(func() { ops.KillTask(id) })
	defer func() { _ = os.WriteFile(filepath.FromSlash(release), nil, 0o600) }()

	index := gitattr.ForProject(project)
	running := func() bool {
		for _, p := range ops.ListProcesses(project) {
			if p.ToolUseID == "tu_shell" {
				return true
			}
		}
		return false
	}
	// Bounded by the command's liveness and the test's own deadline: the
	// command never ends on its own while the test waits.
	deadline, ok := t.Deadline()
	if !ok {
		deadline = time.Now().Add(time.Minute)
	}
	deadline = deadline.Add(-15 * time.Second)
	for !running() {
		if time.Now().After(deadline) {
			t.Fatal("the shell command was never listed as running")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for {
		if got := index.ForPaths("", "", nil); len(got) > 0 {
			if got[0].Path != "shell.txt" || got[0].Conv != "c_shell" || got[0].Thread != "th_shell" || got[0].Item != "tu_shell" || got[0].Strength != gitattr.Strong {
				t.Fatalf("records = %+v, want c_shell's strong record of shell.txt from th_shell/tu_shell", got)
			}
			return
		}
		if !running() {
			t.Fatal("the shell command ended before its write was attributed")
		}
		if time.Now().After(deadline) {
			t.Fatal("the shell command's write was never attributed while no git watch was open")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
