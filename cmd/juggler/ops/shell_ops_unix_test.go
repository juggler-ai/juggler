//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package ops

import (
	"os/exec"
	"testing"
)

// requirePOSIXShell is the twin of the Windows helper, which skips where no
// POSIX shell resolves. The local sh is always there.
func requirePOSIXShell(t *testing.T) { t.Helper() }

// posixShellCommand runs script in the local sh, for a test that needs a
// process to stand in for something else.
func posixShellCommand(t *testing.T, script string) *exec.Cmd {
	t.Helper()
	return exec.Command("sh", "-c", script)
}

// requireGracefulStop is the twin of the Windows helper, which skips because a
// stop there takes the whole job at once. Here a stop is a SIGTERM the
// process group can outlive, and escalation is real.
func requireGracefulStop(t *testing.T) { t.Helper() }

// requirePython skips a test that runs Python where python3 is not installed.
func requirePython(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not installed")
	}
}
