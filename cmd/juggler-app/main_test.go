//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"io"
	"os"
	"testing"
)

// TestMain keeps the package's tests off the local network: opening a window
// onto a server by URL asks macOS to let the app onto it (askLocalNetwork),
// which a test has no business doing.
//
// Run with stayUntilStdinClosesEnv set, the test binary is instead a process
// that lives until its stdin closes, for tests that need one to wait on.
func TestMain(m *testing.M) {
	if os.Getenv(stayUntilStdinClosesEnv) == "1" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
	askLocalNetwork = func() {}
	os.Exit(m.Run())
}

const stayUntilStdinClosesEnv = "JUGGLER_APP_TEST_STAY_UNTIL_STDIN_CLOSES"
