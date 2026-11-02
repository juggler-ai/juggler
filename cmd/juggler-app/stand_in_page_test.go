//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
)

var (
	standInRefPattern    = regexp.MustCompile(`(?:src|href)="(/[^"]*)"`)
	standInImportPattern = regexp.MustCompile(`(?m)^\s*(?:(?:import|export)\b[^;'"]*?\bfrom\s*|import\s*)['"]([^'"]+)['"]`)
	standInCSSURLPattern = regexp.MustCompile(`url\(\s*["']?([^"')]+)["']?\s*\)`)
)

// getControl GETs path — a path on the control endpoint, secret and all — as
// the stand-in's window would.
func getControl(a *appState, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	a.handleControl(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// standInPageOf loads window id's stand-in page the way its window does, from
// the URL the window is opened on.
func standInPageOf(t *testing.T, a *appState, id string) (*httptest.ResponseRecorder, string) {
	t.Helper()
	u, err := url.Parse(a.standInPageURL(id, controlSecretOf(a, id)))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(u.String(), "http://127.0.0.1:") {
		t.Fatalf("the stand-in opens on %s, not this app's control endpoint", u)
	}
	rec := getControl(a, u.RequestURI())
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("GET %s: status %d, type %q", u.RequestURI(), rec.Code, rec.Header().Get("Content-Type"))
	}
	return rec, rec.Body.String()
}

// TestAStandInWearsTheWindowShell: a stand-in's page is drawn under the same
// header bar as the sessions page — the shell's stylesheets, the resize strip,
// the caption buttons a frameless Windows or Linux window is closed by, and
// the Wails runtime its header drags the window by — marking itself a window
// before the first paint. It is served by the app, under the window's secret,
// in the window's theme, and runs under a CSP of its own origin and nonce.
func TestAStandInWearsTheWindowShell(t *testing.T) {
	a := newTestAppState(t)
	a.ctlPort = 5000
	e := registerStandIn(a, "w7", windowSpec{url: "http://devbox:8080", connected: true}, unreachableStandIn("http://dev<box>:8080"))
	a.reg(func(*regState) { e.currentTheme = "light" })

	rec, page := standInPageOf(t, a, "w7")
	for _, want := range []string{
		"/css/layout/app-shell.css", "/css/layout/window-chrome.css", "/css/layout/app-header.css",
		"/machine/sessions.css",
		`<header class="app-header">`, `class="window-resize-strip"`,
		"<window-caption-controls>", "/js/components/window-caption-controls.js",
		"/js/utils/window-fullscreen.js", "/js/utils/window-edge-resize.js",
		"dataset.windowMode", "dataset.windowPlatform", "--logo-with-name-url",
		"/wails/runtime.js",
		// The page's own words, escaped.
		"Can&#39;t reach the server", "dev&lt;box&gt;:8080",
	} {
		if !strings.Contains(page, want) {
			t.Errorf("the stand-in's page has no %s", want)
		}
	}
	if strings.Contains(page, "dev<box>") {
		t.Error("the address is shown unescaped")
	}
	if !strings.Contains(page, `var theme = "light"`) {
		t.Error("the page is not painted in its window's theme")
	}
	secret := controlSecretOf(a, "w7")
	for _, m := range standInRefPattern.FindAllStringSubmatch(page, -1) {
		if !strings.HasPrefix(m[1], "/"+secret+"/win/w7/") {
			t.Errorf("the page loads %s, which is not under its own window's secret", m[1])
		}
	}
	csp := rec.Header().Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'self'", "script-src 'self' 'nonce-", "form-action 'self'", "object-src 'none'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP %q lacks %q", csp, want)
		}
	}
	if strings.Contains(csp, "unsafe-inline") {
		t.Errorf("CSP %q admits inline script or style", csp)
	}
	if !strings.Contains(rec.Header().Get("Cache-Control"), "no-store") {
		t.Errorf("Cache-Control = %q, want no-store: the page carries its window's secret", rec.Header().Get("Cache-Control"))
	}
}

// TestStandInPageResolvesFromTheShell: everything the stand-in's page loads —
// its stylesheets and what they reference, the Wails runtime, and the whole
// static import graph of its modules — is served by the app, from web.Shell.
// That set is listed by hand, so a module that gains an import, or a sheet
// that gains a font, fails here rather than in a window that silently goes
// without its caption buttons.
func TestStandInPageResolvesFromTheShell(t *testing.T) {
	a := newTestAppState(t)
	a.ctlPort = 5000
	registerStandIn(a, "w7", windowSpec{project: "/p"}, lostServerStandIn())
	_, page := standInPageOf(t, a, "w7")

	queue := []string{}
	for _, m := range standInRefPattern.FindAllStringSubmatch(page, -1) {
		queue = append(queue, m[1])
	}
	seen := map[string]bool{}
	modules, sheets := 0, 0
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		if seen[p] {
			continue
		}
		seen[p] = true
		rec := getControl(a, p)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s: status %d", p, rec.Code)
			continue
		}
		from := &url.URL{Path: p}
		ct := rec.Header().Get("Content-Type")
		switch {
		case strings.HasSuffix(p, ".js"):
			if !strings.HasPrefix(ct, "text/javascript") && !strings.HasPrefix(ct, "application/javascript") {
				t.Errorf("GET %s: Content-Type %q, want JavaScript", p, ct)
			}
			if strings.Contains(p, "/wails/") {
				continue // the runtime bundle: one file, imports nothing
			}
			modules++
			for _, m := range standInImportPattern.FindAllStringSubmatch(rec.Body.String(), -1) {
				if !strings.HasPrefix(m[1], ".") {
					t.Errorf("%s imports %q, which the page cannot resolve without an import map", p, m[1])
					continue
				}
				queue = append(queue, from.ResolveReference(&url.URL{Path: m[1]}).Path)
			}
		case strings.HasSuffix(p, ".css"):
			sheets++
			for _, m := range standInCSSURLPattern.FindAllStringSubmatch(rec.Body.String(), -1) {
				if strings.HasPrefix(m[1], "data:") {
					continue
				}
				queue = append(queue, from.ResolveReference(&url.URL{Path: m[1]}).Path)
			}
		}
	}
	if modules < 10 || sheets < 10 {
		t.Fatalf("walked %d modules and %d sheets; the page's graph is larger than that, so the walk is broken", modules, sheets)
	}
}

// TestOnlyAStandInIsServedAPage: the control endpoint serves pages and assets
// to a stand-in's window, under its secret, and nothing else: without a secret
// a GET learns nothing, an ordinary window's secret is still good only for
// posts, and the shell's own templates are not files to be read.
func TestOnlyAStandInIsServedAPage(t *testing.T) {
	a := newTestAppState(t)
	a.ctlPort = 5000
	registerStandIn(a, "w7", windowSpec{project: "/p"}, lostServerStandIn())
	registerTestWindow(a, "w1")
	standIn := "/" + controlSecretOf(a, "w7") + "/win/w7"
	ordinary := "/" + controlSecretOf(a, "w1") + "/win/w1"

	for _, c := range []struct {
		path string
		want int
	}{
		{standIn + "/shell/css/tokens/scale.css", http.StatusOK},
		{"/not-a-secret/win/w7/page", http.StatusNotFound},
		{"/not-a-secret/win/w7/shell/css/tokens/scale.css", http.StatusNotFound},
		{ordinary + "/page", http.StatusMethodNotAllowed},
		{ordinary + "/shell/css/tokens/scale.css", http.StatusMethodNotAllowed},
		{standIn + "/shell/shell/stand-in.html", http.StatusNotFound},
		{standIn + "/shell/shell/window-shell.html", http.StatusNotFound},
		{standIn + "/shell/css/", http.StatusNotFound},
		{standIn + "/shell/index.html", http.StatusNotFound},
		{standIn + "/shell/js/app.js", http.StatusNotFound},
		{standIn + "/retry-server", http.StatusMethodNotAllowed},
		{"/" + controlSecretOf(a, "w7") + "/win/w1/page", http.StatusNotFound},
	} {
		if rec := getControl(a, c.path); rec.Code != c.want {
			t.Errorf("GET %s: status %d, want %d", c.path, rec.Code, c.want)
		}
	}
}
