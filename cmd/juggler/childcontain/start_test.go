//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package childcontain_test

import (
	"os/exec"

	"juggler/cmd/juggler/childcontain"
)

// start prepares, starts, and adopts cmd into child containment: the sequence
// every caller of the package performs.
func start(cmd *exec.Cmd) (*childcontain.Child, error) {
	childcontain.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return childcontain.Adopt(cmd)
}
