//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"slices"
	"strings"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/apipaths"
	"juggler/internal/hostcheck"
)

// mintAPIToken returns a cryptographically-random per-instance token used to
// authenticate same-origin /api and WebSocket traffic. The token is embedded in
// the served index.html (a same-origin page a malicious cross-origin site
// cannot read), so legitimate clients replay it on every /api request while a
// hostile web page can neither read nor guess it. This is the primary defense
// against the localhost cross-site RCE via /api/ops/call.
func mintAPIToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// A predictable token is worse than a crash: it would silently reopen the
		// exact cross-site hole this closes. crypto/rand failing is catastrophic
		// and vanishingly rare, so refuse to start rather than ship a guess.
		panic("mintAPIToken: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// exemptRoutes is the set of /api paths reachable without the per-instance
// token, mapped to the methods admitted on each. A nil method list admits every
// method the route is registered for.
//
// These are cross-process or bootstrap endpoints a caller legitimately hits
// before (or without ever) loading the token-bearing page:
//   - liveness/instance discovery and cross-instance shutdown coordination,
//     probed by *other* juggler processes that cannot know this instance's token
//     (core/lockfile.go, cmd/juggler-app/busy_guard.go);
//   - native desktop window geometry, read/written by cmd/juggler-app before the
//     viewer page (and its embedded token) has loaded;
//   - forgetting the board a window held, which cmd/juggler-app posts as that
//     window closes. It is the other half of the geometry above — the same call
//     drops the same window's frame — and the app has no page and so no token
//     to quote;
//   - the SDP exchange that bootstraps a WebRTC DataChannel, and the viewer
//     WebSocket, whose upgrade carries the token as a query param instead
//     (see websocket_loop.go).
//
// None of these execute tools or expose credentials, so leaving them open does
// not reopen the RCE vector the token closes.
//
// The board delete is the only one that destroys anything, so it is admitted on
// the narrowest terms available: that path for that method, and nothing else on
// it. A caller has to name a board to remove one, board ids are opaque and
// random, and every route that would reveal one — the boards themselves, the
// session — stays gated. Reading is what the token is really protecting, and
// none of it is opened here.
//
// Every key is a path constant from internal/apipaths, which is also what
// registers the route — so the gate and the route cannot be renamed apart, and
// TestAPIAuthExemptRoutesAreRegistered pins that each one still names a route
// the server actually serves.
var exemptRoutes = map[string][]string{
	apipaths.Health:                nil,
	apipaths.HealthActive:          nil,
	apipaths.HealthInstance:        nil,
	apipaths.Shutdown:              nil,
	apipaths.SessionWindowState:    nil,
	apipaths.WebRTCSignal:          nil,
	apipaths.WebSocket:             nil,
	apipaths.SessionPinboardBoards: {http.MethodDelete},
}

// apiAuthExempt reports whether an /api request is reachable without the
// per-instance token (see exemptRoutes for which, and why).
//
// The exempt set is exactly those paths: nothing is admitted by prefix. The
// test harness (/api/test/*) and the engine's status endpoint (/api/engine/*)
// need no exemption of their own, because the only server that serves them is
// one RegisterTestRoutes has run against — and that sets testMode, which takes
// this gate out of the request path altogether.
func apiAuthExempt(method, path string) bool {
	methods, ok := exemptRoutes[path]
	return ok && (methods == nil || slices.Contains(methods, method))
}

// hostAllowed is the DNS-rebinding defense (§S.2): the Host header of a gated
// /api request, a token-bearing page or the viewer WebSocket upgrade (see
// hostGatedPaths) must name this machine (hostcheck.NamesThisMachine). A DNS name such
// as attacker.com (which rebinding transiently points at 127.0.0.1) is
// rejected, since the browser sends the site's hostname as Host. Remote grants
// — an established DataChannel, a tunnel the user opened, or a caller a machine
// server vouched for — legitimately carry arbitrary Host names, so they are
// admitted on their remote-ingress tag and rely on the token (which their page
// also carries) as the authenticator instead. A machine server applies the
// same rule to everything it forwards, so its callers are held to it there.
func hostAllowed(r *http.Request) bool {
	return isRemoteIngress(r) || hostcheck.NamesThisMachine(r.Host)
}

// hostGatedPaths are the routes outside apiAuthMiddleware's Host check that a
// DNS-rebinding page could still turn against this server: the pages that embed
// the API token (index and engine), the test pages that host the app, and the
// viewer WebSocket, whose upgrade the /api gate exempts and which admits anyone
// holding the token. A page on attacker.com rebound to 127.0.0.1 is same-origin
// with this server as far as the browser is concerned, so without this it could
// read the token from index.html and open a viewer socket with it.
var hostGatedPaths = map[string]bool{
	"/":                true,
	"/index.html":      true,
	"/engine":          true,
	"/headless-test":   true,
	"/test-pool":       true,
	apipaths.WebSocket: true,
}

// pageHostMiddleware applies hostAllowed to hostGatedPaths, answering 403 before
// the page or the upgrade is served. It runs in test mode too: the harness
// reaches the server by address, so the rule costs it nothing. Static assets
// carry nothing secret and are left ungated.
func (s *Server) pageHostMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hostGatedPaths[r.URL.Path] && !hostAllowed(r) {
			http.Error(w, "Forbidden: host not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isAssetGetRequest reports whether r is a GET for content the browser loads
// through an element rather than fetch():
//
//   - a content-addressed asset (GET /api/session/conversations/<id>/assets/<sha>);
//   - a project file streamed for a file viewer (GET /api/session/files/content).
//
// Both are loaded as <img src> / <canvas> / <iframe>, which — unlike fetch() —
// cannot carry the custom X-Juggler-Token header, so the token rides as a
// ?token= query param instead (mirroring the WebSocket upgrade in
// websocket_loop.go). The relaxation is scoped to exactly these read-only,
// non-tool routes; the sensitive surface (/api/ops/call, …) still demands the
// header and its forced CORS preflight. The file route additionally contains
// itself to the project root precisely because its token is this exposed — see
// handlers.FilesAPI.
func isAssetGetRequest(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	p := r.URL.Path
	if p == "/api/session/files/content" {
		return true
	}
	return strings.HasPrefix(p, "/api/session/conversations/") && strings.Contains(p, "/assets/")
}

// fileTreeToken returns the token a GET under handlers.FileTreePrefix carries
// as its first path segment, or "" for any other request. That route frames an
// HTML page whose relative links must resolve beside it, and a relative URL
// drops the query string — so the token rides in the path, where every link the
// page makes inherits it. It is the same read-only, project-contained surface as
// the ?token= file route, reached by a different spelling.
func fileTreeToken(r *http.Request) string {
	if r.Method != http.MethodGet {
		return ""
	}
	rest, ok := strings.CutPrefix(r.URL.Path, handlers.FileTreePrefix)
	if !ok {
		return ""
	}
	token, _, _ := strings.Cut(rest, "/")
	return token
}

// apiAuthMiddleware enforces the per-instance token and Host allowlist on the
// sensitive /api surface (§S.1 + §S.2). It is a no-op in test mode — the browser
// integration harness drives the server headlessly over many synthetic origins
// and iframes, and the token path is covered separately by a Go test — and only
// engages for real /api/* paths that are not on the bootstrap exempt list.
//
// The custom X-Juggler-Token header also forces a CORS preflight for any
// cross-origin caller; combined with §S.3 (no wildcard ACAO on /api) that
// preflight fails outright, so a hostile page never even reaches this check.
func (s *Server) apiAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if s.testMode || !strings.HasPrefix(path, "/api/") || apiAuthExempt(r.Method, path) {
			next.ServeHTTP(w, r)
			return
		}
		if !hostAllowed(r) {
			http.Error(w, "Forbidden: host not allowed", http.StatusForbidden)
			return
		}
		token := r.Header.Get("X-Juggler-Token")
		if token == "" && isAssetGetRequest(r) {
			// <img src> loads can't set a custom header — accept the token as a
			// query param for this read-only route (see isAssetGetRequest).
			token = r.URL.Query().Get("token")
		}
		if token == "" {
			token = fileTreeToken(r)
		}
		if token != s.apiToken {
			http.Error(w, "Unauthorized: missing or invalid session token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
