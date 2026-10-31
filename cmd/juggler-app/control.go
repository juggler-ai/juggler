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

	"juggler/cmd/juggler/machineserver"
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
// what authorises a request, and what it authorises is one window: each
// window's page is given a secret of its own (winEntry.ctlSecret), and a
// request acts only on the window whose secret it holds — the id in its path
// must name that same window. The secret is checked before anything else —
// method, routing, CORS — so a request without one learns nothing and is
// granted no origin.
//
// A window on a server by URL hands its secret to that server with every page
// load (in the request line, and to the page's script), so that server is
// trusted with nothing beyond what its page needs in its own window: the
// remote column of windowActions. Delivering the secret some other way would
// not change that, since the page's script must hold it to use it.

// listenControl binds the control endpoint to an OS-assigned loopback port.
func listenControl() (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:0")
}

// serveControl records the listener's loopback port (baked into window URLs as
// ?nativeCtl=, see controlBase), then starts handling control requests on ln.
// Call once, before building any window.
func (a *appState) serveControl(ln net.Listener) {
	a.ctlPort = ln.Addr().(*net.TCPAddr).Port
	go func() { _ = http.Serve(ln, http.HandlerFunc(a.handleControl)) }()
}

// mintControlSecret returns a random secret for one page load of one window:
// minted as the window is built, and again each time it is navigated in place
// (navigateWindow), so a secret never outlives the page it was given to.
func mintControlSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// A guessable secret would reopen the endpoint to every local page;
		// refusing to start is the lesser failure.
		panic("control secret: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// controlBase is the ?nativeCtl= value for window id holding secret: the base
// every page-side call appends its action to.
func (a *appState) controlBase(id, secret string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/%s/win/%s", a.ctlPort, secret, id)
}

// windowBySecret is the open window whose page holds secret, or nil, and
// whether that page is served by a server by URL (remotePage). Every window's
// secret is compared, in constant time, whichever matches.
func (a *appState) windowBySecret(secret string) (e *winEntry, remote bool) {
	a.reg(func(st *regState) {
		for _, w := range st.windows {
			if w.ctlSecret != "" && subtle.ConstantTimeCompare([]byte(secret), []byte(w.ctlSecret)) == 1 {
				e, remote = w, w.remotePage()
			}
		}
	})
	return e, remote
}

// remotePage is whether e's page was served by a server by URL — another
// machine's, as far as the app can know — rather than by this machine's server
// or by the app itself (a stand-in). Read on the registry goroutine.
func (e *winEntry) remotePage() bool {
	return e.standIn == nil && e.spec.isURL()
}

// handleControl admits a request only when its path opens with an open
// window's secret and it is a POST (or the CORS preflight for one), then
// dispatches /win/<id>/<action> for that window: the id must be the secret's
// window, the action one in windowActions, and one its page may ask for (the
// remote column). Anything without a secret is a bare 404 or 405 with no CORS
// headers, so a page that lacks one cannot read even that. A refused action is
// a 403 saying why.
func (a *appState) handleControl(w http.ResponseWriter, r *http.Request) {
	secret, rest, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	e, remote := a.windowBySecret(secret)
	if e == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodOptions {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if preflight(w, r) {
		return
	}
	setCORS(w, r)

	id, action, ok := strings.Cut(strings.TrimPrefix(rest, "win/"), "/")
	if !ok || !strings.HasPrefix(rest, "win/") || id != e.id {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	act, ok := windowActions[action]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if remote && (act.remote == nil || !act.remote(r)) {
		refusal := remoteWindowRefusal
		if act.refusal != nil {
			refusal = *act.refusal
		}
		writeJSON(w, http.StatusForbidden, map[string]any{"error": refusal.English(), "message": refusal})
		return
	}
	act.handle(a, w, r, e)
}

// remoteWindowRefusal is why a window on a server by URL is refused an action
// that is not its own window's (windowActions).
var remoteWindowRefusal = msg.New("This window shows a server on another computer, so Juggler will not do that for it.")

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

// windowAction handles /win/<id>/<action> for the window whose secret the
// request holds.
type windowAction func(a *appState, w http.ResponseWriter, r *http.Request, e *winEntry)

// controlAction is one action a page may post, and who may post it.
type controlAction struct {
	handle windowAction
	// remote is what a window on a server by URL (winEntry.remotePage) may ask
	// of it: nil for nothing, else which requests. Every other window — this
	// machine's server's pages and the app's own stand-ins — may ask for any.
	remote remoteGrant
	// refusal, when set, is what a remote window is told in place of
	// remoteWindowRefusal.
	refusal *msg.Message
}

// remoteGrant decides whether a window on a server by URL may make request r.
type remoteGrant func(r *http.Request) bool

// anyRequest grants a remote window every request for an action.
func anyRequest(*http.Request) bool { return true }

// boardOnly grants a remote window "new" for a detached board alone, which
// controlNewWindow opens on the asking window's own spec — the same server —
// whatever else the query names. A plain new window is this machine's server's
// page, and a project there is this machine's path.
func boardOnly(r *http.Request) bool { return windowOptsFromQuery(r.URL.Query()).isPinboard() }

// windowActions is every action a page may post, by the name it posts, and
// what a window on a server by URL may ask of it: the one place that is
// decided.
//
// What a remote window keeps, and why each is its own window's business or the
// user's own choice:
//   - theme, title, control, attention: its own native window's colour, name,
//     minimise/maximise/close/raise/fullscreen state and Dock bounce. (theme
//     also seeds the next window's bare-frame colour, from a fixed set.)
//   - drafts-flushed: its reply to a close or quit the app announced to it.
//   - attach, server-page: moving itself to a session of its own server, or
//     back to that server's page (attachRemote, controlServerPage).
//   - server-lost: its page giving up on its server; the app checks for itself
//     and replaces only this window, with a stand-in of its own.
//   - open: a link followed to the system browser, as a browser tab would;
//     http and https only (isBrowserURL).
//   - new, for a board only (boardOnly): another window onto the same server.
//   - save-file: what a browser download is — the user picks where in the
//     Save dialog, and the page learns only whether it was saved
//     (controlSaveFile).
//
// Refused it, as app-wide or on this machine's files: locale (the app's
// language and menus), zoom (the next window's zoom), folder-dropped,
// pick-directory and pick-file (they answer with a local path), updater,
// connect, quit, and the stand-in actions retry-server, start-server,
// restart-server and open-local, which no page of another server shows.
var windowActions = map[string]controlAction{
	"theme":          {handle: (*appState).controlTheme, remote: anyRequest},
	"title":          {handle: (*appState).controlTitle, remote: anyRequest},
	"control":        {handle: (*appState).controlWindowState, remote: anyRequest},
	"attention":      {handle: (*appState).controlAttention, remote: anyRequest},
	"drafts-flushed": {handle: (*appState).controlDraftsFlushed, remote: anyRequest},
	"attach":         {handle: (*appState).controlAttach, remote: anyRequest},
	"server-page":    {handle: (*appState).controlServerPage, remote: anyRequest},
	"server-lost":    {handle: (*appState).controlServerLost, remote: anyRequest},
	"open":           {handle: controlOpenURL, remote: anyRequest},
	"new":            {handle: (*appState).controlNewWindow, remote: boardOnly},
	"save-file":      {handle: (*appState).controlSaveFile, remote: anyRequest},
	"locale":         {handle: (*appState).controlLocale},
	"zoom":           {handle: (*appState).controlZoom},
	"folder-dropped": {handle: (*appState).controlFolderDropped},
	"pick-directory": {handle: func(a *appState, w http.ResponseWriter, r *http.Request, e *winEntry) {
		a.controlPickPath(w, r, e, "pick-directory")
	}},
	"pick-file": {handle: func(a *appState, w http.ResponseWriter, r *http.Request, e *winEntry) {
		a.controlPickPath(w, r, e, "pick-file")
	}},
	"updater":        {handle: (*appState).handleUpdaterControl},
	"connect":        {handle: (*appState).controlConnect, refusal: &connectFromURLWindowRefusal},
	"quit":           {handle: (*appState).controlQuit},
	"retry-server":   {handle: (*appState).controlRetryServer},
	"start-server":   {handle: (*appState).controlStartServer},
	"restart-server": {handle: (*appState).controlRestartServer},
	"open-local":     {handle: (*appState).controlOpenLocal},
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
//
// A window on a server by URL may ask for a board alone (boardOnly), which
// opens on its own server: the paths its page offers may be on another
// machine, and any other new window is this machine's.
func (a *appState) controlNewWindow(w http.ResponseWriter, r *http.Request, e *winEntry) {
	opts := windowOptsFromQuery(r.URL.Query())
	// What the asking page shows (pageSpecOf): a stand-in's shows nothing a
	// board could be a view of.
	if opts.isPinboard() {
		spec, ok := a.pageSpecOf(e.id)
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		opts.openedBy = e.id
		openNewWindow(a, spec, opts)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	a.openWindowForProject(r.URL.Query().Get("project"), opts)
	w.WriteHeader(http.StatusNoContent)
}

// openNewWindow opens the board controlNewWindow was asked for. A variable so a
// test can see which window it asked for without a native one.
var openNewWindow = (*appState).openWindow

// controlAttach shows a session in the window that asked, in place of the
// server's page it was showing: what choosing a folder or a session there
// does, after the page has opened the session (web/machine/sessions-view.js).
//
// On this machine's server the window becomes that project's window. Only a
// main window showing that server's page may ask (409 otherwise), and only for
// a session the server is running (404 otherwise).
//
// A window on a server by URL (another machine's) shows the session on that
// server and stays the server's window (attachRemote).
func (a *appState) controlAttach(w http.ResponseWriter, r *http.Request, e *winEntry) {
	page, ok := a.pageSpecOf(e.id)
	if ok && page.isURL() && e.role == roleMain {
		a.attachRemote(w, r, e, page)
		return
	}
	if !ok || page != (windowSpec{}) || e.role != roleMain {
		w.WriteHeader(http.StatusConflict)
		return
	}
	c := a.attachedClient()
	if c == nil || a.serverURLOf(e) != "http://"+c.Addr() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": attachNoServer.English(), "message": attachNoServer})
		return
	}
	id := r.URL.Query().Get("session")
	list, err := c.ListSessions()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	for _, s := range list {
		if s.ID == id && s.State == machineserver.SessionRunning {
			a.navigateWindow(e, windowSpec{project: s.Project}, strings.TrimSuffix(c.SessionURL(id), "/"))
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": attachNotRunning.English(), "message": attachNotRunning})
}

// attachRemote shows session ?session= of the window's server by URL in the
// window: its page has opened the session through that server's own control
// API, which this app holds no credential for, so the app only moves the
// window to /s/<id>/ there. The id must be one (normaliseID), so the page can
// send the window nowhere but a session of its own server. The window keeps
// its spec, so it reopens on the server's page.
func (a *appState) attachRemote(w http.ResponseWriter, r *http.Request, e *winEntry, spec windowSpec) {
	id := normaliseID(r.URL.Query().Get("session"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": attachNotRunning.English(), "message": attachNotRunning})
		return
	}
	a.navigateWindow(e, spec, strings.TrimRight(spec.url, "/")+"/s/"+id)
	w.WriteHeader(http.StatusNoContent)
}

// controlServerPage shows the window's server's sessions page in it again:
// Session ▸ Open… in a window on a server by URL, where another project is
// another session of that server. A window on this machine's server opens a
// new window for that instead (409 here).
func (a *appState) controlServerPage(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	page, ok := a.pageSpecOf(e.id)
	if !ok || !page.isURL() || e.role != roleMain {
		w.WriteHeader(http.StatusConflict)
		return
	}
	a.navigateWindow(e, page, page.url)
	w.WriteHeader(http.StatusNoContent)
}

var (
	attachNoServer   = msg.New("This window is not showing the Juggler server's page any more.")
	attachNotRunning = msg.New("That session is not running.")
)

// navigateWindow makes e the window for spec, showing serverURL, in place, and
// returns the page it loads. A window on a server by URL stays marked external.
// The page it loads holds a new secret, and the one the page it replaces held
// opens nothing any more.
func (a *appState) navigateWindow(e *winEntry, spec windowSpec, serverURL string) string {
	var opts windowOpts
	var secret string
	a.reg(func(st *regState) {
		e.spec, e.serverURL = spec, serverURL
		e.ctlSecret = mintControlSecret()
		secret = e.ctlSecret
		opts = windowOpts{theme: e.currentTheme, zoom: st.lastZoom, external: spec.isURL()}
	})
	logf("window %s: now %+v at %s", e.id, spec.entry(), serverURL)
	a.persistWorkspace()
	a.rememberRecentProject(spec.project)
	a.syncFileDrop(e, spec)
	page := windowPageURL(serverURL, a.controlBase(e.id, secret), opts)
	if e.win != nil {
		application.InvokeAsync(func() { e.win.SetURL(page) })
	}
	return page
}

// controlOpenURL hands a URL to the system browser. WebKit only auto-routes
// target="_blank" links to the default browser for external https URLs; a
// plain http://<lan-ip> link (a server's LAN address, say) is
// treated as an in-app popup request, which this windowless-popup app
// declines — so the page routes such clicks here instead.
func controlOpenURL(_ *appState, w http.ResponseWriter, r *http.Request, _ *winEntry) {
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

// controlTitle takes the page's title for its window, which names the window
// in the macOS "Window" menu (which lists windows by NSWindow title, else every
// window reads "Juggler") and in the Windows/Linux taskbar. What the window
// views is the app's own record (windowSpec), never the page's report.
func (a *appState) controlTitle(w http.ResponseWriter, r *http.Request, e *winEntry) {
	title := strings.TrimSpace(r.URL.Query().Get("title"))
	if title == "" {
		title = a.tr(appWindowTitle)
	}
	application.InvokeAsync(func() { e.win.SetTitle(title) })
	w.WriteHeader(http.StatusNoContent)
}

// controlFolderDropped takes the paths from a file drop on this window's native
// drag overlay. They are reported by the page because that is where the native
// side hands them over (see the bridge in web/machine/sessions-page.js), but nothing is
// decided there: which of them names a project needs the filesystem, and
// filling the window needs the other windows. Only a window with that overlay
// (takesFolderDrops) can have had a drop to report; any other is answered 409.
func (a *appState) controlFolderDropped(w http.ResponseWriter, r *http.Request, e *winEntry) {
	if spec, ok := a.pageSpecOf(e.id); !ok || !takesFolderDrops(spec) {
		w.WriteHeader(http.StatusConflict)
		return
	}
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
// Answers {"path": ...} with where it was written — only the suggested name, to
// a window on a server by URL — or "" when the user cancelled. Nothing is
// written unless the user chose a path in the dialog.
// A request that could never be written (see saveFileRequest) is refused before
// the dialog goes up.
func (a *appState) controlSaveFile(w http.ResponseWriter, r *http.Request, e *winEntry) {
	name, body, status := saveFileRequest(r)
	if status != http.StatusOK {
		w.WriteHeader(status)
		return
	}
	path, err := promptSaveFile(a, e, name)
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
	// A page another machine's server sent learns that the file was saved, as
	// a download would tell it, and not where on this machine: it is answered
	// with the name it suggested.
	var remote bool
	a.reg(func(*regState) { remote = e.remotePage() })
	if remote {
		path = name
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

// promptSaveFile shows the native Save dialog for e, suggesting name, and
// returns the path chosen, or "" when the user cancelled. A variable so a test
// can answer for the user without a native window.
var promptSaveFile = func(a *appState, e *winEntry, name string) (string, error) {
	dialog := a.app.Dialog.SaveFile().
		SetFilename(name).
		CanCreateDirectories(true).
		AttachToWindow(e.win)
	if dir := usableDirectory(a.pickerDirectory()); dir != "" {
		dialog = dialog.SetDirectory(dir)
	}
	return dialog.PromptForSingleSelection()
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
	// AppManagedServer is true when this window views this machine's server,
	// which the relaunched app restarts at its own version once it is free to
	// (see versionMismatchError). When false the window views a server by URL
	// — restarting the app won't update it, and the page scopes its messaging
	// accordingly (edge case 18).
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
		a.reg(func(*regState) { managed = e.standIn == nil && !e.spec.isURL() })
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
// the sessions running a turn, which the restart will stop (the exact tally
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
		if total := a.sessionsAQuitStops(); total > 0 {
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
