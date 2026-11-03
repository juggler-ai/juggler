//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"errors"
	"html/template"
	"io/fs"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"juggler/cmd/juggler/machineserver"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/webui"
	"juggler/internal/logpaths"
	"juggler/web"
)

// A window that cannot show what it is for shows a stand-in for it: a static
// page saying why, with buttons that post to this window's control endpoint. There is no server to serve it from — that is usually what is
// wrong — so the control endpoint serves it itself (serveStandIn), under the
// same window shell as the sessions page (web/shell/), whose header bar is
// what a frameless window is dragged, resized and closed by. The cases:
//
//   - a server by URL that does not answer (unreachable): Try again, or open a
//     local window instead;
//   - this machine's server, which could not be reached or started (failed):
//     Try again, or quit;
//   - this machine's server, or the window's session on it, gone under a live
//     window (lost): Try again, which finds or starts a server and reopens the
//     session — or, for a server this app did not start (one run in a
//     terminal), only finds it, with Start a server beside it;
//   - this machine's server running another version, in use — what a restart
//     would stop (machineserver.Occupancy) is listed (mismatch): Restart
//     server, or quit.
//
// A stand-in is a view (windowView), not a window. A window opened onto
// something that cannot be shown is built showing its stand-in; a window that
// loses what it shows shows its stand-in in place (showView), and its answer —
// Try again, Start a server, Restart server, Open a local window — shows what
// comes of it in that same window (retarget): the window keeps its id, its
// frame and its place in the workspace set throughout, filed under the spec
// it stands in for. Its frame is kept where that window's would be
// (frameHomeOf): on this machine for a server by URL, and nowhere for a local
// window, whose session is not there to keep it.

// The kinds of stand-in.
const (
	standInUnreachable = "unreachable"
	standInFailed      = "failed"
	standInLost        = "lost"
	standInMismatch    = "mismatch"
)

var (
	failedWindowTitle       = msg.New("Server didn't start — Juggler")
	failedPageTitle         = msg.New("Couldn't reach the Juggler server")
	lostWindowTitle         = msg.New("Server stopped — Juggler")
	lostPageTitle           = msg.New("The Juggler server stopped")
	stillNotRunning         = msg.New("The Juggler server still isn't running")
	startServerLabel        = msg.New("Start a server")
	startingLabel           = msg.New("Starting…")
	sessionLostTitle        = msg.New("This session stopped")
	disconnectedWindowTitle = msg.New("Disconnected — Juggler")
	disconnectedPageTitle   = msg.New("This window stopped reconnecting")
	mismatchWindowTitle     = msg.New("Server version — Juggler")
	mismatchPageTitle       = msg.New("Another version of the Juggler server is running")
	restartServerLabel      = msg.New("Restart server")
	restartingLabel         = msg.New("Restarting…")
	quitLabel               = msg.New("Quit")
)

// standInButton is one of a stand-in page's buttons: a form post to this
// window's control action.
type standInButton struct {
	label   msg.Message
	action  string
	primary bool
	// busy, when set, is what the button says once pressed, while the window
	// that answers it is on its way.
	busy *msg.Message
}

// standIn is what a stand-in window says in place of the window it stands in
// for. Immutable: a window that says something else shows another view
// (showView), and the pointer is what tells one stand-in from the next
// (standingIn).
type standIn struct {
	kind        string
	windowTitle msg.Message
	title       msg.Message
	// message is the explanation, one message per paragraph.
	message []msg.Message
	buttons []standInButton
	// held are the windows this one also holds the place of, opened once it
	// is answered: the rest of a launch that stopped at a version mismatch.
	held []windowSpec
	// mismatch is a version mismatch's: the servers, and what the page says a
	// restart stops — all the restart may stop (restartServer).
	mismatch *versionMismatchError
	// startedElsewhere is a stand-in for a window onto a server this app did
	// not start — one run in a terminal. Its Try again only looks for that
	// server (windowOpts.noStart); starting one is the page's other button.
	startedElsewhere bool
}

func retryButton() standInButton {
	return standInButton{label: unreachableRetry, action: "retry-server", primary: true, busy: &unreachableTrying}
}

func unreachableStandIn(serverURL string) *standIn {
	return &standIn{
		kind:        standInUnreachable,
		windowTitle: unreachableWindowTitle,
		title:       unreachablePageTitle,
		message:     []msg.Message{unreachableMessage(serverURL)},
		buttons:     []standInButton{retryButton(), {label: unreachableOpenLocal, action: "open-local"}},
	}
}

// failedStandIn stands in for a local window when this machine's server could
// not be reached or started, for whatever reason err gives: the error itself,
// and where the server's log is. The error is the app's own English, passed as
// a parameter rather than translated, as a log line would be.
func failedStandIn(err error) *standIn {
	return &standIn{
		kind:        standInFailed,
		windowTitle: failedWindowTitle,
		title:       failedPageTitle,
		message: []msg.Message{msg.New("Juggler could not reach or start the Juggler server on this computer.\n\n{error}\n\nIts log is in:\n{dir}",
			"error", err.Error(), "dir", logpaths.LogDir())},
		buttons: []standInButton{retryButton(), {label: quitLabel, action: "quit"}},
	}
}

// lostServerStandIn stands in for a local window whose server has gone.
func lostServerStandIn() *standIn {
	return &standIn{
		kind:        standInLost,
		windowTitle: lostWindowTitle,
		title:       lostPageTitle,
		message:     []msg.Message{msg.New("The Juggler server on this computer has stopped, and this window's session with it. Try again starts the server and opens the session again.")},
		buttons:     []standInButton{retryButton()},
	}
}

// lostElsewhereStandIn stands in for a local window whose server has gone when
// this app did not start it — someone ran it in a terminal — so Try again only
// looks for it, and starting one of the app's own is the user's choice. again
// is a Try again that found none.
func lostElsewhereStandIn(again bool) *standIn {
	title := lostPageTitle
	if again {
		title = stillNotRunning
	}
	return &standIn{
		kind:        standInLost,
		windowTitle: lostWindowTitle,
		title:       title,
		message:     []msg.Message{msg.New("This window's Juggler server was started outside this app, from a terminal, and is no longer running. Start it again there and press Try again, or press Start a server to have this app run one.")},
		buttons: []standInButton{
			retryButton(),
			{label: startServerLabel, action: "start-server", busy: &startingLabel},
		},
		startedElsewhere: true,
	}
}

// lostServerStandInFor is the stand-in for a local window whose server, proc,
// has gone: Try again starts the server again only if this app started it.
func lostServerStandInFor(proc serverProc) *standIn {
	if proc.appStarted {
		return lostServerStandIn()
	}
	return lostElsewhereStandIn(false)
}

// lostSessionStandIn stands in for a window whose session has stopped on a
// server that is still running, which this app started or (startedElsewhere)
// did not.
func lostSessionStandIn(project string, startedElsewhere bool) *standIn {
	return &standIn{
		kind:             standInLost,
		windowTitle:      lostWindowTitle,
		title:            sessionLostTitle,
		message:          []msg.Message{msg.New("The session for {project} has stopped. Try again opens it again.", "project", project)},
		buttons:          []standInButton{retryButton()},
		startedElsewhere: startedElsewhere,
	}
}

// disconnectedStandIn stands in for a local window whose reconnect the user
// stopped while its server and session, as far as the app can tell, are still
// there — or the server would not say. Try again only looks for a server this
// app did not start (startedElsewhere), as the other stand-ins' does.
func disconnectedStandIn(startedElsewhere bool) *standIn {
	return &standIn{
		kind:             standInLost,
		windowTitle:      disconnectedWindowTitle,
		title:            disconnectedPageTitle,
		message:          []msg.Message{msg.New("This window stopped trying to reconnect to the Juggler server on this computer. Try again reconnects it.")},
		buttons:          []standInButton{retryButton()},
		startedElsewhere: startedElsewhere,
	}
}

// mismatchStandIn stands in for a local window when this machine's server is
// another version than this app and in use: it says both versions and
// everything a restart stops, and offers the restart.
func mismatchStandIn(e *versionMismatchError) *standIn {
	message := []msg.Message{
		msg.New("This app is version {app}, and the Juggler server running on this computer is version {server}. Juggler uses a server only of its own version.",
			"app", e.app, "server", e.server),
	}
	if stops := e.occ.Stops(); len(stops) > 0 {
		message = append(message, msg.New("Restarting the server stops:"))
		message = append(message, stops...)
	}
	return &standIn{
		kind:        standInMismatch,
		windowTitle: mismatchWindowTitle,
		title:       mismatchPageTitle,
		message:     message,
		buttons: []standInButton{
			{label: restartServerLabel, action: "restart-server", primary: true, busy: &restartingLabel},
			{label: quitLabel, action: "quit"},
		},
		mismatch: e,
	}
}

// standInFor is the stand-in for a local window whose server could not be
// had: a version mismatch's when that is what err is, and otherwise a failed
// start's. Every failure gets one, so no window ever fails to open in silence.
func standInFor(err error) *standIn {
	if m, ok := asVersionMismatch(err); ok {
		return mismatchStandIn(m)
	}
	return failedStandIn(err)
}

// asVersionMismatch finds a versionMismatchError in err's chain.
func asVersionMismatch(err error) (*versionMismatchError, bool) {
	var e *versionMismatchError
	ok := errors.As(err, &e)
	return e, ok
}

// trParagraphs is the stand-in's explanation in the shell's UI language, a
// paragraph of its page per message.
func (a *appState) trParagraphs(ms []msg.Message) []string {
	parts := make([]string, 0, len(ms))
	for _, m := range ms {
		parts = append(parts, a.tr(m))
	}
	return parts
}

// pageSpecOf reports what the page in window id actually shows. A stand-in's
// page shows nothing it may act for — not the server by URL or the project it
// is filed under — so it is the zero spec with ok false. What a page may ask
// for is decided by this, not by the registry entry's spec.
func (a *appState) pageSpecOf(id string) (spec windowSpec, ok bool) {
	a.reg(func(st *regState) {
		if e := st.windows[id]; e != nil && e.view.standIn == nil {
			spec, ok = e.view.spec, true
		}
	})
	return spec, ok
}

// standInPageData is what a stand-in's page template (web/shell/stand-in.html)
// is drawn from: what the page says, in the UI language, and the window
// shell's fields (web/shell/window-shell.html).
type standInPageData struct {
	HTMLLang, UILocale string
	UICatalog          map[string]string
	Title              string
	Message            []string
	Buttons            []standInPageButton

	AssetBase, WailsBase, CSPNonce, Theme string
	IsWindow                              bool
}

// standInPageButton is one of the page's buttons: a form posting to Action,
// this window's control path for its action.
type standInPageButton struct {
	Label, Action, Busy string
	Primary             bool
}

// standInPageTemplates are the page's template and the window shell it shares
// with the sessions page, in web.Shell.
var standInPageTemplates = []string{"shell/stand-in.html", "shell/window-shell.html"}

// standInPageURL is the URL window id, holding secret, opens its stand-in
// page on: the control endpoint's, as a window onto a server is given it.
func (a *appState) standInPageURL(id, secret string) string {
	base := a.controlBase(id, secret)
	return base + "/page?window=1&nativeCtl=" + url.QueryEscape(base)
}

// serveStandIn answers a stand-in window's GETs, under the window's control
// path: its page (page), the window shell's files (shell/…, web.Shell, no
// templates), and the Wails runtime its header drags the window by. A page
// has no other server to load them from — that is usually what is wrong.
func (a *appState) serveStandIn(w http.ResponseWriter, r *http.Request, e *winEntry, si *standIn, sub string) {
	switch {
	case sub == "page":
		a.serveStandInPage(w, r, e, si)
	case sub == "wails/runtime.js":
		webui.ServeWailsRuntime(w, r)
	case strings.HasPrefix(sub, "shell/"):
		serveShellFile(w, r, strings.TrimPrefix(sub, "shell/"))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// serveShellFile serves rel from web.Shell: a file, never a directory or one
// of the templates the page is drawn from.
func serveShellFile(w http.ResponseWriter, r *http.Request, rel string) {
	if strings.HasSuffix(rel, ".html") || !fs.ValidPath(rel) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if info, err := fs.Stat(web.Shell, rel); err != nil || info.IsDir() {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	// A type of its own for each web asset, not the host's MIME database's.
	if ct := webui.ContentType(rel); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFileFS(w, r, web.Shell, rel)
}

// serveStandInPage draws si's page for window e, in the shell's UI language
// and the window's theme.
func (a *appState) serveStandInPage(w http.ResponseWriter, r *http.Request, e *winEntry, si *standIn) {
	tmpl, err := template.ParseFS(web.Shell, standInPageTemplates...)
	if err != nil {
		logf("stand-in page template: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	base := controlPath(e.id, a.viewOf(e).secret)
	// The secret is random hex, which makes a nonce as good as any.
	nonce := mintControlSecret()
	data := standInPageData{
		HTMLLang:  sourceLocale,
		Title:     a.tr(si.title),
		Message:   a.trParagraphs(si.message),
		AssetBase: base + "/shell",
		WailsBase: base,
		CSPNonce:  nonce,
		Theme:     normaliseTheme(a.windowTheme(e)),
		IsWindow:  r.URL.Query().Has("window"),
	}
	if cur := a.locale.Load(); cur != nil && cur.locale != sourceLocale {
		data.HTMLLang, data.UILocale, data.UICatalog = cur.locale, cur.locale, cur.catalog
	}
	for _, b := range si.buttons {
		pb := standInPageButton{Label: a.tr(b.label), Action: base + "/" + b.action, Primary: b.primary}
		if b.busy != nil {
			pb.Busy = a.tr(*b.busy)
		}
		data.Buttons = append(data.Buttons, pb)
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	// The page carries its window's secret.
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-"+nonce+"'; "+
		"style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; "+
		"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
	if err := tmpl.Execute(w, data); err != nil {
		logf("stand-in page: %v", err)
	}
}

// standInView is the view of a window standing in for spec with si.
func standInView(spec windowSpec, si *standIn) windowView {
	return windowView{spec: spec, standIn: si}
}

// standingIn is the showView guard for a stand-in's answer: the window still
// shows si, the stand-in that was answered.
func standingIn(si *standIn) func(windowView) bool {
	return func(now windowView) bool { return now.standIn == si }
}

// controlRetryServer is a stand-in's "Try again": another attempt at the window
// it stands in for, shown in its place — another stand-in if it still cannot
// be shown. For a server this app did not start, the attempt only looks for
// it. The page posts a form, which any reply with a body would replace, so it
// is answered 204.
func (a *appState) controlRetryServer(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	v := a.viewOf(e)
	if v.standIn == nil {
		w.WriteHeader(http.StatusConflict)
		return
	}
	a.retarget(e, standingIn(v.standIn), v.spec, windowOpts{noStart: v.standIn.startedElsewhere})
	w.WriteHeader(http.StatusNoContent)
}

// controlStartServer is "Start a server" on the stand-in for a server this app
// did not start: the window shows its session in the stand-in's place, on
// whatever server is running or on one this app starts. Answered 204, as Try
// again is.
func (a *appState) controlStartServer(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	v := a.viewOf(e)
	if v.standIn == nil || !v.standIn.startedElsewhere {
		w.WriteHeader(http.StatusConflict)
		return
	}
	a.retarget(e, standingIn(v.standIn), v.spec, windowOpts{})
	w.WriteHeader(http.StatusNoContent)
}

// controlRestartServer is a version mismatch's "Restart server": the server of
// the other version is stopped, every session with it, and the window shows
// its session in the stand-in's place, on the server this app starts — and the
// rest of the windows the stand-in held the place of open. A server that has
// come to hold more than the page said it would stop is left running, and the
// page is drawn again saying what it holds now.
func (a *appState) controlRestartServer(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	v := a.viewOf(e)
	si := v.standIn
	if si == nil || si.kind != standInMismatch || si.mismatch == nil {
		w.WriteHeader(http.StatusConflict)
		return
	}
	theme := a.windowTheme(e)
	go func() {
		err := a.restartServer(si.mismatch)
		if now, ok := asVersionMismatch(err); ok {
			again := mismatchStandIn(now)
			again.held = si.held
			a.showView(e, standingIn(si), standInView(v.spec, again), windowOpts{})
			return
		}
		if err != nil {
			logf("restart server: %v", err)
		}
		a.retarget(e, standingIn(si), v.spec, windowOpts{})
		for _, h := range si.held {
			a.openWindow(h, windowOpts{theme: theme})
		}
	}()
	w.WriteHeader(http.StatusNoContent)
}

// controlServerLost is a window's page saying it has been reconnecting for
// long enough to stop (see web/js/services/server-lost.js). The page's word is
// not taken for it, and the window moves on only when what it shows has
// certainly gone:
//
//   - onto a server by URL, only when the server answers, within
//     remoteReachBudget, that it has forgotten the window's session
//     (remoteSessionGone) — retired, as one left with no viewer is. Nothing
//     the page reconnects to will bring the session back, so the window shows
//     the server's page instead, still filed with the session's project,
//     which that page opens there again (controlReopen), as a launch would. A
//     server that does not answer is never given up on: it may yet, and the
//     page, still reconnecting, comes back with it;
//   - onto this machine's server, the session must be missing from the list of
//     the server process the window's page is served by (windowView.server),
//     or that process gone: no server there, one on its way out, or another in
//     its place. A server that is there but does not answer has not gone.
//
// With ?now, it is the user stopping the reconnect (the overlay's Stop
// trying), and the window shows its stand-in whatever the check finds: a
// server that answers the app is no use to a page it does not answer. What the
// stand-in says is still what the app found, where it found anything. A remote
// page can ask this too, which moves only its own window.
//
// Answered {replaced}: false leaves the page to its own reconnect. A stand-in
// already is one, a page the window no longer shows has been moved on already,
// and a board goes with the window that opened it; those are answered 409.
func (a *appState) controlServerLost(w http.ResponseWriter, r *http.Request, e *winEntry) {
	v := a.viewOf(e)
	spec := v.spec
	if v.standIn != nil || e.role != roleMain {
		w.WriteHeader(http.StatusConflict)
		return
	}
	now := r.URL.Query().Has("now")
	var lost *standIn
	if spec.isURL() {
		if !now {
			ctx, cancel := context.WithTimeout(r.Context(), remoteReachBudget)
			defer cancel()
			if remoteSessionGone(ctx, v.serverURL) {
				logf("window %s: %s has gone from its server; showing the server's page", e.id, v.serverURL)
				replaced := a.showView(e, showing(v), windowView{spec: spec, serverURL: spec.url}, windowOpts{}) != ""
				writeJSON(w, http.StatusOK, map[string]bool{"replaced": replaced})
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"replaced": false})
			return
		}
		lost = unreachableStandIn(spec.url)
	} else {
		lost = lostServerStandInFor(v.server)
		c, gone := a.serverOfWindow(v.server)
		if !gone {
			running, answered := a.sessionRunning(c, v.serverURL)
			switch {
			case answered && !running:
				lost = lostSessionStandIn(spec.project, !v.server.appStarted)
			case !now:
				writeJSON(w, http.StatusOK, map[string]bool{"replaced": false})
				return
			default:
				lost = disconnectedStandIn(!v.server.appStarted)
			}
		}
	}
	logf("window %s: %s lost; showing its stand-in", e.id, v.serverURL)
	if a.showView(e, showing(v), standInView(spec, lost), windowOpts{}) == "" {
		w.WriteHeader(http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"replaced": true})
}

// serverOfWindow finds proc, the server process a local window's page is
// served by: a client of it, or gone true when it has gone — no server there, one on its
// way out, or another process in its place. A server that cannot be told
// either way (it was reached but did not answer) is reported there, with a
// nil client whose sessions sessionRunning cannot read.
func (a *appState) serverOfWindow(proc serverProc) (c *machineserver.Client, gone bool) {
	if c := a.attachedClient(); c != nil && procOf(c) == proc {
		return c, false
	}
	found, err := machineserver.Connect(machineserver.ConnectOptions{ConfigDir: a.connectOpts.ConfigDir})
	switch {
	case err == nil:
		if procOf(found) == proc {
			return found, false
		}
		return nil, true
	case machineserver.ServerGoing(err):
		return nil, true
	default:
		return nil, false
	}
}

// sessionRunning reports whether the session serverURL shows (its project's
// link) is running on c's server, and whether the server answered (never, for
// a nil c). The server's own page is always there while the server is. The
// session is whichever the project has: one opened since the window's was is
// the window's too, as its page will find when it reconnects.
func (a *appState) sessionRunning(c *machineserver.Client, serverURL string) (running, answered bool) {
	mount, ok := sessionMountOf(serverURL)
	if !ok {
		return true, true
	}
	if c == nil {
		return false, false
	}
	list, err := c.ListSessions()
	if err != nil {
		return false, false
	}
	for _, s := range list {
		if strings.TrimSuffix(s.Link, "/") == mount {
			return s.State == machineserver.SessionRunning || s.State == machineserver.SessionRestarting, true
		}
	}
	return false, true
}

// sessionMountPath matches the end of a window's server URL that shows a
// session: its project's link, /p/<key>, or, on a server by URL older than
// project links, /s/<id>.
var sessionMountPath = regexp.MustCompile(`/(p/[a-z0-9-]+|s/[A-Za-z0-9_-]+)/?$`)

// sessionMountOf is where in a window's server URL its session is served,
// without the trailing slash, if the URL shows one.
func sessionMountOf(serverURL string) (string, bool) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return "", false
	}
	m := sessionMountPath.FindString(u.Path)
	if m == "" {
		return "", false
	}
	return strings.TrimSuffix(m, "/"), true
}

// controlOpenLocal is an unreachable server's way out: the window shows this
// machine's server's page in the stand-in's place, and is filed as that from
// then on rather than as the server it stood in for.
func (a *appState) controlOpenLocal(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	v := a.viewOf(e)
	if v.standIn == nil {
		w.WriteHeader(http.StatusConflict)
		return
	}
	a.retarget(e, standingIn(v.standIn), windowSpec{}, windowOpts{})
	w.WriteHeader(http.StatusNoContent)
}
