//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin && !production

package app

// #cgo LDFLAGS: -framework AppKit -framework WebKit
// extern void juggler_set_dock_icon_visible(int visible);
import "C"

// setDockIconVisible shows or hides the macOS Dock icon and App Switcher entry
// by switching between NSApplicationActivationPolicyRegular (visible) and
// NSApplicationActivationPolicyAccessory (hidden). The switch is dispatched to
// the main queue so it is safe to call from any goroutine.
func setDockIconVisible(visible bool) {
	v := C.int(0)
	if visible {
		v = 1
	}
	C.juggler_set_dock_icon_visible(v)
}
