//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"net/http"

	"juggler/cmd/juggler/core"
)

// testPageUILocale is the UI language a test server was asked to serve one page
// in, through ?uiLocale=<tag>, so a browser test can render the whole shell in
// a language without changing the setting every other page on that server
// reads. Only a test server (test.pageUILocale, set by RegisterTestRoutes) honours it;
// any other server answers ok=false whatever the URL says. An invalid tag is
// ignored. The page stays in that language when the setting changes
// (app.js, createUILocaleReloader's caller).
func (s *Server) testPageUILocale(r *http.Request) (locale string, ok bool) {
	if !s.test.pageUILocale {
		return "", false
	}
	q := r.URL.Query().Get("uiLocale")
	if q == "" || !core.IsValidUILocale(q) {
		return "", false
	}
	return core.NormalizeUILocale(q), true
}
