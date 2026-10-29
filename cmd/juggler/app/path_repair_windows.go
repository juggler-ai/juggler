//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package app

// repairPathForGUILaunch is a no-op on Windows: there is no POSIX login shell
// to probe, and Windows GUI launches already inherit the system+user PATH from
// the registry (HKLM/HKCU ...Environment), so the Go toolchain and other
// installed tools are found without help. Kept as a stub so Run() can call it
// unconditionally across platforms.
func repairPathForGUILaunch(hasTerminal bool) {}

// repairPathForServe is a no-op on Windows for the same reason, and must not
// call launchedFromTerminal: there that detaches an icon launch's console.
func repairPathForServe() {}
