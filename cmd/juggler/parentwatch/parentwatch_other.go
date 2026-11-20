//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package parentwatch

import (
	"os"
	"time"
)

// waitExit blocks until the parent process identified at startup is gone.
// macOS/Linux have no Pdeathsig wired here, so poll PPID: when it changes (the
// orphan is reparented to init/launchd, pid 1), the original parent has exited.
func waitExit(startPPID int) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		if os.Getppid() != startPPID {
			return
		}
	}
}
