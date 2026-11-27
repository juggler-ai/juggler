//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"log/slog"
	"strings"

	"juggler/internal/jlog"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// withWailsLog points Wails' own diagnostics at the server's log.
//
// Left to itself Wails writes them to stderr in a test build and discards them
// in a release one, so neither reaches server.log — and among them is the only
// record of a web process failing under the engine or a pool window (on
// Windows, WebView2's ProcessFailed, with the kind of process and what Wails
// did about it). A page whose renderer died otherwise leaves nothing but the
// fetches it never finished. Debug lines are left out: they are Wails talking
// to itself.
func withWailsLog(opts application.Options) application.Options {
	opts.Logger = slog.New(slog.NewTextHandler(wailsLogWriter{}, &slog.HandlerOptions{Level: slog.LevelInfo}))
	opts.ErrorHandler = func(err error) { jlog.Error("[wails] %v", err) }
	opts.WarningHandler = func(msg string) { jlog.Info("[wails] warning: %s", msg) }
	return opts
}

// wailsLogWriter takes the records Wails' slog handler formats, one per Write,
// into jlog. The level is already in the line ("level=ERROR ...").
type wailsLogWriter struct{}

func (wailsLogWriter) Write(p []byte) (int, error) {
	jlog.Info("[wails] %s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}
