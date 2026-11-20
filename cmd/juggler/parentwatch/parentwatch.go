//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package parentwatch tells a spawned process when the process that started it
// is gone, so a server its owner launched (the desktop app, `juggler run`, a
// test harness) never outlives that owner. The wait is platform-specific:
// macOS/Linux poll PPID; Windows waits on the parent's process handle, since
// Windows never reparents an orphan.
package parentwatch

import "os"

// Gone returns a channel closed once this process's parent has exited, or nil
// when it was started by init/launchd (pid 1), which never exits.
func Gone() <-chan struct{} {
	startPPID := os.Getppid()
	if startPPID <= 1 {
		return nil
	}
	ch := make(chan struct{})
	go func() {
		waitExit(startPPID)
		close(ch)
	}()
	return ch
}
