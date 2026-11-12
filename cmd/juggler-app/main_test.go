//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"testing"
)

// TestMain keeps the package's tests off the local network: opening a window
// onto a server by URL asks macOS to let the app onto it (askLocalNetwork),
// which a test has no business doing.
func TestMain(m *testing.M) {
	askLocalNetwork = func() {}
	os.Exit(m.Run())
}
