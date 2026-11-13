//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"fmt"
	"net/http"
	"strings"

	"juggler/internal/basepath"
	"juggler/internal/ingress"
)

// A reverse proxy may mount this server under a path: nginx at /juggler/,
// stripping it before it forwards. Every address this server hands a viewer —
// the sessions page's assets and control API, and each project's link — is
// then put below that path (requestBase), so the page the viewer follows stays
// behind the proxy. A child's link is below it too: the proxy tells the child
// <base>/p/<key> (basepath.Header), and tells it <base> itself
// (basepath.MachineHeader), which the child names when it passes the viewer's
// switcher calls back here (server/connectivity.go).
//
// The links a session offers for LAN access and tunnels (askedSession) are not
// put below it: those reach this server directly, never through the proxy.

// BasePathUsage is --base-path's help, for both commands that take it
// (`juggler serve` and bare juggler).
const BasePathUsage = "The `path` a reverse proxy on this machine serves Juggler under, for one that cannot name it in X-Forwarded-Prefix (tailscale serve --set-path). Applies only to callers through that proxy: requests for a host --allow-host names"

// maxBasePath is the longest base this server is addressed under: a project's
// link below it, <base>/p/<key>, must still be one a session child accepts.
const maxBasePath = basepath.MaxLen - len("/p/-") - projectSlugMax - 2*projectHashBytes

// requestBase is the path r reached this server under: --base-path for a
// caller through the reverse proxy on this machine (callerKind's
// ingress.KindProxy), whatever that proxy sends; else the X-Forwarded-Prefix a
// proxy names (basepath.FromRequest), when a project's link below it fits;
// else "". A client reaching the server directly, a desktop window among them,
// is never put below --base-path.
func (s *Server) requestBase(r *http.Request) string {
	if s.fixedBase != "" && s.callerKind(r) == ingress.KindProxy {
		return s.fixedBase
	}
	if p := basepath.FromRequest(r); len(p) <= maxBasePath {
		return p
	}
	return ""
}

// checkBasePath is --base-path as requestBase uses it, with any trailing slash
// dropped, or an error saying what it may be. "" is none.
func checkBasePath(p string) (string, error) {
	if p == "" {
		return "", nil
	}
	trimmed := strings.TrimSuffix(p, "/")
	if !basepath.Valid(trimmed) || len(trimmed) > maxBasePath {
		return "", fmt.Errorf("--base-path %q: want a path such as /juggler, of letters, digits, '_' and '-', at most %d characters", p, maxBasePath)
	}
	return trimmed, nil
}

// linkUnder is a project's link as a viewer that reached this server under
// base addresses it; "" stays "".
func linkUnder(base, link string) string {
	if link == "" {
		return ""
	}
	return base + link
}

// sessionsUnder is sessions with each link put under base.
func sessionsUnder(base string, sessions []Session) []Session {
	if base == "" {
		return sessions
	}
	out := make([]Session, len(sessions))
	for i, sess := range sessions {
		sess.Link = linkUnder(base, sess.Link)
		out[i] = sess
	}
	return out
}

// under is the recents with each link put under base.
func (rr recentsResponse) under(base string) recentsResponse {
	if base == "" {
		return rr
	}
	links := make(map[string]string, len(rr.Links))
	for p, link := range rr.Links {
		links[p] = linkUnder(base, link)
	}
	rr.Links = links
	return rr
}
