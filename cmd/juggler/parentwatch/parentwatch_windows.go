//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package parentwatch

import "golang.org/x/sys/windows"

// waitExit blocks until the parent process is gone. Windows never reparents
// an orphan, so PPID polling would never fire; instead open the parent by PID and
// wait on its process handle, which becomes signalled when the parent exits —
// clean quit, crash, or kill alike. This is what makes --exit-with-parent
// actually tear the server down with the desktop app on Windows (the Job Object's
// kill-on-close doesn't reliably propagate through Win10/11's nested jobs).
func waitExit(startPPID int) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(startPPID))
	if err != nil {
		return // parent already gone or inaccessible — caller self-terminates
	}
	defer func() { _ = windows.CloseHandle(h) }()
	_, _ = windows.WaitForSingleObject(h, windows.INFINITE)
}
