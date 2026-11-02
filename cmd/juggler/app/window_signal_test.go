//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import "testing"

// The headless server installs its own SIGINT/SIGTERM handling in waitForExit,
// which runs the full teardown — server shutdown, provider subprocesses, the
// project lock — before any native quit. Wails' default handler does none of
// that: signal_handler_desktop.go wires the first signal straight to app.Quit(),
// i.e. [NSApp terminate:], which ends the process without unwinding.
//
// With both handlers armed, one SIGINT reaches both. Terminate wins, because it
// has no work to do, and the process dies wherever teardown had reached — in
// practice partway through stopping the conversation workers, so conversations
// are never closed, provider subprocesses are never reaped, and the project lock
// (released last of all) is stranded until the kernel reclaims the file
// descriptors. The next launch finds the project locked.
//
// Wails must therefore not handle signals for this process.
func TestHeadlessServerDisablesWailsSignalHandler(t *testing.T) {
	if !headlessServerAppOptions(nil).DisableDefaultSignalHandler {
		t.Fatal("headless server must set DisableDefaultSignalHandler: Wails' handler " +
			"calls app.Quit() on the first signal, terminating the process while our own " +
			"graceful shutdown is still running")
	}
}
