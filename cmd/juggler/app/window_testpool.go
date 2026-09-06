//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

// This file is the server's TEST-ONLY visible-window host. Production servers
// are windowless (runHeadlessServerApp in window.go); the only reason the
// server ever creates a visible WebviewWindow is to host the integration
// harness — either the tiled `--test-iframes=N` test-pool page or a single
// `--test --window` debug lane. All of it is gated on testMode and reachable
// only via runWindowApp's dispatcher.
//
// It lives in one file, as a single deletable unit (per the "isolate test/
// legacy code" convention): when the harness no longer needs the server to
// open windows, deleting this file and the runTestPoolWindowApp call in the
// dispatcher removes every windowing concern from the server. The window-state
// persistence (window_state.go) and native-chrome helpers (window_chrome_*.go)
// it leans on are then likewise unused server-side.

import (
	_ "embed"
	"fmt"
	"math"
	"os"
	"runtime"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/osactivity"
	"juggler/cmd/juggler/server"
	"juggler/internal/jlog"
	"juggler/internal/windowgeom"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// appIconPNG is the runtime window/taskbar icon (Linux). The same PNG is the
// source for the macOS .app bundle's Assets.car / .icns and the Windows
// executable icon resource (.syso); the Makefile syncs assets/icons/juggler-icon.png
// here on every build because go:embed cannot follow symlinks.
//
//go:embed icon.png
var appIconPNG []byte

type windowApp struct {
	srv       *server.Server
	headless  bool
	testMode  bool // --test: slot subprocess running its own Wails window
	app       *application.App
	win       *application.WebviewWindow
	engineWin *application.WebviewWindow // hidden process-owned engine browser
	saved     core.WindowState
	geom      *windowgeom.Tracker // tracks the frame to persist for this window

	// saves debounces window-state writes. Trigger via triggerSave(); a
	// background goroutine collapses bursts of move/resize events into a
	// single session save ~300ms after the last change.
	saves *windowgeom.Debouncer

	onWindowReady func(*application.App, *application.WebviewWindow)
}

// startup runs after the application has finished launching, on the main
// thread. Saved size/position/maximised/fullscreen state was applied by
// Wails during native window construction (via WebviewWindowOptions.X/Y/
// Width/Height/InitialPosition/StartState — see runTestPoolWindowApp), so by
// the time this runs the geometry is already correct. We only need to:
//
//   - hand the App/Window references up to app_wait.go
//   - kick off the hidden engine window
//   - Show() the main window (window mode + test slot); terminal mode
//     keeps it hidden until the user presses 'w'
func (a *windowApp) startup() {
	a.onWindowReady(a.app, a.win)

	// Bring the engine browser to life. Run() creates the WebKit window
	// honouring the Hidden:true option (Show() would flash it on screen first).
	// Once created, the WKWebView loads /engine and connects as the sole engine
	// client. Owned by this process — independent of any user UI.
	if a.engineWin != nil {
		a.engineWin.Run()
		// Engine stays Hidden:true. macOS would normally throttle a hidden
		// WKWebView's JS event loop to 0 Hz, but our patched Wails fork
		// sets `WKInactiveSchedulingPolicyNone` on the WKWebViewConfiguration
		// before the WebView is instantiated, so the policy applies from the
		// engine's very first navigation.
	}

	// Test slot: keep the pool window hidden so it doesn't flash on screen on
	// every `make test`. Custom-element paths that depend on first paint
	// (at-mention popup, footer cache reflow, undo-redo prune) are driven off
	// macrotasks (setTimeout), not requestAnimationFrame, so they run fine in
	// a non-composited window.
	if a.headless && a.testMode {
		return
	}

	if a.headless {
		// Terminal mode: window stays hidden until the user presses 'w'.
		// The native window already has the saved geometry baked in via
		// options, so the first Show() puts it in the right place.
		setDockIconVisible(false)
		return
	}

	a.win.Show()
}

// unthrottleWhenReady switches the pool window's hidden-page timer alignment
// off as soon as there is a web view to configure, and says so if it never
// takes: a pool that kept the alignment fires every timer a suite waits on a
// second apart, which reads from the test output as a suite that stopped rather
// than one that is being taxed a tick at a time.
//
// Attempted more than once because the switch needs the window's web view and
// this runs at application start, which on GTK4 is where the widget is still
// being built — WebviewWindow.Run sets the window's impl and only then, after
// activation, creates the widget. macOS has it on the first attempt.
//
// Scoped to the two ports that align a hidden page's timers at all. WebView2
// keeps the pool's controller visible instead, so there is nothing there to
// switch and nothing to report.
func unthrottleWhenReady(win *application.WebviewWindow) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return
	}
	const attempts = 40
	const between = 100 * time.Millisecond
	var attempt func(left int)
	attempt = func(left int) {
		application.InvokeAsync(func() {
			if unthrottleHiddenPageTimers(win) {
				return
			}
			if left <= 1 {
				jlog.Error("[test-pool] hidden-page timer alignment is still on: every timer a suite waits on fires on a ~1s grid")
				return
			}
			time.AfterFunc(between, func() { attempt(left - 1) })
		})
	}
	attempt(attempts)
}

// currentState captures the window's current geometry/state. Must be called
// on the main thread — the tracker reads live native state, which Wails only
// answers correctly there. See windowgeom.Tracker.Capture for when it declines
// to report a frame at all.
func (a *windowApp) currentState() (core.WindowState, bool) {
	return a.geom.Capture(a.win)
}

// triggerSave wakes the save loop. Non-blocking — coalesces bursts of move
// or resize events into a single debounced write.
func (a *windowApp) triggerSave() {
	a.saves.Trigger()
}

// saveLoop writes the settled geometry after each burst of move/resize events.
// Runs for the process lifetime (no stop channel), hopping onto the main thread
// for the capture itself.
func (a *windowApp) saveLoop() {
	a.saves.Run(nil, func() {
		type result struct {
			s  core.WindowState
			ok bool
		}
		done := make(chan result, 1)
		application.InvokeAsync(func() {
			s, ok := a.currentState()
			done <- result{s, ok}
		})
		r := <-done
		if !r.ok {
			return
		}
		if err := saveWindowState(a.srv, r.s); err != nil {
			jlog.Error("[window] failed to save window state: %v", err)
		}
	})
}

// persistNow writes window state synchronously on the main thread. Used at
// quit time to guarantee the final geometry hits disk before app exit, even
// if a debounced save was still pending. Skips the write if the window
// isn't ready (a quick quit before construction completes) — better to
// preserve the existing saved state than to overwrite it with zeros.
func (a *windowApp) persistNow() {
	s, ok := a.currentState()
	if !ok {
		return
	}
	if err := saveWindowState(a.srv, s); err != nil {
		jlog.Error("[window] failed to save window state: %v", err)
	}
}

// runTestPoolWindowApp runs the Wails event loop hosting the integration
// harness's visible window and blocks until it exits. It is reached only in
// test mode (see runWindowApp); production servers are windowless. The window
// is either the tiled iframe test-pool (`--test-iframes=N`) or a single debug
// lane (`--test --window`).
//
// Both windows (main viewer and hidden engine) load over real http://addr/...
// from the same loopback HTTP server every other client uses. There is no
// wails:// scheme handler, no reverse-proxy adapter, no Content-Length
// rewriting — the WKWebView talks to the listener the same way a LAN browser
// does, and the server can't tell them apart. The single thing the
// in-process page does differently is set document.documentElement.dataset.
// windowMode = '1' (from the ?window=1 query param baked into the URL
// below), which CSS picks up to enable --wails-draggable header dragging.
//
// done is closed when an external signal (SIGTERM, server error, etc.) wants
// to quit; a goroutine monitors it and calls app.Quit().
//
// onWindowReady is called after the application has launched, handing the
// caller the *App and main *WebviewWindow so it can drive Show/Hide/Quit.
//
// requestQuit triggers the single, serialized shutdown path (it closes the
// caller's done channel). The WindowClosing handler calls this instead of
// app.Quit() directly: Wails dispatches every WindowClosing listener on its
// own goroutine (HandleWindowEvent), so calling app.Quit() inline would race
// Wails' own built-in window-destroy listener for the same event. Routing
// through done makes a single goroutine own persist+quit.
func runTestPoolWindowApp(srv *server.Server, devMode bool, headless bool, testIframes int, done <-chan struct{}, teardownDone <-chan struct{}, requestQuit func(), onWindowReady func(*application.App, *application.WebviewWindow)) {
	// testMode is always true on this path (the dispatcher only routes here in
	// test mode); kept as a local so the shared windowApp logic reads
	// consistently.
	const testMode = true

	// A test run spends most of its wall-clock in idle waits (waiting for Yjs
	// conditions, worker readiness, etc.). During those idle spans nothing holds
	// the per-request App Nap assertion the worker takes for busy work, so if the
	// dev parks the test window offscreen or on another Space, macOS App-Naps the
	// whole process — and App Nap OVERRIDES KeepRunningWhenHidden, coalescing the
	// WebKit timers to a 30s+ cadence (see osactivity/doc.go), stalling every
	// lane. Hold one process-lifetime assertion across the entire test run so
	// window visibility can't throttle the lanes. Energy savings are irrelevant
	// for a test process; the assertion is released when it exits. No-op off macOS.
	osactivity.Begin()

	saved := loadWindowState(srv)
	place := windowgeom.Place(saved)

	width, height := place.Width, place.Height

	// Test windows live offscreen and exist only to keep macOS from throttling
	// the WebKit process. There's no UI to look at, so make them tiny — unless
	// we're hosting tiled iframe test lanes, in which case the iframes need
	// enough viewport to actually mount their UI (some tests measure DOM
	// dimensions). 2x2 iframes at 600x450 each → 1200x900 host.
	minW, minH := 800, 600
	if headless && testMode {
		if testIframes > 1 {
			// Square-ish grid. 2 iframes = 1x2; 4 = 2x2; 9 = 3x3; 16 = 4x4.
			cols := int(math.Ceil(math.Sqrt(float64(testIframes))))
			rows := (testIframes + cols - 1) / cols
			width, height = cols*600, rows*450
		} else {
			width, height = 200, 150
		}
		minW, minH = 100, 100
	}

	wa := &windowApp{
		srv:           srv,
		headless:      headless,
		testMode:      testMode,
		saved:         saved,
		geom:          windowgeom.NewTracker(saved),
		saves:         windowgeom.NewDebouncer(),
		onWindowReady: onWindowReady,
	}
	go wa.saveLoop()

	// Initial NSWindow background. The page CSS at :root defaults to the dark
	// theme (--bg-primary: #0d1117), so we paint the window dark on startup;
	// the page emits 'juggler:theme' on toggle which re-runs applyWindowChrome
	// with the new colour. Light = #ffffff. Keep these in sync with
	// web/css/styles.css :root[data-theme="light"|"dark"] --bg-primary.
	const (
		themeDark  = "dark"
		themeLight = "light"
	)
	themeColours := map[string]application.RGBA{
		themeDark:  {Red: 13, Green: 17, Blue: 23, Alpha: 255},
		themeLight: {Red: 255, Green: 255, Blue: 255, Alpha: 255},
	}

	// On macOS the .app bundle's AppIcon.icns (compiled by actool with the
	// proper squircle mask + gutter) is the authoritative Dock icon. Passing
	// Options.Icon makes Wails call [NSApp setApplicationIconImage:] with the
	// raw full-bleed PNG, which renders larger than the padded bundle icon and
	// overwrites the tile partway through startup — so across instances the
	// Dock shows a mix of normal (bundle) and oversized (PNG) tiles depending
	// on which have finished launching. Let the bundle own the Dock on macOS;
	// other platforms still need the embedded PNG for the taskbar/window icon.
	appIcon := appIconPNG
	if runtime.GOOS == "darwin" {
		appIcon = nil
	}

	app := application.New(application.Options{
		Name:        "Juggler",
		Description: "AI Code Agent",
		Icon:        appIcon,
		Mac: application.MacOptions{
			// We drive shutdown explicitly via app.Quit() in the main window's
			// WindowClosing handler. Auto-terminate would also fire when the
			// user hides the window via 'w' (the engine window is still alive
			// but offscreen, so Cocoa thinks "no visible windows" and quits).
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		Linux: application.LinuxOptions{
			ProgramName: "Juggler",
		},
		Windows: application.WindowsOptions{
			// Silence the Edge WebView2 (Chromium) runtime's own stderr
			// logging. Without this, tearing the WebView2 windows down at quit
			// races the Chromium widget-window cleanup and prints a benign
			// "Failed to unregister class Chrome_WidgetWin_0. Error = 1412"
			// (ERROR_CLASS_HAS_WINDOWS) — harmless, but it clutters the
			// terminal in headless/CLI mode. --disable-logging suppresses
			// Chromium's LOG() stderr output globally (the WebView2 environment
			// is shared by every window). No-op off Windows.
			AdditionalBrowserArgs: []string{"--disable-logging"},
		},
	})
	wa.app = app

	// Place the window at the saved position+state during native window
	// construction. Wails' impl.run() reads these options on the main thread
	// and applies them via setPosition + StartState BEFORE the page first
	// loads — this is the only race-free placement path. Setting position
	// later from startup() (which fires on ApplicationDidFinishLaunching)
	// loses to Wails' own centering default if the queued dispatch order
	// inverts. In test slots, ignore the saved file entirely and use the
	// default centred 200x150 window.
	posX, posY := 0, 0
	initialPos := application.WindowCentered
	startState := application.WindowStateNormal
	if !headless || !testMode {
		posX, posY, initialPos, startState = place.X, place.Y, place.Position, place.State
	}

	// Pick the page the WebKit window should load:
	//  - production / terminal: the production app at /?window=1
	//  - --test --test-iframes=N: the tiled iframe pool host
	//  - --test (no iframes): the production app, which sees
	//    JUGGLER_TEST_MODE=true and self-redirects to /headless-test
	mainURL := "http://" + srv.GetAddr() + "/?window=1"
	if headless && testMode && testIframes > 1 {
		mainURL = fmt.Sprintf("http://%s/test-pool?n=%d", srv.GetAddr(), testIframes)
	}
	// Production wants the frameless / draggable title bar; the test-iframe
	// host window is just a visible WebKit surface — let it have a normal
	// titlebar so the dev can see "Juggler Test Pool" and resize/drag it
	// like any other macOS window.
	macTitleBar := application.MacTitleBar{
		AppearsTransparent:   true,
		HideTitle:            true,
		HideToolbarSeparator: true,
		FullSizeContent:      true,
	}
	if headless && testMode && testIframes > 1 {
		macTitleBar = application.MacTitleBar{}
	}
	winTitle := "Juggler"
	if headless && testMode && testIframes > 1 {
		winTitle = "Juggler Test Pool"
	}
	macWindow := application.MacWindow{
		TitleBar: macTitleBar,
		// No InvisibleTitleBarHeight: a tall invisible drag band overlaps
		// the OS resize zone at the top edge, so dragging-to-resize from
		// the top would fight a simultaneous window-drag. Drag is driven
		// entirely by CSS `--wails-draggable: drag` on .app-header (via
		// the Wails runtime), and a thin no-drag strip at y=0 keeps the
		// OS resize handle uncontested. See web/index.html and
		// web/css/styles.css for the strip + draggable region.
	}
	// Strip the native title bar on Windows so the app's own header is the
	// whole top of the window, matching the frameless macOS look. The page
	// supplies min/maximise/close caption buttons (window-caption-controls.js).
	// No-op on macOS (frameless comes from MacTitleBar, which keeps the traffic
	// lights) and Linux (keeps its WM decorations). The test-pool host keeps a
	// normal frame so the dev can see/move it like any other window.
	frameless := platformFrameless
	if headless && testMode && testIframes > 1 {
		frameless = false
	}
	// Keep the Aero shadow + Win11 rounded corners in frameless mode (the
	// default; DisableFramelessWindowDecorations would remove them). Resize is
	// still handled by Wails at the window edges.
	winWindow := application.WindowsWindow{
		DisableFramelessWindowDecorations: false,
	}

	if headless && testMode && testIframes > 1 {
		// In the tiled test-pool this window hosts the test iframes (the
		// engine + viewer lanes) — execution happens *here*, not just in the
		// dedicated engine window. If the dev moves it offscreen or to another
		// Space, macOS throttles the WKWebView JS event loop toward 0Hz and the
		// lanes stall en masse (tests time out, then "recover" once the window
		// is visible again). Pin the scheduling policy exactly as the engine
		// window does so the pool keeps running regardless of visibility. Scoped
		// to the test pool: production's main UI window *should* yield CPU when
		// hidden — its hidden engine window does the background work.
		// KeepRunningWhenHidden gets the lanes scheduled; it does not decide how
		// coarsely their timers fire once they are. That second half is the
		// hidden-page timer alignment, switched off separately once the window
		// exists — see unthrottleHiddenPageTimers, called from the startup hook
		// below. WebKitGTK aligns a hidden page the same way and is dealt with
		// there too; WebView2 has no equivalent grid.
		macWindow.WebviewPreferences = application.MacWebviewPreferences{
			KeepRunningWhenHidden: application.Enabled,
		}
		// Windows: the same hazard as WebView2 "efficiency mode" — a hidden
		// window's controller is dropped to IsVisible=false and its JS timers
		// throttle toward 0Hz, stalling every lane. Keep the controller live.
		winWindow.KeepRunningWhenHidden = true
	}
	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:           winTitle,
		URL:             mainURL,
		Width:           width,
		Height:          height,
		MinWidth:        minW,
		MinHeight:       minH,
		X:               posX,
		Y:               posY,
		InitialPosition: initialPos,
		StartState:      startState,
		// Hidden until startup() (or the terminal-mode toggle) calls Show().
		// Saved geometry is baked into the options above, so the first Show
		// puts the window in the right place with no visible jump.
		Hidden: true,
		// We don't use Wails' BackgroundColour — applyWindowChrome below sets
		// the NSWindow background, opacity, appearance, and WKWebView
		// transparency together on macOS once we have a native handle. The
		// page emits a 'juggler:theme' event on theme toggle which re-runs it.
		Frameless: frameless,
		Mac:       macWindow,
		Windows:   winWindow,
		Linux: application.LinuxWindow{
			Icon: appIconPNG,
		},
	})
	wa.win = win

	// Ctrl+Tab / Ctrl+Shift+Tab cycle conversation tabs. WKWebView consumes
	// these before they reach page JS on macOS, so intercept at the window
	// level via Wails KeyBindings and re-dispatch as a CustomEvent for
	// conversation-bar to handle.
	cycle := func(dir string) {
		win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:cycle-tab',{detail:{direction:'" + dir + "'}}))")
	}
	win.RegisterKeyBinding("Ctrl+Tab", func(_ application.Window) { cycle("next") })
	win.RegisterKeyBinding("Ctrl+Shift+Tab", func(_ application.Window) { cycle("prev") })

	// Native application menu. The tiled test-pool host has no use for it and
	// its accelerators (Cmd+O / Cmd+N) could fight the test page's own
	// shortcuts, so install it only for the real app windows.
	isTestPoolHost := headless && testMode && testIframes > 1
	if !isTestPoolHost {
		installAppMenu(app, win, devMode)
	}

	// Engine window: a second WebviewWindow owned by this process that loads
	// /engine and acts as the single, persistent engine client. Lifecycle is
	// tied to the application — viewers (this app's UI window OR external
	// browsers) can come and go without touching it. Test slots get the same
	// dedicated engine window as production so the engine code path (the
	// worker-backed runtime) is identical in tests.
	wa.engineWin = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:   "juggler-engine",
		Title:  "Juggler Engine",
		URL:    "http://" + srv.GetAddr() + "/engine",
		Width:  200,
		Height: 150,
		Hidden: true,
		Mac: application.MacWindow{
			WebviewPreferences: application.MacWebviewPreferences{
				// The engine WKWebView is always hidden. macOS would
				// otherwise throttle its JS event loop to 0Hz once the
				// main viewer window is active, freezing every tool
				// call. KeepRunningWhenHidden sets
				// WKInactiveSchedulingPolicyNone on the configuration
				// before the WebView is allocated (the only timing
				// macOS honors), so the engine keeps executing tools
				// regardless of window visibility.
				KeepRunningWhenHidden: application.Enabled,
			},
		},
		Windows: application.WindowsWindow{
			// The engine WebView is permanently hidden and drives every tool
			// call. Without this, WebView2 efficiency mode throttles its JS
			// timers once the window loses visibility, freezing the backend.
			KeepRunningWhenHidden: true,
		},
		Linux: application.LinuxWindow{},
	})

	// Startup hook: equivalent of v2 OnStartup. Fires on the main thread
	// after the application has finished launching.
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(_ *application.ApplicationEvent) {
		application.InvokeAsync(func() { applyWindowChrome(win, themeColours[themeDark]) })
		if isTestPoolHost {
			// Only the pool host: this window's lanes do timed work nobody is
			// watching, so there is nothing to save by coarsening their timers.
			// A production window that goes idle when hidden is behaving
			// correctly and must keep doing so.
			unthrottleWhenReady(win)
		}
		wa.startup()
	})

	// Native theme repaint and min/maximise/close/new-window are the desktop
	// app's job (via its loopback nativeCtl endpoint); the harness drives none of
	// them, so the test-pool window just hosts the iframes and engine.

	// Persist window state on every move/resize via the debounced save loop.
	// Wails fires these continuously during a drag/resize; the loop collapses
	// bursts into a single write so we always have a current geometry on
	// disk regardless of how the app exits (red close button, Cmd+Q, signal,
	// crash). Skips the test slot where geometry is meaningless.
	if !headless || !testMode {
		win.OnWindowEvent(events.Common.WindowDidMove, func(_ *application.WindowEvent) { wa.triggerSave() })
		win.OnWindowEvent(events.Common.WindowDidResize, func(_ *application.WindowEvent) { wa.triggerSave() })
	}

	// Window-close hook. We can't rely on Mac's
	// ApplicationShouldTerminateAfterLastWindowClosed because the hidden engine
	// window keeps the "open windows" count above zero — closing the visible
	// main window must explicitly trigger Quit.
	//
	// This listener does NOT call app.Quit() itself. Wails runs every
	// WindowClosing listener on its own goroutine (see HandleWindowEvent in the
	// fork), so this callback executes concurrently with Wails' built-in
	// close-and-destroy listener for the same event. Calling app.Quit()
	// (→ InvokeSync([NSApp terminate:])) from here interleaves its main-queue
	// work with the built-in teardown nondeterministically, which intermittently
	// left the process alive after the window vanished (the "close button does
	// nothing" symptom). Instead we capture a best-effort final geometry and
	// hand off to the single serialized shutdown path via requestQuit().
	win.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		jlog.Info("📴 Window close requested — routing through shutdown path")
		if !headless || !testMode {
			// Read-only, destroyed-guarded getters; safe even if Wails' built-in
			// listener has concurrently marked the window destroyed (then it
			// simply no-ops and the last debounced saveLoop write stands).
			wa.persistNow()
		}
		requestQuit()
	})

	// Single owner of quit. Closed by an external signal (SIGTERM, server
	// error) OR by the WindowClosing handler via requestQuit — both converge
	// here, so persist+quit always runs exactly once on this dedicated
	// goroutine rather than inside a racing Wails event listener. Flush state
	// first: signal-driven quits bypass WindowClosing entirely, so the
	// debounced save is our only guarantee of a fresh write on that path.
	go func() {
		<-done
		// Teardown first, native quit second — see awaitTeardown.
		awaitTeardown(teardownDone, serverShutdownTimeout)
		jlog.Info("[window] shutdown requested — quitting Wails")
		if !headless || !testMode {
			application.InvokeAsync(func() {
				wa.persistNow()
				app.Quit()
			})
		} else {
			app.Quit()
		}

		// Safety net. app.Quit() drives [NSApp terminate:], which macOS
		// dispatches onto the main queue; under main-queue contention during the
		// window-close burst it can occasionally fail to land, leaving the
		// process alive with no window. A successful terminate kills the process
		// (and this goroutine) well within the grace window, so this force-exit
		// only ever fires when quit genuinely stalled. Skipped in test slots,
		// whose lifecycle the harness owns.
		if !testMode {
			time.Sleep(quitGraceTimeout)
			jlog.Error("[window] quit did not complete within %v — forcing exit", quitGraceTimeout)
			os.Exit(0)
		}
	}()

	// The same main-thread watchdog the production server arms (window.go),
	// minus the relaunch: a wedged main thread under test is a result to
	// surface, not something to silently restart, so it force-exits instead.
	// No-op off macOS.
	startMainThreadWatchdog(srv.GetAddr(), false, jlog.FilePath())

	if err := app.Run(); err != nil {
		jlog.Error("application.Run failed: %v", err)
		os.Exit(1)
	}
}

// installAppMenu builds and installs the native application menu. It replaces
// Wails' DefaultApplicationMenu, which ships several items that are wrong for
// Juggler: a "Learn More" that navigates the main webview to the Wails site, a
// View menu full of zoom/actual-size commands that break our fixed layout, and
// Reload/devtools entries that should only exist in dev mode.
//
//   - Session ▸ Open…      opens the project-folder picker (same as clicking
//     the project path in the header). Driven via a CustomEvent the page
//     listens for, mirroring the Ctrl+Tab bridge.
//   - Session ▸ New Window spawns a fresh, independent juggler process.
//   - View                 carries Zoom In/Out (font-size zoom, mirroring the
//     header −/+ buttons — never the webview's layout-breaking page zoom) plus
//     Reload / Force Reload / Open Developer Tools ONLY in dev mode, and Toggle
//     Full Screen always.
//   - Help ▸ Learn More  launches the user's real browser at juggler.studio
//     instead of hijacking the app's own webview.
//
// This is reached only on the test path. The production native menu lives in
// the desktop app (cmd/juggler-app/menu.go).
func installAppMenu(app *application.App, win *application.WebviewWindow, devMode bool) {
	menu := application.NewMenu()

	// macOS application menu (About / Services / Hide / Quit). No-op elsewhere.
	menu.AddRole(application.AppMenu)

	sessionMenu := menu.AddSubmenu("Session")
	sessionMenu.Add("Open...").
		SetAccelerator("CmdOrCtrl+o").
		OnClick(func(_ *application.Context) {
			win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:open-project'))")
		})
	sessionMenu.Add("New Window").
		SetAccelerator("CmdOrCtrl+n").
		OnClick(func(_ *application.Context) {
			if err := spawnNewWindow(""); err != nil {
				jlog.Error("New Window failed: %v", err)
			}
		})
	sessionMenu.AddSeparator()
	sessionMenu.AddRole(application.CloseWindow)

	// Standard Undo/Redo/Cut/Copy/Paste/Select All.
	menu.AddRole(application.EditMenu)

	viewMenu := menu.AddSubmenu("View")
	// Font-size zoom (mirrors the header bar's −/+ buttons), not the webview's
	// own page zoom — that breaks the fixed layout. The page also handles the
	// Cmd +/− keypresses directly for browser tabs that have no native menu.
	viewMenu.Add("Zoom In").
		SetAccelerator("CmdOrCtrl+plus").
		OnClick(func(_ *application.Context) {
			win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:zoom-in'))")
		})
	viewMenu.Add("Zoom Out").
		SetAccelerator("CmdOrCtrl+-").
		OnClick(func(_ *application.Context) {
			win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:zoom-out'))")
		})
	viewMenu.AddSeparator()
	if devMode {
		viewMenu.AddRole(application.Reload)
		viewMenu.AddRole(application.ForceReload)
		viewMenu.AddRole(application.OpenDevTools)
		viewMenu.AddSeparator()
	}
	viewMenu.AddRole(application.ToggleFullscreen)

	menu.AddRole(application.WindowMenu)

	helpMenu := menu.AddSubmenu("Help")
	helpMenu.Add("Learn More").
		OnClick(func(_ *application.Context) {
			if err := openInBrowser("https://juggler.studio"); err != nil {
				jlog.Error("open Learn More failed: %v", err)
			}
		})

	app.Menu.Set(menu)
}
