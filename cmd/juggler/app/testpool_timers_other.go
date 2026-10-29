//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production && ((!darwin && !linux) || (linux && gtk3))

package app

import "github.com/wailsapp/wails/v3/pkg/application"

// unthrottleHiddenPageTimers is a no-op outside a macOS or GTK4 test build.
//
// Elsewhere there is nothing to call: WebView2 keeps its controller visible
// (Windows.KeepRunningWhenHidden), so its timers are not backgrounded in the
// first place, and GTK3 is a Wails build tag this project neither ships nor
// tests. In a production build it is excluded deliberately — see the macOS file
// for why the SPI must not reach a shipped binary.
func unthrottleHiddenPageTimers(_ *application.WebviewWindow) bool { return false }

// ensureHiddenPoolWebViewSized reports that the pool's web view has a size,
// because on these platforms it always has: a hidden Cocoa or WebView2 window
// is still an allocated one, so its web view is the size the window was asked
// for and the lanes in it lay out in a page of that size. GTK4 is the port that
// leaves an unmapped window's web view at 0x0 — see the Linux file.
func ensureHiddenPoolWebViewSized(_ *application.WebviewWindow, _, _ int) bool { return true }
