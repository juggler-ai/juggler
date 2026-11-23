//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package machineserver

import (
	"fmt"
	"io"
	"os"
	"syscall"
)

// execSelf replaces this process's image with exe's, run with args: the same
// process, terminal and parent, so --exit-with-parent holds as it did. It
// returns only when the exec failed.
func execSelf(exe string, args []string, stderr io.Writer, _ bool) int {
	err := syscall.Exec(exe, append([]string{exe}, args...), os.Environ()) //nolint:gosec // this process's own binary and arguments
	fmt.Fprintf(stderr, "juggler: relaunching %s: %v\n", exe, err)
	return 1
}
