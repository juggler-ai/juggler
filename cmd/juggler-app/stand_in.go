//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"html"
	"net/http"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
	"juggler/cmd/juggler/msg"
	"juggler/internal/logpaths"
	"juggler/internal/windowgeom"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// A window that cannot show what it is for opens as a stand-in for it: a
// static page saying why, with buttons that post to this window's control
// endpoint. There is no server to serve it from — that is usually what is
// wrong — so it travels as a data URL (standInPage). The cases:
//
//   - a server by URL that does not answer (unreachable): Try again, or open a
//     local window instead;
//   - this machine's server, which could not be reached or started (failed):
//     Try again, or quit;
//   - this machine's server, or the window's session on it, gone under a live
//     window (lost): Try again, which finds or starts a server and reopens the
//     session;
//   - this machine's server running another version, in use — what a restart
//     would stop (machineserver.Occupancy) is listed (mismatch): Restart
//     server, or quit.
//
// A stand-in is filed under the spec it stands in for, so it keeps that
// window's place in the workspace set, and its frame is kept where that
// window's would be: on this machine for a server by URL, and nowhere for a
// local window, whose session is not there to keep it.

// The kinds of stand-in.
const (
	standInUnreachable = "unreachable"
	standInFailed      = "failed"
	standInLost        = "lost"
	standInMismatch    = "mismatch"
)

var (
	failedWindowTitle   = msg.New("Server didn't start — Juggler")
	failedPageTitle     = msg.New("Couldn't reach the Juggler server")
	lostWindowTitle     = msg.New("Server stopped — Juggler")
	lostPageTitle       = msg.New("The Juggler server stopped")
	sessionLostTitle    = msg.New("This session stopped")
	mismatchWindowTitle = msg.New("Server version — Juggler")
	mismatchPageTitle   = msg.New("Another version of the Juggler server is running")
	restartServerLabel  = msg.New("Restart server")
	restartingLabel     = msg.New("Restarting…")
	quitLabel           = msg.New("Quit")
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
// for. Immutable: a change replaces the winEntry's pointer, on the registry
// goroutine.
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

// lostSessionStandIn stands in for a window whose session has stopped on a
// server that is still running.
func lostSessionStandIn(project string) *standIn {
	return &standIn{
		kind:        standInLost,
		windowTitle: lostWindowTitle,
		title:       sessionLostTitle,
		message:     []msg.Message{msg.New("The session for {project} has stopped. Try again opens it again.", "project", project)},
		buttons:     []standInButton{retryButton()},
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

// trParagraphs is the stand-in's explanation in the shell's UI language, as
// one block of text, for its page.
func (a *appState) trParagraphs(ms []msg.Message) string {
	parts := make([]string, 0, len(ms))
	for _, m := range ms {
		parts = append(parts, a.tr(m))
	}
	return strings.Join(parts, "\n\n")
}

// standInOf reports the spec window e stands in for and what it says, or a nil
// standIn when e is an ordinary window. Read on the registry goroutine.
func (a *appState) standInOf(e *winEntry) (windowSpec, *standIn) {
	var spec windowSpec
	var si *standIn
	a.reg(func(*regState) { spec, si = e.spec, e.standIn })
	return spec, si
}

// pageSpecOf reports what the page in window id actually shows. A stand-in's
// page shows nothing it may act for — not the server by URL or the project it
// is filed under — so it is the zero spec with ok false. What a page may ask
// for is decided by this, not by the registry entry's spec.
func (a *appState) pageSpecOf(id string) (spec windowSpec, ok bool) {
	a.reg(func(st *regState) {
		if e := st.windows[id]; e != nil && e.standIn == nil {
			spec, ok = e.spec, true
		}
	})
	return spec, ok
}

// standInPageText is what a stand-in's page says, in the UI language, and the
// control endpoint of the window showing it.
type standInPageText struct {
	title, message string
	buttons        []standInPageButton
	controlBase    string
}

type standInPageButton struct {
	label, action, busy string
	primary             bool
}

// standInPage renders a stand-in's page as a data URL: there is no server to
// serve it from. Its buttons are plain form posts to this window's control
// endpoint, which need no script and no CORS — the script only says the press
// is under way, since the window that answers it replaces this one.
func standInPage(p standInPageText) string {
	t := html.EscapeString(p.title)
	var buttons strings.Builder
	for _, b := range p.buttons {
		onsubmit := ""
		if b.busy != "" {
			onsubmit = ` onsubmit="` + html.EscapeString("var b=this.querySelector('button');b.disabled=true;b.textContent="+jsString(b.busy)) + `"`
		}
		class := ""
		if b.primary {
			class = ` class="primary"`
		}
		buttons.WriteString(`<form method="post" action="` + html.EscapeString(p.controlBase+"/"+b.action) + `"` + onsubmit + `>` +
			`<button type="submit"` + class + `>` + html.EscapeString(b.label) + `</button></form>`)
	}
	doc := `<!doctype html><meta charset="utf-8"><title>` + t + `</title>` +
		`<style>body{margin:0;padding:48px;background:#0d1117;color:#e6edf3;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}` +
		`main{max-width:720px;margin:auto}h1{margin-top:0}pre{white-space:pre-wrap;font:inherit}` +
		`.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}form{margin:0}` +
		`button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#e6edf3;cursor:pointer}` +
		`button.primary{background:#238636;border-color:#2ea043}button:disabled{opacity:.6;cursor:default}</style>` +
		`<main><h1>` + t + `</h1><pre>` + html.EscapeString(p.message) + `</pre><div class="actions">` +
		buttons.String() + `</div></main>`
	// Base64, not percent-encoding. url.QueryEscape encodes for
	// application/x-www-form-urlencoded, where a space is "+" — a rule no
	// browser applies to a data URL, so every space arrives as a literal "+".
	// PathEscape leaves "?" unescaped and lets a stray "#" truncate the
	// document at the fragment. Base64 has no such characters to get wrong.
	return "data:text/html;charset=utf-8;base64," + base64.StdEncoding.EncodeToString([]byte(doc))
}

// standInPageFor is si's page, in the shell's UI language, for window id
// holding secret.
func (a *appState) standInPageFor(si *standIn, id, secret string) string {
	p := standInPageText{title: a.tr(si.title), message: a.trParagraphs(si.message), controlBase: a.controlBase(id, secret)}
	for _, b := range si.buttons {
		pb := standInPageButton{label: a.tr(b.label), action: b.action, primary: b.primary}
		if b.busy != nil {
			pb.busy = a.tr(*b.busy)
		}
		p.buttons = append(p.buttons, pb)
	}
	return standInPage(p)
}

// buildStandInWindow opens a native window onto si's page, registered under
// spec as a stand-in, so it keeps its place in the workspace set for as long as
// it is open. Must run on the main thread. A window onto a server by URL opens
// where that window was last left.
func (a *appState) buildStandInWindow(spec windowSpec, si *standIn, inheritedTheme string) *winEntry {
	logf("stand-in (%s) for %+v", si.kind, spec.entry())
	id := <-a.ids
	secret := mintControlSecret()
	startupTheme := normaliseTheme(inheritedTheme)
	if startupTheme == "" {
		a.reg(func(st *regState) { startupTheme = st.lastTheme })
	}
	bgTheme := startupTheme
	if bgTheme == "" {
		bgTheme = "dark"
	}
	var saved core.WindowState
	if spec.isURL() {
		saved, _ = a.remoteFrames.get(normalizeURL(spec.url), roleMain)
	}
	place := windowgeom.PlaceVisible(saved, a.app.Screen.GetAll())
	win := a.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            a.tr(si.windowTitle),
		URL:              a.standInPageFor(si, id, secret),
		Width:            place.Width,
		Height:           place.Height,
		MinWidth:         minWindowWidth,
		MinHeight:        minWindowHeight,
		X:                place.X,
		Y:                place.Y,
		InitialPosition:  place.Position,
		Screen:           place.Screen,
		StartState:       place.State,
		Hidden:           platformWindowHidden,
		Frameless:        platformFrameless,
		BackgroundColour: themeColours[bgTheme],
		Mac:              application.MacWindow{TitleBar: application.MacTitleBar{AppearsTransparent: true, HideTitle: true, HideToolbarSeparator: true, FullSizeContent: true}},
		Linux:            application.LinuxWindow{WebviewGpuPolicy: a.gpuPolicy},
		Windows:          application.WindowsWindow{DisableFramelessWindowDecorations: false},
	})
	if win == nil {
		fatalf("Window.NewWithOptions returned nil for stand-in window %s (%+v)", id, spec.entry())
	}
	e := &winEntry{id: id, win: win, ctlSecret: secret, spec: spec, standIn: si, role: roleMain, currentTheme: startupTheme,
		geom: windowgeom.NewTracker(windowgeom.Seed(place), a.app.Screen.GetAll), saves: windowgeom.NewDebouncer(), stopSave: make(chan struct{})}
	a.reg(func(st *regState) { st.windows[id] = e })
	a.persistWorkspace()
	go a.saveLoop(e)
	win.OnWindowEvent(events.Common.WindowDidMove, func(_ *application.WindowEvent) { e.triggerSave() })
	win.OnWindowEvent(events.Common.WindowDidResize, func(_ *application.WindowEvent) { e.triggerSave() })
	win.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) { a.handleWindowClosed(e) })
	return e
}

// openStandIn opens a stand-in for spec, which cannot be shown, in the place of
// opts.replaces when it names a window.
func (a *appState) openStandIn(spec windowSpec, si *standIn, opts windowOpts, why string) {
	application.InvokeAsync(func() {
		a.showOpened(a.buildStandInWindow(spec, si, opts.theme), opts, why)
	})
}

// controlRetryServer is a stand-in's "Try again": another attempt at the window
// it stands in for, which takes its place — another stand-in if it still
// cannot be shown. The page posts a form, which any reply with a body would
// replace, so it is answered 204.
func (a *appState) controlRetryServer(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	spec, si := a.standInOf(e)
	if si == nil {
		w.WriteHeader(http.StatusConflict)
		return
	}
	a.openWindow(spec, windowOpts{theme: a.windowTheme(e), replaces: e.id})
	w.WriteHeader(http.StatusNoContent)
}

// controlRestartServer is a version mismatch's "Restart server": the server of
// the other version is stopped, every session with it, and the window opens in
// the stand-in's place on the server this app starts — with the rest of the
// windows the stand-in held the place of. A server that has come to hold more
// than the page said it would stop is left running, and the page is drawn
// again saying what it holds now.
func (a *appState) controlRestartServer(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	spec, si := a.standInOf(e)
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
			a.openStandIn(spec, again, windowOpts{theme: theme, replaces: e.id}, "server in use")
			return
		}
		if err != nil {
			logf("restart server: %v", err)
		}
		a.openWindow(spec, windowOpts{theme: theme, replaces: e.id})
		for _, h := range si.held {
			a.openWindow(h, windowOpts{theme: theme})
		}
	}()
	w.WriteHeader(http.StatusNoContent)
}

// openLostServerStandIn opens the stand-in for a window whose server or
// session has gone, in that window's place. A variable so a test can see it
// asked for without a native window.
var openLostServerStandIn = func(a *appState, spec windowSpec, si *standIn, opts windowOpts) {
	a.openStandIn(spec, si, opts, "server lost")
}

// controlServerLost is a window's page saying it has been reconnecting for
// long enough to stop (see web/js/services/server-lost.js). The page's word is
// not taken for it, and the window is replaced by its stand-in only if what it
// shows has really gone:
//
//   - onto a server by URL, the server gets remoteReachBudget to answer the
//     app, as it would when the window opens;
//   - onto this machine's server, the session must be missing from the list of
//     the server process the window was opened on (winEntry.server), or that
//     process gone: no server there, one on its way out, or another in its
//     place. A server that is there but does not answer has not gone.
//
// Answered {replaced}: false leaves the page to its own reconnect. A stand-in
// already is one, a window already being replaced (claimReplacement) is as
// good as one, and a board goes with the window that opened it; those are
// answered 409.
func (a *appState) controlServerLost(w http.ResponseWriter, r *http.Request, e *winEntry) {
	var spec windowSpec
	var standing bool
	a.reg(func(*regState) { spec, standing = e.spec, e.standIn != nil || e.replacing })
	if standing || e.role != roleMain {
		w.WriteHeader(http.StatusConflict)
		return
	}
	theme := a.windowTheme(e)
	lost := lostServerStandIn()
	if spec.isURL() {
		ctx, cancel := context.WithTimeout(r.Context(), remoteReachBudget)
		defer cancel()
		if _, _, reached := readWindowState(ctx, normalizeURL(spec.url), roleMain); reached {
			writeJSON(w, http.StatusOK, map[string]bool{"replaced": false})
			return
		}
		lost = unreachableStandIn(spec.url)
	} else {
		c, gone := a.serverOfWindow(e)
		if !gone {
			running, answered := a.sessionRunning(c, a.serverURLOf(e))
			if running || !answered {
				writeJSON(w, http.StatusOK, map[string]bool{"replaced": false})
				return
			}
			lost = lostSessionStandIn(spec.project)
		}
	}
	if !a.claimReplacement(e) {
		w.WriteHeader(http.StatusConflict)
		return
	}
	logf("window %s: %s lost; opening its stand-in", e.id, a.serverURLOf(e))
	openLostServerStandIn(a, spec, lost, windowOpts{theme: theme, replaces: e.id})
	writeJSON(w, http.StatusOK, map[string]bool{"replaced": true})
}

// serverOfWindow finds the server process local window e was opened on: a
// client of it, or gone true when it has gone — no server there, one on its
// way out, or another process in its place. A server that cannot be told
// either way (it was reached but did not answer) is reported there, with a
// nil client whose sessions sessionRunning cannot read.
func (a *appState) serverOfWindow(e *winEntry) (c *machineserver.Client, gone bool) {
	if c := a.attachedClient(); c != nil && procOf(c) == e.server {
		return c, false
	}
	found, err := machineserver.Connect(machineserver.ConnectOptions{ConfigDir: a.connectOpts.ConfigDir})
	switch {
	case err == nil:
		if procOf(found) == e.server {
			return found, false
		}
		return nil, true
	case machineserver.ServerGoing(err):
		return nil, true
	default:
		return nil, false
	}
}

// sessionRunning reports whether the session serverURL shows (its /s/<id>
// path) is running on c's server, and whether the server answered (never, for
// a nil c). The server's own page is always there while the server is.
func (a *appState) sessionRunning(c *machineserver.Client, serverURL string) (running, answered bool) {
	id, ok := sessionIDOf(serverURL)
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
		if s.ID == id {
			return s.State == machineserver.SessionRunning || s.State == machineserver.SessionRestarting, true
		}
	}
	return false, true
}

// sessionIDOf is the session id in a window's server URL (…/s/<id>), if it
// names one.
func sessionIDOf(serverURL string) (string, bool) {
	i := strings.LastIndex(serverURL, "/s/")
	if i < 0 {
		return "", false
	}
	id := strings.Trim(serverURL[i+len("/s/"):], "/")
	return id, id != "" && !strings.Contains(id, "/")
}

// controlOpenLocal is an unreachable server's way out: an empty local window
// in the stand-in's place. That is what drops the server it stood in for from
// the workspace set, which a plain close of the last window would not (an
// empty set is never written, so the app would reopen it next launch).
func (a *appState) controlOpenLocal(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	if _, si := a.standInOf(e); si == nil {
		w.WriteHeader(http.StatusConflict)
		return
	}
	a.openWindow(windowSpec{}, windowOpts{theme: a.windowTheme(e), replaces: e.id})
	w.WriteHeader(http.StatusNoContent)
}
