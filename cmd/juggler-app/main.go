//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Command juggler-app is the Juggler desktop window. One process owns many
// windows, each a viewer pointed at a juggler server over HTTP/WebSocket. It is
// a client of this machine's Juggler server, which it finds or starts at launch
// and stays attached to (server_conn.go):
//
//   - with --url, the first window connects to a server by its address,
//   - with --project, it shows that project's session on this machine's
//     server,
//   - with neither, it restores the windows open last time.
//
// "New Window" (menu or the page) opens another in-process window onto this
// machine's server's page, where a project is chosen. The server and its
// sessions do all the work; this process is a pure viewer plus a small loopback
// endpoint that lets each page drive its own native window controls (theme,
// minimise/maximise/close, new window).
package main

import (
	"flag"
	"os"
	"strings"

	"juggler/internal/jlog"
	"juggler/internal/webviewenv"
)

func main() {
	urlFlag := flag.String("url", "", "Connect the first window to a juggler server at this URL. When omitted, the window shows this machine's server, started if none is running.")
	project := flag.String("project", "", "Project folder whose session the first window shows (ignored when --url is given).")
	verbose := flag.Bool("verbose", false, "Verbose logging and the dev View menu (reload, devtools).")
	dev := flag.Bool("dev", false, "Enable dev mode: web inspector + the full right-click menu, and the dev View menu.")
	flag.Parse()

	devMode := 0
	if *verbose || *dev {
		devMode = 1
	}
	initAppLogging()
	defer jlog.Close()
	logf("start: url=%q project=%q args=%v", *urlFlag, *project, os.Args)
	// Before any GTK/WebKit init: on a Linux host that blocks the unprivileged
	// user namespaces WebKitGTK's bwrap sandbox needs, disable that sandbox so
	// the window can come up instead of aborting with a cgo SIGTRAP. No-op off
	// Linux, on an unrestricted host, or when the user set the var themselves.
	if note := webviewenv.PrepareLinuxWebKit(); note != "" {
		logf("%s", note)
	}
	app := newAppState(devMode)
	// The visible-window GPU policy is resolved exactly once, in newAppState, and
	// stored on appState. Log that same resolved reason here so the startup line
	// provably matches the policy every window actually applied (no independent
	// re-evaluation that could drift from it).
	if app.gpuNote != "" {
		logf("%s", app.gpuNote)
	}

	// Build the application — and acquire the single-instance lock — BEFORE
	// reaching for any server. If another juggler-app is already running, this
	// call hands our argv (--url/--project) to it and os.Exit()s here, so a
	// redundant launch never starts or attaches to anything; the running
	// instance opens/raises the window (onSecondInstance).
	app.initApplication()

	// Bind the loopback control endpoint so its port can be baked into window
	// URLs as ?nativeCtl=.
	ln, err := listenControl()
	if err != nil {
		logf("control listener: %v", err)
		return
	}
	app.serveControl(ln)

	// On Linux, follow live desktop light/dark toggles in "system" mode by
	// watching the XDG desktop portal; a no-op on macOS/Windows, where the WebView
	// already tracks the OS setting. Started after the app + control endpoint exist
	// and before the event loop, so the first signal is delivered once windows are
	// up.
	app.watchSystemColorScheme()

	// An explicit --url/--project opens just that window; otherwise restore the
	// last open set of windows (each at its remembered geometry).
	specs := app.startupSpecs(*urlFlag, *project)
	runErr := app.run(specs)
	app.detachServer()
	if runErr != nil {
		// A non-nil return from the event loop means the GUI itself failed (e.g.
		// g_application_run exited non-zero). Surface it loudly and exit non-zero
		// rather than reporting success for a launch that never showed a window.
		fatalf("window app exited with error: %v", runErr)
	}
}

// normalizeURL ensures a user-supplied --url has an http(s) scheme.
func normalizeURL(u string) string {
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return "http://" + u
	}
	return u
}

// parseLaunchArgs extracts --url and --project from a second instance's argv
// (args[0] is the program), in either flag spelling (-x or --x, with the value
// after = or as the next argument). Every other argument is stepped over rather
// than ending the scan, as a flag.FlagSet would at the first flag it did not
// declare: a dev-mode server opens its window with --dev ahead of --url, and
// macOS can add a -psn_ argument of its own. A later value wins, as with flag.
func parseLaunchArgs(args []string) (url, project string) {
	for i := 1; i < len(args); i++ {
		name, ok := strings.CutPrefix(args[i], "-")
		if !ok {
			continue
		}
		if name == "-" {
			break // "--" ends the flags
		}
		name = strings.TrimPrefix(name, "-")
		name, value, hasValue := strings.Cut(name, "=")
		if name != "url" && name != "project" {
			continue
		}
		if !hasValue {
			if i+1 >= len(args) {
				break
			}
			i++
			value = args[i]
		}
		if name == "url" {
			url = value
		} else {
			project = value
		}
	}
	return strings.TrimSpace(url), strings.TrimSpace(project)
}
