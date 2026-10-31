//go:build windows

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modkernel32               = windows.NewLazySystemDLL("kernel32.dll")
	procGetConsoleProcessList = modkernel32.NewProc("GetConsoleProcessList")
)

// launchedFromTerminal reports whether juggler was started from an existing
// terminal (cmd.exe / PowerShell / Windows Terminal) rather than the Explorer /
// Start-menu icon.
//
// juggler is a console-subsystem binary because that is the only Windows
// subsystem a shell actually *waits* on: a terminal launch then runs in the
// foreground with visible output, Ctrl+C, and the interactive keys. (A
// GUI-subsystem binary would instead detach into a hidden background process
// the moment it's run from a shell.) The cost is that an icon launch makes
// Windows allocate a fresh console window for us — but that is the right thing
// here: this binary is the *server*, so a double-click should show its terminal,
// not impersonate the desktop app. We deliberately keep that console (the GUI
// lives in juggler-app.exe; users launch that for a window).
//
// We tell a shell launch from an icon launch with GetConsoleProcessList: a shell
// launch shares the shell's console, so ≥2 processes are attached, whereas an
// icon launch owns a brand-new console alone (exactly 1). term.IsTerminal can't
// distinguish them — both look like a genuine console — so this process-count
// test is the reliable signal. The result decides, for one, whether bare
// juggler reads keys from its terminal.
func launchedFromTerminal() bool {
	var pids [2]uint32
	n, _, _ := procGetConsoleProcessList.Call(uintptr(unsafe.Pointer(&pids[0])), uintptr(len(pids)))
	return n >= 2 // sharing an existing shell's console → CLI launch
}
