//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package app

import (
	"juggler/internal/windowchrome"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// applyWindowChrome syncs the native NSWindow chrome (background colour,
// opacity, titlebar appearance) with the page theme. Call it once after window
// creation and again whenever the page theme toggles.
func applyWindowChrome(win *application.WebviewWindow, bg application.RGBA) {
	windowchrome.Apply(win, bg)
}
