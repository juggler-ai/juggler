//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package machineserver

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"

	"juggler/cmd/juggler/parentwatch"
)

// execSelf runs exe with args in this process's place, as Windows has no
// exec: a child on this process's console and standard streams, which this
// process waits for and exits with. A Ctrl-C at the console is the child's to
// answer, so this process ignores it. With exitWithParent, this process is
// the child's parent, and keeps watching its own: once that has gone, so does
// the child.
func execSelf(exe string, args []string, stderr io.Writer, exitWithParent bool) int {
	cmd := exec.Command(exe, args...) //nolint:gosec // this process's own binary and arguments
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	signal.Ignore(os.Interrupt)
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(stderr, "juggler: relaunching %s: %v\n", exe, err)
		return 1
	}
	if exitWithParent {
		// This process leaving is what the child, run with --exit-with-parent
		// too, watches for: it then stops as a stopping server does, draining
		// its sessions, rather than being killed.
		gone := parentwatch.Gone()
		go func() {
			<-gone
			os.Exit(1)
		}()
	}
	err := cmd.Wait()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit):
		return exit.ExitCode()
	default:
		fmt.Fprintf(stderr, "juggler: relaunched %s: %v\n", exe, err)
		return 1
	}
}
