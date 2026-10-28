//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows && !darwin

package app

import "juggler/internal/detach"

// launchDetached starts a new juggler instance on Linux (and other unix). There
// is no single-instance window manager convention to defeat, so we exec the
// binary directly, detached (see the detach package), so it outlives this
// process.
func launchDetached(exe string, args []string) error {
	cmd, err := detach.Start(detach.Command(exe, args...))
	if err != nil {
		return err
	}
	return cmd.Process.Release()
}
