//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package browser_test

import "golang.org/x/sys/unix"

// descendantsOf lists roots and every process descended from them, from the
// kernel's process table.
func descendantsOf(roots []int) ([]int, error) {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, err
	}
	parent := make(map[int]int, len(procs))
	for i := range procs {
		parent[int(procs[i].Proc.P_pid)] = int(procs[i].Eproc.Ppid)
	}
	return descendantsFrom(roots, parent), nil
}
