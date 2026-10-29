//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"
	"os"
	"time"

	"juggler/cmd/juggler/server"
	"juggler/internal/jlog"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	// serverShutdownTimeout bounds the graceful server shutdown registered as a
	// cleanup by initServer: closing WebSockets, stopping workers, and closing
	// every cached conversation (which terminates provider subprocesses).
	serverShutdownTimeout = 10 * time.Second

	// quitGraceTimeout bounds how long a shutdown path waits before forcing
	// os.Exit. A normal quit kills us in well under a second; this only fires if
	// the shutdown genuinely stalled.
	//
	// It must stay comfortably above serverShutdownTimeout, because the
	// parent-gone watchdog runs the whole teardown inside this window (see
	// onParentGone) and force-exiting partway through would orphan the very
	// subprocesses teardown exists to reap. On the quit path teardown has
	// already finished before the window opens (see awaitTeardown), so there it
	// bounds only the native quit itself.
	quitGraceTimeout = serverShutdownTimeout + 5*time.Second
)

// runWindowApp blocks on the calling goroutine and dispatches by mode:
//
//   - Production with Node: starts the engine process without initializing Wails.
//   - Production with WebView: runs the hidden engine WebView in a background
//     native application; the visible UI lives in juggler-app.
//   - Test: runs the integration harness's visible tiled pool or debug lane.
//
// done is closed when an external signal (SIGTERM, server error, etc.) wants to
// quit; teardownDone is closed once the teardown stack has finished, gating the
// native quit; requestQuit triggers the single serialized shutdown path;
// onWindowReady hands the caller the *App (and main window, when there is one)
// once launched. relaunchEnv is what a production server's watchdog re-exec
// adds to the environment (spawnerEnv.environ).
func runWindowApp(srv *server.Server, devMode bool, headless bool, testMode bool, testIframes int, testWindowURL string, selected selectedEngineHost, relaunchEnv []string, done <-chan struct{}, teardownDone <-chan struct{}, requestQuit func(), onWindowReady func(*application.App, *application.WebviewWindow)) {
	if testMode {
		runTestPoolWindowApp(srv, devMode, headless, testIframes, testWindowURL, done, teardownDone, requestQuit, onWindowReady)
		return
	}
	runHeadlessServerApp(srv, selected, relaunchEnv, done, teardownDone, requestQuit, onWindowReady)
}

// awaitTeardown blocks until the teardown stack has finished, or the budget
// elapses.
//
// The native quit is [NSApp terminate:], which ends the process without
// unwinding. Issuing it while cleanups are still running discards whatever they
// had not yet reached — most visibly the conversation documents the workers
// write on their way out, so a conversation mid-turn loses the whole turn
// (nothing else persists it while the LLM call is in flight). The budget keeps a
// wedged cleanup from holding the process open indefinitely.
func awaitTeardown(teardownDone <-chan struct{}, budget time.Duration) {
	select {
	case <-teardownDone:
	case <-time.After(budget):
		jlog.Error("[server] teardown did not finish within %v — quitting anyway", budget)
	}
}

// runHeadlessServerApp runs a windowless production server. Node mode starts
// without a native application or display connection. WebView mode runs Wails
// as a macOS accessory application with only the hidden engine window: no Dock
// icon, menu bar, or main window. The visible UI lives in the separate
// juggler-app process, which connects over HTTP/WebSocket like any viewer.
// Blocks on the calling goroutine until done is closed.
//
// requestQuit is the same shutdown trigger the signal handlers use. Engine-host
// startup failures route through it so the server cannot linger without a
// functioning engine. relaunchEnv is handed to the main-thread watchdog.
func runHeadlessServerApp(srv *server.Server, selected selectedEngineHost, relaunchEnv []string, done <-chan struct{}, teardownDone <-chan struct{}, requestQuit func(), onWindowReady func(*application.App, *application.WebviewWindow)) {
	// A Node-hosted server creates no native application, so nothing on this
	// path ever pumps a main run loop: the engine runs in a child process and
	// this goroutine just blocks on done. The main-thread watchdog is therefore
	// not armed below — it probes by dispatching a block to the main queue, and
	// with no run loop draining that queue every probe goes unanswered, which
	// reads as a permanent wedge within seconds of launch. The NSWorkspace
	// sleep/wake observers it installs can't be delivered either. That leaves a
	// Node-hosted server exactly where every non-macOS platform already is.
	if !engineHostRequiresNativeApp(selected.mode) {
		onWindowReady(nil, nil)
		host := buildEngineHost(selected, nil, srv, requestQuit)
		startEngineHost(host, srv, requestQuit)
		<-done
		// The engine is a separate process here, so it has to be told. Teardown
		// first, for the same reason the webview host quits after it: the engine
		// is still the realm the closing conversations belong to, and the wait is
		// bounded. Then take the process tree down, so nothing of this server is
		// left dialling a port the next one will bind.
		awaitTeardown(teardownDone, serverShutdownTimeout)
		host.Stop()
		return
	}

	app := application.New(headlessServerAppOptions())

	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(_ *application.ApplicationEvent) {
		// Hand the App reference up to app_wait.go (no window in this mode), then
		// bring the hidden engine WebView up. It stays alive for the process's
		// lifetime — its work runs in a module worker that WebKit doesn't throttle
		// while hidden, and KeepRunningWhenHidden=Disabled keeps it off the
		// CVDisplayLink path that deadlocks on display reconfiguration (see
		// engine_lifecycle.go).
		onWindowReady(app, nil)
		startEngineHost(buildEngineHost(selected, app, srv, requestQuit), srv, requestQuit)
	})

	go func() {
		<-done
		// Teardown first, native quit second — see awaitTeardown.
		awaitTeardown(teardownDone, serverShutdownTimeout)
		jlog.Info("[server] shutdown requested — quitting Wails")
		app.Quit()
		// Safety net: if [NSApp terminate:] fails to land under main-queue
		// contention it can leave the process alive; force-exit after the grace
		// window (mirrors runTestPoolWindowApp's non-test path).
		time.Sleep(quitGraceTimeout)
		jlog.Error("[server] quit did not complete within %v — forcing exit", quitGraceTimeout)
		os.Exit(0)
	}()

	// Watchdog for the Cocoa main thread, armed here because this is the path
	// that owns the native application. WebKit's CVDisplayLink path has a
	// lock-ordering bug that wedges the main thread across sleep/wake or a
	// display reconfiguration (see mainthread_watchdog_darwin.m); when it
	// fires, every UI-thread operation hangs forever — including app.Quit().
	// The watchdog spots it via main-queue heartbeats and re-execs a fresh
	// server in place (same PID, same port) so the viewer reconnects
	// transparently. Its heartbeat only means anything while the run loop
	// app.Run() is about to enter is pumping the main queue, which is why it is
	// armed alongside that loop rather than at startup. No-op off macOS.
	startMainThreadWatchdog(srv.GetAddr(), true, jlog.FilePath(), relaunchEnv)

	if err := app.Run(); err != nil {
		jlog.Error("application.Run failed: %v", err)
		os.Exit(1)
	}
}

// headlessServerAppOptions builds the Wails options for the windowless
// production server.
//
// The headless server MUST NOT share a GtkApplication identity with the desktop
// viewer (juggler-app) or with sibling per-project servers. On Linux, Wails
// derives the GApplication ID from Name ("org.wails."+sanitized) and always
// registers it as *unique* on the session bus (it hardcodes
// G_APPLICATION_DEFAULT_FLAGS). Two live processes with the same ID collide:
// the second becomes a remote instance, its GTK "activate" never fires locally,
// and Wails' window Run() blocks forever in waitForActivation before it ever
// calls windowNew — so that process's window is never created. For the viewer
// that means no window at all plus gtk_widget_is_visible(NULL) GTK-CRITICAL
// spam; for a server it means the hidden engine WebView never comes up. Because
// both this server and juggler-app were named "Juggler", every launch that runs
// a server alongside the app (i.e. all of them) raced for org.wails.juggler and
// one side lost. Give each server a process-unique name so its GApplication ID
// can never collide. The server is windowless, so this name is never
// user-visible.
func headlessServerAppOptions() application.Options {
	return application.Options{
		Name:        fmt.Sprintf("Juggler Server %d", os.Getpid()),
		Description: "AI Code Agent",
		// This process handles SIGINT/SIGTERM itself, in waitForExit, and owes
		// that path a full teardown before any native quit. Wails' default
		// handler (signal_handler_desktop.go) wires the first signal straight to
		// app.Quit() — [NSApp terminate:], which does not unwind. Both handlers
		// receive the same signal, terminate wins because it has nothing to do
		// first, and the process dies mid-teardown with the project lock still
		// held. Wails must not handle signals here.
		DisableDefaultSignalHandler: true,
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: false,
			// Background process with no main window — the engine WebView stays
			// hidden and the app never shows or activates a window.
			ActivationPolicy: application.ActivationPolicyAccessory,
		},
		// This server's lifetime is governed by signals / the done channel, NOT
		// by how many windows are open. Its only window is the hidden engine
		// WebView, which the lifecycle controller tears down after an idle
		// window (engine_lifecycle.go) and recreates on demand. Without these,
		// Wails' default "quit when the last window closes" fires the moment the
		// idle engine is reaped, killing the headless server out from under its
		// viewers (the desktop app sees the WS drop a few minutes after going
		// idle: "accept tcp: use of closed network connection"). These are the
		// Windows/Linux twins of the macOS ApplicationShouldTerminate... = false
		// above.
		Linux: application.LinuxOptions{
			ProgramName:                   "Juggler",
			DisableQuitOnLastWindowClosed: true,
		},
		Windows: application.WindowsOptions{
			AdditionalBrowserArgs:         []string{"--disable-logging"},
			DisabledFeatures:              serverWebViewDisabledFeatures,
			DisableQuitOnLastWindowClosed: true,
		},
	}
}

// serverWebViewDisabledFeatures are the Chromium features turned off in the
// server's WebView2, the engine's and the test pool's alike.
//
// IsolateSandboxedIframes would give the sandbox frame that every run_code and
// query_code program runs in (web/sdk/lib/sandbox-runner.js) a renderer
// process of its own. The frame is display:none, so WebView2 puts that process
// into efficiency mode, the idle priority class, however visible the engine
// page is; on a machine whose cores are busy it is then scheduled only in
// bursts seconds apart, and every program stalls. Without the feature the
// frame shares the engine page's renderer and its priority.
//
// What the frame's isolation rests on is unchanged: its opaque origin and its
// CSP, which deny the program the backend, the engine page and its storage
// (query-sandbox-isolation and query-capability-vs-direct assert this). What is
// given up is the process boundary, which only matters to code that has
// escaped V8 itself — such code could read the engine page's memory, the API
// token included. WebKit, which hosts the engine on macOS and Linux, runs the
// frame in the page's process anyway: it has no site isolation by default.
// Revisit this if the sandbox ever has to
// contain code hostile enough to bring its own V8 exploit, rather than model
// output whose tool calls are already gated.
var serverWebViewDisabledFeatures = []string{"IsolateSandboxedIframes"}
