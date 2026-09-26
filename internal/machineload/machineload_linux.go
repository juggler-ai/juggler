//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build linux

package machineload

import (
	"os"
	"strconv"
	"strings"
)

// readLoadAverage reads /proc/loadavg, whose first three fields are the
// averages. Preferred over the sysinfo syscall because it needs no fixed-point
// conversion and reads the same on every kernel that has a procfs — including a
// container, where it reports the host's figure, which is the one that decides
// whether this process gets a core.
func readLoadAverage() (one, five, fifteen float64, ok bool) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return 0, 0, 0, false
	}
	var vals [3]float64
	for i := range vals {
		v, err := strconv.ParseFloat(fields[i], 64)
		if err != nil {
			return 0, 0, 0, false
		}
		vals[i] = v
	}
	return vals[0], vals[1], vals[2], true
}
