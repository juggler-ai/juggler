//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	goruntime "runtime"
	"strings"
	"sync"
	"syscall"

	"juggler/cmd/juggler/server"
	"juggler/internal/jlog"
	"juggler/internal/sysopen"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// waitForExit blocks until something asks the process to stop. Always runs
// the Wails event loop (the test pool's slot subprocesses each own their own
// Wails window per A10).
//
// Signal handling runs in goroutines that call quit() to exit. Run's deferred
// cleanups release allocated resources after waitForExit returns.
func (a *App) waitForExit() {
	// done is closed by the first goroutine that wants to shut down.
	done := make(chan struct{})
	var closeOnce sync.Once
	signalDone := func() { closeOnce.Do(func() { close(done) }) }

	// readyCh receives the Wails *App + main *WebviewWindow from window.go's
	// startup hook. Buffered so the hook never blocks. Callers that need the
	// references wait on ready.
	type windowRefs struct {
		app *application.App
		win *application.WebviewWindow
	}
	readyCh := make(chan windowRefs, 1)
	ready := make(chan struct{})
	var refs windowRefs

	go func() {
		refs = <-readyCh
		close(ready)
	}()

	// onWindowReady is called by window.go's startup hook to hand us the
	// application and main-window pointers.
	onWindowReady := func(app *application.App, win *application.WebviewWindow) {
		readyCh <- windowRefs{app: app, win: win}
	}

	// teardownDone is closed once the teardown stack has finished, immediately
	// before the native quit is issued. window.go's shutdown goroutine waits on
	// it, so closing done can no longer race [NSApp terminate:] against the
	// cleanups: whoever asks to quit, teardown completes first.
	teardownDone := make(chan struct{})
	var teardownOnce sync.Once
	signalTeardownDone := func() { teardownOnce.Do(func() { close(teardownDone) }) }

	// quit closes done, releases everything the startup phases allocated, and
	// only then asks the native application to stop when this startup path owns
	// one. Node-hosted production servers have no native application.
	//
	// Teardown runs here rather than being left to Run's deferred walk because
	// the native quit does not reliably return — see beginShutdown.
	//
	// Single-shot: several triggers can fire at once (a failing engine host and
	// a SIGINT, say), and a second pass would issue a second native quit while
	// the first is mid-flight. Concurrent callers block here until the first
	// has finished tearing down, which is what they want anyway.
	var quitOnce sync.Once
	quit := func() {
		quitOnce.Do(func() {
			if a.server != nil {
				a.server.StopTunnel()
			}
			signalDone()
			<-ready
			a.beginShutdown(func() {
				signalTeardownDone()
				if refs.app != nil {
					refs.app.Quit()
				}
			})
		})
	}

	// requestQuit is the trigger handed to the window layer and the engine host.
	// It runs the same serialized path as the signal handlers rather than just
	// closing done: an engine-host failure or a window close owes the same
	// teardown a Ctrl-C does, and closing done alone would terminate the process
	// with the cleanup stack untouched — server never shut down, conversations
	// never saved, provider subprocesses orphaned. On its own goroutine because
	// quit blocks on <-ready, and its callers include Wails event listeners.
	requestQuit := func() { go quit() }

	// --window opens a desktop window: the server is windowless, so it launches
	// the juggler-app process pointed at this server's URL. The app owns the
	// visible UI and connects back over HTTP/WebSocket like any viewer.
	launchWindow := func() {
		devMode := a.devModeEnabled()
		if err := launchDesktopApp(a.serverURL(), devMode); err != nil {
			jlog.Error("Failed to open window: %v", err)
		}
	}

	// Two independent signal pipelines:
	//
	//   emergencySig — fed by a separate signal.Notify subscription. Owned by
	//                  a goroutine that does NOTHING but count Ctrl-Cs and
	//                  os.Exit(130) on the third. No logging, no shared state,
	//                  no other channels. Designed to be the absolute last line
	//                  of defence: if any other part of the process is wedged
	//                  (Cocoa main thread inside WebKit, jlog sink blocked, Go
	//                  scheduler starved, …), 3 × Ctrl-C still kills us.
	//
	//   gracefulSig  — fed by its own signal.Notify subscription. Owned by a
	//                  goroutine that prints status and triggers app.Quit()
	//                  asynchronously. Allowed to be slow or hang; the
	//                  emergency path is independent of it.
	//
	// Go's signal package delivers EVERY registered SIGINT/SIGTERM to EVERY
	// channel passed to signal.Notify (it iterates registrations and sends to
	// each), so a single Ctrl-C reaches both pipelines. Either can be wedged
	// without affecting the other.
	emergencySig := make(chan os.Signal, 32)
	signal.Notify(emergencySig, os.Interrupt, syscall.SIGTERM)
	go func() {
		// Minimal: drain channel, count, exit. No string formatting, no
		// logger calls, no IO of any kind that could block, no interaction
		// with anything else. If even THIS is somehow blocked, the process
		// is unrecoverable from userland.
		//
		// We do NOT print before exiting. A stderr write to a TTY in a
		// paused state (Ctrl-S, pipe with no reader, AppKit-blocked
		// Terminal) can block indefinitely; if that happens between the
		// write and the os.Exit call, the user's third Ctrl-C silently
		// does nothing — the exact failure mode this code exists to
		// prevent. The user pressed Ctrl-C three times: they know they
		// asked us to quit.
		n := 0
		for range emergencySig {
			n++
			if n >= 3 {
				os.Exit(130)
			}
		}
	}()

	gracefulSig := make(chan os.Signal, 8)
	signal.Notify(gracefulSig, os.Interrupt, syscall.SIGTERM)
	{
		var serverErr <-chan error
		var shutdownChan <-chan struct{}
		if a.serverErrChan != nil {
			serverErr = a.serverErrChan
		}
		if a.server != nil {
			shutdownChan = a.server.ShutdownChan()
		}
		go watchQuitRequests(gracefulSig, serverErr, shutdownChan,
			func(line string) { jlog.Info("%s", line) }, quit)
	}

	// startTunnelMode brings up the given WAN tunnel mode in the background and
	// prints its status box once the guest URL is ready. Only one tunnel is ever
	// active: StartTunnelMode stops any tunnel running in a different mode first.
	startTunnelMode := func(spec server.TunnelModeSpec) {
		if spec.ConnectingMessage != "" {
			jlog.Info("%s", spec.ConnectingMessage)
		}
		go func() {
			if _, err := a.server.StartTunnelMode(spec.Mode); err != nil {
				if !strings.Contains(err.Error(), "context canceled") {
					// context-canceled is expected when the tunnel is stopped
					// while the connection is still starting.
					jlog.Error("Tunnel: %v", err)
				}
				return
			}
			if info, ok := a.server.GetTunnelInfo(); ok {
				printTunnelStatus(info)
			}
		}()
	}

	// A GUI launch starts the saved "Start WAN on launch" mode.
	if a.server != nil {
		if spec, ok := savedWANModeToStart(a.isGUILaunch(), a.connectivity.WANOnLaunch, server.TunnelModes()); ok {
			startTunnelMode(spec)
		} else if a.isGUILaunch() && a.connectivity.WANOnLaunch != "" {
			// Saved mode isn't registered or isn't available in this build/machine
			// — skip it but keep the value on disk so it revives if the mode returns.
			jlog.Debug("Connectivity: saved WAN mode %q unavailable; not starting", a.connectivity.WANOnLaunch)
		}
	}

	// A window-mode launch (icon/Finder/--window) opens the desktop app pointed
	// at this server. Skipped in test mode, which hosts its own test window via
	// runWindowApp.
	if a.flags.window && !a.flags.testMode && a.server != nil {
		launchWindow()
	}

	devMode := a.devModeEnabled()
	selected := selectedEngineHost{}
	if !a.flags.testMode {
		var ok bool
		selected, ok = selectEngineHost()
		if !ok {
			signalDone()
			return
		}
	}
	runWindowApp(a.server, devMode, !a.flags.window, a.flags.testMode, a.flags.testIframes, a.flags.testWindowURL, selected, done, teardownDone, requestQuit, onWindowReady)
}

// resolveLANDefault decides whether LAN access starts enabled. LAN exposure with
// no authentication is opt-in, never a silent default: only a GUI launch
// consults the saved "Start LAN on launch" preference, and every other launch
// starts localhost-only.
func (a *App) resolveLANDefault() bool {
	return lanOnLaunch(a.isGUILaunch(), a.connectivity.LANOnLaunch)
}

// lanOnLaunch is the pure LAN-at-launch decision, factored out so the saved
// preference can be injected in tests rather than read from the real home dir:
// a GUI launch honours savedLAN, and any other launch stays localhost-only.
func lanOnLaunch(guiLaunch, savedLAN bool) bool {
	return guiLaunch && savedLAN
}

// isGUILaunch reports whether this is a desktop-app/icon launch (no controlling
// terminal) that isn't the test harness or a machine-server session child. Only
// such a launch applies the saved connectivity preferences; a terminal launch
// uses CLI flags, test mode must not read the developer's real settings, and a
// session child is reached only through its supervisor, which owns exposure.
func (a *App) isGUILaunch() bool {
	return !a.flags.hasTerminal && !a.flags.testMode && !a.flags.sessionChild
}

// savedWANModeToStart returns the tunnel-mode spec to auto-start from the saved
// "Start WAN on launch" preference, or ok=false. It honours the preference only
// on a GUI launch, only when savedWAN is non-empty, and only when savedWAN names
// a registered mode that is currently available. An unknown or unavailable saved
// mode yields ok=false so the caller skips it, leaving the value on disk to
// revive if the mode returns. Pure over its specs argument for testability.
func savedWANModeToStart(guiLaunch bool, savedWAN string, specs []server.TunnelModeSpec) (server.TunnelModeSpec, bool) {
	if !guiLaunch || savedWAN == "" {
		return server.TunnelModeSpec{}, false
	}
	for _, spec := range specs {
		if string(spec.Mode) == savedWAN {
			if spec.IsAvailable() {
				return spec, true
			}
			return server.TunnelModeSpec{}, false
		}
	}
	return server.TunnelModeSpec{}, false
}

func (a *App) serverURL() string {
	return fmt.Sprintf("http://%s/", a.server.GetAddr())
}

// watchQuitRequests is the graceful half of the signal handling: it reports
// each request to stop — a Ctrl-C or SIGTERM, the server exiting, a shutdown
// asked for over the API — and fires quit for it. It never returns.
//
// quit runs on its own goroutine so a wedged Cocoa/WebKit main thread can't
// prevent this loop from receiving further signals; it is single-shot, so
// firing it again is harmless.
//
// serverErr and shutdown are dropped once they fire: the server closes
// shutdown rather than sending on it, and a closed channel is ready on every
// receive, so left in the select it would report the same request until the
// process exits — a spinning core, and a log buried under that one line.
func watchQuitRequests(gracefulSig <-chan os.Signal, serverErr <-chan error, shutdown <-chan struct{}, report func(string), quit func()) {
	n := 0
	for {
		var reason string
		select {
		case s := <-gracefulSig:
			n++
			switch n {
			case 1:
				reason = fmt.Sprintf("📴 Received %v, initiating graceful shutdown... (Ctrl-C twice more to force quit)", s)
			case 2:
				report("Still shutting down. Press Ctrl-C again to force quit.")
				continue
			default:
				// Emergency goroutine handles 3rd press. Don't fall
				// through to quit() — it's already been called once.
				continue
			}
		case err := <-serverErr:
			serverErr = nil
			n++
			if err != nil {
				jlog.Error("Server error: %v", err)
			}
			reason = "📴 Server exited, shutting down..."
		case <-shutdown:
			shutdown = nil
			n++
			reason = "📴 Shutdown requested via API..."
		}
		report(reason)
		go quit()
	}
}

// openInBrowser launches the user's default browser pointed at url, passed to
// the system opener whole and never through a shell (see sysopen.Argv).
func openInBrowser(url string) error {
	argv := sysopen.Argv(goruntime.GOOS, url)
	return exec.Command(argv[0], argv[1:]...).Start() //nolint:gosec // one argument, no shell
}
