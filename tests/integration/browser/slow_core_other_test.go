//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin && !linux && !windows

package browser_test

import (
	"errors"
	"runtime"
)

func slowCoreSupported() error {
	return errors.New("slow-core mode has no way to stop a process on " + runtime.GOOS)
}

func pauseProcesses([]int)               {}
func resumeProcesses([]int)              {}
func descendantsOf([]int) ([]int, error) { return nil, nil }
