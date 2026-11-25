//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin && !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// noteWindowCornerRadius has nothing to measure: the frameless Linux window
// ends square at the page's last pixel.
func noteWindowCornerRadius(_ *application.WebviewWindow) {}

// windowCornerRadius is 0: the frameless Linux window has square corners.
func windowCornerRadius() int { return 0 }
