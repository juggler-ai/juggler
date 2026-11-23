//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package main

import (
	"errors"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"juggler/cmd/juggler/msg"

	"golang.org/x/sys/windows"
)

// Process-creation flags the syscall package does not export.
const (
	relaunchNewProcessGroup  = 0x00000200 // CREATE_NEW_PROCESS_GROUP
	relaunchBreakawayFromJob = 0x01000000 // CREATE_BREAKAWAY_FROM_JOB
)

// errRelaunchWouldDie refuses a relaunch that would not survive this launch:
// this app runs in a job that kills what it holds once closed, and will not
// let the next launch leave it.
var errRelaunchWouldDie = msg.NewError("Juggler can't relaunch itself from here: whatever started it would stop the new launch along with this one. Quit Juggler and open it again.")

// startRelaunch starts the next launch: exe with args, in exe's directory, in
// a process group of its own, and out of this app's job object if it is in
// one, since a job that kills its processes when it closes would take the next
// launch with this one. A job that refuses to let it leave is tolerated when
// it kills nothing on closing; otherwise the relaunch is refused, and this
// launch keeps running.
//
// The window is not hidden, unlike internal/detach's processes: the next
// launch is the app, and its first window must show. It returns the next
// launch's pid.
func startRelaunch(exe string, args []string) (int, error) {
	cmd := relaunchCommand(exe, args, true)
	err := cmd.Start()
	if errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		if ownJobKillsOnClose() {
			return 0, errRelaunchWouldDie
		}
		cmd = relaunchCommand(exe, args, false)
		err = cmd.Start()
	}
	if err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	return pid, cmd.Process.Release()
}

func relaunchCommand(exe string, args []string, breakaway bool) *exec.Cmd {
	cmd := exec.Command(exe, args...) //nolint:gosec // this app's own binary and its own flags
	cmd.Dir = filepath.Dir(exe)
	flags := uint32(relaunchNewProcessGroup)
	if breakaway {
		flags |= relaunchBreakawayFromJob
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags}
	return cmd
}

// ownJobKillsOnClose is whether this process is in a job object that kills its
// processes when the job closes. A process in no job, or whose job cannot be
// asked, is not.
func ownJobKillsOnClose() bool {
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(0, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		return false
	}
	return info.BasicLimitInformation.LimitFlags&windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0
}

// waitForExit returns once the process pid has exited, or at once when there
// is none it may wait on.
func waitForExit(pid int) {
	if pid <= 0 {
		return
	}
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return
	}
	defer func() { _ = windows.CloseHandle(h) }()
	_, _ = windows.WaitForSingleObject(h, windows.INFINITE)
}
