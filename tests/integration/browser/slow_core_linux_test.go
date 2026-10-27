//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build linux

package browser_test

import (
	"os"
	"strconv"
	"strings"
)

// descendantsOf lists roots and every process descended from them, from
// /proc. A process that exits mid-read is skipped.
func descendantsOf(roots []int) ([]int, error) {
	dirs, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	parent := map[int]int{}
	for _, d := range dirs {
		pid, err := strconv.Atoi(d.Name())
		if err != nil {
			continue
		}
		stat, err := os.ReadFile("/proc/" + d.Name() + "/stat")
		if err != nil {
			continue
		}
		// The command name is parenthesised and may hold spaces or ')', so
		// the fields are counted from the last ')': state, then ppid.
		s := string(stat)
		i := strings.LastIndexByte(s, ')')
		if i < 0 {
			continue
		}
		fields := strings.Fields(s[i+1:])
		if len(fields) < 2 {
			continue
		}
		if ppid, err := strconv.Atoi(fields[1]); err == nil {
			parent[pid] = ppid
		}
	}
	return descendantsFrom(roots, parent), nil
}
