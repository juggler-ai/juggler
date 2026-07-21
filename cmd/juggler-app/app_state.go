//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"fmt"
	"html"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/webviewenv"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	defaultWindowWidth  = 1400
	defaultWindowHeight = 900
	minWindowWidth      = 800
	minWindowHeight     = 600
)

// saveDebounce collapses a burst of window move/resize events into a single
// geometry write ~this long after the last change.
const saveDebounce = 300 * time.Millisecond

// themeColours maps the page theme name to the NSWindow background. Keep in
// sync with --bg-primary in web/css/styles.css :root[data-theme=...].
var themeColours = map[string]application.RGBA{
	"dark":  {Red: 13, Green: 17, Blue: 23, Alpha: 255},
	"light": {Red: 255, Green: 255, Blue: 255, Alpha: 255},
}

// linuxGpuPolicy maps the resolved webviewenv GPU decision (see
// webviewenv.LinuxWebviewGpuAcceleration) to the Wails policy for the *visible*
// viewer windows: WebviewGpuPolicyAlways when there is positive evidence a
// working GL stack is present, so WebKitGTK composites the UI's continuous
// animations on the GPU instead of re-rasterising every frame on the main
// thread; WebviewGpuPolicyNever (software rendering) otherwise. Pure mapping —
// the decision itself is resolved once in newAppState and stored on
// appState.gpuPolicy. The engine window (off-screen, paints nothing) keeps its
// own hard-coded Never.
func linuxGpuPolicy(enabled bool) application.WebviewGpuPolicy {
	if enabled {
		return application.WebviewGpuPolicyAlways
	}
	return application.WebviewGpuPolicyNever
}

// winEntry tracks one open window and the server URL it views. Geometry is NOT
// stored here — it lives server-side in the session (see window_state_client.go);
// this only carries the window's workspace identity (spec) and the live frame
// state the save loop needs.
type winEntry struct {
	id        string
	win       *application.WebviewWindow
	spec      windowSpec // what this window views (project or URL) — its workspace identity
	serverURL string     // the server this window posts/reads its geometry to (immutable)

	// currentTheme is the last page-reported theme for this native window. It is
	// used to paint chrome immediately on show and as the inherited theme for
	// File ▸ New Window.
	currentTheme string

	// lastPos is the last known normal (non-maximised/non-fullscreen) frame,
	// owned by the save loop. It lets a maximised/fullscreen window still
	// persist a sane restore frame alongside the maximised flag.
	lastPos core.WindowState

	// saveCh debounces geometry writes (Wails fires move/resize many times per
	// drag); stopSave ends the per-window save loop when the window closes.
	saveCh   chan struct{}
	stopSave chan struct{}

	// forceClose is set (via the registry goroutine) once the busy-work close
	// guard has been satisfied — either the server had no in-flight turn or the
	// user confirmed the discard. The WindowClosing hook reads it to let the
	// real close proceed instead of vetoing and re-prompting. Owned by the
	// registry goroutine like the rest of winEntry's shared fields.
	forceClose bool
}

// regState is the registry's owned data: the open windows and the servers this
// app spawned, keyed by server URL. Servers are reference-counted by how many
// windows view them, so closing the window that happened to spawn a server
// doesn't kill it while another window still shares it.
type regState struct {
	windows map[string]*winEntry
	servers map[string]*exec.Cmd // url -> spawned server we own (and must stop)

	// lastTheme is the most recent page-reported theme across all windows. It
	// seeds the native background colour of the next window built without an
	// inherited theme (e.g. a restored window), so its bare frame matches the
	// theme instead of flashing the default before the page's first paint.
	lastTheme string

	// quitting is set once an app-wide quit has been authorised (the quit guard
	// found no busy work, or the user confirmed the discard). While set, the
	// ShouldQuit hook allows termination and per-window close hooks stop
	// guarding, so teardown doesn't re-prompt window by window.
	quitting bool
}

// appState owns the single desktop process and its many windows. It runs one
// Wails application and manages WebviewWindows — each a viewer pointed at a
// server — through a channel-served registry (no mutex, per the project's
// concurrency rule: one goroutine owns the maps; everyone else sends ops).
type appState struct {
	app       *application.App
	devMode   bool
	ctlPort   int
	workspace *workspaceStore

	// gpuPolicy is the WebKitGTK hardware-acceleration policy applied to every
	// visible viewer window; gpuNote is the one-line reason to log at startup.
	// Both are resolved ONCE here in newAppState (webviewenv.LinuxWebviewGpuAcceleration
	// reads the env override and probes /dev/dri + /proc), so every window gets
	// the same policy and the logged reason provably matches what the windows
	// applied — instead of each window and the startup log independently
	// re-evaluating the decision (which also did that filesystem I/O on every
	// window open, on macOS/Windows too).
	gpuPolicy application.WebviewGpuPolicy
	gpuNote   string

	regOps chan func(*regState)
	ids    chan string
}

func newAppState(devMode int) *appState {
	gpuEnabled, gpuNote := webviewenv.LinuxWebviewGpuAcceleration()
	a := &appState{
		devMode:   devMode != 0,
		workspace: newWorkspaceStore(),
		gpuPolicy: linuxGpuPolicy(gpuEnabled),
		gpuNote:   gpuNote,
		regOps:    make(chan func(*regState), 32),
		ids:       make(chan string),
	}
	go func() {
		// Seed lastTheme from the persisted last-used theme so the very first
		// window built this launch (before any page has reported) paints its bare
		// frame to match instead of flashing the dark default (see workspace.go).
		st := &regState{windows: map[string]*winEntry{}, servers: map[string]*exec.Cmd{}, lastTheme: a.workspace.loadLastTheme()}
		for op := range a.regOps {
			op(st)
		}
	}()
	go func() {
		for i := 1; ; i++ {
			a.ids <- "w" + strconv.Itoa(i)
		}
	}()
	return a
}

// reg runs fn against the registry on its owning goroutine and waits for it.
func (a *appState) reg(fn func(*regState)) {
	done := make(chan struct{})
	a.regOps <- func(st *regState) {
		fn(st)
		close(done)
	}
	<-done
}

// window returns the entry for id, or nil.
func (a *appState) window(id string) *winEntry {
	var e *winEntry
	a.reg(func(st *regState) { e = st.windows[id] })
	return e
}

// singleInstanceID is the unique key for the single-instance lock. A second
// `juggler-app` launch fails to acquire it, hands its argv to the first
// instance (onSecondInstance), and exits — so one process owns all windows.
// Matches the .app bundle identifier (MAC_BUNDLE_ID in the Makefile).
const singleInstanceID = "studio.juggler.juggler"

// initApplication constructs the single Wails application with the
// single-instance guard installed. It MUST be called before the caller spawns
// any server: if this is a second instance, application.New notifies the first
// instance with our argv and os.Exit()s from inside this call — doing it first
// means a redundant second launch never spawns a throwaway server. Also wires
// the quit-time server cleanup hook and the native menu (neither needs a
// window).
func (a *appState) initApplication() {
	// Route Wails' own logger/errors/warnings/panics into jlog. Without this a
	// production build discards them (default logger is io.Discard, no
	// ErrorHandler), so a failed window launch — including Wails' internal
	// os.Exit(1) fatal path — produces no output at all. See wailsLogHandlers.
	wailsLogger, onWailsError, onWailsWarn, onWailsPanic := wailsLogHandlers()
	a.app = application.New(application.Options{
		Name:           "Juggler",
		Description:    "AI Code Agent",
		Logger:         wailsLogger,
		LogLevel:       slog.LevelDebug,
		ErrorHandler:   onWailsError,
		WarningHandler: onWailsWarn,
		PanicHandler:   onWailsPanic,
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:               singleInstanceID,
			OnSecondInstanceLaunch: a.onSecondInstance,
		},
		Mac: application.MacOptions{
			// Many windows in one process: don't let Cocoa terminate us when a
			// single window closes. We quit explicitly when the last one goes
			// (handleWindowClosed) — there's no hidden engine window here to
			// keep the count above zero, so without that we'd linger invisibly.
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		// Guard Cmd+Q / Quit: if any window's server still has a turn in flight,
		// veto the terminate and ask first (see busy_guard.go). Returns
		// synchronously, so the real decision happens asynchronously and a
		// confirmed quit re-issues app.Quit() with the quitting flag set.
		ShouldQuit: a.shouldQuit,
		Linux:      application.LinuxOptions{ProgramName: "Juggler"},
		Windows: application.WindowsOptions{
			AdditionalBrowserArgs: []string{"--disable-logging"},
		},
	})

	// On quit: snapshot the still-open window set (so Cmd+Q with several windows
	// restores all of them, not just whatever survived a teardown race), then
	// stop our spawned servers. macOS terminate ([NSApp terminate:]) doesn't
	// reliably return from app.Run(), so the post-Run cleanup can be skipped on a
	// Cmd+Q — this hook fires first. The servers' own --exit-with-parent watchdog
	// is the backstop for crashes/kills that bypass this entirely.
	a.app.Event.OnApplicationEvent(events.Mac.ApplicationWillTerminate, func(_ *application.ApplicationEvent) {
		a.persistWorkspaceSync()
		a.signalAllServers()
	})

	afterAppInit(a)
	installAppMenu(a, a.devMode)
}

// run opens windows for the given specs and runs the event loop. Blocks on the
// calling (main) goroutine. initApplication must have run first.
//
// The first spec that resolves becomes the initial window, built BEFORE Run so
// the app never starts with zero windows (a zero-window launch makes Cocoa exit
// immediately). The rest are opened once the app has launched. If no spec
// resolves (e.g. every restored project is gone), it falls back to a fresh
// no-project window so the app still starts.
func (a *appState) run(specs []windowSpec) error {
	if len(specs) == 0 {
		specs = []windowSpec{{}}
	}

	var initial *winEntry
	var rest []windowSpec
	for i, s := range specs {
		if initial = a.tryBuildInitial(s); initial != nil {
			rest = specs[i+1:]
			break
		}
	}
	if initial == nil {
		serverURL, proc, err := windowSpec{}.resolve()
		if err != nil {
			return fmt.Errorf("start initial window: %w", err)
		}
		saved, hasSaved := fetchWindowState(serverURL)
		initial = a.buildWindow(windowSpec{}, serverURL, proc, saved, hasSaved, "")
	}

	// Crash loudly if the initial window never becomes visible (e.g. the webview
	// fails to realise but reports no error), instead of lingering invisibly.
	// windowUp is closed once the window is confirmed visible; we consult it after
	// the loop returns to distinguish a real exit from a silent never-showed one.
	windowUp := make(chan struct{})
	go a.watchWindowStartup(initial, windowUp)

	a.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(_ *application.ApplicationEvent) {
		// The initial window is materialised by Wails during startup in its own
		// goroutine (go window.Run()). When it was created visible
		// (platformWindowHidden=false, Windows) Wails auto-shows it after the page
		// loads — calling Show() ourselves here would race that goroutine's impl
		// creation and intermittently corrupt the window (two impls → no visible
		// window). Only reveal it ourselves when it was created hidden (macOS/Linux),
		// where it won't show on its own.
		if platformWindowHidden {
			application.InvokeAsync(func() {
				// A panic while showing the first window would otherwise die in this
				// Wails-owned callback goroutine; make it a visible crash instead.
				defer func() {
					if r := recover(); r != nil {
						fatalf("panic while showing initial window: %v", r)
					}
				}()
				a.showWindow(initial)
			})
		}
		for _, s := range rest {
			a.openWindow(s, "")
		}
	})

	err := a.app.Run()
	// The GTK loop has returned. If it did so before the initial window was ever
	// confirmed visible, this is the silent failure: the loop exits cleanly
	// (status 0) having presented nothing. Turn it into a loud crash rather than a
	// success. A window that showed at least once (windowUp closed) exiting is a
	// normal quit.
	select {
	case <-windowUp:
	default:
		fatalf("%s\n(the GUI event loop exited with err=%v)", webviewenv.UnavailableMessage(
			"the GUI event loop exited before the initial window ever became visible"), err)
	}
	return err
}

// tryBuildInitial resolves spec's server and builds a window for it, returning
// the entry on success or nil when the project can't be resolved (logged and
// skipped). A locked project resolves to a locked-project placeholder window,
// which is still a non-nil entry.
func (a *appState) tryBuildInitial(spec windowSpec) *winEntry {
	serverURL, proc, err := spec.resolve()
	if err != nil {
		if locked, ok := err.(*lockedProjectError); ok {
			return a.buildLockedProjectWindow(spec, locked.message(), "")
		}
		logf("restore: skipping %+v: %v", spec.entry(), err)
		return nil
	}
	saved, hasSaved := fetchWindowState(serverURL)
	return a.buildWindow(spec, serverURL, proc, saved, hasSaved, "")
}

// startupSpecs decides which windows to open at launch. An explicit --url or
// --project opens exactly that one window; with neither, it restores the last
// open set (falling back to a single no-project window when there's nothing
// saved).
func (a *appState) startupSpecs(rawURL, project string) []windowSpec {
	if u := strings.TrimSpace(rawURL); u != "" {
		return []windowSpec{{url: normalizeURL(u)}}
	}
	if strings.TrimSpace(project) != "" {
		return []windowSpec{{project: project}}
	}
	if specs := a.workspace.load(); len(specs) > 0 {
		return specs
	}
	return []windowSpec{{}}
}

// onSecondInstance handles a redundant `juggler-app` launch routed to us by the
// single-instance manager. It parses the second instance's argv for --url /
// --project, then raises the existing window for that identity if one is open,
// or opens a fresh window onto it. Runs on the single-instance listener
// goroutine; all window work is marshalled to the main thread.
func (a *appState) onSecondInstance(data application.SecondInstanceData) {
	rawURL, project := parseLaunchArgs(data.Args)
	logf("second instance: url=%q project=%q", rawURL, project)

	// A bare relaunch (no --url/--project — e.g. double-clicking the icon again)
	// should surface the running app, not spin up a redundant server and window:
	// focus an existing window if there is one, and only open a fresh one when
	// none remain. This is the standard single-instance behaviour and avoids
	// spawning extra servers that become orphan candidates.
	if rawURL == "" && project == "" {
		if a.focusAnyWindow() {
			logf("second instance: raised existing window (bare relaunch)")
			return
		}
		logf("second instance: no window open, opening a fresh one (bare relaunch)")
		a.openWindow(windowSpec{}, "")
		return
	}

	var spec windowSpec
	if rawURL != "" {
		spec = windowSpec{url: normalizeURL(rawURL)}
	} else {
		spec = windowSpec{project: project}
	}
	// Raise an already-open window for this identity rather than duplicating it;
	// a project window's identity is independent of which server hosts it, so we
	// can match without resolving the server first.
	if a.focusWindowBySpec(spec) {
		logf("second instance: raised existing window for %+v", spec.entry())
		return
	}
	logf("second instance: opening new window for %+v", spec.entry())
	a.openWindow(spec, "")
}

// focusAnyWindow raises and focuses the most-recently-opened window, returning
// true if any window is open. Used for a bare relaunch, where there is no
// specific identity to match — the user just wants the app surfaced.
func (a *appState) focusAnyWindow() bool {
	var match *winEntry
	a.reg(func(st *regState) {
		best := -1
		for _, w := range st.windows {
			if n := winNum(w.id); n > best {
				best, match = n, w
			}
		}
	})
	return focusEntry(match)
}

// focusWindowBySpec raises and focuses the open window viewing the given
// identity, returning true if one was found. Used to dedupe second-instance
// launches onto an already-open window.
func (a *appState) focusWindowBySpec(spec windowSpec) bool {
	var match *winEntry
	a.reg(func(st *regState) {
		for _, w := range st.windows {
			if w.spec == spec {
				match = w
				break
			}
		}
	})
	return focusEntry(match)
}

// focusEntry un-minimises, shows and focuses the given window entry, returning
// true when e is non-nil. Shared raise/restore tail for the focus-any and
// focus-by-spec helpers.
func focusEntry(e *winEntry) bool {
	if e == nil {
		return false
	}
	application.InvokeAsync(func() {
		e.win.Restore() // un-minimise if needed
		e.win.Show()
		e.win.Focus()
	})
	return true
}

// openWindow resolves a server for the spec (spawning/discovering for a project,
// or connecting to a URL), reads that session's saved geometry, and opens a new
// in-process window onto it. The blocking resolve + geometry fetch run off the
// main thread; the window is then created on the main thread.
func (a *appState) openWindow(spec windowSpec, inheritedTheme string) {
	inheritedTheme = normaliseTheme(inheritedTheme)
	go func() {
		serverURL, proc, err := spec.resolve()
		if err != nil {
			if locked, ok := err.(*lockedProjectError); ok {
				application.InvokeAsync(func() {
					e := a.buildLockedProjectWindow(spec, locked.message(), inheritedTheme)
					a.showWindow(e)
					go a.warnIfWindowNeverVisible(e, "opened locked project")
				})
				return
			}
			logf("open window failed to resolve %+v: %v", spec, err)
			return
		}
		saved, hasSaved := fetchWindowState(serverURL)
		application.InvokeAsync(func() {
			e := a.buildWindow(spec, serverURL, proc, saved, hasSaved, inheritedTheme)
			a.showWindow(e)
			// Don't let a dynamically-opened window fail to appear silently.
			go a.warnIfWindowNeverVisible(e, "opened dynamically")
		})
	}()
}

// openWindowForProject opens a window onto a project. Used by "New Window" and
// the page's "open in new window" (via the loopback control endpoint).
func (a *appState) openWindowForProject(project, inheritedTheme string) {
	a.openWindow(windowSpec{project: project}, inheritedTheme)
}

func normaliseTheme(theme string) string {
	if _, ok := themeColours[theme]; ok {
		return theme
	}
	return ""
}

func (a *appState) themeForWindow(win application.Window) string {
	if win == nil {
		return ""
	}
	var theme string
	a.reg(func(st *regState) {
		for _, w := range st.windows {
			if w.win != nil && w.win.ID() == win.ID() {
				theme = w.currentTheme
				return
			}
		}
	})
	return theme
}

func (a *appState) currentWindowTheme() string {
	return a.themeForWindow(a.app.Window.Current())
}

func (a *appState) setWindowTheme(e *winEntry, theme string) (application.RGBA, bool) {
	theme = normaliseTheme(theme)
	if theme == "" {
		return application.RGBA{}, false
	}
	changed := false
	a.reg(func(st *regState) {
		if e != nil {
			e.currentTheme = theme
		}
		// Remember the freshest theme so the next window built without an
		// inherited one paints its bare frame to match (see buildWindow's bgTheme).
		if st.lastTheme != theme {
			st.lastTheme = theme
			changed = true
		}
	})
	// Persist across launches so a restored window's first frame matches, too.
	// Only on an actual change — the page reports its theme on every load.
	if changed {
		a.workspace.saveTheme(theme)
	}
	return themeColours[theme], true
}

// cascadeStep is the down-right nudge applied when a new window would open
// exactly on top of an existing one.
const cascadeStep = 30

// cascadeFrom offsets (x, y) down-right until it no longer coincides with an
// already-open window's top-left, so a new window doesn't perfectly cover an
// existing one (e.g. a second window for the same project, which shares the
// session's saved geometry). It reads each open window's LIVE position — never a
// cached snapshot, which would drift the moment the user moved a window and let
// the new one stack exactly on top. Bounded so it can't march a window
// off-screen.
//
// Must run on the main thread, since reading native window positions does;
// buildWindow's dynamic-window path (the only caller that can collide) already
// runs there, and the very first window has no peers to collide with.
func (a *appState) cascadeFrom(x, y int) (int, int) {
	taken := a.openWindowOrigins()
	for i := 0; i < 10 && taken[[2]int{x, y}]; i++ {
		x += cascadeStep
		y += cascadeStep
	}
	return x, y
}

// openWindowOrigins returns the current top-left of every open window, keyed for
// O(1) collision lookup. The registry snapshot is taken first (off the window
// objects) so the registry goroutine isn't held while the native Position()
// calls run. Caller must be on the main thread.
func (a *appState) openWindowOrigins() map[[2]int]bool {
	var wins []*application.WebviewWindow
	a.reg(func(st *regState) {
		for _, w := range st.windows {
			if w.win != nil {
				wins = append(wins, w.win)
			}
		}
	})
	origins := make(map[[2]int]bool, len(wins))
	for _, w := range wins {
		x, y := w.Position()
		origins[[2]int{x, y}] = true
	}
	return origins
}

// setWindowProject updates a window's workspace identity to the project the page
// reports it is now viewing. Projects are chosen in-page (the picker switches the
// server's project), so this report is how the app learns which project a window
// actually shows — it's what makes the restore set point at real projects.
// URL windows keep their URL identity; an empty report never downgrades a window
// that already has a project (avoids a transient reload blanking it). Geometry is
// unaffected — it lives in the session, which the server itself switched.
func (a *appState) setWindowProject(e *winEntry, project string) {
	project = strings.TrimSpace(project)
	changed := false
	a.reg(func(st *regState) {
		if e == nil || e.spec.isURL() {
			return
		}
		if project == "" && e.spec.project != "" {
			return
		}
		if e.spec.project != project {
			e.spec = windowSpec{project: project}
			changed = true
		}
	})
	if changed {
		a.persistWorkspace()
	}
}

// buildLockedProjectWindow opens an empty native window containing a clear
// recovery explanation when an OS-level project lock cannot be verified. It has
// no server or spawned process, so closing it cannot affect another session.
func (a *appState) buildLockedProjectWindow(spec windowSpec, message, inheritedTheme string) *winEntry {
	id := <-a.ids
	startupTheme := normaliseTheme(inheritedTheme)
	if startupTheme == "" {
		a.reg(func(st *regState) { startupTheme = st.lastTheme })
	}
	bgTheme := startupTheme
	if bgTheme == "" {
		bgTheme = "dark"
	}
	page := "data:text/html;charset=utf-8," + url.QueryEscape(`<!doctype html><meta charset="utf-8"><title>Project locked</title><style>body{margin:0;padding:48px;background:#0d1117;color:#e6edf3;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}main{max-width:720px;margin:auto}h1{margin-top:0}pre{white-space:pre-wrap;font:inherit}</style><main><h1>Project locked</h1><pre>`+html.EscapeString(message)+`</pre></main>`)
	win := a.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Project locked — Juggler",
		URL:              page,
		Width:            defaultWindowWidth,
		Height:           defaultWindowHeight,
		MinWidth:         minWindowWidth,
		MinHeight:        minWindowHeight,
		InitialPosition:  application.WindowCentered,
		Hidden:           platformWindowHidden,
		Frameless:        platformFrameless,
		BackgroundColour: themeColours[bgTheme],
		Mac:              application.MacWindow{TitleBar: application.MacTitleBar{AppearsTransparent: true, HideTitle: true, HideToolbarSeparator: true, FullSizeContent: true}},
		Linux:            application.LinuxWindow{WebviewGpuPolicy: a.gpuPolicy},
		Windows:          application.WindowsWindow{DisableFramelessWindowDecorations: false},
	})
	if win == nil {
		fatalf("Window.NewWithOptions returned nil for locked project %s", id)
	}
	e := &winEntry{id: id, win: win, spec: spec, currentTheme: startupTheme, saveCh: make(chan struct{}, 1), stopSave: make(chan struct{})}
	a.reg(func(st *regState) { st.windows[id] = e })
	a.persistWorkspace()
	win.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) { a.handleWindowClosed(e) })
	return e
}

// buildWindow constructs a WebviewWindow viewing serverURL and registers it,
// without showing it. Safe to call before app.Run() (initial window) or, on the
// main thread, after it (dynamic windows). serverProc is the server this app
// spawned for the window, or nil for a shared/remote server. Show it with
// showWindow once the app has launched.
func (a *appState) buildWindow(spec windowSpec, serverURL string, serverProc *exec.Cmd, saved core.WindowState, hasSaved bool, inheritedTheme string) *winEntry {
	id := <-a.ids
	nativeCtl := fmt.Sprintf("http://127.0.0.1:%d/win/%s", a.ctlPort, id)

	// Resolve the startup theme hint before building the URL/options. The page can
	// use ?theme= to apply the user's last-reported theme before localStorage is
	// read, and the native window uses the same colour for its bare pre-paint fill.
	// Only send a real hint (inherited from the source window or persisted from a
	// previous launch); don't send the dark fallback, because a first-ever launch
	// with no explicit choice should still let the page follow the OS preference.
	startupTheme := normaliseTheme(inheritedTheme)
	if startupTheme == "" {
		a.reg(func(st *regState) { startupTheme = st.lastTheme })
	}
	fullURL := strings.TrimRight(serverURL, "/") + "/?window=1&nativeCtl=" + url.QueryEscape(nativeCtl)
	if startupTheme != "" {
		fullURL += "&theme=" + url.QueryEscape(startupTheme)
	}

	// Resolve the native background colour to paint before the page's first
	// frame. On Windows the window is created visible (platformWindowHidden is
	// false), so Wails fills the bare frame with options.BackgroundColour on
	// WM_ERASEBKGND until WebView2 paints; left unset that fill is black, which
	// shows as a flash. Match it to the theme: the inherited theme for File ▸ New
	// Window, else the last theme any window reported this session or a previous
	// launch (so a restored/Finder-launched window matches where you left off),
	// else the app's dark default.
	bgTheme := startupTheme
	if bgTheme == "" {
		bgTheme = "dark"
	}

	// Place the window at the geometry saved in this project's session (passed in
	// by the caller, read from the server), falling back to a centred default the
	// first time a project is opened.
	width, height := defaultWindowWidth, defaultWindowHeight
	posX, posY := 0, 0
	initialPos := application.WindowCentered
	startState := application.WindowStateNormal
	if hasSaved {
		if saved.Width > 0 && saved.Height > 0 {
			width, height = saved.Width, saved.Height
		}
		if saved.HasPos {
			posX, posY = saved.X, saved.Y
			initialPos = application.WindowXY
		}
		switch {
		case saved.Maximised:
			startState = application.WindowStateMaximised
		case saved.Fullscreen:
			startState = application.WindowStateFullscreen
		}
	}
	// Don't stack a new window exactly on top of an open one (e.g. a second
	// window for the same project, which shares the session's geometry): nudge it
	// down-right until its top-left no longer coincides with another window.
	if initialPos == application.WindowXY {
		posX, posY = a.cascadeFrom(posX, posY)
	}

	win := a.app.Window.NewWithOptions(application.WebviewWindowOptions{
		// Startup placeholder only — the page reports its session path via the
		// loopback control endpoint (action=title) once loaded, so the macOS
		// "Window" menu names each window by the project it views.
		Title:           "Juggler",
		URL:             fullURL,
		Width:           width,
		Height:          height,
		MinWidth:        minWindowWidth,
		MinHeight:       minWindowHeight,
		X:               posX,
		Y:               posY,
		InitialPosition: initialPos,
		StartState:      startState,
		Hidden:          platformWindowHidden,
		Frameless:       platformFrameless,
		// Theme-matched bare-frame fill (see bgTheme above) so a window shown
		// before its first paint doesn't flash black. On macOS applyWindowChrome
		// repaints the NSWindow too; this covers Windows/Linux where it's a no-op.
		BackgroundColour: themeColours[bgTheme],
		// NB: deliberately NOT setting EnableFileDrop. With it off, WebKit's own
		// HTML5 file drag-and-drop reaches the page — the WKWebView delivers real
		// File objects to page JS exactly like a browser — and the input box's
		// dragover/drop listeners handle image drops with no native bridge. (The
		// Wails runtime would otherwise cancel the drop when the flag is off; the
		// input box re-enables it — see installFileDropOverride in input-box.js.)
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBar{
				AppearsTransparent:   true,
				HideTitle:            true,
				HideToolbarSeparator: true,
				FullSizeContent:      true,
			},
		},
		// WebviewGpuPolicy: hardware-accelerated compositing when a working GL
		// stack is detected, else software (Never) — resolved once and stored on
		// appState.gpuPolicy (see newAppState). Forcing acceleration on a
		// broken/absent GL stack (VM software GL, no DRI, headless) fails during
		// webview realisation, the native window never comes up, and the startup
		// watchdog FATALs — so the decision only returns Always on positive
		// evidence (a usable DRI render node + display; only a machine whose sole
		// render node is the NVIDIA proprietary driver stays software), and
		// JUGGLER_WEBVIEW_GPU overrides it. Software rendering re-rasterises the
		// UI's continuous animations (the busy spinner) on the main thread every
		// frame, pinning a CPU core while work is in flight; acceleration
		// composites them on the GPU and frees the main thread.
		Linux: application.LinuxWindow{
			WebviewGpuPolicy: a.gpuPolicy,
		},
		Windows: application.WindowsWindow{DisableFramelessWindowDecorations: false},
	})
	if win == nil {
		fatalf("Window.NewWithOptions returned nil for %s (url=%s) — the native window could not be created", id, fullURL)
	}

	// Ctrl+Tab / Ctrl+Shift+Tab cycle conversation tabs in THIS window (WKWebView
	// swallows them before page JS on macOS). Per-window keybindings target the
	// focused window correctly.
	win.RegisterKeyBinding("Ctrl+Tab", func(_ application.Window) {
		win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:cycle-tab',{detail:{direction:'next'}}))")
	})
	win.RegisterKeyBinding("Ctrl+Shift+Tab", func(_ application.Window) {
		win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:cycle-tab',{detail:{direction:'prev'}}))")
	})

	e := &winEntry{
		id:           id,
		win:          win,
		spec:         spec,
		serverURL:    serverURL,
		saveCh:       make(chan struct{}, 1),
		stopSave:     make(chan struct{}),
		currentTheme: startupTheme,
	}
	a.reg(func(st *regState) {
		st.windows[id] = e
		if serverProc != nil {
			if _, ok := st.servers[serverURL]; !ok {
				st.servers[serverURL] = serverProc
			}
		}
	})
	// The open set changed — remember it so a standalone launch restores it.
	a.persistWorkspace()

	// Persist geometry on every move/resize (debounced) so the window reopens
	// where the user left it, regardless of how the app exits.
	go a.saveLoop(e)
	win.OnWindowEvent(events.Common.WindowDidMove, func(_ *application.WindowEvent) { e.triggerSave() })
	win.OnWindowEvent(events.Common.WindowDidResize, func(_ *application.WindowEvent) { e.triggerSave() })

	// Guard the close: a hook runs before the WindowClosing listeners and can
	// cancel the event. If this window's server still has a turn in flight, veto
	// the close and confirm first (see busy_guard.go); once satisfied the guard
	// sets forceClose and re-issues Close(), which falls straight through here.
	win.RegisterHook(events.Common.WindowClosing, func(ev *application.WindowEvent) {
		if a.closeAllowed(e) {
			return
		}
		ev.Cancel()
		go a.confirmThenClose(e)
	})
	win.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		a.handleWindowClosed(e)
	})

	return e
}

// triggerSave wakes the window's save loop. Non-blocking — coalesces a burst
// of move/resize events into one debounced write.
func (e *winEntry) triggerSave() {
	select {
	case e.saveCh <- struct{}{}:
	default:
	}
}

// saveLoop debounces this window's geometry writes. A burst of move/resize
// events collapses into one write ~300ms after the last change. It returns when
// stopSave is closed; handleWindowClosed performs the authoritative final save
// before closing it, so there's nothing left to flush here. Runs on its own
// goroutine for the window's lifetime.
func (a *appState) saveLoop(e *winEntry) {
	var timerC <-chan time.Time
	for {
		select {
		case <-e.saveCh:
			timerC = time.After(saveDebounce)
		case <-timerC:
			timerC = nil
			if s, ok := a.currentWindowState(e); ok {
				putWindowState(e.serverURL, s)
			}
		case <-e.stopSave:
			return
		}
	}
}

// currentWindowState reads the window's geometry/state on the main thread.
// Returns (zero, false) when the native window isn't ready (zero size) so we
// never overwrite a good saved frame with junk. Mirrors the server's
// windowApp.currentState, tracking lastPos for maximise/fullscreen restore.
func (a *appState) currentWindowState(e *winEntry) (core.WindowState, bool) {
	type res struct {
		s  core.WindowState
		ok bool
	}
	done := make(chan res, 1)
	application.InvokeAsync(func() {
		maximised := e.win.IsMaximised()
		fullscreen := e.win.IsFullscreen()
		if !maximised && !fullscreen {
			x, y := e.win.Position()
			w, h := e.win.Size()
			if w <= 0 || h <= 0 {
				done <- res{core.WindowState{}, false}
				return
			}
			e.lastPos = core.WindowState{X: x, Y: y, Width: w, Height: h, HasPos: true}
		} else if !e.lastPos.HasPos {
			done <- res{core.WindowState{}, false}
			return
		}
		done <- res{core.WindowState{
			X:          e.lastPos.X,
			Y:          e.lastPos.Y,
			Width:      e.lastPos.Width,
			Height:     e.lastPos.Height,
			HasPos:     e.lastPos.HasPos,
			Maximised:  maximised,
			Fullscreen: fullscreen,
		}, true}
	})
	r := <-done
	return r.s, r.ok
}

// showWindow makes a built window visible and paints its native chrome. Must
// run on the main thread, after the application has finished launching.
func (a *appState) showWindow(e *winEntry) {
	e.win.Show()
	// In dev mode, enable the WKWebView inspector so the native right-click menu
	// (which the web layer only lets through in dev — see context-menu-service.js)
	// carries "Inspect Element". Done here, once the window has a native handle.
	// No-op off macOS. Outside dev mode the page suppresses the native menu
	// entirely, so a half-populated menu can never appear.
	if a.devMode {
		enableWebInspector(e.win)
	}
	theme := e.currentTheme
	if theme == "" {
		theme = "dark"
	}
	applyWindowChrome(e.win, themeColours[theme])
}

// handleWindowClosed removes the closed window, stops its server when no other
// window still views it, and quits the app when no windows remain. Runs on the
// Wails WindowClosing goroutine.
func (a *appState) handleWindowClosed(e *winEntry) {
	// Authoritative final geometry write, while the window is still readable
	// (its native getters work until Wails' built-in listener destroys it) AND
	// the server is still up (we may stop it just below). A pending debounced
	// write may not have fired yet, so capture and post now; then stop the save
	// loop. currentWindowState no-ops if the window is already gone, leaving the
	// last good write intact.
	if s, ok := a.currentWindowState(e); ok {
		putWindowState(e.serverURL, s)
	}
	a.notifyWindowCloseRequested(e)
	close(e.stopSave)

	var orphanServer *exec.Cmd
	remaining := -1
	a.reg(func(st *regState) {
		delete(st.windows, e.id)
		remaining = len(st.windows)
		// If no surviving window views this server, hand back the spawned proc
		// (if any) so we can stop it.
		stillViewed := false
		for _, w := range st.windows {
			if w.serverURL == e.serverURL {
				stillViewed = true
				break
			}
		}
		if !stillViewed {
			orphanServer = st.servers[e.serverURL]
			delete(st.servers, e.serverURL)
		}
	})
	if orphanServer != nil {
		go stopServer(orphanServer)
	}
	// Persist the shrunken set (so a closed window doesn't reappear next launch).
	// When this was the last window the set is now empty; persistWorkspace skips
	// the empty write, preserving the previous set for restore.
	a.persistWorkspace()
	if remaining == 0 {
		// The last window already passed its own close guard, so the quit it
		// triggers must not re-prompt: authorise it up front.
		a.reg(func(st *regState) { st.quitting = true })
		application.InvokeAsync(func() { a.app.Quit() })
	}
}

// notifyWindowCloseRequested tells one webview that its native window is about to
// close, giving page-owned state a synchronous chance to flush before teardown.
func (a *appState) notifyWindowCloseRequested(e *winEntry) {
	if e == nil || e.win == nil {
		return
	}
	done := make(chan struct{}, 1)
	application.InvokeAsync(func() {
		e.win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:window-close-requested'))")
		done <- struct{}{}
	})
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		logf("window close notification timed out for %s", e.id)
	}
}

// notifyAllWindowsCloseRequested dispatches the same close-requested lifecycle
// event to every live window before app-wide termination.
func (a *appState) notifyAllWindowsCloseRequested() {
	var wins []*winEntry
	a.reg(func(st *regState) { wins = sortedWindows(st) })
	for _, e := range wins {
		a.notifyWindowCloseRequested(e)
	}
}

// sortedWindows returns the open window entries in stable open order
// (ascending window number). Must be called while holding the reg lock.
func sortedWindows(st *regState) []*winEntry {
	ids := make([]string, 0, len(st.windows))
	for id := range st.windows {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return winNum(ids[i]) < winNum(ids[j]) })
	wins := make([]*winEntry, 0, len(ids))
	for _, id := range ids {
		wins = append(wins, st.windows[id])
	}
	return wins
}

// persistWorkspace records the current open-window set asynchronously.
func (a *appState) persistWorkspace() { a.persistWorkspaceTo(false) }

// persistWorkspaceSync records it and waits for the write (used at quit).
func (a *appState) persistWorkspaceSync() { a.persistWorkspaceTo(true) }

// persistWorkspaceTo snapshots the open windows (in open order) and writes them
// as the workspace set. An empty set is never written — that keeps the last
// non-empty set on disk so closing the final window (which quits the app) still
// restores it next launch.
func (a *appState) persistWorkspaceTo(sync bool) {
	var specs []windowSpec
	a.reg(func(st *regState) {
		for _, w := range sortedWindows(st) {
			// Only project windows are restorable; a URL window points at an
			// externally-supplied/ephemeral address that won't be valid next
			// launch, so never persist it (load() ignores them too).
			if s := w.spec; !s.isURL() {
				specs = append(specs, s)
			}
		}
	})
	if len(specs) == 0 {
		return
	}
	entries := make([]workspaceEntry, len(specs))
	for i, s := range specs {
		entries[i] = s.entry()
	}
	if sync {
		a.workspace.flush(entries)
	} else {
		a.workspace.save(entries)
	}
}

// winNum extracts the monotonic counter from a "wN" window id, for stable
// open-order sorting of the workspace set.
func winNum(id string) int {
	n, _ := strconv.Atoi(strings.TrimPrefix(id, "w"))
	return n
}

// stopAllServers stops every server this app spawned, waiting briefly for each.
// Called after the event loop returns (the clean-exit path).
func (a *appState) stopAllServers() {
	a.reg(func(st *regState) {
		for url, proc := range st.servers {
			stopServer(proc)
			delete(st.servers, url)
		}
	})
}

// signalAllServers sends a graceful interrupt to every spawned server without
// waiting. Used from the terminate hook, where the process is about to exit and
// can't block — the servers shut down on the signal, and their --exit-with-parent
// watchdog catches any that miss it.
func (a *appState) signalAllServers() {
	a.reg(func(st *regState) {
		for _, proc := range st.servers {
			if proc != nil && proc.Process != nil {
				_ = proc.Process.Signal(os.Interrupt)
			}
		}
	})
}
