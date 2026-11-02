//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import "github.com/godbus/dbus/v5"

// singleInstanceUnavailable reports why the single-instance lock cannot be
// taken, or nil. On Linux the lock is a name on the session bus, so there is
// none to take without one: an ssh -X session, or a desktop that starts no
// bus.
func singleInstanceUnavailable() error {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return err
	}
	_ = conn.Close()
	return nil
}
