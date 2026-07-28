//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"net/netip"
	"strings"
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

// apiAuthExempt reports whether an /api path is reachable without the
// per-instance token. These are cross-process or bootstrap endpoints a caller
// legitimately hits before (or without ever) loading the token-bearing page:
//   - liveness/instance discovery and cross-instance shutdown coordination,
//     probed by *other* juggler processes that cannot know this instance's token
//     (core/lockfile.go, cmd/juggler-app/busy_guard.go);
//   - native desktop window geometry, read/written by cmd/juggler-app before the
//     viewer page (and its embedded token) has loaded;
//   - the SDP exchange that bootstraps a WebRTC DataChannel;
//   - the loopback engine's own endpoints (/api/engine/*), served from a page
//     that carries no token and already gated to the in-process WebView;
//   - the test harness (/api/test/*), which drives the server headlessly.
//
// None of these execute tools or expose credentials, so leaving them open does
// not reopen the RCE vector the token closes.
func apiAuthExempt(path string) bool {
	switch path {
	case "/api/health", "/api/health/active", "/api/health/instance",
		"/api/session/window-state",
		"/api/shutdown", "/api/webrtc/signal", "/api/ws":
		return true
	}
	return strings.HasPrefix(path, "/api/engine/") || strings.HasPrefix(path, "/api/test/")
}

// hostAllowed is the DNS-rebinding defense (§S.2): a gated /api request's Host
// header must name this machine — literally "localhost" or an IP address
// (loopback or a LAN address the server is reachable on). A DNS name such as
// attacker.com (which rebinding transiently points at 127.0.0.1) is rejected,
// since the browser sends the site's hostname as Host. Remote grants — an
// established DataChannel or a tunnel the user opened — legitimately carry
// arbitrary Host names, so they are admitted on their remote-ingress tag and
// rely on the token (which their page also carries) as the authenticator
// instead.
func hostAllowed(r *http.Request) bool {
	if isRemoteIngress(r) {
		return true
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host == "localhost" {
		return true
	}
	// netip.ParseAddr (unlike net.ParseIP) accepts a zoned IPv6 literal such as
	// fe80::1%en0 — the form a same-subnet client sends over a link-local
	// address. It still rejects DNS names, so the rebinding defense holds.
	_, err := netip.ParseAddr(host)
	return err == nil
}

// isAssetGetRequest reports whether r is a GET for a content-addressed asset
// (GET /api/session/conversations/<id>/assets/<sha>). These are loaded by the
// browser as <img src>, which — unlike fetch() — cannot carry the custom
// X-Juggler-Token header, so the token rides as a ?token= query param instead
// (mirroring the WebSocket upgrade in websocket_loop.go). The relaxation is
// scoped to exactly this read-only, non-tool route; the sensitive surface
// (/api/ops/call, …) still demands the header and its forced CORS preflight.
func isAssetGetRequest(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	p := r.URL.Path
	return strings.HasPrefix(p, "/api/session/conversations/") && strings.Contains(p, "/assets/")
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
		if s.testMode || !strings.HasPrefix(path, "/api/") || apiAuthExempt(path) {
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
		if token != s.apiToken {
			http.Error(w, "Unauthorized: missing or invalid session token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
