//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package detach

import (
	"errors"
	"os/exec"
	"syscall"
)

// Windows process-creation flags (not exported by the syscall package).
const (
	createNewProcessGroup  = 0x00000200 // CREATE_NEW_PROCESS_GROUP
	createNoWindow         = 0x08000000 // CREATE_NO_WINDOW
	createBreakawayFromJob = 0x01000000 // CREATE_BREAKAWAY_FROM_JOB
)

// setDetached gives the process a process group of its own, so a ctrl-C in
// its starter's console never reaches it, and a console with no window rather
// than none at all (DETACHED_PROCESS): console programs it starts in turn
// inherit that hidden console instead of each opening a visible one. It also
// asks to leave its starter's job object, if any, whose closing would kill it.
func setDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNewProcessGroup | createNoWindow | createBreakawayFromJob,
		HideWindow:    true,
	}
}

// Start starts cmd, made by Command, and returns the command that is running.
// A job that does not allow breakaway refuses the start with access denied;
// the process is then started inside it, which is all such a job allows, and
// the command returned is that second one.
func Start(cmd *exec.Cmd) (*exec.Cmd, error) {
	err := cmd.Start()
	if err == nil || !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		return cmd, err
	}
	retry := exec.Command(cmd.Path, cmd.Args[1:]...) //nolint:gosec // the command the caller built
	retry.Env, retry.Dir = cmd.Env, cmd.Dir
	retry.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNewProcessGroup | createNoWindow,
		HideWindow:    true,
	}
	if err := retry.Start(); err != nil {
		return nil, err
	}
	return retry, nil
}
