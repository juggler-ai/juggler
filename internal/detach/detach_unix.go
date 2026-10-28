//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package detach

import (
	"os/exec"
	"syscall"
)

// setDetached puts the process in a session of its own (Setsid), out of its
// starter's process group and away from its controlling terminal, so neither
// a ctrl-C there nor a kill of the starter's group reaches it.
func setDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// Start starts cmd, made by Command, and returns the command that is running.
func Start(cmd *exec.Cmd) (*exec.Cmd, error) {
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}
