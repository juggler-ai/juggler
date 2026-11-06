//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"

	"juggler/internal/lanfind"
	"juggler/web"
)

// fetch GETs url and returns status, headers and body.
func fetch(t *testing.T, url string) (int, http.Header, string) {
	t.Helper()
	resp, err := http.Get(url) //nolint:gosec,noctx // test server URL
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(body)
}

var (
	pageConfigPattern = regexp.MustCompile(`(?s)<script type="application/json" id="machine-config">(.*?)</script>`)
	pageRefPattern    = regexp.MustCompile(`(?:src|href)="(/[^"]*)"`)
	pageNoncePattern  = regexp.MustCompile(`<script nonce="([^"]+)">`)
)

// decodePageConfig decodes the configuration the sessions page carries for its
// script.
func decodePageConfig(t *testing.T, body string) map[string]any {
	t.Helper()
	m := pageConfigPattern.FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("sessions page carries no machine-config:\n%s", body)
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(m[1]), &cfg); err != nil {
		t.Fatalf("machine-config %q: %v", m[1], err)
	}
	return cfg
}

// TestSessionsPagePaintsTheMachinesTheme: the sessions page is handed the theme
// mode the user chose in Settings, as a session's page is, for when its viewer
// hands it none — and nothing for a mode that is not one.
func TestSessionsPagePaintsTheMachinesTheme(t *testing.T) {
	for mode, want := range map[string]string{"light": "light", "dark": "dark", "system": "system", "": "", "mauve": ""} {
		s := &Server{reg: newRegistry(), assets: web.Files, token: testToken,
			uiLocale: func() string { return "" }, themeMode: func() string { return mode }}
		front := httptest.NewServer(s.routes())
		_, _, body := fetch(t, front.URL+"/?window=1")
		front.Close()
		if !strings.Contains(body, `isMode("`+want+`") ? "`+want+`"`) {
			t.Errorf("with %q chosen, the page is not handed the mode %q", mode, want)
		}
	}
}

// TestSessionsPageWearsTheOpenersZoom: a desktop window opened from another
// hands its page the opener's UI zoom (?zoom=, cmd/juggler-app windowPageURL)
// beside its theme, and the sessions page applies it before the first paint
// as the root font size, within the range a session's page allows, as
// web/index.html does — so a new window opens at the scale of the one it was
// opened from.
func TestSessionsPageWearsTheOpenersZoom(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	_, _, body := fetch(t, front.URL+"/?window=1&theme=dark&mode=dark&zoom=130")
	for _, want := range []string{
		"parseInt(query.get('zoom'), 10)",
		"root.style.fontSize = Math.max(60, Math.min(160, zoom)) + '%'",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("the page does not apply the zoom it is handed: no %s", want)
		}
	}
}

// TestSessionsPageCarriesTheControlToken: GET / is the sessions page, and it
// hands its script the control-API token — the page is behind the Host guard
// and the LAN gate like everything else here, so whoever may load it may hold
// the token. The page is never cached, since it carries a secret that changes
// with every server process, and it runs under a CSP that admits only this
// origin and the page's own nonce'd inline script.
func TestSessionsPageCarriesTheControlToken(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	code, hdr, body := fetch(t, front.URL+"/")
	if code != http.StatusOK || !strings.HasPrefix(hdr.Get("Content-Type"), "text/html") {
		t.Fatalf("GET /: status %d, type %q", code, hdr.Get("Content-Type"))
	}
	if got := decodePageConfig(t, body)["token"]; got != testToken {
		t.Fatalf("page token = %v, want the server's", got)
	}
	if cc := hdr.Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	csp := hdr.Get("Content-Security-Policy")
	nonce := pageNoncePattern.FindStringSubmatch(body)
	if nonce == nil {
		t.Fatalf("page has no nonce'd inline script")
	}
	for _, want := range []string{"default-src 'self'", "script-src 'self' 'nonce-" + nonce[1] + "'", "frame-ancestors 'none'", "object-src 'none'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP %q lacks %q", csp, want)
		}
	}
	if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
		t.Errorf("CSP %q admits inline or eval'd script or style", csp)
	}

	// A second load gets a fresh nonce.
	_, _, again := fetch(t, front.URL+"/")
	if n2 := pageNoncePattern.FindStringSubmatch(again); n2 == nil || n2[1] == nonce[1] {
		t.Errorf("two loads of the page share the nonce %q", nonce[1])
	}
}

// TestSessionsPageSaysWhetherItsViewerIsLocal: the page tells its script whether
// it was loaded on this machine, which decides whether it offers the switches
// for LAN access and tunnels, and what opens when Juggler starts (only this
// machine may change them).
func TestSessionsPageSaysWhetherItsViewerIsLocal(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	s.lan.Store(true)
	for _, c := range []struct {
		caller string
		want   bool
	}{{"127.0.0.1:5000", true}, {"192.168.1.20:54321", false}} {
		front := httptest.NewServer(asCaller(c.caller, s.routes()))
		_, _, body := fetch(t, front.URL+"/")
		front.Close()
		if got := decodePageConfig(t, body)["local"]; got != c.want {
			t.Errorf("caller %s: config local = %v, want %v", c.caller, got, c.want)
		}
	}
}

// TestSessionsPageAdmitsTheDesktopWindowsControlEndpoint: a desktop app's
// window loads the page with its loopback control endpoint in ?nativeCtl=, and
// the page posts to it, so the CSP admits exactly that origin — and nothing
// for an endpoint off loopback, which no desktop app on this machine names.
func TestSessionsPageAdmitsTheDesktopWindowsControlEndpoint(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	connectSrc := func(nativeCtl string) string {
		t.Helper()
		_, hdr, _ := fetch(t, front.URL+"/?window=1&nativeCtl="+url.QueryEscape(nativeCtl))
		for _, d := range strings.Split(hdr.Get("Content-Security-Policy"), ";") {
			if d = strings.TrimSpace(d); strings.HasPrefix(d, "connect-src ") {
				return d
			}
		}
		return ""
	}
	if got := connectSrc("http://127.0.0.1:5555/s3cret/win/w1"); got != "connect-src 'self' http://127.0.0.1:5555" {
		t.Errorf("with a loopback control endpoint: %q, want it admitted", got)
	}
	if got := connectSrc("http://evil.example:5555/s3cret/win/w1"); got != "connect-src 'self'" {
		t.Errorf("with an endpoint off loopback: %q, want only 'self'", got)
	}
}

// TestSessionsPageWearsTheAppsWindowChrome: the page is drawn under the same
// header bar as a session's page — the app shell's stylesheets, its
// .app-header with the wordmark that opens the About box, the window-resize
// strip and the caption controls a frameless window closes by — so a desktop window showing it can
// be dragged by its header and clears the platform's window buttons. In a
// window it marks itself as one before the first paint, as web/index.html
// does, and loads the Wails runtime that turns --wails-draggable into a drag,
// which this server serves; a browser tab gets the same header but no runtime.
func TestSessionsPageWearsTheAppsWindowChrome(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	_, _, win := fetch(t, front.URL+"/?window=1&nativeCtl="+url.QueryEscape("http://127.0.0.1:5555/s3cret/win/w1"))
	_, _, tab := fetch(t, front.URL+"/")
	for name, body := range map[string]string{"window": win, "tab": tab} {
		for _, want := range []string{
			"/css/layout/app-shell.css", "/css/layout/window-chrome.css", "/css/layout/app-header.css",
			// What a drag may select: the header bar is chrome, never text.
			"/css/base/text-selection.css",
			`<header class="app-header">`, `<app-wordmark class="logo">`, `class="window-resize-strip"`,
			// The wordmark opens the About box, as on a session's page.
			"/js/components/app-wordmark.js", "/js/components/about-modal.js",
			"/css/components/about-modal.css", "<about-modal>",
			"<window-caption-controls>", "/js/components/window-caption-controls.js",
			"/js/utils/window-fullscreen.js", "/js/utils/window-edge-resize.js",
			"/js/utils/window-history-buttons.js", "/js/utils/window-resize-cursor.js", "/js/utils/window-shell-theme.js",
			"dataset.windowMode", "dataset.windowPlatform", "dataset.os", "--logo-with-name-url",
			// A window onto another computer's server (native-host.js).
			"dataset.externalServer",
			// The app's spinner, shown while the first list loads.
			"/css/patterns/spinner.css", "/js/components/juggler-spinner.js",
		} {
			if !strings.Contains(body, want) {
				t.Errorf("%s: the page has no %s", name, want)
			}
		}
	}
	if !strings.Contains(win, `src="/wails/runtime.js"`) {
		t.Errorf("window: the page does not load the Wails runtime")
	}
	if strings.Contains(tab, "/wails/runtime.js") {
		t.Errorf("tab: the page loads the Wails runtime outside a desktop window")
	}

	for _, m := range pageRefPattern.FindAllStringSubmatch(win, -1) {
		code, hdr, _ := fetch(t, front.URL+m[1])
		if code != http.StatusOK {
			t.Errorf("window: GET %s: status %d", m[1], code)
			continue
		}
		if ct := hdr.Get("Content-Type"); strings.HasSuffix(m[1], ".js") &&
			!strings.HasPrefix(ct, "text/javascript") && !strings.HasPrefix(ct, "application/javascript") {
			t.Errorf("window: GET %s: Content-Type %q, want JavaScript", m[1], ct)
		}
	}
}

// TestSessionsPageEmbedsUnderAnotherMachinesHeader: ?embed=1 is the sessions
// page as a desktop window on another computer frames it, below that window's
// own header (which names this server and switches between servers): its body
// alone, with no header bar and none of the chrome a top-level window wears,
// and framable by a page on the viewer's own loopback only. The page itself
// still refuses every frame, and /api/version says which embedded page this
// server serves, so the app frames only a server that has one.
func TestSessionsPageEmbedsUnderAnotherMachinesHeader(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	frameAncestors := func(hdr http.Header) string {
		for _, d := range strings.Split(hdr.Get("Content-Security-Policy"), ";") {
			if d = strings.TrimSpace(d); strings.HasPrefix(d, "frame-ancestors ") {
				return d
			}
		}
		return ""
	}
	ctl := url.QueryEscape("http://127.0.0.1:5555/s3cret/win/w1")
	_, hdr, body := fetch(t, front.URL+"/?embed=1&external=1&nativeCtl="+ctl)
	if got, want := frameAncestors(hdr), "frame-ancestors http://127.0.0.1:* http://localhost:* http://[::1]:*"; got != want {
		t.Errorf("embedded: %q, want %q", got, want)
	}
	for _, absent := range []string{`<header class="app-header">`, "<window-caption-controls>", "/wails/runtime.js",
		"/js/utils/window-edge-resize.js", `class="window-resize-strip"`} {
		if strings.Contains(body, absent) {
			t.Errorf("embedded: the page has %s, which belongs to the window framing it", absent)
		}
	}
	for _, want := range []string{`id="sessions-root"`, "/machine/sessions-page.js", "/css/tokens/scale.css", "dataset.externalServer"} {
		if !strings.Contains(body, want) {
			t.Errorf("embedded: the page has no %s", want)
		}
	}
	if decodePageConfig(t, body)["token"] != testToken {
		t.Error("embedded: the page is not handed the control token")
	}
	for _, d := range strings.Split(hdr.Get("Content-Security-Policy"), ";") {
		if d = strings.TrimSpace(d); strings.HasPrefix(d, "connect-src ") && d != "connect-src 'self' http://127.0.0.1:5555" {
			t.Errorf("embedded: %q, want its window's control endpoint admitted", d)
		}
	}

	for _, page := range []string{"/", "/?window=1"} {
		if _, hdr, _ := fetch(t, front.URL+page); frameAncestors(hdr) != "frame-ancestors 'none'" {
			t.Errorf("%s: %q, want no frame at all", page, frameAncestors(hdr))
		}
	}
	_, _, version := fetch(t, front.URL+"/api/version")
	if !strings.Contains(version, `"embedVersion":1`) {
		t.Errorf("GET /api/version = %s, want embedVersion 1", version)
	}
	host, _ := os.Hostname()
	if want := fmt.Sprintf(`"name":%q`, lanfind.InstanceName(host)); !strings.Contains(version, want) {
		t.Errorf("GET /api/version = %s, want %s, the name it is announced by", version, want)
	}
}

// TestSessionsPageFramesOnlyTheServerItIsAskedFor: a desktop window on another
// computer's server loads this page with ?server=<that server>, and frames that
// server's embedded page, so the CSP admits exactly that origin as a frame.
// Anything that is not an http(s) server address frames nothing, and a page
// without ?server= frames nothing at all.
func TestSessionsPageFramesOnlyTheServerItIsAskedFor(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	frameSrc := func(query string) string {
		t.Helper()
		_, hdr, _ := fetch(t, front.URL+"/?window=1"+query)
		for _, d := range strings.Split(hdr.Get("Content-Security-Policy"), ";") {
			if d = strings.TrimSpace(d); strings.HasPrefix(d, "frame-src ") {
				return d
			}
		}
		return ""
	}
	for query, want := range map[string]string{
		"&server=" + url.QueryEscape("http://devbox:3939"):          "frame-src http://devbox:3939",
		"&server=" + url.QueryEscape("https://box.example.com/x?y"): "frame-src https://box.example.com",
		"&server=" + url.QueryEscape("http://[fd00::9]:3939"):       "frame-src http://[fd00::9]:3939",
		"&server=" + url.QueryEscape("javascript:alert(1)"):         "frame-src 'none'",
		"&server=" + url.QueryEscape("http://a b;script-src *"):     "frame-src 'none'",
		"": "frame-src 'none'",
	} {
		if got := frameSrc(query); got != want {
			t.Errorf("%q: %q, want %q", query, got, want)
		}
	}
}

// moduleImportPattern finds a module's static imports, `import … from '…'`,
// `export … from '…'` and `import '…'`, each at the start of a line, so the
// import() types in JSDoc comments are not taken for one.
var moduleImportPattern = regexp.MustCompile(`(?m)^\s*(?:(?:import|export)\b[^;'"]*?\bfrom\s*|import\s*)['"]([^'"]+)['"]`)

// TestSessionsPageModulesResolveWithoutAnImportMap: the page has no import
// map, as a session's page does, so a bare specifier anywhere in the static
// import graph of a module it loads (a `juggler/*` SDK name, say) fails the
// whole module, and the page goes on without it, silently — the About box
// the wordmark opens once did. Every module the page loads is walked, over
// this server, and each import must be a path.
func TestSessionsPageModulesResolveWithoutAnImportMap(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	_, _, body := fetch(t, front.URL+"/")
	base, _ := url.Parse(front.URL + "/")
	var queue []string
	for _, m := range pageRefPattern.FindAllStringSubmatch(body, -1) {
		if strings.HasSuffix(m[1], ".js") && !strings.HasPrefix(m[1], "/wails/") {
			queue = append(queue, base.ResolveReference(&url.URL{Path: m[1]}).String())
		}
	}
	seen := map[string]bool{}
	for len(queue) > 0 {
		u := queue[0]
		queue = queue[1:]
		if seen[u] {
			continue
		}
		seen[u] = true
		code, _, src := fetch(t, u)
		if code != http.StatusOK {
			t.Errorf("GET %s: status %d", u, code)
			continue
		}
		from, _ := url.Parse(u)
		for _, m := range moduleImportPattern.FindAllStringSubmatch(src, -1) {
			spec := m[1]
			if !strings.HasPrefix(spec, ".") && !strings.HasPrefix(spec, "/") {
				t.Errorf("%s imports %q, which this page cannot resolve without an import map", from.Path, spec)
				continue
			}
			ref, err := url.Parse(spec)
			if err != nil {
				t.Errorf("%s imports %q: %v", from.Path, spec, err)
				continue
			}
			queue = append(queue, from.ResolveReference(ref).String())
		}
	}
	if len(seen) < 10 {
		t.Fatalf("walked %d modules; the page's graph is larger than that, so the walk is broken", len(seen))
	}
}

// TestSessionsPageAssetsResolve: everything the page loads is served from this
// server, with a JavaScript type for modules and a long-lived cache for the
// versioned paths (the version changes with the process).
func TestSessionsPageAssetsResolve(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	_, _, body := fetch(t, front.URL+"/")
	refs := pageRefPattern.FindAllStringSubmatch(body, -1)
	if len(refs) < 4 {
		t.Fatalf("page references %d assets, want its stylesheets, icon and script", len(refs))
	}
	sawModule := false
	for _, m := range refs {
		u := m[1]
		if !strings.HasPrefix(u, "/v"+assetVersion+"/") {
			t.Errorf("page references %q outside this process's versioned asset root", u)
			continue
		}
		code, hdr, _ := fetch(t, front.URL+u)
		if code != http.StatusOK {
			t.Errorf("GET %s: status %d", u, code)
			continue
		}
		if !strings.Contains(hdr.Get("Cache-Control"), "immutable") {
			t.Errorf("GET %s: Cache-Control %q, want immutable", u, hdr.Get("Cache-Control"))
		}
		if strings.HasSuffix(u, ".js") {
			sawModule = true
			if ct := hdr.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
				t.Errorf("GET %s: Content-Type %q, want text/javascript", u, ct)
			}
		}
	}
	if !sawModule {
		t.Errorf("page loads no script")
	}
}

// TestMachineServerServesOnlyItsAssetRoots: the versioned root serves the
// directories a page draws on, and nothing else of the tree — not the app's
// own page templates — and nothing under another version.
func TestMachineServerServesOnlyItsAssetRoots(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	v := "/v" + assetVersion
	for _, p := range []string{v + "/css/tokens/scale.css", v + "/machine/sessions-page.js", v + "/sdk/lib/i18n.js", v + "/js/utils/icons.js", v + "/resources/juggler-logo.svg"} {
		if code, _, _ := fetch(t, front.URL+p); code != http.StatusOK {
			t.Errorf("GET %s: status %d, want 200", p, code)
		}
	}
	for _, p := range []string{v + "/index.html", v + "/engine.html", v + "/machine/index.html", v + "/", "/vstale/css/tokens/scale.css", "/css/tokens/scale.css"} {
		if code, _, _ := fetch(t, front.URL+p); code != http.StatusNotFound {
			t.Errorf("GET %s: status %d, want 404", p, code)
		}
	}
}

// TestSessionsPageSpeaksTheChosenLanguage: the page is written in the UI
// language the user chose, with its catalogue inline, as a session's page is.
func TestSessionsPageSpeaksTheChosenLanguage(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "en-XA" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	_, _, body := fetch(t, front.URL+"/")
	if !strings.Contains(body, `<html lang="en-XA" data-ui-locale="en-XA"`) {
		t.Errorf("page does not declare en-XA:\n%.300s", body)
	}
	if !strings.Contains(body, `<script type="application/json" id="juggler-ui-catalog">{`) {
		t.Errorf("page carries no catalogue for en-XA")
	}

	s.uiLocale = func() string { return "" }
	_, _, plain := fetch(t, front.URL+"/")
	if !strings.Contains(plain, `<html lang="en">`) || strings.Contains(plain, "juggler-ui-catalog") {
		t.Errorf("with no language chosen the page should be plain English, with no catalogue")
	}
}
