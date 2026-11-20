//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin && !production

package app

import "github.com/wailsapp/wails/v3/pkg/application"

// keepTestPageForeground is a no-op outside macOS, whose WebKit is the one that
// moves a hidden page's web process to the efficiency cores. WebView2 keeps the
// pool's controller visible instead; WebKitGTK's scheduling is the kernel's.
func keepTestPageForeground(_ *application.WebviewWindow) bool { return true }
