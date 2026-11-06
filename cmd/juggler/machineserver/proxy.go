//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/gorilla/mux"

	"juggler/internal/ingress"
)

// handleProjectProxy serves a project's link, /p/<key>/… (projectlink.go),
// which is the address of the project's session: it reverse-proxies to the
// session's child. Clients only ever see the machine server's address; child
// ports stay loopback-internal. WebSocket upgrades pass through via the
// standard ReverseProxy switching-protocols support.
//
// While the project has no running child — none, or one starting, restarting,
// stopping or failed — a browser loading the link's page gets the sessions
// page set to open the project (serveOpener), which reloads the link once the
// session runs. Anything else gets 404 with no session, 503 with one not
// running: a viewer's socket among them, which keeps retrying, and reaches the
// project's next session once there is one.
//
// Every proxied request reaches the child from here, over loopback, so the
// child cannot tell its callers apart by address. The proxy tells it instead:
// a caller off loopback is forwarded with the child's ingress secret
// (internal/ingress), which the child turns into its remote-ingress tag — so
// such a caller cannot take the engine slot or pass for a local viewer — and
// with how it arrived, from where, and who a tunnel's transport says it is,
// for the child's clients list.
func (s *Server) handleProjectProxy(w http.ResponseWriter, r *http.Request) {
	key := mux.Vars(r)["key"]
	prefix := "/p/" + key
	sess, secret, ok := s.reg.routeKey(key)
	if !ok || sess.State != SessionRunning || sess.Addr == "" {
		switch {
		case r.URL.Path == prefix+"/" && loadsAPage(r):
			s.serveOpener(w, r, key, sess, ok)
		case !ok:
			http.Error(w, "this project has no session", http.StatusNotFound)
		default:
			http.Error(w, "session is not running (state: "+string(sess.State)+")", http.StatusServiceUnavailable)
		}
		return
	}
	id := sess.ID
	kind := s.callerKind(r)
	remote := kind != ""
	if remote && secret == "" {
		// Forwarded untagged, a remote caller would look local to the child.
		http.Error(w, "session cannot identify a remote caller", http.StatusBadGateway)
		return
	}
	s.reg.renewUnviewed(id)

	// Who a tunnel's transport says the caller is, passed on as it said it.
	var user string
	if tag, ok := ingressOf(r); ok && !tag.caller.IsZero() {
		if b, err := json.Marshal(tag.caller); err == nil {
			user = string(b)
		}
	}

	target := &url.URL{Scheme: "http", Host: sess.Addr}
	var release func()
	defer func() {
		if release != nil {
			release()
		}
	}()
	proxy := &httputil.ReverseProxy{
		ModifyResponse: func(resp *http.Response) error {
			if resp.StatusCode != http.StatusSwitchingProtocols || !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") {
				return nil
			}
			var held bool
			release, held = s.reg.holdViewer(id)
			if !held {
				return fmt.Errorf("session is stopping")
			}
			return nil
		},
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// Strip the link's prefix: the child serves the same tree it
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
			pr.Out.Header.Del(ingress.UserHeader)
			if remote {
				pr.Out.Header.Set(ingress.Header, secret)
				pr.Out.Header.Set(ingress.KindHeader, kind)
				if user != "" {
					pr.Out.Header.Set(ingress.UserHeader, user)
				}
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
	proxy.ServeHTTP(w, r)
}

// loadsAPage reports whether r is a browser loading a page for its tab or
// window: Sec-Fetch-Dest says so where the browser sends it, and otherwise an
// Accept that asks for HTML, which neither a script's fetch (*/*) nor a socket
// does.
func loadsAPage(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" {
		return dest == "document"
	}
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

// callerKind says how a request reached this server, as the ingress kind the
// proxy names to a child, or "" for a caller on this machine:
//
//   - ingress.KindLAN: off loopback, on this server's own listener. An address
//     that does not parse counts too, so a doubt costs the caller local trust
//     rather than granting it.
//   - a tunnel's mode: it came through that tunnel (ingressOf), whose
//     forwarder or data channel reaches this server from inside the machine.
//   - ingress.KindProxy: on loopback, but naming one of allowedHosts. That is a
//     reverse proxy on this machine (tailscale serve) forwarding a caller from
//     wherever it serves. Its socket is local and its caller is not. A local
//     process that sends the name only demotes itself to remote.
func (s *Server) callerKind(r *http.Request) string {
	if tag, ok := ingressOf(r); ok {
		return string(tag.tunnel.mode)
	}
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

// serveOpener answers a page load of a project's link while the project has
// no running child: the sessions page, set to open the project — the
// session's own (sess, when found), else the recent project the key names —
// which it does through the control API, so the load itself starts nothing. A
// key that names neither is the page saying so, as a 404.
//
// The page opens the project as it loads only for a visitor this server's own
// pages sent, or none did — a bookmark, an address typed or scanned. One sent
// from anywhere else (sentFromElsewhere) is asked first, so a link planted on
// another site starts nothing until the user says so.
func (s *Server) serveOpener(w http.ResponseWriter, r *http.Request, key string, sess Session, found bool) {
	project := sess.Project
	if !found {
		var ok bool
		if project, ok = s.recentForKey(key); !ok {
			s.servePage(w, r, http.StatusNotFound, pageConfig{OpenMissing: true})
			return
		}
	}
	s.servePage(w, r, http.StatusOK, pageConfig{Open: project, Confirm: sentFromElsewhere(r)})
}

// sentFromElsewhere reports whether a browser's navigation to r came from a
// page of another origin, as its Sec-Fetch-Site says. "same-site" counts: to a
// browser every port of localhost is one site, so it is another server on this
// machine. A request without the header — an older browser, a client that is
// none — is taken at its word, as one the user made.
func sentFromElsewhere(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "none", "same-origin":
		return false
	}
	return true
}

// redirectProjectLink normalizes a bare /p/<key> to /p/<key>/ so the child
// sees "/" and relative asset URLs resolve under the link, keeping the query (a
// link to a conversation, ?c=). The target is rebuilt — its path from the
// escaped key, never the raw request path, and its query re-encoded from the
// parsed one, so it can carry no fragment or second path — and so can only ever
// be a local link. GET /p/{key}.
func (s *Server) redirectProjectLink(w http.ResponseWriter, r *http.Request) {
	target := url.URL{Path: "/p/" + mux.Vars(r)["key"] + "/", RawQuery: r.URL.Query().Encode()}
	http.Redirect(w, r, target.String(), http.StatusMovedPermanently)
}
