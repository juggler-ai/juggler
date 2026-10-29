//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build production

package app

import (
	"juggler/cmd/juggler/server"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// runTestPoolWindowApp in a production build: the test-pool window host is
// not compiled in (window_testpool.go), so a release binary started with
// --test stops here rather than opening a harness window. RegisterTestRoutes
// refuses --test before startup reaches this.
func runTestPoolWindowApp(_ *server.Server, _ bool, _ bool, _ int, _ string, _ <-chan struct{}, _ <-chan struct{}, _ func(), _ func(*application.App, *application.WebviewWindow)) {
	panic("runTestPoolWindowApp: this is a production-tagged build, which has no test-pool window (--test is unsupported)")
}
