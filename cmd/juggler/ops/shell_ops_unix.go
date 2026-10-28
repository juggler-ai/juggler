//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package ops

import (
	"context"
	"os/exec"
	"syscall"
)

// newShellCmd builds the command that runs an approved shell string through a
// POSIX shell. On Unix that shell is the local `sh` — the same syntax the
// command-approval analyser tokenises.
func newShellCmd(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "sh", "-c", command)
}

// newPythonCmd builds the command that runs Python with the program supplied
// on stdin (caller sets cmd.Stdin).
func newPythonCmd(ctx context.Context) *exec.Cmd {
	return exec.CommandContext(ctx, "python3", "-")
}

// shellEnv adapts the environment applyProjectEnv built to the shell the
// command runs in. The local sh reads it as it is; the Windows twin has to
// route it into WSL when WSL is the shell.
func shellEnv(_ *exec.Cmd, env []string, _ map[string]string) []string {
	return env
}

// setProcGroup sets up process group for the command so we can kill all children
func setProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// startContained starts a command whose whole process tree can later be killed
// together. On Unix the containment is the process group setProcGroup asked for
// before the command was built, so there is nothing left to do once it is
// running; the Windows twin has to place the tree in a job object here, which it
// can only do after the process exists.
func startContained(cmd *exec.Cmd) error {
	return cmd.Start()
}

// releaseContainment frees whatever held the command's tree. A process group
// costs nothing to leave behind, so this is a no-op; the Windows twin closes a
// job handle.
func releaseContainment(_ *exec.Cmd) {}

// killProcessGroup kills the process and all its children
func killProcessGroup(cmd *exec.Cmd) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
