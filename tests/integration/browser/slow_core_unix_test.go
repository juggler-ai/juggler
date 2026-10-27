//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin || linux

package browser_test

import "syscall"

func slowCoreSupported() error { return nil }

// pauseProcesses stops each process; one that has exited is skipped.
func pauseProcesses(pids []int) {
	for _, p := range pids {
		_ = syscall.Kill(p, syscall.SIGSTOP)
	}
}

// resumeProcesses continues each process; one that has exited is skipped.
func resumeProcesses(pids []int) {
	for _, p := range pids {
		_ = syscall.Kill(p, syscall.SIGCONT)
	}
}
