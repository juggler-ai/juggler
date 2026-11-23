//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package main

import (
	"errors"
	"syscall"
	"time"
)

// waitForExit returns once the process pid has exited, or at once when there
// is none. Unix gives no handle to wait on a process that is not a child, so
// it asks after it (signal 0) until there is no such process — or one of
// another user's, which the pid has been reused for.
func waitForExit(pid int) {
	if pid <= 0 {
		return
	}
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) || errors.Is(err, syscall.EPERM) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}
