//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

// windows11Build is the first Windows build that rounds window corners.
const windows11Build = 22000

// noteWindowCornerRadius has nothing to measure on Windows: DWM reports no
// radius, and windowCornerRadius goes by the build instead.
func noteWindowCornerRadius(_ *application.WebviewWindow) {}

// windowCornerRadius is how round the corners of a window this app opens are,
// in CSS pixels at 100%: DWM rounds a window's corners at 8 on Windows 11 and
// not at all on Windows 10.
func windowCornerRadius() int {
	if v := windows.RtlGetVersion(); v != nil && v.BuildNumber >= windows11Build {
		return 8
	}
	return 0
}
