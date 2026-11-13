//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package basepath is the one rule for the path prefix a server is mounted
// under by a reverse proxy, which the pages it serves address it through.
//
// Two servers mount: the machine server (`juggler serve`), under whatever path
// a proxy in front of it uses, and each session child, under its project's
// link on the machine server, /p/<key>, or that link below the machine
// server's own prefix. A proxy names the prefix in Header. The machine server
// also names its own prefix to a child in MachineHeader, so the child can say
// where the machine server is mounted when it passes a viewer's call on to it.
package basepath

import (
	"net/http"
	"regexp"
)

// Header names the path prefix a reverse proxy mounts a server under. The
// machine server's proxy sets it on every request it forwards to a child,
// replacing any value the client sent.
const Header = "X-Forwarded-Prefix"

// MachineHeader names, on a request the machine server forwards to a child,
// the prefix the machine server itself was reached under; absent when it has
// none. The machine server sets it, replacing any value the client sent, and
// the child passes it back as Header on the calls it relays for the viewer, so
// the links the machine server answers with are addressed as the viewer
// reaches them.
const MachineHeader = "X-Juggler-Machine-Prefix"

// MaxLen bounds an accepted base path.
const MaxLen = 128

// pattern admits a rooted path of plain segments with no trailing slash:
// letters, digits, '_' and '-' only. Nothing in it can close a quoted string or
// form a dot segment, so it is safe to template into a page verbatim.
var pattern = regexp.MustCompile(`^(/[A-Za-z0-9_-]+)+$`)

// Valid reports whether p is a base path a page may be served under.
func Valid(p string) bool {
	return len(p) <= MaxLen && pattern.MatchString(p)
}

// FromRequest returns the path prefix the client addressed this server under:
// "" for a direct request, or the proxy's Header when it is a well-formed path.
// A malformed one is ignored. The header is not a credential — anyone can send
// one — so a forged value can only mis-address the page served to the forger.
func FromRequest(r *http.Request) string {
	return validOrNone(r.Header.Get(Header))
}

// MachineFromRequest returns the machine server's prefix a forwarded request
// carries in MachineHeader, or "" for none or a malformed one. Like Header, it
// is no credential.
func MachineFromRequest(r *http.Request) string {
	return validOrNone(r.Header.Get(MachineHeader))
}

func validOrNone(p string) string {
	if !Valid(p) {
		return ""
	}
	return p
}
