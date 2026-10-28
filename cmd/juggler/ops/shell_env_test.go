//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/projectenv"
)

// writeEnvFile writes one projectenv file as a user or a cloned repo would.
func writeEnvFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Every way a command starts — foreground, background (run_in_background and
// Monitor), Python, streaming — gets the project's variables, read from the
// PROJECT even when the command runs in a workspace, and the unapproved project
// file contributes nothing.
func TestShellCommandsGetProjectEnv(t *testing.T) {
	requirePOSIXShell(t)
	requirePython(t)
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	project, workspace := t.TempDir(), t.TempDir()
	writeEnvFile(t, projectenv.Path(projectenv.ScopeLocal, project), `{"JUGGLER_T_LOCAL":"from-local"}`)
	writeEnvFile(t, projectenv.Path(projectenv.ScopeProject, project), `{"JUGGLER_T_REPO":"from-repo"}`)
	shellOps := NewShellOperations(NewPathScope(workspace, nil).WithProjectRoot(project))

	const cmd = `printf '%s|%s' "$JUGGLER_T_LOCAL" "${JUGGLER_T_REPO-unset}"`
	const py = `import os; print(os.environ.get("JUGGLER_T_LOCAL","") + "|" + os.environ.get("JUGGLER_T_REPO","unset"), end="")`

	run := func(t *testing.T, want string) {
		t.Helper()
		res, err := shellOps.execute(context.Background(), map[string]any{"command": cmd})
		if err != nil {
			t.Fatal(err)
		}
		if got := res.(map[string]any)["stdout"]; got != want {
			t.Errorf("execute: %q, want %q", got, want)
		}

		res, err = shellOps.execute(context.Background(), map[string]any{"code": py})
		if err != nil {
			t.Fatal(err)
		}
		if got := res.(map[string]any)["stdout"]; got != want {
			t.Errorf("python: %q, want %q", got, want)
		}

		res, err = shellOps.startBackground(map[string]any{"command": cmd + "; echo; echo end"})
		if err != nil {
			t.Fatal(err)
		}
		id := res.(map[string]any)["task_id"].(string)
		defer KillTask(id)
		waitForOutput(t, id, "end", 10*time.Second)
		out, err := shellOps.getOutput(map[string]any{"taskId": id})
		if err != nil {
			t.Fatal(err)
		}
		if got := strings.SplitN(out.(map[string]any)["output"].(string), "\n", 2)[0]; got != want {
			t.Errorf("background: %q, want %q", got, want)
		}

		ch := make(chan ShellStreamChunk, 64)
		var streamed strings.Builder
		collected := make(chan struct{})
		go func() {
			for c := range ch {
				streamed.WriteString(c.Data)
			}
			close(collected)
		}()
		shellOps.ExecuteStreaming(context.Background(), "shell-env", "", cmd, "", 30000, ch)
		<-collected
		if got := streamed.String(); got != want {
			t.Errorf("streaming: %q, want %q", got, want)
		}
	}

	t.Run("unapproved", func(t *testing.T) { run(t, "from-local|unset") })
	if err := projectenv.Approve(project); err != nil {
		t.Fatal(err)
	}
	t.Run("approved", func(t *testing.T) { run(t, "from-local|from-repo") })
}

// The overrides replace an inherited variable rather than adding a duplicate,
// matching names case-insensitively where the platform does.
func TestEnvWithOverrides(t *testing.T) {
	got := envWithOverrides([]string{"PATH=/bin", "KEEP=1", "path=/x"}, map[string]string{"PATH": "/opt/bin", "NEW": "x"}, false)
	slices.Sort(got)
	want := []string{"KEEP=1", "NEW=x", "PATH=/opt/bin", "path=/x"}
	if !slices.Equal(got, want) {
		t.Fatalf("case-sensitive env %v, want %v", got, want)
	}

	got = envWithOverrides([]string{"Path=C:\\bin", "KEEP=1"}, map[string]string{"PATH": "C:\\x"}, true)
	slices.Sort(got)
	if want := []string{"KEEP=1", "PATH=C:\\x"}; !slices.Equal(got, want) {
		t.Fatalf("case-folding env %v, want %v", got, want)
	}
}
