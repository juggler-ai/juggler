//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
)

// TestRequestBasePath pins which forwarded prefixes a page may be served
// under: nothing for a direct request, a well-formed path of plain segments
// from a proxy, and nothing for anything else — so a forged header can at
// worst mis-address the forger's own page, never inject into it.
func TestRequestBasePath(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"", ""},
		{"/s/81fb48e2", "/s/81fb48e2"},
		{"/a/b_c-d", "/a/b_c-d"},
		{"s/81fb48e2", ""},     // not rooted
		{"/s/81fb48e2/", ""},   // trailing slash
		{"//evil.example", ""}, // protocol-relative
		{"/s/../x", ""},
		{"/s/a b", ""},
		{"/s/x'", ""},
		{"/s/<script>", ""},
		{"/" + strings.Repeat("a", maxBasePathLen), ""},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if c.header != "" {
			req.Header.Set(forwardedPrefixHeader, c.header)
		}
		if got := requestBasePath(req); got != c.want {
			t.Errorf("requestBasePath(%q) = %q, want %q", c.header, got, c.want)
		}
	}
}

// pageBasePattern finds the base path a served page hands its scripts. The
// index is rendered by html/template, which escapes '/' inside a JS string.
var pageBasePattern = regexp.MustCompile(`window\.__jugglerBase = '([^']*)';`)

func pageBase(t *testing.T, body string) string {
	t.Helper()
	m := pageBasePattern.FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("page does not set window.__jugglerBase")
	}
	return strings.ReplaceAll(m[1], `\/`, "/")
}

// TestServedPagesCarryTheBasePath checks both served pages hand their scripts
// the base path of the request that loaded them: empty when reached directly,
// the proxy's prefix when reached through one. Each is loaded both as a
// browser tab loads it and as a desktop window does (?window=1), because the
// window's page carries references a tab's does not — the Wails runtime, which
// is what turns the header into the window's drag region.
func TestServedPagesCarryTheBasePath(t *testing.T) {
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s := &Server{router: mux.NewRouter(), apiToken: testAPIToken, staticVersion: "test-static-version"}
	s.projectState.Store(&projectState{sessionManager: mgr, projectPath: t.TempDir()})
	if err := s.loadIndexTemplate(); err != nil {
		t.Fatalf("loadIndexTemplate: %v", err)
	}

	pages := map[string]func(http.ResponseWriter, *http.Request){
		"index":  s.serveIndex,
		"engine": s.serveEngine,
	}
	for name, serve := range pages {
		for _, target := range []string{"/", "/?window=1"} {
			for _, prefix := range []string{"", "/s/81fb48e2"} {
				req := httptest.NewRequest(http.MethodGet, target, nil)
				req.RemoteAddr = localViewerAddr
				if prefix != "" {
					req.Header.Set(forwardedPrefixHeader, prefix)
				}
				rec := httptest.NewRecorder()
				serve(rec, req)
				if rec.Code != http.StatusOK {
					t.Fatalf("%s %s: status %d", name, target, rec.Code)
				}
				body := rec.Body.String()
				if got := pageBase(t, body); got != prefix {
					t.Errorf("%s %s served under %q sets base %q", name, target, prefix, got)
				}
				for _, u := range pageServerURLs(body) {
					if !strings.HasPrefix(u, prefix+"/") {
						t.Errorf("%s %s served under %q references %q outside its base", name, target, prefix, u)
					}
				}
			}
		}
	}
}

// pageServerRefPattern finds the server-relative URLs a page loads: src and
// href attributes, import-map entries, and the asset prefix its scripts build
// module URLs from. Protocol-relative and external URLs don't match.
var pageServerRefPattern = regexp.MustCompile(
	`(?:src|href)="(/[^/"][^"]*)"` +
		`|"juggler/[^"]+":\s*"(/[^/"][^"]*)"` +
		`|__assetPrefix = '([^']*)'` +
		`|url\('(/[^/'][^']*)'\)`)

// pageServerURLs returns every server-relative URL pageServerRefPattern finds,
// with html/template's JS-string escaping of '/' undone.
func pageServerURLs(body string) []string {
	var out []string
	for _, m := range pageServerRefPattern.FindAllStringSubmatch(body, -1) {
		for _, g := range m[1:] {
			if g != "" {
				out = append(out, strings.ReplaceAll(g, `\/`, "/"))
			}
		}
	}
	return out
}
