//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package helpers

import (
	"os/exec"
	"syscall"
)

// SetProcGroupAttr is a no-op on Windows, which has no process groups to put
// cmd in.
func SetProcGroupAttr(_ *exec.Cmd) {}

// SignalGroup signals cmd alone. Windows can deliver no signal to another
// process but a kill, so any other signal kills it — what the machine server's
// supervisor does to a session child it cannot interrupt. A caller waiting for
// the process to exit after a SIGTERM would otherwise wait forever.
func SignalGroup(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if err := cmd.Process.Signal(sig); err != nil {
		_ = cmd.Process.Kill()
	}
}
