//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Nothing of Juggler's may be written into a workspace. A command that runs in
// one still spills into the PROJECT's .juggler/ — otherwise a fresh worktree is
// reported dirty by `git status`, and removing it takes the spill with it.
func TestSpillDir_FollowsTheProjectNotTheWorkspace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("seq/sh streaming command is POSIX-only")
	}
	project := t.TempDir()
	workspace := t.TempDir()

	scope := NewPathScope(workspace, nil).WithProjectRoot(project)
	if got := scope.Root(); got != workspace {
		t.Fatalf("Root() = %q, want the workspace the command runs in", got)
	}
	if got := scope.ProjectRoot(); got != project {
		t.Fatalf("ProjectRoot() = %q, want %q", got, project)
	}

	// A command run in the workspace, with output past the spill threshold: the
	// spill file it reports is where the shell actually put it.
	out := make(chan ShellStreamChunk, 1024)
	var done ShellStreamChunk
	collected := make(chan struct{})
	go func() {
		for c := range out {
			if c.Done {
				done = c
			}
		}
		close(collected)
	}()
	NewShellOperations(scope).ExecuteStreaming(context.Background(), "shell-spill", "conv_1", "seq 1 1000000", "", 60000, out)
	<-collected

	if done.OutputFile == "" {
		t.Fatalf("no spill file reported for output past the threshold: %+v", done)
	}
	if want := filepath.Join(project, ".juggler", "bash-output", "conv_1") + string(filepath.Separator); !strings.HasPrefix(done.OutputFile, want) {
		t.Fatalf("spill file = %q, want it under %q", done.OutputFile, want)
	}
	if _, err := os.Stat(filepath.Join(workspace, ".juggler")); !os.IsNotExist(err) {
		t.Fatalf("the workspace has a .juggler/ (stat err %v), want nothing of ours inside it", err)
	}
}

// A scope that was never told about a project is its own project, so a
// request that names no workspace spills into the tree it runs in.
func TestProjectRoot_DefaultsToTheWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	scope := NewPathScope(root, []string{"/tmp"})
	if got := scope.ProjectRoot(); got != root {
		t.Fatalf("ProjectRoot() = %q, want the working directory %q", got, root)
	}
	if got := spillDirFor(scope.ProjectRoot(), ""); got != filepath.Join(root, ".juggler", "bash-output", "_unassigned") {
		t.Fatalf("spill dir = %q, want the unassigned bucket under the working directory", got)
	}
}
