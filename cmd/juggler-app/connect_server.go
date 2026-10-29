//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"juggler/cmd/juggler/msg"
)

// Connecting to a server by its address: Session ▸ Connect to Server…, which
// puts up a panel in a session's page, or "Connect to another computer" on the
// sessions page an empty window shows; both post the typed address here. The window that opens is a connected one (see
// windowSpec), so it is part of the workspace set and reopens at every launch
// until it is closed.
//
// A server by address can be down when the app starts, and a window onto it
// would then be a blank page with nothing in it to act on. So a window whose
// server does not answer opens as a stand-in for it instead (stand_in.go),
// saying so, with a way to try again and a way out to a local window — which is
// also how a connected server that is gone for good stops being reopened.

var (
	unreachableWindowTitle = msg.New("Server unreachable — Juggler")
	unreachablePageTitle   = msg.New("Can't reach the server")
	unreachableRetry       = msg.New("Try again")
	unreachableTrying      = msg.New("Trying…")
	unreachableOpenLocal   = msg.New("Open a local window instead")

	// connectFromURLWindowRefusal is why a window on a server by URL cannot
	// connect to another (controlConnect).
	connectFromURLWindowRefusal = msg.New("This window shows a server on another computer, so it cannot connect to a different one. Open a new window and connect from there.")
	connectBadAddress           = msg.New("That is not a server address. Enter one like http://devbox:3939.")
)

// unreachableMessage explains the unreachable-server page, naming the server.
func unreachableMessage(serverURL string) msg.Message {
	return msg.New("Juggler could not connect to {url}.\n\n"+
		"Check that the server is running and that this computer can reach it. "+
		"A server answers only on its own machine until LAN access is turned on for it.",
		"url", serverURL)
}

// normaliseServerURL turns what someone typed as a server's address into the
// origin a window is opened on, or reports that it is not one. A bare host:port
// is taken as http. Only the scheme, host and port are kept: a server is served
// from its root, so a path or query typed with it names nothing extra. Anything
// but http(s), a missing host, a port that is not one, and credentials in the
// address are all refused — the address becomes a window's URL, and the
// control endpoint's secret goes with it.
func normaliseServerURL(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", false
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", false
	}
	if u.User != nil || u.Hostname() == "" {
		return "", false
	}
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			return "", false
		}
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), true
}

// controlConnect opens a window onto the server the page names, in reply to its
// Connect to Server panel.
//
// Only a window on this machine's server — a project's session or an empty
// window — may ask. A window on a server by URL is showing a page that server
// sent, and if it could name another host, any server ever connected to could
// put windows onto anywhere it liked, with a place in the workspace set; it is
// refused before it gets here, with connectFromURLWindowRefusal
// (windowActions). A stand-in's page is the app's own, and asks for nothing of
// the kind (pageSpecOf).
func (a *appState) controlConnect(w http.ResponseWriter, r *http.Request, e *winEntry) {
	from, ok := a.pageSpecOf(e.id)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	serverURL, ok := normaliseServerURL(r.URL.Query().Get("url"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   connectBadAddress.English(),
			"message": connectBadAddress,
		})
		return
	}
	// The appearance hand-off, and nothing else the query could say: this is a
	// main window onto another server, not a board of the one asking.
	q := windowOptsFromQuery(r.URL.Query())
	a.connectServer(e, from, serverURL, windowOpts{theme: q.theme, mode: q.mode, zoom: q.zoom})
	w.WriteHeader(http.StatusNoContent)
}

// connectServer opens a connected window onto serverURL, asked for from the
// window from (whose spec is fromSpec).
//
// A window already open on that server is raised instead, and remembered from
// now on if it was a --url one: connecting to it is saying it should come back.
// A stand-in for it is not open on it, so connecting is another attempt. An
// empty window asking is replaced by the new one rather than left behind beside
// it, as a dropped folder fills the window it is dropped on.
func (a *appState) connectServer(from *winEntry, fromSpec windowSpec, serverURL string, opts windowOpts) {
	spec := windowSpec{url: serverURL, connected: true}
	var open *winEntry
	a.reg(func(st *regState) {
		for _, w := range st.windows {
			if !isBoardRole(w.role) && w.standIn == nil && w.spec.sameView(spec) {
				w.spec.connected = true
				open = w
				break
			}
		}
	})
	if open != nil {
		a.persistWorkspace()
		focusEntry(open)
		return
	}
	if fromSpec == (windowSpec{}) && !isBoardRole(from.role) {
		opts.replaces = from.id
	}
	logf("connect: opening %s", serverURL)
	a.openWindow(spec, opts)
}
