//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"regexp"
)

// forwardedPrefixHeader names the path prefix a reverse proxy mounts this
// server under. The machine server's proxy (`juggler serve`, a project's link
// /p/<key>/) sets it on every request it forwards, replacing any value the
// client sent.
const forwardedPrefixHeader = "X-Forwarded-Prefix"

// maxBasePathLen bounds an accepted base path.
const maxBasePathLen = 128

// basePathPattern admits a rooted path of plain segments with no trailing
// slash: letters, digits, '_' and '-' only. Nothing in it can close a quoted
// string or form a dot segment, so it is safe to template into a page verbatim.
var basePathPattern = regexp.MustCompile(`^(/[A-Za-z0-9_-]+)+$`)

// requestBasePath returns the path prefix the client addressed this server
// under: "" for a direct request, or the proxy's X-Forwarded-Prefix when it is
// a well-formed path. A malformed one is ignored. The header is not a
// credential — anyone can send one — so a forged value can only mis-address
// the page served to the forger.
func requestBasePath(r *http.Request) string {
	p := r.Header.Get(forwardedPrefixHeader)
	if len(p) > maxBasePathLen || !basePathPattern.MatchString(p) {
		return ""
	}
	return p
}
