//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows && !darwin

package main

import (
	"path/filepath"

	"juggler/internal/detach"
)

// startRelaunch starts the next launch detached, in exe's directory, so it is
// not stopped along with this one, and returns its pid.
func startRelaunch(exe string, args []string) (int, error) {
	cmd := detach.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	started, err := detach.Start(cmd)
	if err != nil {
		return 0, err
	}
	pid := started.Process.Pid
	return pid, started.Process.Release()
}
