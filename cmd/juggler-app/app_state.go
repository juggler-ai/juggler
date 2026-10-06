//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/webviewenv"
	"juggler/internal/windowgeom"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	defaultWindowWidth  = windowgeom.DefaultWidth
	defaultWindowHeight = windowgeom.DefaultHeight
	minWindowWidth      = 800
	minWindowHeight     = 600
)

// resizeHandleEdgePx and resizeHandleCornerExtraPx size the edge-resize band of
// a frameless window. Dropping the native decorations also drops the invisible
// resize border a decorated window reserves outside its content, so the only
// thing left to grab is the Wails runtime's own pointer hit-test — and that
// falls back to 5px for the edges and 5+10px for the corners when the app
// publishes no flags. Five pixels against a layout whose content runs to the
// last pixel is close to ungrabbable; these match the ~8px a GTK
// client-side-decorated window reserves for the same job.
const (
	resizeHandleEdgePx        = 8
	resizeHandleCornerExtraPx = 8
)

// resizeHandleFlags publishes that band to the Wails runtime as frontend flags.
//
// The keys are FLAT and must stay that way. The runtime reads them with
// GetFlag("system.resizeHandleWidth"), which is a single map lookup and not a
// dotted path walk, so a nested {"system": {...}} value is never found — which
// is exactly why Wails' own Windows GetFlags, the only platform that populates
// these, silently gets the 5px fallback too.
//
// Published unconditionally: macOS gates its resize hit-test off entirely (it
// keeps a decorated frame, so AppKit resizes it), and never reads them.
func resizeHandleFlags() map[string]any {
	return map[string]any{
		"system.resizeHandleWidth":  resizeHandleEdgePx,
		"system.resizeHandleHeight": resizeHandleEdgePx,
		"resizeCornerExtra":         resizeHandleCornerExtraPx,
	}
}

// closeFlushTimeout bounds the whole close-requested handshake — every window
// flushing its composer drafts and confirming they reached disk. Generous enough
// to cover a page whose worker is mid-turn (the page allows 2.5s per
// conversation and answers regardless), short enough that a wedged webview can't
// make the app feel hung on Cmd+Q.
const closeFlushTimeout = 4 * time.Second

// themeColours maps the page theme name to the NSWindow background. Keep in
// sync with --bg-primary in web/css/tokens/theme-dark.css and theme-light.css.
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

	// fileDrop is whether native file drop is currently on for this window —
	// true while it shows no project. Tracked so a repeated report of the same
	// state does not keep adding and removing the macOS drag overlay.
	fileDrop bool

	// sizeDefaulted is whether this window opened at the default size rather
	// than one saved or inherited. The initial window is built before Wails
	// knows of any screens, so its default is the layout's bare minimum;
	// knowing the size was nobody's choice is what lets fitWindowToScreens
	// replace it with the one the display deserves, and leave every other
	// window's size alone. Immutable.
	sizeDefaulted bool

	// role is what this window is for — roleMain for the app, or this board's own
	// rolePinboardFor slot. It keys the geometry this window reads and writes,
	// and it is what keeps a board out of the restored workspace file (a board is
	// restored from its project's session instead). Immutable.
	role string

	// board is the pinboard composition this window is, for a detached board, and
	// empty for the app. It is what a board's own state is looked up by when the
	// window is closed for good.
	board string

	// openedBy is the id of the window a detached board was opened from, and
	// empty for everything else. It is how the app knows which boards to take
	// with a window when it closes: a board's own server cannot say, because two
	// main windows on one project share it. A window whose opener has already
	// gone keeps a dangling id, which matches nothing and is exactly right —
	// there is nobody left to be closed alongside.
	openedBy string

	// currentTheme is the last page-reported theme for this native window. It is
	// used to paint chrome immediately on show and as the inherited theme for
	// Session ▸ New Window.
	currentTheme string

	// geom holds the frame this window persists, owned by the save loop. It
	// lets a maximised/fullscreen window still record a sane restore frame
	// alongside the maximised flag.
	geom *windowgeom.Tracker

	// saves debounces geometry writes (Wails fires move/resize many times per
	// drag); stopSave ends the per-window save loop when the window closes.
	saves    *windowgeom.Debouncer
	stopSave chan struct{}

	// forceClose is set (via the registry goroutine) once the busy-work close
	// guard has been satisfied — either the server had no in-flight turn or the
	// user confirmed the discard. The close gate reads it (through closeAllowed)
	// to skip straight past the prompt. Owned by the registry goroutine like the
	// rest of winEntry's shared fields.
	forceClose bool

	// settling is set while the close gate is running for this window, and
	// settled once it has finished and the close it re-issues may proceed to
	// teardown. They are separate because the gate can take seconds — a prompt
	// waits on the user, a flush on the page — and the window stays clickable
	// throughout, so further closes must be turned away without either starting
	// a second gate or being mistaken for a settled one. Owned by the registry
	// goroutine, like forceClose above them.
	settling bool
	settled  bool

	// retainBoard is set (via the registry goroutine) when this board window is
	// being taken down with the window that opened it, rather than closed on its
	// own. The difference is the whole of what the board keeps: a window put away
	// with its owner comes back with it, and one closed on its own is finished
	// with. Owned by the registry goroutine, like forceClose beside it.
	retainBoard bool

	// closing is set once this window's teardown has been claimed, so only the
	// first WindowClosing for it runs one. Owned by the registry goroutine, and
	// kept on the entry rather than in the registry map because teardown removes
	// the entry from that map partway through.
	closing bool

	// flushSeq counts close-requested announcements to this window; flushDone is
	// the channel closed when the page answers the current one (nil between
	// handshakes). The page quotes the sequence number back, which is what stops
	// a reply to an earlier announcement from releasing a later one — the same
	// notification is issued for a quit and for an updater restart. Owned by the
	// registry goroutine.
	flushSeq  int
	flushDone chan struct{}
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

	// lastZoom is the most recent page-reported UI zoom (root font-size %) across
	// all windows. It seeds the ?zoom= hint of the next window built without an
	// inherited zoom (a restored, Finder-launched, or Cmd+N window), so it opens
	// at the last-active size instead of the default. Persisted across launches
	// via workspace.json; the per-project value lives in the session.
	lastZoom int

	// lastPickerDir is the folder the most recent native path chooser picked
	// from, and where the next one opens. It is the run's browsing position
	// rather than a setting, so it is deliberately not persisted: a fresh launch
	// starts from whatever the caller suggests again. Of the three platforms
	// only macOS and Windows remember this by themselves, and both forget it the
	// moment a start directory is named, which every file chooser here does.
	lastPickerDir string

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
		st := &regState{windows: map[string]*winEntry{}, servers: map[string]*exec.Cmd{}, lastTheme: a.workspace.loadLastTheme(), lastZoom: a.workspace.loadLastZoom()}
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

// openerFrame is the live frame of the window that asked for a new one, or the
// zero frame when there is no longer such a window. What a panel measured in
// that window's page is relative to, so it is read at the moment the new window
// is built rather than when the request arrived.
//
// Must be called on the main thread: Position and Size read live native state.
func (a *appState) openerFrame(id string) core.WindowState {
	if id == "" {
		return core.WindowState{}
	}
	e := a.window(id)
	if e == nil || e.win == nil {
		return core.WindowState{}
	}
	x, y := e.win.Position()
	w, h := e.win.Size()
	return core.WindowState{X: x, Y: y, Width: w, Height: h, HasPos: true}
}

// windowSpecOf reports what a window views, read on the registry goroutine
// because the spec is mutable — the page reports its project as it switches, so
// reading the field off the entry afterwards would race that write. Used to open
// a detached board onto exactly the project the window asking for it has open.
func (a *appState) windowSpecOf(id string) (windowSpec, bool) {
	var spec windowSpec
	var ok bool
	a.reg(func(st *regState) {
		if e := st.windows[id]; e != nil {
			spec, ok = e.spec, true
		}
	})
	return spec, ok
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
		// The same snapshot the macOS terminate hook takes, on the platforms that
		// have no such hook. Wails runs this first in its own teardown, before it
		// closes the windows — which is the last moment the open set is still the
		// set the user left.
		OnShutdown: a.onShutdown,
		// Widen the frameless window's edge-resize band (see resizeHandleFlags).
		Flags: resizeHandleFlags(),
		Linux: application.LinuxOptions{ProgramName: "Juggler"},
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
		// Mark teardown authoritatively: any termination path that reached here is
		// really quitting (not just the ShouldQuit-guarded ones). onSecondInstance
		// reads this to ignore a relaunch hand-off routed to us while we're dying —
		// servicing it would build a window against a collapsing Cocoa layer and
		// present the corrupt/blank frame seen on a quick quit-then-relaunch.
		a.reg(func(st *regState) { st.quitting = true })
		a.persistWorkspaceSync()
		a.signalAllServers()
	})

	// A folder dropped on the Dock icon, or sent here by Finder's "Open With".
	// macOS delivers these by Apple Event, so they never reach the launch flags
	// — this is the only place they arrive.
	a.app.Event.OnApplicationEvent(events.Common.ApplicationOpenedWithFile, func(event *application.ApplicationEvent) {
		var quitting bool
		a.reg(func(st *regState) { quitting = st.quitting })
		if quitting {
			return
		}
		a.openDroppedFolder(event.Context().Filename())
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
		saved, hasSaved := fetchWindowState(serverURL, roleMain)
		initial = a.buildWindow(windowSpec{}, serverURL, proc, saved, hasSaved, windowOpts{})
	}

	// Crash loudly if the initial window never becomes visible (e.g. the webview
	// fails to realise but reports no error), instead of lingering invisibly.
	// windowUp is closed once the window is confirmed visible; we consult it after
	// the loop returns to distinguish a real exit from a silent never-showed one.
	windowUp := make(chan struct{})
	go a.watchWindowStartup(initial, windowUp)

	a.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(_ *application.ApplicationEvent) {
		// The initial window is materialised by Wails during startup in its own
		// goroutine (go window.Run()). A hidden initial window can be revealed
		// directly. On Windows the window is logically created visible, but the
		// vendored Wails version omits WS_VISIBLE at CreateWindowEx and waits for
		// WebView2 navigation before calling ShowWindow. Wait until the native frame
		// exists, then reveal it without racing Run into creating a second impl.
		if platformWindowHidden {
			application.InvokeAsync(func() {
				// A panic while showing the first window would otherwise die in this
				// Wails-owned callback goroutine; make it a visible crash instead.
				defer func() {
					if r := recover(); r != nil {
						fatalf("panic while showing initial window: %v", r)
					}
				}()
				if a.fitWindowToScreens(initial) {
					initial.triggerSave()
				}
				a.showWindow(initial)
			})
		} else {
			go a.revealInitialWindowWhenReady(initial)
		}
		for _, s := range rest {
			a.openWindow(s, windowOpts{})
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
	saved, hasSaved := fetchWindowState(serverURL, roleMain)
	return a.buildWindow(spec, serverURL, proc, saved, hasSaved, windowOpts{})
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
	// If we're already tearing down, do NOT service the hand-off. On a quick
	// quit-then-relaunch the new process can route its argv to us while our
	// Cocoa layer is collapsing; any window opened here comes up as a corrupt or
	// tiny blank frame. Ignore it — the second instance has already exited, so the
	// user's next launch starts a clean process once we're gone.
	var quitting bool
	a.reg(func(st *regState) { quitting = st.quitting })
	if quitting {
		logf("second instance: ignoring hand-off during shutdown")
		return
	}

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
		a.openWindow(windowSpec{}, windowOpts{})
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
	a.openWindow(spec, windowOpts{})
}

// focusAnyWindow raises and focuses the most-recently-opened window, returning
// true if any window is open. Used for a bare relaunch, where there is no
// specific identity to match — the user just wants the app surfaced.
func (a *appState) focusAnyWindow() bool {
	var match *winEntry
	a.reg(func(st *regState) {
		best := -1
		for _, w := range st.windows {
			// A relaunch wants Juggler, not a board belonging to one of its
			// windows.
			if isBoardRole(w.role) {
				continue
			}
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
			// A board shares its owner's identity but is not a window onto that
			// project in the sense a second launch means.
			if isBoardRole(w.role) {
				continue
			}
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
func (a *appState) openWindow(spec windowSpec, opts windowOpts) {
	opts.theme = normaliseTheme(opts.theme)
	opts.mode = normaliseMode(opts.mode)
	go func() {
		serverURL, proc, err := spec.resolve()
		if err != nil {
			if locked, ok := err.(*lockedProjectError); ok {
				application.InvokeAsync(func() {
					// A locked window shows a static recovery page, not the app —
					// there is no root font-size to scale, so zoom is not threaded,
					// and the static page has no theme mode to seed either.
					e := a.buildLockedProjectWindow(spec, locked.message(), opts.theme)
					a.showWindow(e)
					go a.warnIfWindowNeverVisible(e, "opened locked project")
				})
				return
			}
			logf("open window failed to resolve %+v: %v", spec, err)
			return
		}
		// A window born onto a project (New Window, the page's "open in new
		// window", restore, or a second instance) never routes through the
		// server's POST /api/project switch, which is the only other place the
		// recents list is updated. Without this, a folder first opened in its own
		// window would never appear in the picker's recents.
		if spec.project != "" {
			a.rememberRecentProject(spec.project)
		}
		saved, hasSaved := fetchWindowState(serverURL, opts.role())
		application.InvokeAsync(func() {
			e := a.buildWindow(spec, serverURL, proc, saved, hasSaved, opts)
			a.showWindow(e)
			// Don't let a dynamically-opened window fail to appear silently.
			go a.warnIfWindowNeverVisible(e, "opened dynamically")
		})
	}()
}

// openWindowForProject opens a window onto a project. Used by "New Window" and
// the page's "open in new window" (via the loopback control endpoint).
func (a *appState) openWindowForProject(project string, opts windowOpts) {
	a.openWindow(windowSpec{project: project}, opts)
}

// openDroppedFolder handles a folder dropped on the Dock icon, or opened from
// Finder's "Open With" — macOS delivers those as an Apple Event rather than on
// the command line, so they arrive here and not through the launch flags. No
// window is implied by the gesture, so any empty one will do.
func (a *appState) openDroppedFolder(path string) {
	a.openDroppedFolderInWindow(a.emptyMainWindow(), []string{path})
}

// openDroppedFolderInWindow opens what was dropped, preferring the window it was
// dropped on. A nil window means the gesture named none.
//
// Three outcomes, in the order a user would expect:
//
//  1. A window is already on that project. Raise it. Opening a second window
//     onto one project is never what the gesture meant, and the project lock
//     would refuse it anyway.
//  2. The window that took the drop is empty. Fill it, by handing the page an
//     announcement — which is also what routes the open through the endpoint
//     that validates the path and records it in recents. Leaving a blank window
//     next to a new one is the shabbier answer.
//  3. Otherwise open a window for it.
func (a *appState) openDroppedFolderInWindow(e *winEntry, paths []string) {
	folder := droppedProjectFolder(paths)
	if folder == "" {
		return
	}
	if a.focusWindowBySpec(windowSpec{project: folder}) {
		return
	}
	if e != nil && e.win != nil {
		focusEntry(e)
		e.win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:folder-dropped',{detail:{path:" +
			jsString(folder) + "}}))")
		return
	}
	a.openWindowForProject(folder, windowOpts{})
}

// emptyMainWindow returns an open app window showing no project, or nil. A
// board is not a candidate: it is a view of a conversation, with nowhere to put
// a project.
func (a *appState) emptyMainWindow() *winEntry {
	var match *winEntry
	a.reg(func(st *regState) {
		best := -1
		for _, w := range st.windows {
			if isBoardRole(w.role) || w.spec.isURL() || w.spec.project != "" {
				continue
			}
			if n := winNum(w.id); n > best {
				best, match = n, w
			}
		}
	})
	return match
}

func normaliseTheme(theme string) string {
	if _, ok := themeColours[theme]; ok {
		return theme
	}
	return ""
}

// normaliseMode validates a theme *mode* hand-off value. Unlike normaliseTheme
// (which only accepts concrete paintable themes), 'system' is a valid mode: it
// is what lets an 'auto' opener hand its mode to a child window. Anything else,
// including an empty value, yields "".
func normaliseMode(mode string) string {
	switch mode {
	case "system", "light", "dark":
		return mode
	default:
		return ""
	}
}

// startupPrefs decides the theme, mode and zoom a window opens with, from the
// three things that can have an opinion:
//
//   - saved: what this window's own role was last left in, read from the project
//     session. It wins. Two boards detached onto two displays and set to two
//     themes have to come back wearing them, whichever window opens them.
//   - opts: the opener's hand-off (Session ▸ New Window, the page's open-in-new-
//     window, a detach). What a window with nothing of its own inherits.
//   - lastTheme/lastZoom: the freshest values any window of this app reported,
//     this session or a previous launch. The fallback for a launch with no
//     opener at all (Finder, restore).
//
// theme is a colour to paint the bare frame with before the page's first paint;
// mode is the user's selection, so a 'system' opener hands 'system' on rather
// than collapsing the child to a concrete colour. A saved 'system' therefore
// names no colour: the inherited one stays as the pre-paint fill and the page
// resolves the OS preference itself on its first frame. Empty/zero results mean
// "say nothing", which leaves a first-ever launch following the OS and the
// default size.
func startupPrefs(opts windowOpts, saved core.WindowState, hasSaved bool, lastTheme string, lastZoom int) (theme, mode string, zoom int) {
	theme = normaliseTheme(opts.theme)
	if theme == "" {
		theme = lastTheme
	}
	mode = normaliseMode(opts.mode)
	zoom = opts.zoom
	if zoom <= 0 {
		zoom = lastZoom
	}
	if !hasSaved {
		return theme, mode, zoom
	}
	if savedMode := normaliseMode(saved.Theme); savedMode != "" {
		mode = savedMode
		if savedTheme := normaliseTheme(saved.Theme); savedTheme != "" {
			theme = savedTheme
		}
	}
	if saved.Zoom > 0 {
		zoom = saved.Zoom
	}
	return theme, mode, zoom
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

// pickerDirectory returns where the last native path chooser picked from, or ""
// if none has yet this run.
func (a *appState) pickerDirectory() string {
	var dir string
	a.reg(func(st *regState) { dir = st.lastPickerDir })
	return dir
}

// setPickerDirectory records where a native path chooser just picked from, so
// the next one opens there. It is one position for the whole app, not one per
// window or per project: a chooser is a place you were, and the window you
// happened to open it from is not what you remember about it.
func (a *appState) setPickerDirectory(dir string) {
	if dir == "" {
		return
	}
	a.reg(func(st *regState) { st.lastPickerDir = dir })
}

// setWindowZoom records the freshest page-reported UI zoom, so the next window
// built without an inherited zoom opens at the last-active size. Unlike theme it
// touches no native window (zoom is a web-only root font-size); it just tracks
// the inheritance seed and persists it across launches. A non-positive value is
// ignored. The per-project value is owned by the session (server-side); this is
// only the cross-window seed.
func (a *appState) setWindowZoom(zoom int) {
	if zoom <= 0 {
		return
	}
	changed := false
	a.reg(func(st *regState) {
		if st.lastZoom != zoom {
			st.lastZoom = zoom
			changed = true
		}
	})
	// Only on an actual change — the page reports its zoom on every load.
	if changed {
		a.workspace.saveZoom(zoom)
	}
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

// syncFileDrop keeps native file drop on exactly while a window shows no
// project, from the project the page has just reported.
//
// It cannot ride setWindowProject's "changed" flag: that deliberately ignores a
// report of "" once a window has a project, so the workspace identity survives
// a momentary blank — but closing a project is precisely when drop has to come
// back. So this reads every report instead, and dedupes against what the window
// was last told.
func (a *appState) syncFileDrop(e *winEntry, project string) {
	if e == nil || e.win == nil {
		return
	}
	want := strings.TrimSpace(project) == ""
	changed := false
	a.reg(func(st *regState) {
		if e.fileDrop == want {
			return
		}
		e.fileDrop = want
		changed = true
	})
	if changed {
		// Does its own main-thread hop.
		e.win.SetEnableFileDrop(want)
	}
}

// droppedProjectFolder picks the folder to open from what was dropped.
//
// One item only: a multi-item drop names no single project, and picking the
// first would be a guess the user cannot see being made. A dropped FILE is read
// as its containing folder — dragging a file from a project you want to open is
// a near miss, not a mistake worth refusing.
func droppedProjectFolder(paths []string) string {
	if len(paths) != 1 {
		return ""
	}
	path := strings.TrimSpace(paths[0])
	if path == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	if info.IsDir() {
		return path
	}
	return filepath.Dir(path)
}

// jsString renders s as a JavaScript string literal for an ExecJS payload. A
// path can hold quotes and backslashes, and JSON's escaping is JavaScript's.
func jsString(s string) string {
	encoded, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(encoded)
}

// rememberRecentProject records an opened project folder in the user-level
// recents list the in-page picker reads (GET /api/recents). The server updates
// that list when a project is switched in place (POST /api/project), but a
// window opened directly onto a project bypasses that path, so the app records
// it here. The path is expanded and absolutised to dedupe against the absolute
// paths the server stores. Best-effort: a failure only costs a missing recents
// entry, so errors are ignored.
func (a *appState) rememberRecentProject(project string) {
	project = strings.TrimSpace(project)
	if project == "" {
		return
	}
	if project == "~" || strings.HasPrefix(project, "~/") || strings.HasPrefix(project, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			project = home + project[1:]
		}
	}
	abs, err := filepath.Abs(project)
	if err != nil {
		return
	}
	store, err := core.NewRecentsStore()
	if err != nil {
		return
	}
	_ = store.Add(abs)
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
	page := lockedProjectPage(message)
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
	e := &winEntry{id: id, win: win, spec: spec, role: roleMain, currentTheme: startupTheme, geom: windowgeom.NewTracker(core.WindowState{}, a.app.Screen.GetAll), saves: windowgeom.NewDebouncer(), stopSave: make(chan struct{})}
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
func (a *appState) buildWindow(spec windowSpec, serverURL string, serverProc *exec.Cmd, saved core.WindowState, hasSaved bool, opts windowOpts) *winEntry {
	id := <-a.ids
	nativeCtl := fmt.Sprintf("http://127.0.0.1:%d/win/%s", a.ctlPort, id)

	// Resolve the startup appearance before building the URL/options, from what
	// this window was last left in and what it inherits (see startupPrefs).
	var lastTheme string
	var lastZoom int
	a.reg(func(st *regState) { lastTheme, lastZoom = st.lastTheme, st.lastZoom })
	startupTheme, startupMode, startupZoom := startupPrefs(opts, saved, hasSaved, lastTheme, lastZoom)

	resolved := opts
	resolved.theme, resolved.mode, resolved.zoom = startupTheme, startupMode, startupZoom
	resolved.external = spec.isURL()
	fullURL := windowPageURL(serverURL, nativeCtl, resolved)

	// Resolve the native background colour to paint before the page's first
	// frame. On Windows the window is created visible (platformWindowHidden is
	// false), so Wails fills the bare frame with options.BackgroundColour on
	// WM_ERASEBKGND until WebView2 paints; left unset that fill is black, which
	// shows as a flash. Match it to the theme startupPrefs resolved — this
	// window's own, else the one it inherits — so a restored window comes up in
	// the colour it was left in; the app's dark default covers a first-ever launch
	// that has neither.
	bgTheme := startupTheme
	if bgTheme == "" {
		bgTheme = "dark"
	}

	// Place the window at the geometry saved in this project's session (passed in
	// by the caller, read from the server), else over the panel a board was
	// popped out of, else at a centred default (see openingFrame). The opener's
	// frame is read live, which is why this is on the main thread.
	//
	// Wails fills its screen cache inside Run(), so the initial window — built
	// before Run — is placed against no screens at all and PlaceVisible cannot
	// judge it — neither for reachability nor for size. fitWindowToScreens
	// re-checks the live frame once the app is up, before the window is
	// revealed; this log line is what says which of the two decided the outcome.
	screens := a.app.Screen.GetAll()
	frame := openingFrame(saved, hasSaved, opts, a.openerFrame(opts.openedBy), screens)
	place := windowgeom.PlaceVisible(frame, screens)
	logf("placing window %s: saved=%s screens=%s → %s", id, describeFrame(frame), describeScreens(screens), describePlacement(place))
	width, height := place.Width, place.Height
	posX, posY := place.X, place.Y
	initialPos, startState := place.Position, place.State
	// Don't stack a new window exactly on top of an open one (e.g. a second
	// window for the same project, which shares the session's geometry): nudge it
	// down-right until its top-left no longer coincides with another window.
	if initialPos == application.WindowXY {
		posX, posY = a.cascadeFrom(posX, posY)
		place.X, place.Y = posX, posY
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
		Screen:          place.Screen,
		StartState:      startState,
		Hidden:          platformWindowHidden,
		Frameless:       platformFrameless,
		// Theme-matched bare-frame fill (see bgTheme above) so a window shown
		// before its first paint doesn't flash black. On macOS applyWindowChrome
		// repaints the NSWindow too; this covers Windows/Linux where it's a no-op.
		BackgroundColour: themeColours[bgTheme],
		// File drop is on for a window with no project and off for one with a
		// project, and syncFileDrop keeps it that way as the window changes state.
		//
		// The two drag mechanisms cannot coexist. Native drop is the only way to
		// learn a dropped folder's PATH — WebKit withholds it from the page for
		// every file drag, so text/uri-list and text/plain both come back empty —
		// but on macOS it works by putting a drag destination above the webview,
		// and a drag has exactly one destination: what that overlay takes, the
		// page never sees.
		//
		// Off is therefore the right default, and what makes it safe to switch on
		// here is that the two states want opposite things and never overlap. With
		// no project there is no composer, so nothing in the page wants a file
		// drag, and a dropped folder is the fastest way into a project. With a
		// project open, HTML5 drop reaches the page again and the composer's own
		// dragover/drop listeners handle image and file drops as before. (The
		// Wails runtime cancels the drop while the flag is off; the composer
		// re-enables it — see installFileDropGuard in composer.js.)
		//
		// What the overlay catches arrives back here through the page: the native
		// side hands the paths to window._wails.handlePlatformFileDrop, which
		// no-project-overlay.js implements and reports to the "folder-dropped"
		// window-control action.
		EnableFileDrop: spec.project == "",
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBar{
				AppearsTransparent:   true,
				HideTitle:            true,
				HideToolbarSeparator: true,
				FullSizeContent:      true,
			},
			// Escape belongs to the page. Left to AppKit, a fullscreen window
			// drops out of fullscreen on the same press that stops a turn or
			// closes a menu — through cancelOperation:, or, with the message box
			// focused, through the command WebKit runs for the key. The page
			// leaves fullscreen itself, through the control endpoint's
			// "unfullscreen", only when nothing else wanted the key
			// (escape-behaviour.js).
			DisableEscapeExitsFullscreen: true,
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
		id:            id,
		win:           win,
		spec:          spec,
		serverURL:     serverURL,
		role:          opts.role(),
		board:         opts.board,
		openedBy:      opts.openedBy,
		fileDrop:      spec.project == "", // matches EnableFileDrop in the options above
		sizeDefaulted: frame.Width <= 0 || frame.Height <= 0,
		geom:          windowgeom.NewTracker(windowgeom.Seed(place), a.app.Screen.GetAll),
		saves:         windowgeom.NewDebouncer(),
		stopSave:      make(chan struct{}),
		currentTheme:  startupTheme,
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

	// Settle the close before the window can be torn down: confirming a discard
	// and flushing the page's drafts both need a live webview, and this hook is
	// the last point in the close that still has one. It cancels, settles on its
	// own goroutine, and re-issues the close — which then falls straight through
	// here. See close_gate.go.
	win.RegisterHook(events.Common.WindowClosing, func(ev *application.WindowEvent) {
		if a.closeReady(e) {
			return
		}
		ev.Cancel()
		if a.claimSettle(e) {
			go a.settleThenClose(e)
		}
	})
	win.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		a.handleWindowClosed(e)
	})

	return e
}

// triggerSave wakes the window's save loop. Non-blocking — coalesces a burst
// of move/resize events into one debounced write.
func (e *winEntry) triggerSave() {
	e.saves.Trigger()
}

// saveLoop writes this window's settled geometry after each burst of
// move/resize events. It returns when stopSave is closed; handleWindowClosed
// performs the authoritative final save before closing it, so there's nothing
// left to flush here. Runs on its own goroutine for the window's lifetime.
func (a *appState) saveLoop(e *winEntry) {
	e.saves.Run(e.stopSave, func() {
		if s, ok := a.currentWindowState(e); ok {
			putWindowState(e.serverURL, e.role, s)
		}
	})
}

// currentWindowState reads the window's geometry/state, marshalling onto the
// main thread because that is the only place Wails answers the native getters
// correctly. Returns (zero, false) when there is nothing worth writing — see
// windowgeom.Tracker.Capture — so a good saved frame is never overwritten with
// junk from a window that isn't ready or has already gone.
func (a *appState) currentWindowState(e *winEntry) (core.WindowState, bool) {
	type res struct {
		s  core.WindowState
		ok bool
	}
	done := make(chan res, 1)
	application.InvokeAsync(func() {
		s, ok := e.geom.Capture(e.win)
		done <- res{s, ok}
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

// claimClose gives exactly one caller the right to tear e down, reporting
// whether this one won it. Claimed on the registry goroutine, which owns
// winEntry's shared fields.
func (a *appState) claimClose(e *winEntry) bool {
	first := false
	a.reg(func(*regState) {
		first = !e.closing
		e.closing = true
	})
	return first
}

// onShutdown records the workspace and stops the spawned servers as the app
// goes down. Wails runs it first in its own teardown, before it closes the
// windows — which is the last moment the open set is still the set the user
// left, and the last moment a window's own teardown could still be racing the
// process.
//
// It does the same work as the macOS terminate hook, and both are registered
// because neither covers the other: [NSApp terminate:] does not reliably return
// through Wails' teardown, and Linux and Windows have no terminate event at all.
// Running twice costs a second snapshot of a set that has not changed.
func (a *appState) onShutdown() {
	a.reg(func(st *regState) { st.quitting = true })
	a.persistWorkspaceSync()
	a.signalAllServers()
}

// markBoardsClosingWith works out what a window closing means for the boards
// around it, and marks them. Runs on the registry goroutine, which owns every
// field it reads and writes.
//
// It answers with the board windows this one opened, which go down with it: a
// board is a view of a conversation, and one whose window has gone has nothing
// left to reveal into. Marking them is what tells each one, when its own close
// arrives, that it is being put away rather than finished with — see
// boardFinishedWith, which reads the mark.
//
// Ownership is by opener, never by server. Two main windows on one project share
// a server URL, so a server match cannot tell one window's boards from the
// other's — it would take both down and leave the surviving window without the
// board it was using.
//
// Nothing happens while the app is quitting: at quit the boards are going anyway,
// and the window teardowns race the process, so a board taken down by the window
// that happened to close first would be indistinguishable from one closed on
// purpose.
func markBoardsClosingWith(st *regState, e *winEntry) (boards []*winEntry) {
	if st.quitting {
		return nil
	}
	for _, w := range st.windows {
		if w.openedBy != e.id || w.board == "" {
			continue
		}
		w.retainBoard = true
		// The close guard for this server was satisfied a moment ago by the
		// window that owned these, so they are not made to ask about it again.
		w.forceClose = true
		boards = append(boards, w)
	}
	// A settled order, so a test and a user get the same one.
	sort.Slice(boards, func(i, j int) bool { return boards[i].id < boards[j].id })
	return boards
}

// boardFinishedWith reports whether the window closing is a detached board the
// user is done with, which is the one case where what it holds is discarded.
//
// A board closed on its own is finished with. Every other way a board window
// ends — the window it came from closing, the app quitting — is it being put
// away, and it keeps its tabs and its frame so it comes back as it was. Both of
// those are already marked by the time a board's own close runs:
// markBoardsClosingWith sets retainBoard before it closes the boards going down
// with their opener, and a quit sets st.quitting before any window tears down.
func (a *appState) boardFinishedWith(e *winEntry) bool {
	if e == nil || e.board == "" {
		return false
	}
	finished := false
	a.reg(func(st *regState) { finished = !st.quitting && !e.retainBoard })
	return finished
}

// handleWindowClosed removes the closed window, stops its server when no other
// window still views it, and quits the app when no windows remain. Runs on the
// Wails WindowClosing goroutine.
func (a *appState) handleWindowClosed(e *winEntry) {
	// WindowClosing can arrive more than once for the same window: the close gate
	// re-issues the close it cancelled, and both of this window's listener
	// registrations answer the same event. Only the first tears the window down —
	// a repeat would close stopSave twice, which panics.
	if !a.claimClose(e) {
		return
	}
	// Authoritative final geometry write, while the window is still readable
	// (its native getters work until Wails' built-in listener destroys it) AND
	// the server is still up (we may stop it just below). A pending debounced
	// write may not have fired yet, so capture and post now; then stop the save
	// loop. currentWindowState no-ops if the window is already gone, leaving the
	// last good write intact.
	if s, ok := a.currentWindowState(e); ok {
		putWindowState(e.serverURL, e.role, s)
	}
	// A board closed on its own is a board the user is finished with, so its tabs
	// and its frame go with it. Waited on rather than left to a goroutine, and
	// kept up here beside the geometry write: everything this window still owes
	// the session is written before anything below can take the process down.
	if a.boardFinishedWith(e) {
		forgetBoard(e.serverURL, e.board)
	}
	close(e.stopSave)

	var orphanServer *exec.Cmd
	remaining := -1
	// The boards this window opened, which go with it.
	var boards []*winEntry
	a.reg(func(st *regState) {
		delete(st.windows, e.id)
		remaining = len(st.windows)
		boards = markBoardsClosingWith(st, e)
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
	for _, b := range boards {
		win := b.win
		application.InvokeAsync(func() { win.Close() })
	}
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

// armFlushWait registers a close-requested handshake for e and returns the token
// the page must quote back, plus the channel closed when it does. Returns an
// empty token when the window is no longer registered.
//
// A handshake already awaiting a reply is joined rather than replaced. Two
// callers can want the same window flushed at once — the gate closing that one
// window, and a quit sweeping every window — and the page can only answer what
// it was last told. Re-arming would raise the sequence number under the reply
// already on its way, so the answer would be refused as stale and the first
// waiter would spend the whole deadline waiting for a reply that had already
// come. Sharing the channel releases both on that one reply.
func (a *appState) armFlushWait(e *winEntry) (string, chan struct{}) {
	fresh := make(chan struct{})
	token := ""
	var done chan struct{}
	a.reg(func(st *regState) {
		w := st.windows[e.id]
		if w == nil {
			return
		}
		if w.flushDone == nil {
			w.flushSeq++
			w.flushDone = fresh
		}
		done = w.flushDone
		token = strconv.Itoa(w.flushSeq)
	})
	if token == "" {
		return "", nil
	}
	return token, done
}

// releaseFlushWait completes the handshake for e when token names the current
// announcement, unblocking whoever is waiting to close or quit. Anything else —
// a stale sequence number, a repeat of one already answered — is ignored: the
// waiter keeps waiting and eventually times out, which is the safe direction.
func (a *appState) releaseFlushWait(e *winEntry, token string) {
	a.reg(func(st *regState) {
		w := st.windows[e.id]
		if w == nil || w.flushDone == nil || token != strconv.Itoa(w.flushSeq) {
			return
		}
		close(w.flushDone)
		w.flushDone = nil
	})
}

// notifyWindowCloseRequested tells one webview that its native window is about to
// close, giving page-owned state a chance to flush before teardown. It returns
// the channel that closes once the page reports it has finished; the caller does
// the waiting, so several windows can flush concurrently.
//
// Nothing here can be inferred from ExecJS returning: it only schedules the
// script (ExecJS → InvokeSync → InvokeAsync → an async WKWebView evaluate), so
// the page's reply on /drafts-flushed is the only real evidence the flush ran.
func (a *appState) notifyWindowCloseRequested(e *winEntry) chan struct{} {
	if e == nil || e.win == nil {
		return nil
	}
	token, done := a.armFlushWait(e)
	if token == "" {
		return nil
	}
	application.InvokeAsync(func() {
		e.win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:window-close-requested'," +
			"{detail:{ackToken:'" + token + "'}}))")
	})
	return done
}

// notifyAllWindowsCloseRequested dispatches the close-requested lifecycle event
// to every live window and waits for them all to report back before returning,
// so app-wide termination can't outrun a page still writing its drafts to disk.
//
// Every window is notified first and waited on afterwards, against one shared
// deadline: the flushes are independent, so N windows should cost one timeout
// rather than N. On expiry we quit anyway — a draft in flight is a smaller loss
// than an app that won't close.
func (a *appState) notifyAllWindowsCloseRequested() {
	var wins []*winEntry
	a.reg(func(st *regState) { wins = sortedWindows(st) })

	waits := make(map[string]chan struct{}, len(wins))
	for _, e := range wins {
		if done := a.notifyWindowCloseRequested(e); done != nil {
			waits[e.id] = done
		}
	}

	deadline := time.Now().Add(closeFlushTimeout)
	for id, done := range waits {
		a.awaitFlush(id, done, deadline)
	}
}

// awaitFlush blocks until the page answers the handshake on done, or deadline
// passes. A nil channel means there was nothing to notify. Expiry is logged and
// tolerated: losing a draft still in flight beats refusing to close. Callers
// waiting on several windows share one deadline, so the whole set costs at most
// one timeout — an already-expired deadline returns immediately.
func (a *appState) awaitFlush(id string, done chan struct{}, deadline time.Time) {
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-time.After(time.Until(deadline)):
		logf("window %s did not confirm its draft flush; closing anyway", id)
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

// restorableSpecs is the open windows, in open order, that a next launch should
// bring back.
//
// Two kinds are left out. A URL window points at an externally-supplied or
// ephemeral address that won't be valid next launch (load() ignores them too).
// And a window is remembered as the project it views, which is not what a
// detached board is: two boards on two conversations of one project are one
// entry, and neither of them is the pin it was opened on. There is nothing here
// to restore a board from, rather than a preference not to.
//
// Must run on the registry goroutine.
func restorableSpecs(st *regState) []windowSpec {
	var specs []windowSpec
	for _, w := range sortedWindows(st) {
		if isBoardRole(w.role) || w.spec.isURL() {
			continue
		}
		specs = append(specs, w.spec)
	}
	return specs
}

// persistWorkspaceTo snapshots the open windows (in open order) and writes them
// as the workspace set. An empty set is never written — that keeps the last
// non-empty set on disk so closing the final window (which quits the app) still
// restores it next launch.
func (a *appState) persistWorkspaceTo(sync bool) {
	var specs []windowSpec
	a.reg(func(st *regState) { specs = restorableSpecs(st) })
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
