//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// A main window on a server by URL shows that server's sessions page framed in
// this machine's server's own sessions page, whose header chooses the server
// the window is on (switch-server). The outer page is this machine's and holds
// the window's secret; the framed page is the other server's, at ?embed=1, and
// holds the frame secret (windowView.frameSecret), which reaches only what a
// remote window's does. A server that cannot be framed — one older than
// embedVersion — and a window whose machine's server cannot be had show the
// other server's page full-window instead, as a window on it always did.

// callerKey is the request context key under which handleControl records who
// a request came from (caller).
type callerKey struct{}

// caller is who a control request came from: a page a server by URL served
// (remote), and whether that page is the one framed in its window (frame).
type caller struct {
	remote, frame bool
}

// callerOf is who r came from, as handleControl recorded it; a request it did
// not record is taken for nobody's in particular.
func callerOf(r *http.Request) caller {
	c, _ := r.Context().Value(callerKey{}).(caller)
	return c
}

// embedProbeHTTP is the client the embed probe asks with. It follows no
// redirect: what is framed is the server at the window's address.
var embedProbeHTTP = &http.Client{
	Timeout: remoteReachBudget,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// embedsSessions reports whether the server at root says, in GET
// /api/version, that its sessions page can be framed (embedVersion 1 or
// more). No answer, or one without it, is a server that cannot.
func embedsSessions(ctx context.Context, root string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, root+"/api/version", nil)
	if err != nil {
		return false
	}
	resp, err := embedProbeHTTP.Do(req) //nolint:gosec // app-owned server URL, see fetchWindowState
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var v struct {
		EmbedVersion int `json:"embedVersion"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<12)).Decode(&v); err != nil {
		return false
	}
	return v.EmbedVersion >= 1
}

// serverRoot is serverURL's origin when serverURL names a server's root, as
// a connected server's address does; a --url naming a page on it is shown as
// that page, never framed.
func serverRoot(serverURL string) (string, bool) {
	u, err := url.Parse(normalizeURL(serverURL))
	if err != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return "", false
	}
	return normaliseServerURL(serverURL)
}

// framedPageView is the view a main window on spec, a server by URL, shows
// for that server's sessions page: framed in this machine's server's page when
// the server can be framed and this machine's server is found or (with start)
// started, else the server's own page at fullURL. This machine's server is
// asked for first, as it is attached to already whenever any window is on it;
// the other server is asked only then. Blocking, so never on the main thread.
func (a *appState) framedPageView(spec windowSpec, fullURL string, start bool) windowView {
	full := windowView{spec: spec, serverURL: fullURL}
	root, ok := serverRoot(spec.url)
	if !ok {
		return full
	}
	c, err := a.serverClient(start)
	if err != nil {
		logf("window on %s: no server here to frame it in (%v); showing it whole", root, err)
		return full
	}
	ctx, cancel := context.WithTimeout(context.Background(), remoteReachBudget)
	defer cancel()
	if !embedsSessions(ctx, root) {
		return full
	}
	return windowView{spec: spec, serverURL: "http://" + c.Addr(), server: procOf(c), framed: root}
}

// controlSwitchServer is the outer sessions page's server chooser: the window
// shows ?url='s server's sessions page, in place — framed where it can be,
// and as the unreachable stand-in when that server does not answer, as
// opening a window onto it would — or, with no ?url, this machine's. The
// window is filed as what it shows from then on, so the workspace keeps it.
//
// Only a main window showing a sessions page may ask: an empty local window
// or a framed one (409 otherwise). A page another server sent is refused
// before it gets here (windowActions): if it could name another host, any
// server ever connected to could put this window anywhere it liked, with a
// place in the workspace set. An address that is not a server's is 400.
func (a *appState) controlSwitchServer(w http.ResponseWriter, r *http.Request, e *winEntry) {
	v := a.viewOf(e)
	if e.role != roleMain || v.standIn != nil || (v.spec != (windowSpec{}) && v.framed == "") {
		w.WriteHeader(http.StatusConflict)
		return
	}
	spec := windowSpec{}
	if raw := strings.TrimSpace(r.URL.Query().Get("url")); raw != "" {
		serverURL, ok := normaliseServerURL(raw)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error":   connectBadAddress.English(),
				"message": connectBadAddress,
			})
			return
		}
		spec = windowSpec{url: serverURL, connected: true}
	}
	logf("window %s: switching to %+v", e.id, spec.entry())
	a.retarget(e, showing(v), spec, windowOpts{})
	w.WriteHeader(http.StatusNoContent)
}
