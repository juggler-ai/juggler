//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"juggler/cmd/juggler/msg"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The page is served by the (possibly remote) juggler server, so window-control
// requests (theme repaint, minimise/maximise/close, new window) can't go to
// that server — they target this loopback listener instead, addressed per
// window as /<secret>/win/<id>/<action>. The app bakes each window's base URL
// into its page as the ?nativeCtl= query param.
//
// Loopback is not a boundary on its own: any web page in any browser on this
// machine can POST to 127.0.0.1, and window ids are a counter. The secret is
// what authorises a request. It is minted per launch, travels only in the URLs
// of this app's own windows, and is checked before anything else — method,
// routing, CORS — so a request without it learns nothing and is granted no
// origin.

// listenControl binds the control endpoint to an OS-assigned loopback port.
func listenControl() (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:0")
}

// serveControl records the listener's loopback port and mints this launch's
// secret (both baked into window URLs as ?nativeCtl=, see controlBase), then
// starts handling control requests on ln. Call once, before building any
// window.
func (a *appState) serveControl(ln net.Listener) {
	a.ctlPort = ln.Addr().(*net.TCPAddr).Port
	a.ctlSecret = mintControlSecret()
	go func() { _ = http.Serve(ln, http.HandlerFunc(a.handleControl)) }()
}

// mintControlSecret returns a random secret for the control endpoint.
func mintControlSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// A guessable secret would reopen the endpoint to every local page;
		// refusing to start is the lesser failure.
		panic("control secret: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// controlBase is the ?nativeCtl= value for window id: the base every page-side
// call appends its action to.
func (a *appState) controlBase(id string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/%s/win/%s", a.ctlPort, a.ctlSecret, id)
}

// handleControl admits a request only when its path opens with this launch's
// secret and it is a POST (or the CORS preflight for one), then hands the rest
// of the path to handleWindowControl. Anything else is a bare 404 or 405 with
// no CORS headers, so a page that lacks the secret cannot read even that.
func (a *appState) handleControl(w http.ResponseWriter, r *http.Request) {
	secret, rest, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if !ok || a.ctlSecret == "" || subtle.ConstantTimeCompare([]byte(secret), []byte(a.ctlSecret)) != 1 {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodOptions {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/" + rest
	r2.URL.RawPath = ""
	a.handleWindowControl(w, r2)
}

// setCORS lets the page read the reply. It runs only behind handleControl,
// whose secret is what authorises the caller; the page's origin is whatever
// server it was loaded from, so it is echoed rather than listed.
func setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
}

func preflight(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodOptions {
		return false
	}
	setCORS(w, r)
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.WriteHeader(http.StatusNoContent)
	return true
}

// writeJSON answers with v as a JSON body and the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// windowAction handles /win/<id>/<action> for a window that exists.
type windowAction func(a *appState, w http.ResponseWriter, r *http.Request, e *winEntry)

// windowActions is every action addressed to an existing window, by the name
// the page posts. "new" and "open" are not here: neither needs the window to be
// one this app still has (see handleWindowControl).
var windowActions = map[string]windowAction{
	"theme":          (*appState).controlTheme,
	"title":          (*appState).controlTitle,
	"locale":         (*appState).controlLocale,
	"folder-dropped": (*appState).controlFolderDropped,
	"control":        (*appState).controlWindowState,
	"attention":      (*appState).controlAttention,
	"zoom":           (*appState).controlZoom,
	"drafts-flushed": (*appState).controlDraftsFlushed,
	"pick-directory": func(a *appState, w http.ResponseWriter, r *http.Request, e *winEntry) {
		a.controlPickPath(w, r, e, "pick-directory")
	},
	"pick-file": func(a *appState, w http.ResponseWriter, r *http.Request, e *winEntry) {
		a.controlPickPath(w, r, e, "pick-file")
	},
	"save-file":    (*appState).controlSaveFile,
	"updater":      (*appState).handleUpdaterControl,
	"connect":      (*appState).controlConnect,
	"stand-in":     (*appState).controlStandIn,
	"retry-server": (*appState).controlRetryServer,
	"open-local":   (*appState).controlOpenLocal,
	"quit":         (*appState).controlQuit,
}

// handleWindowControl dispatches /win/<id>/<action>, for a request
// handleControl has already authorised. The id selects the target window from
// the registry; an unknown action or window is a 404.
func (a *appState) handleWindowControl(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	setCORS(w, r)

	rest := strings.TrimPrefix(r.URL.Path, "/win/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[0] == "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	id, action := parts[0], parts[1]

	switch action {
	case "new":
		a.controlNewWindow(w, r, id)
		return
	case "open":
		controlOpenURL(w, r)
		return
	}

	handle, ok := windowActions[action]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	e := a.window(id)
	if e == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	handle(a, w, r, e)
}

// controlNewWindow opens another window, carrying whatever the caller handed
// over so the child's first paint and native chrome match the source window
// (see windowOpts).
//
// An ordinary new window doesn't need the originating one — it is told which
// project to open. A detached pinboard does, twice over: it is a view of a
// conversation in the asking window's project, so it opens on that window's
// own spec, which is what puts the two on one server; and it is remembered as
// that window's board, which is what takes it with the window when it closes.
//
// Taken with it, not closed by it. A board's own arrangement outlives its
// window closing this way — one left open on a conversation with work running
// in it is the reason to detach a board at all — and comes back when the
// window it belonged to does.
func (a *appState) controlNewWindow(w http.ResponseWriter, r *http.Request, id string) {
	opts := windowOptsFromQuery(r.URL.Query())
	// What the asking page shows, which for a stand-in is an empty window on a
	// server this app spawned (pageSpecOf).
	if opts.isPinboard() {
		spec, ok := a.pageSpecOf(id)
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		opts.openedBy = id
		a.openWindow(spec, opts)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	project := r.URL.Query().Get("project")
	// A window on a server this app did not start (--url) offers that
	// server's paths, which may be on another machine. Opening one here
	// would spawn a local server for a folder that is not here, so the page
	// is told to switch in place instead.
	if spec, ok := a.pageSpecOf(id); ok && spec.isURL() && project != "" {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":   urlWindowNewWindowRefusal.English(),
			"message": urlWindowNewWindowRefusal,
		})
		return
	}
	a.openWindowForProject(project, opts)
	w.WriteHeader(http.StatusNoContent)
}

// urlWindowNewWindowRefusal is why a window on a server by URL cannot open one
// of that server's projects in a new window (controlNewWindow).
var urlWindowNewWindowRefusal = msg.New("This window is connected to a server by URL, so its projects cannot open in a new window. Use Switch to open it here.")

// controlOpenURL hands a URL to the system browser. WebKit only auto-routes
// target="_blank" links to the default browser for external https URLs; a
// plain http://<lan-ip> link (e.g. the connectivity panel's LAN address) is
// treated as an in-app popup request, which this windowless-popup app
// declines — so the page routes such clicks here instead. No window needed.
func controlOpenURL(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	if !isBrowserURL(target) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if err := openInBrowser(target); err != nil {
		logf("open URL failed: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// controlTheme repaints the native window to the page's theme.
func (a *appState) controlTheme(w http.ResponseWriter, r *http.Request, e *winEntry) {
	pageTheme := r.URL.Query().Get("theme")
	colour, ok := a.setWindowTheme(e, pageTheme)
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if r.URL.Query().Get("mode") == "system" {
		// System mode: the OS light/dark setting is authoritative, and only
		// the native side can read it reliably — the WKWebView's
		// prefers-color-scheme is pinned by the window's forced appearance, so
		// the page's guessed theme can be stale. paintSystemChrome clears that
		// forced appearance (so the window follows the OS again) and reports
		// the resolved theme, which we echo back so the page can repaint.
		type chrome struct {
			colour application.RGBA
			theme  string
		}
		ch := make(chan chrome, 1)
		application.InvokeAsync(func() {
			c, t := paintSystemChrome(e.win, colour, normaliseTheme(pageTheme))
			e.win.SetBackgroundColour(c)
			ch <- chrome{c, t}
		})
		got := <-ch
		a.setWindowTheme(e, got.theme)
		writeJSON(w, http.StatusOK, map[string]string{"theme": got.theme})
		return
	}
	application.InvokeAsync(func() {
		// SetBackgroundColour is the cross-platform lever: it updates the stored
		// option (so the bare frame exposed during a live resize — and the
		// pre-paint fill — use the new colour) AND repaints the window
		// immediately. On Windows/Linux this is what makes a theme flip actually
		// update the window background, since applyWindowChrome is a no-op
		// there. On macOS applyWindowChrome then additionally repaints the
		// NSWindow appearance and traffic lights.
		e.win.SetBackgroundColour(colour)
		applyWindowChrome(e.win, colour)
	})
	w.WriteHeader(http.StatusNoContent)
}

// controlTitle takes the page's report of the project it's viewing. Two uses:
// the display title names the window in the macOS "Window" menu (which lists
// windows by NSWindow title, else every window reads "Juggler"); and the raw
// project path becomes the window's workspace identity, so a relaunch reopens
// the right project (projects are chosen in-page, so this report is the only
// way the app learns which one a window actually shows).
func (a *appState) controlTitle(w http.ResponseWriter, r *http.Request, e *winEntry) {
	// A stand-in names what it stands in for until a project is opened in it,
	// which setWindowProject below takes as its no longer standing in.
	project := r.URL.Query().Get("project")
	title := strings.TrimSpace(r.URL.Query().Get("title"))
	if _, si := a.standInOf(e); si != nil && strings.TrimSpace(project) == "" {
		title = a.tr(si.windowTitle)
	}
	if title == "" {
		title = a.tr(appWindowTitle)
	}
	application.InvokeAsync(func() { e.win.SetTitle(title) })
	a.setWindowProject(e, project)
	// The same report says whether this window is empty, which is the one
	// state that accepts a dropped folder.
	a.syncFileDrop(e, project)
	w.WriteHeader(http.StatusNoContent)
}

// controlFolderDropped takes the paths from a file drop on this window's native
// drag overlay. They are reported by the page because that is where the native
// side hands them over (see the bridge in no-project-overlay.js), but nothing is
// decided there: which of them names a project needs the filesystem, and
// filling the window needs the other windows.
func (a *appState) controlFolderDropped(w http.ResponseWriter, r *http.Request, e *winEntry) {
	a.openDroppedFolderInWindow(e, r.URL.Query()["path"])
	w.WriteHeader(http.StatusNoContent)
}

// controlWindowState minimises, maximises, closes, raises or leaves fullscreen.
// The reply reports the window's state after the action, which is how page
// chrome that mirrors it stays in step: the maximise/restore glyph
// (window-caption-controls.js) and the macOS traffic-light gutter
// (window-fullscreen.js), which a window restored straight into fullscreen has
// no event to learn about.
func (a *appState) controlWindowState(w http.ResponseWriter, r *http.Request, e *winEntry) {
	type windowState struct {
		Maximised  bool `json:"maximised"`
		Fullscreen bool `json:"fullscreen"`
	}
	done := make(chan windowState, 1)
	application.InvokeAsync(func() {
		switch r.URL.Query().Get("action") {
		case "minimise":
			e.win.Minimise()
		case "maximise":
			e.win.ToggleMaximise()
		case "unfullscreen":
			// Escape's last rung: the window hands the key to the page
			// (DisableEscapeExitsFullscreen), which asks for this only when
			// nothing in the page wanted the press.
			e.win.UnFullscreen()
		case "close":
			e.win.Close()
		case "raise":
			// Something in another window pointed at this one — a detached
			// pinboard revealing a thread, which is carried out here because
			// this is where the columns are. Un-minimise first: the window
			// the user is being sent to may be the one they put away.
			e.win.Restore()
			e.win.Show()
			e.win.Focus()
		}
		done <- windowState{Maximised: e.win.IsMaximised(), Fullscreen: e.win.IsFullscreen()}
	})
	writeJSON(w, http.StatusOK, <-done)
}

// controlAttention bounces the Dock icon once to pull the user back to a window
// that needs them (a tool awaiting approval, or a turn that just came to rest).
// The page only posts this for an unwatched window, so it never fires on the
// conversation the user is actively looking at.
func (a *appState) controlAttention(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	application.InvokeAsync(func() { e.win.Flash(true) })
	w.WriteHeader(http.StatusNoContent)
}

// controlZoom takes the page's UI zoom (root font-size %), reported on load and
// whenever the user changes it. It is tracked only as the cross-window
// inheritance seed (the next window built without an inherited zoom opens at
// this size) — no native window is touched, since zoom is a web-only root
// font-size.
func (a *appState) controlZoom(w http.ResponseWriter, r *http.Request, _ *winEntry) {
	zoom, _ := strconv.Atoi(r.URL.Query().Get("zoom"))
	a.setWindowZoom(zoom)
	w.WriteHeader(http.StatusNoContent)
}

// controlQuit is the page's Exit/Quit command: the whole app, every window,
// taken down by the same path as the app menu's Quit, so the full window set is
// what the next launch restores. Windows and Linux windows show no native menu
// to carry that command, so the page offers it. It answers at once — the busy
// confirmation may still be on screen, and the window that asked is about to
// close — and does nothing when a quit is already under way.
func (a *appState) controlQuit(w http.ResponseWriter, _ *http.Request, _ *winEntry) {
	var quitting bool
	a.reg(func(st *regState) { quitting = st.quitting })
	if !quitting {
		startQuit(a)
	}
	w.WriteHeader(http.StatusNoContent)
}

// startQuit begins an app-wide quit off the caller's goroutine. A variable so a
// test can see it was asked for without quitting anything.
var startQuit = func(a *appState) { go a.confirmThenQuit() }

// controlDraftsFlushed is the page's reply to a close-requested announcement:
// its composer drafts are rescued and the affected conversations are on disk,
// so the pending close/quit may proceed. Unlike every other action this is a
// reply to something the app asked, so it only counts when it quotes the token
// from that announcement — a reply to an earlier one must not release a later
// one. Always 204: the page has nothing to do about a mismatch, and the waiter
// times out on its own.
func (a *appState) controlDraftsFlushed(w http.ResponseWriter, r *http.Request, e *winEntry) {
	a.releaseFlushWait(e, r.URL.Query().Get("token"))
	w.WriteHeader(http.StatusNoContent)
}

// controlPickPath runs the native chooser for the in-page path pickers, as a
// sheet on the requesting window, and returns the chosen absolute path (empty
// string on cancel). Browser clients have no native host and never reach here —
// they keep using the text path input.
//
// The project picker wants a folder and nothing else. Everything else that asks
// for a path — pinning a file, adding one to the context — accepts a directory
// just as readily, so pick-file takes either rather than refusing half of what
// the typed path allows. Only macOS can offer both at once; GTK and the Windows
// common item dialog have a file mode and a folder mode, and a dialog that will
// take a file gets the file one there. The title is the caller's, since it is
// the same sentence the panel above it is already saying.
func (a *appState) controlPickPath(w http.ResponseWriter, r *http.Request, e *winEntry, action string) {
	files, title, dir := pickerOptions(action, r.URL.Query().Get("title"), a.tr(defaultPickerTitle), r.URL.Query().Get("dir"), a.pickerDirectory())
	dialog := a.app.Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(files).
		CanCreateDirectories(!files).
		SetTitle(title).
		AttachToWindow(e.win)
	// Only when there is somewhere worth starting. Left unset, the platform
	// opens wherever it feels like — for GTK, which remembers nothing, that
	// is the working directory this app was launched from.
	if dir != "" {
		dialog = dialog.SetDirectory(dir)
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		logf("%s picker failed: %v", action, err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	// Remember where that came from, so the next chooser opens where this
	// one left off instead of starting over. A cancelled chooser reports
	// nothing and moves nothing.
	if path != "" {
		a.setPickerDirectory(filepath.Dir(path))
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

// maxSaveFileBytes caps what save-file will take from a page. An exported
// conversation with every image inlined is the largest thing that asks; a body
// past this is refused before any dialog is shown.
const maxSaveFileBytes = 64 << 20

// controlSaveFile saves what the page hands over to a file the user chooses: the
// native Save dialog, as a sheet on the requesting window, suggesting the name
// the page proposed, then the bytes written exactly as sent. The WebView has no
// download handling of its own, so this is how a page in the desktop app puts a
// file on disk; a browser client has no native host, never reaches here, and
// downloads instead.
//
// Answers {"path": ...} with where it was written, or "" when the user cancelled.
// A request that could never be written (see saveFileRequest) is refused before
// the dialog goes up.
func (a *appState) controlSaveFile(w http.ResponseWriter, r *http.Request, e *winEntry) {
	name, body, status := saveFileRequest(r)
	if status != http.StatusOK {
		w.WriteHeader(status)
		return
	}
	dialog := a.app.Dialog.SaveFile().
		SetFilename(name).
		CanCreateDirectories(true).
		AttachToWindow(e.win)
	if dir := usableDirectory(a.pickerDirectory()); dir != "" {
		dialog = dialog.SetDirectory(dir)
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		logf("save-file dialog failed: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if path == "" {
		writeJSON(w, http.StatusOK, map[string]string{"path": ""})
		return
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		logf("save-file write failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.setPickerDirectory(filepath.Dir(path))
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

// saveFileRequest reads a save-file request: the suggested file name from
// ?name= — its last path element only, whichever separator the page used, so a
// name can never point the dialog somewhere — and the body, which is the file.
// A missing name or body is 400 and a body past maxSaveFileBytes is 413; the
// status is 200 when there is something to save.
func saveFileRequest(r *http.Request) (name string, body []byte, status int) {
	name = strings.TrimSpace(r.URL.Query().Get("name"))
	name = strings.TrimSpace(name[strings.LastIndexAny(name, `/\`)+1:])
	if name == "" || name == "." || name == ".." {
		return "", nil, http.StatusBadRequest
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxSaveFileBytes+1))
	if err != nil {
		return "", nil, http.StatusBadRequest
	}
	if len(body) > maxSaveFileBytes {
		return "", nil, http.StatusRequestEntityTooLarge
	}
	if len(body) == 0 {
		return "", nil, http.StatusBadRequest
	}
	return name, body, http.StatusOK
}

// pickerOptions decides what a path chooser offers, from the action that asked
// for it and the title the page supplied.
//
// The project picker takes a folder and nothing else, and is the one chooser
// that creates directories — you open a project by making a folder for it. A
// chooser asked for a file takes either: a file pin and a file context item both
// accept a directory, so Browse must reach everything the typed path does or it
// is a lesser way of answering the same question. An untitled request gets
// defaultTitle, the project picker's wording (defaultPickerTitle) in the UI
// language.
//
// Where the chooser opens is decided here too, from two candidates. The place
// this app last picked from wins: a chooser that reopens where you were beats
// one that starts over every time, and it is the only such memory there is — of
// the three platforms only macOS and Windows keep one, and naming a start
// directory, which a file chooser always does, discards it. The caller's
// suggestion is the fallback, and stands for the first pick of a run. The
// project picker offers none: it is being asked where a new project is, and
// nothing about the open one predicts that.
//
// Either candidate is taken only when it is an absolute path to a directory that
// exists — a stale or misspelt one is dropped rather than passed on, since a
// chooser that opens somewhere is better than one that refuses to.
func pickerOptions(action, rawTitle, defaultTitle, rawDir, lastDir string) (files bool, title, dir string) {
	title = strings.TrimSpace(rawTitle)
	if title == "" {
		title = defaultTitle
	}
	dir = usableDirectory(lastDir)
	if dir == "" && action == "pick-file" {
		dir = usableDirectory(rawDir)
	}
	return action == "pick-file", title, dir
}

// defaultPickerTitle titles a chooser the page asked for without a title.
var defaultPickerTitle = msg.New("Open project folder")

// usableDirectory returns the path if it is an absolute one naming a directory
// that is there, and "" otherwise.
func usableDirectory(path string) string {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return ""
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		return ""
	}
	return path
}

// updaterStateResponse is the JSON the page reads from op=state: the global
// updater snapshot plus a per-window flag it can only be answered here, since it
// depends on which window (hence which server) asked — see appManagedServer.
type updaterStateResponse struct {
	UpdaterSnapshot
	// AppManagedServer is true when this window's server was spawned by this app
	// (recorded in st.servers), and so will be replaced by a bundle swap +
	// relaunch. When false the window views a server the app did not start (a
	// terminal/URL/LAN server) — restarting the app won't update it, and the
	// page scopes its messaging accordingly (edge case 18).
	AppManagedServer bool `json:"appManagedServer"`
}

// handleUpdaterControl serves /win/<id>/updater?op=state|install|check|restart.
// state reports the updater snapshot merged with this window's app-managed-server
// flag; install kicks the download/stage flow; check runs a check-only probe
// (reveal availability, never download); restart relaunches into a staged
// update, guarded by the same in-flight-turn check as Cmd+Q. All ops are POST.
func (a *appState) handleUpdaterControl(w http.ResponseWriter, r *http.Request, e *winEntry) {
	switch r.URL.Query().Get("op") {
	case "state":
		snap := updaterSnapshot()
		var managed bool
		a.reg(func(st *regState) { _, managed = st.servers[e.serverURL] })
		writeJSON(w, http.StatusOK, updaterStateResponse{UpdaterSnapshot: snap, AppManagedServer: managed})
	case "install":
		// Fire-and-forget; the overlay guards against a double-start itself. The
		// page learns the outcome from the pushed snapshot, not this response.
		// auto=1 marks the page's own proactive kick rather than a click, so a
		// failure nobody asked to see stays in the log.
		go updaterInstall(r.URL.Query().Get("auto") != "1")
		w.WriteHeader(http.StatusNoContent)
	case "check":
		// Check-only probe: reveal availability without starting a download. The
		// page learns the outcome from the pushed snapshot, not this response.
		go updaterCheck()
		w.WriteHeader(http.StatusNoContent)
	case "restart":
		a.handleUpdaterRestart(w, r)
	default:
		w.WriteHeader(http.StatusBadRequest)
	}
}

// handleUpdaterRestart relaunches into the staged update. It first re-checks
// in-flight turns across every server the restart will stop (the exact tally
// confirmThenQuit does) and, unless force=1, returns 409 with the busy
// count so the page can confirm the discard and re-POST with force=1.
//
// CRITICAL sequencing: it authorises the quit (st.quitting + notify pages)
// BEFORE calling updaterRestart(). updaterRestart spawns the swap helper and
// then dispatches Host.Quit(); without a pre-authorised quit the shouldQuit hook
// would veto that quit and show its own native confirm — double-prompting, and
// worse, leaving the already-spawned helper alive to swap the bundle at whatever
// later moment the app eventually quits. On failure it un-authorises the quit so
// the app keeps running and the page can surface the reason.
func (a *appState) handleUpdaterRestart(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("force") != "1" {
		total := 0
		for _, u := range a.ownedServerURLs() {
			total += serverBusy(u)
		}
		if total > 0 {
			writeJSON(w, http.StatusConflict, map[string]any{
				"busy":        total,
				"message":     restartBusyMessage(total).English(),
				"messageText": restartBusyMessage(total),
			})
			return
		}
	}

	// Authorise the quit before the updater dispatches it (see the doc comment).
	// notifyAllWindowsCloseRequested also flushes page-owned workspace state so
	// windows/projects restore after the relaunch.
	a.reg(func(st *regState) { st.quitting = true })
	a.notifyAllWindowsCloseRequested()

	if err := updaterRestart(); err != nil {
		// Restart failed — nothing was relaunched. Roll back the authorisation so
		// the app stays runnable and hand the reason to the page.
		a.reg(func(st *regState) { st.quitting = false })
		logf("updater: restart: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
