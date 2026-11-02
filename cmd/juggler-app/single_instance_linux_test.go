//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"path/filepath"
	"testing"
)

// TestNoSessionBusIsNoLock: a session bus address that leads nowhere is a lock
// the app cannot take.
func TestNoSessionBusIsNoLock(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path="+filepath.Join(t.TempDir(), "no-bus"))
	if err := singleInstanceUnavailable(); err == nil {
		t.Error("with no session bus the single-instance lock is reported available")
	}
}
