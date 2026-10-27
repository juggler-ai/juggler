//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"net/http"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/internal/logpaths"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// A window that cannot show what it is for — a server by URL that does not
// answer, a project whose lock is held by something that is not a Juggler
// session, or a server this app could not start — opens as a stand-in for it. A stand-in is an empty window's page,
// served by a private no-project server of its own, so it has the app's header
// bar, theme and window chrome like any other window. The page is told so by
// ?standIn= and asks this window's "stand-in" action what to say in place of
// its welcome panel.
//
// It is filed under the spec it stands in for, so it keeps that window's place
// in the workspace set, and its frame is kept where that window's would be: on
// this machine for a server by URL, and nowhere for a locked project, whose
// session cannot be reached. It stops standing in when it is retried into the
// real window, traded for an empty one, or has a project opened in it.
//
// When no local server can be started either, the window shows a static page
// instead (unreachableServerPage, lockedProjectPage), which still takes the
// same recovery actions.

// The kinds of stand-in, as the page names them in ?standIn=.
const (
	standInUnreachable = "unreachable"
	standInLocked      = "locked"
	standInFailed      = "failed"
)

var (
	failedWindowTitle = msg.New("Server didn't start — Juggler")
	failedPageTitle   = msg.New("Couldn't start the server")
)

// standIn is what a stand-in window says in place of the window it stands in
// for. Immutable: a change replaces the winEntry's pointer, on the registry
// goroutine.
type standIn struct {
	kind        string
	windowTitle msg.Message
	title       msg.Message
	// message is the explanation, one message per paragraph.
	message []msg.Message
}

func unreachableStandIn(serverURL string) *standIn {
	return &standIn{
		kind:        standInUnreachable,
		windowTitle: unreachableWindowTitle,
		title:       unreachablePageTitle,
		message:     []msg.Message{unreachableMessage(serverURL)},
	}
}

func lockedStandIn(e *lockedProjectError) *standIn {
	return &standIn{
		kind:        standInLocked,
		windowTitle: lockedWindowTitle,
		title:       lockedPageTitle,
		message:     e.adviceMessages(),
	}
}

// failedStandIn stands in for a window whose server could not be started, for
// whatever reason err gives: the error itself, and where that server's logs are.
// The error is the app's own English, passed as a parameter rather than
// translated, as a log line would be.
func failedStandIn(spec windowSpec, err error) *standIn {
	logs := logpaths.ProjectLogDir(spec.project)
	what := msg.New("Juggler could not start a server for this window.\n\n{error}\n\nIts logs are in:\n{dir}",
		"error", err.Error(), "dir", logs)
	if spec.project != "" {
		what = msg.New("Juggler could not start a server for {project}.\n\n{error}\n\nIts logs are in:\n{dir}",
			"project", spec.project, "error", err.Error(), "dir", logs)
	}
	return &standIn{
		kind:        standInFailed,
		windowTitle: failedWindowTitle,
		title:       failedPageTitle,
		message:     []msg.Message{what},
	}
}

// standInFor is the stand-in for a window whose server could not be resolved:
// a locked project's when that is what err is, and otherwise a failed start's.
// Every resolve failure gets one, so no window ever fails to open in silence.
func standInFor(spec windowSpec, err error) *standIn {
	if locked, ok := asLockedProject(err); ok {
		return lockedStandIn(locked)
	}
	return failedStandIn(spec, err)
}

// trParagraphs is the stand-in's explanation in the shell's UI language, as
// one block of text, for the static page.
func (a *appState) trParagraphs(ms []msg.Message) string {
	parts := make([]string, 0, len(ms))
	for _, m := range ms {
		parts = append(parts, a.tr(m))
	}
	return strings.Join(parts, "\n\n")
}

// standInOf reports the spec window e stands in for and what it says, or a nil
// standIn when e is an ordinary window. Read on the registry goroutine: both
// change when the window stops standing in.
func (a *appState) standInOf(e *winEntry) (windowSpec, *standIn) {
	var spec windowSpec
	var si *standIn
	a.reg(func(*regState) { spec, si = e.spec, e.standIn })
	return spec, si
}

// pageSpecOf reports what the page in window id actually shows, which for a
// stand-in is an empty window on a server this app spawned — not the server by
// URL or the locked project it is filed under. What the page may ask for is
// decided by this, not by windowSpecOf.
func (a *appState) pageSpecOf(id string) (windowSpec, bool) {
	var spec windowSpec
	var ok bool
	a.reg(func(st *regState) {
		if e := st.windows[id]; e != nil {
			ok = true
			if e.standIn == nil {
				spec = e.spec
			}
		}
	})
	return spec, ok
}

// standInHost is the local server a stand-in's page is served from — empty
// when none could be started — and the frame the window opens at.
type standInHost struct {
	serverURL string
	proc      *serverProc
	saved     core.WindowState
	hasSaved  bool
}

// prepareStandIn starts the private no-project server a stand-in for spec is
// served from, and waits for it to answer. Blocking, so never on the main
// thread. A window onto a server by URL opens where that window was last left;
// a locked project's frame is in its session, which cannot be reached.
func (a *appState) prepareStandIn(spec windowSpec) standInHost {
	serverURL, proc, err := windowSpec{}.resolve()
	if err != nil {
		logf("stand-in for %+v: no local server (%v); showing the static page", spec.entry(), err)
		return standInHost{}
	}
	h := standInHost{serverURL: serverURL, proc: proc}
	// Read for the wait, not the answer: it retries until the new server
	// accepts, so the page is not loaded from one that is not listening yet.
	fetchWindowState(serverURL, roleMain)
	if spec.isURL() {
		h.saved, h.hasSaved = a.remoteFrames.get(normalizeURL(spec.url), roleMain)
	}
	return h
}

// buildStandInWindow builds the stand-in for spec on host, or the static page
// when host has no server. Must run on the main thread. Only the appearance and
// the window it replaces carry over from opts: a stand-in is a main window,
// whatever the window it stands in for would have been.
func (a *appState) buildStandInWindow(spec windowSpec, si *standIn, host standInHost, opts windowOpts) *winEntry {
	logf("stand-in (%s) for %+v", si.kind, spec.entry())
	if host.serverURL == "" {
		if si.kind == standInLocked {
			return a.buildLockedProjectWindow(spec, si, opts.theme)
		}
		return a.buildUnreachableServerWindow(spec, si, opts.theme)
	}
	return a.buildWindow(spec, host.serverURL, host.proc, host.saved, host.hasSaved, windowOpts{
		theme:    opts.theme,
		mode:     opts.mode,
		zoom:     opts.zoom,
		replaces: opts.replaces,
		standIn:  si,
	})
}

// standInReply is the "stand-in" action's answer: what the page shows in place
// of its welcome panel. An empty kind means the window is not, or is no longer,
// a stand-in, and the page is an ordinary empty window.
type standInReply struct {
	Kind    string        `json:"kind"`
	Title   *msg.Message  `json:"title,omitempty"`
	Message []msg.Message `json:"message,omitempty"`
}

// controlStandIn tells the page what this window stands in for.
func (a *appState) controlStandIn(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	_, si := a.standInOf(e)
	if si == nil {
		writeJSON(w, http.StatusOK, standInReply{})
		return
	}
	title := si.title
	writeJSON(w, http.StatusOK, standInReply{Kind: si.kind, Title: &title, Message: si.message})
}

// resolveSpec resolves a spec to a server. A variable so a test can stand in
// for the spawn.
var resolveSpec = windowSpec.resolve

// controlRetryServer is a stand-in's "Try again": another attempt at the window
// it stands in for, which takes its place if it can be shown now.
//
// The stand-in's page asks with reply=1 and is answered {opened}: false leaves
// it standing, to say it still cannot, rather than opening a new stand-in in
// its place for every press. The static page posts a form, which any reply
// with a body would replace, so it is answered 204 and the attempt replaces it
// either way — another static page if nothing has changed, a stand-in if a
// local server can be started now.
func (a *appState) controlRetryServer(w http.ResponseWriter, r *http.Request, e *winEntry) {
	spec, si := a.standInOf(e)
	if si == nil {
		w.WriteHeader(http.StatusConflict)
		return
	}
	opts := windowOpts{theme: a.windowTheme(e), replaces: e.id}
	if r.URL.Query().Get("reply") == "" {
		a.openWindow(spec, opts)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"opened": a.retryStandIn(e, spec, opts)})
}

// retryStandIn opens the window e stands in for in its place if it can be shown
// now, reporting whether it did. A lock that is still held may have changed
// hands, and a server that still fails may fail differently, so the stand-in's
// explanation is brought up to date.
func (a *appState) retryStandIn(e *winEntry, spec windowSpec, opts windowOpts) bool {
	if spec.isURL() {
		ctx, cancel := context.WithTimeout(context.Background(), remoteReachBudget)
		defer cancel()
		if _, _, reached := readWindowState(ctx, normalizeURL(spec.url), roleMain); !reached {
			return false
		}
		a.openWindow(spec, opts)
		return true
	}
	serverURL, proc, err := resolveSpec(spec)
	if err != nil {
		si := standInFor(spec, err)
		a.reg(func(*regState) {
			if e.standIn != nil {
				e.standIn = si
			}
		})
		logf("retry %+v: %v", spec.entry(), err)
		return false
	}
	go a.openResolvedWindow(spec, serverURL, proc, opts)
	return true
}

// openLostServerStandIn opens the stand-in for a window whose server has gone,
// in that window's place. A variable so a test can stand in for the local
// server a stand-in starts.
var openLostServerStandIn = func(a *appState, spec windowSpec, si *standIn, opts windowOpts) {
	go a.openStandIn(spec, si, opts, "server lost")
}

// controlServerLost is a window onto a server by URL saying its page has been
// reconnecting for long enough to stop (see web/js/services/server-lost.js).
// The page's word is not taken for it: the server gets remoteReachBudget to
// answer the app, as it would when the window opens, and the window is
// replaced by the stand-in it would have opened as only if it does not. That
// stand-in is filed under the same server, so it keeps the window's place in
// the workspace set, and its Try again is the way back.
//
// Answered {replaced}: false leaves the page to its own reconnect, which a
// server that answers the app should let through soon. Only a main window onto
// a server by URL has such a stand-in: a project window's server is this app's
// to restart, a stand-in already is one, and a stand-in is always a main
// window, never a detached pinboard. Those are answered 409.
func (a *appState) controlServerLost(w http.ResponseWriter, r *http.Request, e *winEntry) {
	spec, si := a.standInOf(e)
	if si != nil || !spec.isURL() || e.role != roleMain {
		w.WriteHeader(http.StatusConflict)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), remoteReachBudget)
	defer cancel()
	if _, _, reached := readWindowState(ctx, normalizeURL(spec.url), roleMain); reached {
		writeJSON(w, http.StatusOK, map[string]bool{"replaced": false})
		return
	}
	logf("window %s: %s lost; opening its stand-in", e.id, spec.url)
	openLostServerStandIn(a, spec, unreachableStandIn(spec.url), windowOpts{theme: a.windowTheme(e), replaces: e.id})
	writeJSON(w, http.StatusOK, map[string]bool{"replaced": true})
}

// controlOpenLocal is a stand-in's way out: an empty local window in its place.
// That is what drops the server or project it stood in for from the workspace
// set, which a plain close of the last window would not (an empty set is never
// written, so the app would reopen it next launch).
//
// A stand-in already is an empty window's page, so it becomes one where it is,
// on the server it has. The static page has no server, so an empty window is
// opened in its place.
func (a *appState) controlOpenLocal(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	if _, si := a.standInOf(e); si == nil {
		w.WriteHeader(http.StatusConflict)
		return
	}
	if e.serverURL == "" {
		a.openWindow(windowSpec{}, windowOpts{theme: a.windowTheme(e), replaces: e.id})
		w.WriteHeader(http.StatusNoContent)
		return
	}
	a.stopStandingIn(e, windowSpec{})
	w.WriteHeader(http.StatusNoContent)
}

// stopStandingIn makes stand-in e the ordinary window its page already is,
// filed as spec from now on. Reports whether e was a stand-in.
func (a *appState) stopStandingIn(e *winEntry, spec windowSpec) bool {
	was := false
	a.reg(func(*regState) {
		if e.standIn == nil {
			return
		}
		was = true
		e.standIn = nil
		e.spec = spec
	})
	if !was {
		return false
	}
	logf("window %s: no longer a stand-in, now %+v", e.id, spec.entry())
	a.persistWorkspace()
	if e.win != nil && spec.project == "" {
		title := a.tr(appWindowTitle)
		application.InvokeAsync(func() { e.win.SetTitle(title) })
	}
	return true
}
