//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/tunnel"
	"juggler/internal/ingress"
)

// PrintSessionInfo prints a prominent box with the server URL.
func (s *Server) PrintSessionInfo() {
	core.PrintProminentBox("JUGGLER IS RUNNING", fmt.Sprintf("http://%s/", s.addr), core.ColorCyan)
}

// isLoopbackAddr reports whether a "host:port" RemoteAddr originates from a
// loopback IP. Used to restrict the engine WS role to in-process callers.
func isLoopbackAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// isLocalDirect reports whether a request came from this machine over a plain
// loopback connection. Remote-ingress requests are excluded explicitly: every
// remote caller reaches a session child over loopback, through its machine
// server's proxy, so the address alone would admit them.
func isLocalDirect(r *http.Request) bool {
	return isLoopbackAddr(r.RemoteAddr) && !isRemoteIngress(r)
}

// engineRoleAllowed reports whether a request may claim the engine WS role. The
// engine is the in-process WebView, reachable only over loopback. Remote-ingress
// requests are excluded explicitly — remote callers reach the server over
// loopback through the machine server's proxy, so a remote guest could
// otherwise claim the engine slot.
func engineRoleAllowed(r *http.Request) bool {
	return isLocalDirect(r)
}

// localViewerOnly guards a write to this project's stored UI preferences
// (/session/ui-prefs). Those describe how the desktop window on this machine is
// set up, so only a viewer on this machine may change them. A phone or laptop
// browsing in over the LAN or a tunnel is handed the stored values as its
// starting point but keeps its own preferences in its own localStorage — it
// reads the desktop's setup without redecorating it, and several remote devices
// never overwrite each other through one shared slot.
func localViewerOnly(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLocalDirect(r) {
			http.Error(w, "UI preferences are per-device: a remote viewer keeps its own",
				http.StatusForbidden)
			return
		}
		next(w, r)
	})
}

// supervisorIngressKind is the MarkRemoteIngress kind for a request the
// machine server forwarded from a caller off loopback.
const supervisorIngressKind = "machine-server"

// supervisorIngressMiddleware is a session child's half of the caller-identity
// handshake with its machine server (internal/ingress). The supervisor reaches
// the child over loopback for every caller, so it vouches for a caller off
// loopback with the secret it spawned the child with, and this tags that
// request as remote ingress: from then on the engine role refuses it and
// localViewerOnly treats it as remote. Anything else — another value, a server spawned with no secret, a
// connection that is not loopback, so cannot be the supervisor's — leaves the
// request untagged. The header is removed either way, so nothing downstream
// can read the secret back.
//
// Alongside the secret, the supervisor says how the caller reached it
// (ingress.KindHeader), from where (ingress.AddrHeader), and who its transport
// says it is (ingress.UserHeader). Those are believed only with the secret,
// and only for display: a LAN caller is listed by its address and a tunnel's
// by its name (see clientInfoFromRequest), while the request stays remote
// ingress. Nothing is granted on a name.
func (s *Server) supervisorIngressMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get(ingress.Header)
		kind := r.Header.Get(ingress.KindHeader)
		addr := r.Header.Get(ingress.AddrHeader)
		user := r.Header.Get(ingress.UserHeader)
		r.Header.Del(ingress.Header)
		r.Header.Del(ingress.KindHeader)
		r.Header.Del(ingress.AddrHeader)
		r.Header.Del(ingress.UserHeader)
		if s.ingressSecret != "" && got != "" && isLoopbackAddr(r.RemoteAddr) &&
			subtle.ConstantTimeCompare([]byte(got), []byte(s.ingressSecret)) == 1 {
			r = MarkRemoteIngress(r, supervisedIngressKind(kind))
			if ip := supervisedLANCallerIP(kind, addr); ip != "" {
				r = r.WithContext(context.WithValue(r.Context(), supervisedLANCallerKey{}, ip))
			}
			if name := supervisedCallerName(user); name != "" {
				r = r.WithContext(context.WithValue(r.Context(), supervisedCallerNameKey{}, name))
			}
		}
		next.ServeHTTP(w, r)
	})
}

// supervisedIngressKind is the remote-ingress tag for a caller the supervisor
// vouched for, given the transport it names. A transport this server can title
// — the user's reverse proxy, a registered tunnel mode — keeps its own kind.
// Any other caller is supervisorIngressKind, including a LAN one, which its
// address names instead (supervisedLANCallerIP).
func supervisedIngressKind(kind string) string {
	if kind == ingress.KindProxy {
		return ingress.KindProxy
	}
	if _, ok := tunnel.Find(tunnel.Mode(kind)); ok && kind != "" {
		return kind
	}
	return supervisorIngressKind
}

// supervisedCallerNameKey carries, on a request the supervisor vouched for,
// the caller's name as its transport gave it. Read by clientInfoFromRequest.
type supervisedCallerNameKey struct{}

// supervisedCallerName returns the display name in a vouched-for caller's
// identity (tunnel.CallerIdentity, as JSON), or "" for none or one that does
// not parse.
func supervisedCallerName(user string) string {
	if user == "" {
		return ""
	}
	var who tunnel.CallerIdentity
	if err := json.Unmarshal([]byte(user), &who); err != nil {
		return ""
	}
	return who.Name
}

// supervisedLANCallerKey carries, on a request the supervisor vouched for, the
// IP of the LAN caller it forwarded. Read by clientInfoFromRequest.
type supervisedLANCallerKey struct{}

// supervisedLANCallerIP returns the caller's IP when the supervisor says the
// caller came over the LAN from an address that parses, else "".
func supervisedLANCallerIP(kind, addr string) string {
	if kind != ingress.KindLAN {
		return ""
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return ""
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return ""
	}
	return ip.String()
}

// remoteIngressContextKey carries the MarkRemoteIngress kind on a request
// context. Private: taggers use MarkRemoteIngress, readers use RemoteIngressKind.
type remoteIngressContextKey struct{}

// MarkRemoteIngress returns r tagged as having arrived through an
// explicitly-granted remote-access transport of the given kind (a short
// transport name: the machine server, the user's reverse proxy, a tunnel
// mode). Remote callers reach a session child through its machine server's
// proxy, over loopback, so such requests look loopback by RemoteAddr, and the
// tag, not the address, is what identifies them: hostAllowed honours it to
// admit traffic the machine server already checked, while engineRoleAllowed
// and the engine WS upgrade refuse it so a remote client can never claim the
// in-process engine slot.
func MarkRemoteIngress(r *http.Request, kind string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), remoteIngressContextKey{}, kind))
}

// RemoteIngressKind returns the transport kind the request was tagged with by
// MarkRemoteIngress, or "" for a direct connection.
func RemoteIngressKind(r *http.Request) string {
	v, _ := r.Context().Value(remoteIngressContextKey{}).(string)
	return v
}

// isRemoteIngress reports whether the request arrived over an explicitly-granted
// remote-access transport (see MarkRemoteIngress).
func isRemoteIngress(r *http.Request) bool {
	return RemoteIngressKind(r) != ""
}

// clientInfoFromRequest derives display metadata for a client from the request
// that opened its connection: how it reached us (local / LAN / remote transport),
// a human detail (LAN IP, or the transport label), its User-Agent, and now as the
// connect time. Presentational only.
func clientInfoFromRequest(r *http.Request) ClientInfo {
	info := ClientInfo{UserAgent: r.UserAgent(), ConnectedAt: time.Now().UnixMilli()}
	if ip, ok := r.Context().Value(supervisedLANCallerKey{}).(string); ok {
		info.Origin = "lan"
		info.Detail = ip
		return info
	}
	if kind := RemoteIngressKind(r); kind != "" {
		info.Origin = "remote"
		info.Detail = remoteTransportLabel(kind)
		info.Name, _ = r.Context().Value(supervisedCallerNameKey{}).(string)
		return info
	}
	if isLoopbackAddr(r.RemoteAddr) {
		info.Origin = "local"
		return info
	}
	info.Origin = "lan"
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		info.Detail = host
	}
	return info
}

// maxViewerIDLen bounds a caller-supplied viewer id. The ids Juggler mints are
// 34 characters; the cap is what keeps an arbitrary client from parking a large
// string in every other viewer's clients-changed payload.
const maxViewerIDLen = 64

// sanitiseViewerID accepts a viewer's own identity, or returns empty. The id is
// chosen by the client and relayed verbatim to the other viewers sharing the
// session, so it is held to an unambiguous alphabet rather than trusted: nothing
// here may need escaping downstream, and an id that arrives malformed addresses
// nothing rather than addressing something else.
func sanitiseViewerID(id string) string {
	if id == "" || len(id) > maxViewerIDLen {
		return ""
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return ""
		}
	}
	return id
}

// remoteTransportLabel turns a remote-ingress kind (see MarkRemoteIngress) into a
// short human label: the machine server, the user's reverse proxy, or a
// registered tunnel mode's title, falling back to the raw kind for anything
// unrecognised.
func remoteTransportLabel(kind string) string {
	if kind == supervisorIngressKind {
		return "Via machine server"
	}
	if kind == ingress.KindProxy {
		return "Via reverse proxy"
	}
	if spec, ok := tunnel.Find(tunnel.Mode(kind)); ok {
		return spec.Title.English()
	}
	return kind
}
