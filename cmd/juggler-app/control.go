//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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
// window's page is given a secret of its own (windowView.secret), and a
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
// (showView), so a secret lasts no longer than the page it was given to — and
// that page lasts until the one replacing it has loaded (windowBySecret).
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
	return fmt.Sprintf("http://127.0.0.1:%d%s", a.ctlPort, controlPath(id, secret))
}

// controlPath is controlBase's path: what a page served from the control
// endpoint itself (a stand-in's) addresses its window by.
func controlPath(id, secret string) string {
	return "/" + secret + "/win/" + id
}

// replacedSecret is a secret of a page showView has replaced, judged as that
// page was: whether a server by URL served it, and whether it was the page
// framed in the window's (windowBySecret).
type replacedSecret struct {
	secret        string
	remote, frame bool
}

// maxReplacedSecrets bounds a window's replaced secrets when none of the pages
// after them ever loads. A navigation started before the last has loaded
// supersedes it, so the page on screen is the first of the run, and once the
// list is full the pages after it, which never loaded, are not added.
const maxReplacedSecrets = 4

// replacedSecretsOf are v's secrets, as replacedSecrets judged as v's page.
func replacedSecretsOf(v windowView) []replacedSecret {
	var out []replacedSecret
	if v.secret != "" {
		out = append(out, replacedSecret{secret: v.secret, remote: v.remotePage()})
	}
	if v.frameSecret != "" {
		out = append(out, replacedSecret{secret: v.frameSecret, remote: true, frame: true})
	}
	return out
}

// windowBySecret is the open window whose page holds secret, or nil, and
// whether that page is served by a server by URL: its own page on one
// (remotePage), or the page framed in it, which holds the window's frame
// secret (frame). Every window's secrets are compared, in constant time,
// whichever matches.
//
// A page showView has replaced holds a secret of the window's replaced list,
// and is judged as it was, whatever the window shows now; replaced says so.
// The current page's first use of its own secret, or its framed page's, is
// the proof it has loaded, and retires them all.
func (a *appState) windowBySecret(secret string) (e *winEntry, remote, frame, replaced bool) {
	match := func(s string) bool {
		return s != "" && subtle.ConstantTimeCompare([]byte(secret), []byte(s)) == 1
	}
	loaded := ""
	a.reg(func(st *regState) {
		for _, w := range st.windows {
			if match(w.view.secret) {
				e, remote, frame, replaced = w, w.view.remotePage(), false, false
				if len(w.replaced) > 0 {
					loaded = w.id
				}
				w.replaced = nil
			}
			if match(w.view.frameSecret) {
				e, remote, frame, replaced = w, true, true, false
				if len(w.replaced) > 0 {
					loaded = w.id
				}
				w.replaced = nil
			}
			for _, r := range w.replaced {
				if match(r.secret) {
					e, remote, frame, replaced = w, r.remote, r.frame, true
				}
			}
		}
	})
	if loaded != "" {
		logf("window %s: its new page has loaded; the pages it replaced hold no secret now", loaded)
	}
	return e, remote, frame, replaced
}

// handleControl admits a request only when its path opens with an open
// window's secret and it is a POST (or the CORS preflight for one), then
// dispatches /win/<id>/<action> for that window: the id must be the secret's
// window, the action one in windowActions, and one its page may ask for (the
// remote column). Anything without a secret is a bare 404 or 405 with no CORS
// headers, so a page that lacks one cannot read even that. A refused action is
// a 403 saying why.
//
// The one GET admitted is a stand-in's, under its own window's path, for the
// page this endpoint serves it and what that page loads (serveStandIn). It is
// same-origin, so it needs no CORS either. A replaced page's secret is never
// admitted a GET: the stand-in it would load from is the window's current one.
func (a *appState) handleControl(w http.ResponseWriter, r *http.Request) {
	secret, rest, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	e, remote, frame, replaced := a.windowBySecret(secret)
	if e == nil {
		// A page whose secret was retired — replaced in its window by one that
		// has since loaded — asking for its window: say so, without the secret.
		if strings.HasPrefix(rest, "win/") {
			logf("control: %s %s refused: no open window's page holds its secret", r.Method, rest)
		}
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && !replaced {
		if si := a.viewOf(e).standIn; si != nil {
			id, sub, ok := strings.Cut(strings.TrimPrefix(rest, "win/"), "/")
			if !ok || !strings.HasPrefix(rest, "win/") || id != e.id {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if _, isAction := windowActions[sub]; !isAction {
				a.serveStandIn(w, r, e, si, sub)
				return
			}
		}
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
	act.handle(a, w, r.WithContext(context.WithValue(r.Context(), callerKey{}, caller{remote: remote, frame: frame})), e)
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

// windowActions is every action a page may post, by the name it posts, and
// what a page a server by URL sent may ask of it: the one place that is
// decided. That is a window's own page on such a server, or the page framed
// in a window's sessions page, which holds its frame secret; the outer page
// is this machine's server's, and may ask for any.
//
// What a remote window keeps, and why each is its own window's business or the
// user's own choice:
//   - theme, title, control, attention: its own native window's colour, name,
//     minimise/maximise/close/raise/fullscreen state and Dock bounce. (theme
//     also seeds the next window's bare-frame colour, from a fixed set; a
//     framed page's theme does neither, controlTheme.)
//   - drafts-flushed: its reply to a close or quit the app announced to it.
//   - attach, server-page: moving itself to a session of its own server, or
//     back to that server's page (attachRemote, controlServerPage).
//   - reopen: the project of the session of its own server it showed when the
//     app last quit, which its page opens there again (controlReopen).
//   - server-lost: its page giving up on its server; the app checks for itself
//     — unless the user stopped it, with ?now — and replaces only this
//     window, with a stand-in of its own.
//   - open: a link followed to the system browser, as a browser tab would;
//     http and https only, and on macOS its Privacy & Security settings
//     (isOpenableURL).
//   - new: another window onto the same server — its page, or a board of one
//     of its conversations — whatever project the query names
//     (controlNewWindow).
//   - save-file: what a browser download is — the user picks where in the
//     Save dialog, and the page learns only whether it was saved
//     (controlSaveFile).
//   - quit: the Exit its header menu offers on Windows and Linux, as in any
//     other window. It goes no further than the window's own close does when
//     it is the last one: busy sessions are confirmed first (confirmThenQuit),
//     and the next launch restores every window.
//
// Refused it, as app-wide or on this machine's files: locale (the app's
// language and menus), zoom (the next window's zoom), folder-dropped,
// pick-directory and pick-file (they answer with a local path), updater,
// switch-server and discover (choosing another server to show), and the
// stand-in actions retry-server, start-server,
// restart-server and open-local, which no page of another server shows.
var windowActions = map[string]controlAction{
	"theme":          {handle: (*appState).controlTheme, remote: anyRequest},
	"title":          {handle: (*appState).controlTitle, remote: anyRequest},
	"control":        {handle: (*appState).controlWindowState, remote: anyRequest},
	"attention":      {handle: (*appState).controlAttention, remote: anyRequest},
	"drafts-flushed": {handle: (*appState).controlDraftsFlushed, remote: anyRequest},
	"attach":         {handle: (*appState).controlAttach, remote: anyRequest},
	"server-page":    {handle: (*appState).controlServerPage, remote: anyRequest},
	"reopen":         {handle: (*appState).controlReopen, remote: anyRequest},
	"server-lost":    {handle: (*appState).controlServerLost, remote: anyRequest},
	"open":           {handle: controlOpenURL, remote: anyRequest},
	"new":            {handle: (*appState).controlNewWindow, remote: anyRequest},
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
	"switch-server":  {handle: (*appState).controlSwitchServer, refusal: &connectFromURLWindowRefusal},
	"discover":       {handle: (*appState).controlDiscover, refusal: &connectFromURLWindowRefusal},
	"quit":           {handle: (*appState).controlQuit, remote: anyRequest},
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
// project to open, and may be told one of its conversations to open on
// (?conversation=, linkedOpts), as a project's page names it when the user
// picks a conversation of another project. One project has one window: when
// another main window already shows that project, it is raised at the
// conversation instead (raiseProjectWindow), answered {"raised":true}, and no
// window is opened. An empty window is never raised in place of a new one.
//
// A detached pinboard does need the originating window, twice over: it is a view of a
// conversation in the asking window's project, so it opens on that window's
// own spec, which is what puts the two on one server; and it is remembered as
// that window's board, which is what takes it with the window when it closes.
//
// Taken with it, not closed by it. A board's own arrangement outlives its
// window closing this way — one left open on a conversation with work running
// in it is the reason to detach a board at all — and comes back when the
// window it belonged to does.
//
// A window on a server by URL gets the same new window as any other, on its
// own server: that server's page, where the user picks one of its projects.
// The project the query names is not taken — it is a path on another machine,
// and any new window on this machine's server would be this machine's — so
// such a window can open windows onto nothing but the server it already shows.
// Nor are the theme, mode and zoom such a page hands over: they are that
// machine's, and the new window's header is this machine's sessions page,
// which wears this machine's own.
func (a *appState) controlNewWindow(w http.ResponseWriter, r *http.Request, e *winEntry) {
	opts := windowOptsFromQuery(r.URL.Query())
	if callerOf(r).remote && !opts.isPinboard() {
		opts.theme, opts.mode, opts.zoom = "", "", 0
	}
	// What the asking page shows (pageSpecOf): a stand-in's shows nothing a
	// board could be a view of.
	spec, ok := a.pageSpecOf(e.id)
	if opts.isPinboard() {
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		opts.openedBy = e.id
		openNewWindow(a, spec, opts)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if ok && spec.isURL() {
		openNewWindow(a, windowSpec{url: spec.url, connected: spec.connected}, opts)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// A project's window opens on the conversation the page names, as an
	// attach's does (linkedOpts) — or, when one is open already, is raised at
	// it.
	opts.linkedConversation = linkedOpts(r).linkedConversation
	project := windowSpec{project: r.URL.Query().Get("project")}
	if a.raiseProjectWindow(e, project, opts.linkedConversation) {
		writeJSON(w, http.StatusOK, map[string]any{"raised": true})
		return
	}
	openNewWindow(a, project, opts)
	w.WriteHeader(http.StatusNoContent)
}

// openNewWindow opens a window controlNewWindow was asked for on the asking
// window's server. A variable so a test can see which window it asked for
// without a native one.
var openNewWindow = (*appState).openWindow

// raiseWindow raises e, a window already showing the project a page picked,
// and tells its page to open conversation there when one is named: the
// project's page lands on it (juggler:open-conversation, app.js) as it would
// on a deep link. A variable so a test can see which window was raised
// without a native one.
var raiseWindow = func(e *winEntry, conversation string) {
	focusEntry(e)
	if conversation == "" || e.win == nil {
		return
	}
	application.InvokeAsync(func() {
		e.win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:open-conversation',{detail:{conversation:" +
			jsString(conversation) + "}}))")
	})
}

// controlAttach shows a session in the window that asked, in place of what it
// was showing: what choosing a folder or a session on a server's page does,
// after the page has opened the session (web/machine/sessions-view.js), and
// what picking one in a project window's Home does
// (web/js/services/project-navigation.js).
//
// A window belongs to its server and shows the server's page or one of its
// sessions. On this machine's server a main window — showing the server's page
// or a project's session — becomes the picked project's window. Only such a
// window may ask (409 otherwise: a board, a stand-in, or a page another
// process of the server served), and only for a session the server is running
// (404 otherwise).
//
// One project has one window. When another main window already shows the
// picked project, that window is raised instead, at the conversation named
// (raiseWindow), and the asking one stays as it was; the answer is
// {"raised":true}, so the page knows it was not replaced. A pick of the
// window's own project moves nothing (204).
//
// A window on a server by URL (another machine's) shows the session on that
// server and stays the server's window (attachRemote) — a framed one too,
// whichever of its pages asks: the outer page attaches nothing of this
// machine's server.
//
// Either way an attach may name one of the session's conversations,
// ?conversation=, which the session's page opens on (linkedOpts). An id that is
// not one is dropped, never a reason to refuse the attach.
func (a *appState) controlAttach(w http.ResponseWriter, r *http.Request, e *winEntry) {
	v := a.viewOf(e)
	if v.standIn == nil && v.spec.isURL() && e.role == roleMain {
		a.attachRemote(w, r, e, v)
		return
	}
	if v.standIn != nil || v.spec.isURL() || e.role != roleMain {
		w.WriteHeader(http.StatusConflict)
		return
	}
	c := a.attachedClient()
	if c == nil || !onAttachedServer(v, c) {
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
		if s.ID != id || s.State != machineserver.SessionRunning {
			continue
		}
		spec := windowSpec{project: s.Project}
		switch {
		case v.spec.sameView(spec):
			w.WriteHeader(http.StatusNoContent)
		case a.raiseProjectWindow(e, spec, linkedOpts(r).linkedConversation):
			writeJSON(w, http.StatusOK, map[string]any{"raised": true})
		default:
			a.showView(e, showing(v), windowView{spec: spec, serverURL: strings.TrimSuffix(c.SessionURL(s), "/"), server: v.server}, linkedOpts(r))
			w.WriteHeader(http.StatusNoContent)
		}
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": attachNotRunning.English(), "message": attachNotRunning})
}

// onAttachedServer is whether v's page is served by c's server: its address, and —
// where the window recorded one — the same process of it, since a server
// started after another takes the same port (serverProc).
func onAttachedServer(v windowView, c *machineserver.Client) bool {
	base := "http://" + c.Addr()
	if v.serverURL != base && !strings.HasPrefix(v.serverURL, base+"/") {
		return false
	}
	return v.server == (serverProc{}) || v.server.addr == c.Addr() && v.server.pid == c.PID
}

// raiseProjectWindow raises the main window other than e that shows spec, a
// local project, at conversation (raiseWindow), and reports whether there was
// one. A board shares its owner's project but is not that project's window.
func (a *appState) raiseProjectWindow(e *winEntry, spec windowSpec, conversation string) bool {
	if spec.project == "" {
		return false
	}
	var match *winEntry
	a.reg(func(st *regState) {
		best := -1
		for _, w := range st.windows {
			if w == e || w.role != roleMain || !w.view.spec.sameView(spec) {
				continue
			}
			// The oldest, so the same window answers every time.
			if n := winNum(w.id); match == nil || n < best {
				best, match = n, w
			}
		}
	})
	if match == nil {
		return false
	}
	raiseWindow(match, conversation)
	return true
}

// attachRemote shows the session the window's server by URL serves at
// ?link= in the window: its page has opened the session through that server's
// own control API, which this app holds no credential for, so the app only
// moves the window to the session's link there (remoteSessionPath). The window
// stays that server's, filed with the session's ?project=
// (windowSpec.remoteProject) so a next launch can open that project's session
// there again.
func (a *appState) attachRemote(w http.ResponseWriter, r *http.Request, e *winEntry, v windowView) {
	path, ok := remoteSessionPath(r.URL.Query())
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": attachNotRunning.English(), "message": attachNotRunning})
		return
	}
	spec := v.spec
	spec.remoteProject = strings.TrimSpace(r.URL.Query().Get("project"))
	a.showView(e, showing(v), windowView{spec: spec, serverURL: strings.TrimRight(spec.url, "/") + path}, linkedOpts(r))
	w.WriteHeader(http.StatusNoContent)
}

// linkedOpts is how an attach's session page opens: on the conversation the
// attach names, ?conversation=, when that is an id (normaliseID).
func linkedOpts(r *http.Request) windowOpts {
	return windowOpts{linkedConversation: normaliseID(r.URL.Query().Get("conversation"))}
}

// projectLinkPath is a project's link as a server names it, /p/<key>/
// (machineserver/projectlink.go).
var projectLinkPath = regexp.MustCompile(`^/p/[a-z0-9-]+/$`)

// remoteSessionPath is the path, without its trailing slash, at which a
// server by URL serves the session an attach names: ?link=, which must be a
// project's link, or — from the page of a server older than project links,
// which names none — /s/<?session=>, the id normalised (normaliseID). Either
// way the page can send the window nowhere but a session of its own server; a
// link that is not one is refused, never passed over for the id.
func remoteSessionPath(q url.Values) (string, bool) {
	if link := q.Get("link"); link != "" {
		if !projectLinkPath.MatchString(link) {
			return "", false
		}
		return strings.TrimSuffix(link, "/"), true
	}
	if id := normaliseID(q.Get("session")); id != "" {
		return "/s/" + id, true
	}
	return "", false
}

// controlServerPage shows the window's server's sessions page in it again, in
// place of the session it showed: Session ▸ Open… in a window on a server by
// URL, where another project is another session of that server, and Home's
// Show server page in any main window. On this machine's server the window is
// filed as an empty window from then on, and its page's server chooser
// (controlSwitchServer) can take it to another server.
//
// Only a main window showing a session may ask: one on a server by URL, or a
// local project's whose page the server the app is attached to served (409
// otherwise).
func (a *appState) controlServerPage(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	v := a.viewOf(e)
	if v.standIn != nil || e.role != roleMain {
		w.WriteHeader(http.StatusConflict)
		return
	}
	if v.spec.isURL() {
		a.showServerPage(e, v)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	c := a.attachedClient()
	if v.spec.project == "" || c == nil || !onAttachedServer(v, c) {
		w.WriteHeader(http.StatusConflict)
		return
	}
	logf("window %s: leaving %s for the server's page", e.id, v.spec.project)
	a.showView(e, showing(v), windowView{serverURL: "http://" + c.Addr(), server: procOf(c)}, windowOpts{})
	w.WriteHeader(http.StatusNoContent)
}

// controlReopen answers a window on a server by URL's sessions page with the
// project whose session the window showed when the app last quit
// ({"project": ...}, "" for none), which the page opens there again by its
// project — the session's id may not have outlived a restart of that server.
//
// It is handed over once: the window is filed as showing the server's page
// from then on, until the page attaches the session it opens, which files it
// again. A session that will not open leaves the window on the server's page,
// and that is what a next launch restores. A window on this machine's server
// reopens its project's session itself (resolveWindow), so it is refused (409),
// as is any window but a main one.
func (a *appState) controlReopen(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	page, ok := a.pageSpecOf(e.id)
	if !ok || !page.isURL() || e.role != roleMain {
		w.WriteHeader(http.StatusConflict)
		return
	}
	project := ""
	a.reg(func(*regState) {
		project = e.view.spec.remoteProject
		e.view.spec.remoteProject = ""
	})
	if project != "" {
		a.persistWorkspace()
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": project})
}

var (
	attachNoServer   = msg.New("This window is not showing the Juggler server's page any more.")
	attachNotRunning = msg.New("That session is not running.")
)

// showServerPage shows v's server by URL's sessions page in e — framed where
// it can be (framedPageView) — in place of whichever of its sessions e
// showed, provided e still shows v. Blocking.
func (a *appState) showServerPage(e *winEntry, v windowView) {
	spec := v.spec
	spec.remoteProject = ""
	a.showView(e, showing(v), a.framedPageView(spec, spec.url, true), windowOpts{})
}

// showView makes e show next, in place, provided what it shows now is what
// the caller decided on (from): the same webview, under the same id and at the
// same frame, wherever it is going — a session, its server's page, a stand-in,
// or back. It returns the page loaded, or "" when from said no, which is how
// two causes racing to move one window settle on one of them. opts says how
// the page opens beyond the window's own theme and the app's zoom: its notice,
// and the conversation it is linked to.
//
// The page loaded holds a new secret, and a framed one a new frame secret, so
// the ones the page it replaces held open nothing any more. The boards the window opened are put away with the
// page that opened them: kept (retainBoard), so the session's page, when the
// window shows it again, opens them again (restoreBoards), as a relaunch does.
//
// Nothing is flushed first (close_gate.go flushes for a close). A page whose
// server has gone has nowhere to flush drafts to; a page leaving a live
// session keeps the drafts it persisted when the user last stopped typing.
func (a *appState) showView(e *winEntry, from func(windowView) bool, next windowView, opts windowOpts) string {
	next.secret, next.frameSecret = mintControlSecret(), ""
	if next.framed != "" {
		next.frameSecret = mintControlSecret()
	}
	shown := false
	var boards []*winEntry
	a.reg(func(st *regState) {
		if st.windows[e.id] != e || !from(e.view) {
			return
		}
		// The page being replaced stays on screen until next's has loaded.
		if len(e.replaced) < maxReplacedSecrets {
			e.replaced = append(e.replaced, replacedSecretsOf(e.view)...)
		}
		e.view, shown = next, true
		boards = markBoardsClosingWith(st, e)
		opts = windowOpts{theme: e.currentTheme, zoom: st.lastZoom, notice: opts.notice, linkedConversation: opts.linkedConversation}
	})
	if !shown {
		return ""
	}
	if next.standIn != nil {
		logf("window %s: now the %s stand-in for %+v", e.id, next.standIn.kind, next.spec.entry())
	} else {
		logf("window %s: now %+v at %s", e.id, next.spec.entry(), next.serverURL)
		a.rememberRecentProject(next.spec.project)
	}
	a.persistWorkspace()
	a.syncFileDrop(e, next)
	page, title := a.pageOf(e.id, next, opts)
	if win := e.win; win != nil {
		application.InvokeAsync(func() {
			win.SetTitle(title)
			win.SetURL(page)
		})
	}
	for _, b := range boards {
		if win := b.win; win != nil {
			application.InvokeAsync(func() { win.Close() })
		}
	}
	viewShown(e, next, page)
	return page
}

// viewShown is told each view showView shows, and the page it loaded for it. A
// variable so a test can see a window move without a native one.
var viewShown = func(*winEntry, windowView, string) {}

// showing is the showView guard for a view decided on from v, read from the
// window: the window still shows that page.
func showing(v windowView) func(windowView) bool {
	return func(now windowView) bool { return now.secret == v.secret }
}

// retarget shows spec in e, in place, provided e still shows what from
// accepts. It plans spec off the caller's goroutine (planWindow), as opening a
// window onto it would, and shows what was planned: spec's page, or the
// stand-in for it when it still cannot be shown.
func (a *appState) retarget(e *winEntry, from func(windowView) bool, spec windowSpec, opts windowOpts) {
	go func() {
		p := a.planWindow(spec, opts)
		a.showView(e, from, p.view, p.opts)
	}()
}

// controlOpenURL hands a URL to the system browser. WebKit only auto-routes
// target="_blank" links to the default browser for external https URLs; a
// plain http://<lan-ip> link (a server's LAN address, say) is
// treated as an in-app popup request, which this windowless-popup app
// declines — so the page routes such clicks here instead. On macOS it opens
// the Privacy & Security settings too, which no WebView link can.
func controlOpenURL(_ *appState, w http.ResponseWriter, r *http.Request, _ *winEntry) {
	target := r.URL.Query().Get("url")
	if !isOpenableURL(target, runtime.GOOS) {
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
//
// A framed window's colour is its outer page's, this machine's theme: the page
// framed in it reports the other computer's, so its report repaints nothing
// and seeds no window. In system mode it is answered with the window's colour,
// which it repaints to, as the outer page does to the OS's.
func (a *appState) controlTheme(w http.ResponseWriter, r *http.Request, e *winEntry) {
	if callerOf(r).frame {
		if r.URL.Query().Get("mode") != "system" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var theme string
		a.reg(func(*regState) { theme = e.currentTheme })
		if theme == "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"theme": theme})
		return
	}
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
	if spec, ok := a.pageSpecOf(e.id); !ok || !takesFolderDrops(windowView{spec: spec}) {
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
	remote := callerOf(r).remote
	a.reg(func(*regState) { remote = remote || e.view.remotePage() })
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
		v := a.viewOf(e)
		managed := v.standIn == nil && (!v.spec.isURL() || v.framed != "")
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
// then dispatches Host.Quit(); without a pre-authorised quit the
// shouldQuitLater hook would hold that quit and show its own native confirm —
// double-prompting, and
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
