//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package machineload

import (
	"unsafe"

	"golang.org/x/sys/unix"
)

// loadavg mirrors the kernel's `struct loadavg` (sys/resource.h): three
// fixed-point averages and the scale to divide them by. The averages are
// fixpt_t (uint32) and fscale is a long, so the compiler pads four bytes
// between them — the same padding the kernel writes, which is why this can be
// read straight off the sysctl's bytes.
type loadavg struct {
	ldavg  [3]uint32
	fscale uint64
}

// readLoadAverage asks the kernel for vm.loadavg. There is no libc call for this
// that does not need cgo, and the sysctl is stable API.
func readLoadAverage() (one, five, fifteen float64, ok bool) {
	raw, err := unix.SysctlRaw("vm.loadavg")
	if err != nil || len(raw) < int(unsafe.Sizeof(loadavg{})) {
		return 0, 0, 0, false
	}
	la := (*loadavg)(unsafe.Pointer(&raw[0]))
	if la.fscale == 0 {
		return 0, 0, 0, false
	}
	scale := float64(la.fscale)
	return float64(la.ldavg[0]) / scale, float64(la.ldavg[1]) / scale, float64(la.ldavg[2]) / scale, true
}
