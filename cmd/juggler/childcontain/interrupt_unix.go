//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build unix

package childcontain

import (
	"os/exec"
	"syscall"
)

// Interrupt asks a contained child's whole process group to stop, as Ctrl-C
// would: SIGINT, which a program can catch to clean up after itself. Terminate
// is the answer to a child that does not. Prepare put the child in a group of
// its own, so the signal reaches whatever it started too.
func Interrupt(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGINT); err != nil && err != syscall.ESRCH {
		return err
	}
	return nil
}
