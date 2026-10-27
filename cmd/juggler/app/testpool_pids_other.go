//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build production || !darwin

package app

import "github.com/wailsapp/wails/v3/pkg/application"

// webProcessPIDs reports nothing here. WebKitGTK and WebView2 start their
// processes as descendants of this one, where the harness finds them itself,
// and a production build has no test routes to report through.
func webProcessPIDs(_ ...*application.WebviewWindow) []int { return nil }
