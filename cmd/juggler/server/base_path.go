//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"

	"juggler/internal/basepath"
)

// requestBasePath returns the path prefix the client addressed this server
// under: "" for a direct request, or the proxy's X-Forwarded-Prefix when it is
// a well-formed path (basepath.FromRequest). The machine server's proxy
// (`juggler serve`, a project's link /p/<key>/) sets it on every request it
// forwards, replacing any value the client sent.
func requestBasePath(r *http.Request) string {
	return basepath.FromRequest(r)
}
