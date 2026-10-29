//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"juggler/internal/jlog"
	"juggler/internal/logpaths"
	"juggler/internal/sysopen"
)

// initAppLogging brings up the shared jlog sink for the desktop app, writing to
// app.log in the platform log dir (component "app"). The app ships as a GUI-subsystem
// (windowsgui) binary with no console, so stderr goes nowhere on Windows — the
// file is the only way to see startup breadcrumbs (e.g. why a window failed to
// appear). We resolve a writable path — the central app.log first, then the
// temp dir, then next to the executable — so a file is produced even if the home
// dir is unwritable. Console output is kept (harmless on Windows, useful on a
// terminal launch). Caller pairs this with jlog.Close at exit.
func initAppLogging() {
	jlog.Init(jlog.Options{
		ConsoleLevel: jlog.LevelInfo,
		Colors:       true,
		Component:    "app",
		MaxSizeMB:    10,
		MaxBackups:   5,
		LogFilePath:  resolveWritable(logpaths.AppLogPath()),
	})
	// Best-effort: age out stale logs from the shared directory so they don't
	// accumulate forever (the server does the same; this covers an app launch
	// that never reaches one). Active logs keep a current mtime.
	if n := logpaths.SweepOldLogs(logpaths.LogDir(), logpaths.DefaultLogRetention, time.Now()); n > 0 {
		jlog.Debug("🧹 Removed %d stale log file(s) from %s", n, logpaths.LogDir())
	}
}

// resolveWritable returns the first of [preferred, temp/app.log, exe-dir/app.log]
// whose parent directory it can create, so logging always lands somewhere.
func resolveWritable(preferred string) string {
	candidates := []string{preferred, filepath.Join(os.TempDir(), "juggler-app.log")}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "juggler-app.log"))
	}
	for _, p := range candidates {
		if os.MkdirAll(filepath.Dir(p), 0o755) == nil {
			return p
		}
	}
	return preferred
}

// logf writes an operational breadcrumb through the shared jlog sink: to stderr
// (visible on a terminal launch) and to app.log (the only sink on a windowless
// Windows launch).
func logf(format string, args ...any) {
	jlog.Info("[juggler-app] "+format, args...)
}

// openInBrowser opens url in the user's default browser. The URL can come from
// a link in rendered model output, so it is passed to the system opener whole
// and never through a shell (see sysopen.Argv).
func openInBrowser(url string) error {
	argv := sysopen.Argv(runtime.GOOS, url)
	return exec.Command(argv[0], argv[1:]...).Start() //nolint:gosec // isBrowserURL-checked, passed as one argument
}

// isBrowserURL reports whether s is a plain web URL safe to hand to the system
// browser. Restricting to http/https stops the loopback control endpoint from
// being coaxed into launching arbitrary schemes (file:, custom app URLs) via
// the platform "open" command.
func isBrowserURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}
