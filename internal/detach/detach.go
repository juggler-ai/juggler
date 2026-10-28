//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package detach starts a process that outlives the one starting it: its own
// session (unix) or process group (Windows), no console of ours, and the null
// device for stdio, so nothing it inherits ties it to its starter and no pipe
// is left for the starter to abandon. Whoever starts one may Wait for it while
// it runs, or Release it; either way it carries on once the starter exits.
//
// It is not childcontain, which does the opposite: a contained child dies
// with its parent.
package detach

import "os/exec"

// Command returns the command for name and args, set up to run detached.
// Start it with Start.
func Command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...) //nolint:gosec // callers pass their own binary and fixed args
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	setDetached(cmd)
	return cmd
}
