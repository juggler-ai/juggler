//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"testing"
	"time"
)

// The shell op's params are camelCase like every other op's. Its snake_case
// spellings are still read, because `juggler/ops` is public and extensions pass
// these params by name. Each case goes through Execute, the dispatch a real call
// takes, and every conversation-scoped step names a WRONG conversation first: an
// op that ignored the key it was given would answer that call as if it were
// the owner's, so a refusal is what proves the key was read.

// paramNames is one spelling of the shell op's id params.
type paramNames struct {
	name, conv, toolUse, task, shell, tasks string
}

var (
	camelNames = paramNames{"camelCase", "convId", "toolUseId", "taskId", "shellId", "taskIds"}
	snakeNames = paramNames{"snake_case", "conv_id", "tool_use_id", "task_id", "shell_id", "task_ids"}
)

func TestShellOpReadsItsParamsInEitherSpelling(t *testing.T) {
	requirePOSIXShell(t)
	for _, n := range []paramNames{camelNames, snakeNames} {
		t.Run(n.name, func(t *testing.T) {
			ctx := t.Context()
			shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
			const owner = "conv-owner"

			res, err := shellOps.Execute(ctx, "startBackground", map[string]any{
				"command": "echo ready; sleep 30",
				n.conv:    owner,
				n.toolUse: "toolu_names",
			})
			if err != nil {
				t.Fatalf("startBackground: %v", err)
			}
			id, _ := res.(map[string]any)["task_id"].(string)
			if id == "" {
				t.Fatalf("startBackground returned no task_id: %+v", res)
			}
			t.Cleanup(func() { KillTask(id) })
			// The owner's own reads below answer only if startBackground stamped the
			// task with the conversation it was given.
			waitForOutput(t, id, "ready", 5*time.Second)

			for _, op := range []string{"getOutput", "getOutputDelta"} {
				res, err = shellOps.Execute(ctx, op, map[string]any{n.task: id, n.conv: "conv-other"})
				if err != nil {
					t.Fatalf("%s for another conversation: %v", op, err)
				}
				if got := statusOf(t, res); got != "not_found" {
					t.Fatalf("%s answered another conversation (status %q): the conversation key was not read", op, got)
				}
				res, err = shellOps.Execute(ctx, op, map[string]any{n.task: id, n.conv: owner})
				if err != nil {
					t.Fatalf("%s: %v", op, err)
				}
				if got := statusOf(t, res); got != "running" {
					t.Fatalf("%s for the owner: expected running, got %q", op, got)
				}
			}

			res, err = shellOps.Execute(ctx, "taskStatus", map[string]any{n.conv: owner, n.tasks: []any{id}})
			if err != nil {
				t.Fatalf("taskStatus: %v", err)
			}
			tasks, _ := res.(map[string]any)["tasks"].([]map[string]any)
			if len(tasks) != 1 || tasks[0]["running"] != true {
				t.Fatalf("taskStatus did not report the task running: %+v", res)
			}

			res, err = shellOps.Execute(ctx, "listBackgroundShells", map[string]any{n.conv: owner})
			if err != nil {
				t.Fatalf("listBackgroundShells: %v", err)
			}
			if shells, _ := res.(map[string]any)["shells"].([]map[string]any); len(shells) != 1 {
				t.Fatalf("listBackgroundShells: expected the one task, got %+v", res)
			}

			res, err = shellOps.Execute(ctx, "kill", map[string]any{n.shell: id, n.conv: "conv-other"})
			if err != nil {
				t.Fatalf("kill for another conversation: %v", err)
			}
			if killed, _ := res.(map[string]any)["killed"].(bool); killed {
				t.Fatal("kill for another conversation killed the task: the conversation key was not read")
			}
			res, err = shellOps.Execute(ctx, "kill", map[string]any{n.shell: id, n.conv: owner})
			if err != nil {
				t.Fatalf("kill: %v", err)
			}
			if killed, _ := res.(map[string]any)["killed"].(bool); !killed {
				t.Fatalf("kill for the owner did not kill the task: %+v", res)
			}
		})
	}
}
