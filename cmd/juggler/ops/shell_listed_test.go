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

// A shell command is listed in the process inventory before it can touch the
// tree: whoever hears its first write asks the inventory who is running (the
// shell attribution recorder does, once per change), and a command not listed
// yet is nobody's. afterStart holds the spawner just past the start, until the
// command has written; the inventory must already name it then, on every path
// that runs a shell command.
func TestAShellCommandIsListedBeforeItWrites(t *testing.T) {
	requirePOSIXShell(t)
	for _, path := range []struct {
		name string
		run  func(ops *ShellOperations, command, toolUseID string)
	}{
		{"execute", func(ops *ShellOperations, command, toolUseID string) {
			_, _ = ops.Execute(context.Background(), "execute", map[string]any{"command": command, "convId": "c", "toolUseId": toolUseID})
		}},
		{"startBackground", func(ops *ShellOperations, command, toolUseID string) {
			res, err := ops.Execute(context.Background(), "startBackground", map[string]any{"command": command, "convId": "c", "toolUseId": toolUseID})
			if err == nil {
				id, _ := res.(map[string]any)["task_id"].(string)
				t.Cleanup(func() { KillTask(id) })
			}
		}},
		{"streaming", func(ops *ShellOperations, command, toolUseID string) {
			out := make(chan ShellStreamChunk, 64)
			go ops.ExecuteStreamingFor(context.Background(), ProcessOwner{ConvID: "c", ToolUseID: toolUseID}, "sh-"+toolUseID, command, "", 0, out)
			for range out { //nolint:revive // drained until the command is done
			}
		}},
	} {
		t.Run(path.name, func(t *testing.T) {
			dir := t.TempDir()
			marker := filepath.Join(dir, "written")
			toolUseID := "tu_" + path.name
			ops := NewShellOperations(NewPathScope(dir, nil))
			listed := make(chan bool, 1)
			ops.afterStart = func() {
				// Bounded by the test's own deadline: the command's first act is
				// the write, and nothing holds it up.
				for {
					if _, err := os.Stat(marker); err == nil {
						break
					}
					time.Sleep(5 * time.Millisecond)
				}
				found := false
				for _, p := range ListProcesses(dir) {
					found = found || p.ToolUseID == toolUseID
				}
				listed <- found
			}
			path.run(ops, `echo x > "`+filepath.ToSlash(marker)+`"`, toolUseID)
			if !<-listed {
				t.Fatal("the command had written before the process inventory listed it")
			}
		})
	}
}
