//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin && !linux

package machineload

// readLoadAverage has nothing to read. Windows keeps no run-queue average — the
// nearest equivalent is a performance counter sampled over an interval, which
// costs a wait, and a diagnostic assembled inside a failing test cannot afford
// one. Callers report the absence instead.
func readLoadAverage() (one, five, fifteen float64, ok bool) {
	return 0, 0, 0, false
}
