//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package browser_test

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// NtSuspendProcess and NtResumeProcess stop and continue every thread of a
// process at once, which is what SIGSTOP/SIGCONT do elsewhere. They are
// undocumented but stable ntdll exports, and the only whole-process switch
// Windows has.
var (
	ntdll            = windows.NewLazySystemDLL("ntdll.dll")
	ntSuspendProcess = ntdll.NewProc("NtSuspendProcess")
	ntResumeProcess  = ntdll.NewProc("NtResumeProcess")
)

func slowCoreSupported() error {
	if err := ntSuspendProcess.Find(); err != nil {
		return err
	}
	return ntResumeProcess.Find()
}

func pauseProcesses(pids []int)  { eachProcess(pids, ntSuspendProcess) }
func resumeProcesses(pids []int) { eachProcess(pids, ntResumeProcess) }

// eachProcess calls one of the two on each process; one that has exited, or
// will not open, is skipped.
func eachProcess(pids []int, call *windows.LazyProc) {
	for _, p := range pids {
		h, err := windows.OpenProcess(windows.PROCESS_SUSPEND_RESUME, false, uint32(p))
		if err != nil {
			continue
		}
		_, _, _ = call.Call(uintptr(h))
		_ = windows.CloseHandle(h)
	}
}

// descendantsOf lists roots and every process descended from them, from a
// process snapshot.
func descendantsOf(roots []int) ([]int, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = windows.CloseHandle(snap) }()
	parent := map[int]int{}
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		parent[int(entry.ProcessID)] = int(entry.ParentProcessID)
	}
	return descendantsFrom(roots, parent), nil
}
