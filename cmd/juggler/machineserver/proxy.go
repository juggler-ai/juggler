//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"

	"juggler/internal/ingress"
)

// handleSessionProxy reverse-proxies /s/<id>/… to the owning session child.
// Clients only ever see the machine server's address; child ports stay
// loopback-internal. WebSocket upgrades pass through via the standard
// ReverseProxy switching-protocols support.
//
// Every proxied request reaches the child from here, over loopback, so the
// child cannot tell its callers apart by address. The proxy tells it instead:
// a caller off loopback is forwarded with the child's ingress secret
// (internal/ingress), which the child turns into its remote-ingress tag — so
// such a caller cannot take the engine slot or pass for a local viewer — and
// with how it arrived and from where, for the child's clients list.
func (s *Server) handleSessionProxy(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	sess, secret, ok := s.reg.route(id)
	if !ok {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	if sess.State != SessionRunning || sess.Addr == "" {
		http.Error(w, "session is not running (state: "+string(sess.State)+")", http.StatusServiceUnavailable)
		return
	}
	kind := s.callerKind(r)
	remote := kind != ""
	if remote && secret == "" {
		// Forwarded untagged, a remote caller would look local to the child.
		http.Error(w, "session cannot identify a remote caller", http.StatusBadGateway)
		return
	}

	target := &url.URL{Scheme: "http", Host: sess.Addr}
	prefix := "/s/" + id
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// Strip the session prefix: the child serves the same tree it
			// would serve standalone.
			path := strings.TrimPrefix(pr.In.URL.Path, prefix)
			if path == "" {
				path = "/"
			}
			pr.Out.URL.Path = path
			pr.Out.URL.RawPath = ""
			// Preserve the client-facing Host: the child's same-origin check
			// compares a browser's Origin (the machine server's address)
			// against the Host header, so rewriting it to the child's
			// loopback address would reject every proxied WebSocket upgrade.
			pr.Out.Host = pr.In.Host
			// Tell the child where it is mounted, so the pages it serves
			// address it through this proxy (the child's requestBasePath).
			// Set, never appended: a client's own value must not reach it.
			pr.Out.Header.Set("X-Forwarded-Prefix", prefix)
			// Only this proxy speaks for the caller: a client's own ingress
			// headers are dropped whoever sent them.
			pr.Out.Header.Del(ingress.Header)
			pr.Out.Header.Del(ingress.KindHeader)
			pr.Out.Header.Del(ingress.AddrHeader)
			if remote {
				pr.Out.Header.Set(ingress.Header, secret)
				pr.Out.Header.Set(ingress.KindHeader, kind)
				// A LAN caller's address is its own. A proxied caller's is the
				// proxy's loopback hop, which says nothing about who it is.
				if kind == ingress.KindLAN {
					pr.Out.Header.Set(ingress.AddrHeader, pr.In.RemoteAddr)
				}
			}
		},
		// Flush streamed responses immediately — the UI relies on
		// incremental delivery, not just WebSocket frames.
		FlushInterval: -1,
	}
	// A viewer's socket is an attached client (see attach) for as long as it
	// is open: for an upgrade, ServeHTTP returns only once the socket closes.
	if websocket.IsWebSocketUpgrade(r) {
		defer s.attach()()
	}
	proxy.ServeHTTP(w, r)
}

// callerKind says how a request reached this server, as the ingress kind the
// proxy names to a child, or "" for a caller on this machine:
//
//   - ingress.KindLAN: off loopback, on this server's own listener. An address
//     that does not parse counts too, so a doubt costs the caller local trust
//     rather than granting it.
//   - ingress.KindProxy: on loopback, but naming one of allowedHosts. That is a
//     reverse proxy on this machine (tailscale serve) forwarding a caller from
//     wherever it serves. Its socket is local and its caller is not. A local
//     process that sends the name only demotes itself to remote.
//
// Transports that end on this server over loopback (tunnels) add their kinds
// here.
func (s *Server) callerKind(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return ingress.KindLAN
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return ingress.KindLAN
	}
	if s.allowedHosts.Has(r.Host) {
		return ingress.KindProxy
	}
	return ""
}

// redirectSession normalizes a bare /s/<id> to /s/<id>/ so the child sees "/"
// and relative asset URLs resolve under the session prefix. The target is
// rebuilt from the escaped id — never the raw request path — so it can only
// ever be a local session path.
func (s *Server) redirectSession(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/s/"+url.PathEscape(mux.Vars(r)["id"])+"/", http.StatusMovedPermanently)
}
