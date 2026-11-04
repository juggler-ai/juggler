//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"crypto/rand"
	"encoding/hex"
	"html/template"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/webui"
	"juggler/internal/jlog"
)

// The sessions page: GET / on the machine server. It lists the sessions this
// server runs and opens, stops and launches them through the control API. It is
// its own small page (web/machine/), drawing on the app's fonts, theme tokens,
// element defaults and shell — the header bar and a desktop window's chrome —
// from the asset tree, not the session client.
//
// The asset tree is the server's assets (ServeOptions.Assets), handed in by
// the binary that serves, so a client that links this package for Connect does
// not carry the tree with it.

// assetVersion names this process's versioned asset root, /v<assetVersion>/.
// It is fresh per process, so the root can be cached for good.
var assetVersion = mintAssetVersion()

func mintAssetVersion() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		panic("machineserver.mintAssetVersion: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// assetRoots are the directories of the web tree served under the versioned
// root: what the sessions page draws on, and nothing of the app's own pages.
var assetRoots = []string{"css", "js", "machine", "resources", "sdk"}

// pageTemplates are the sessions page's template in the web tree, and the
// desktop window's shell it shares with the app's own pages.
var pageTemplates = []string{"machine/index.html", "shell/window-shell.html"}

// assetHandler serves files of the web tree under /v<assetVersion>/, from
// assetRoots only. Directories and HTML (page templates) are not served, and a
// server with no assets serves none.
func (s *Server) assetHandler() http.Handler {
	if s.assets == nil {
		return http.NotFoundHandler()
	}
	tree := s.assets
	files := webui.AssetHandler(http.FileServer(http.FS(tree)))
	prefix := "/v" + assetVersion + "/"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, prefix)
		top, rest, _ := strings.Cut(rel, "/")
		if rest == "" || !slices.Contains(assetRoots, top) || strings.HasSuffix(rel, ".html") {
			http.NotFound(w, r)
			return
		}
		if info, err := fs.Stat(tree, rel); err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + rel
		r2.URL.RawPath = ""
		files.ServeHTTP(w, r2)
	})
}

// pageConfig is what the page hands its script, as JSON in the
// #machine-config element (web/machine/control-api.js, readPageConfig).
type pageConfig struct {
	// Token is the control-API credential. Delivering it in the page is safe
	// behind hostGuard and the LAN gate: whoever may load the page may drive
	// the control API anyway. readPageConfig is the one place the page's
	// script takes its credential from, so another delivery replaces both
	// ends of this field and nothing else.
	Token   string `json:"token"`
	Version string `json:"version"`
	Host    string `json:"host"`
	// Local is whether the page was loaded on this machine, which alone may
	// switch LAN access and tunnels and choose what opens at start
	// (localOnly). The page offers them only then; the routes refuse anyone
	// else whatever the page shows.
	Local bool `json:"local"`
	// Open is the project the page opens as it loads, when it is served at a
	// project's link whose session is not running (serveOpener); OpenMissing
	// is set instead when the link names no project this server knows of.
	Open        string `json:"open,omitempty"`
	OpenMissing bool   `json:"openMissing,omitempty"`
	// Confirm has the page ask before it opens Open: the visitor was sent
	// from another site (serveOpener).
	Confirm bool `json:"confirm,omitempty"`
}

// handlePage serves the sessions page. GET /.
func (s *Server) handlePage(w http.ResponseWriter, r *http.Request) {
	s.servePage(w, r, http.StatusOK, pageConfig{})
}

// servePage serves the sessions page with status, its config carrying what
// cfg sets of Open, OpenMissing and Confirm.
func (s *Server) servePage(w http.ResponseWriter, r *http.Request, status int, cfg pageConfig) {
	if s.assets == nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	tmpl, err := template.ParseFS(s.assets, pageTemplates...)
	if err != nil {
		jlog.Error("[machineserver] sessions page template: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	locale := ""
	if s.uiLocale != nil {
		locale = s.uiLocale()
	}
	lang := webui.SourceLocale
	var catalog map[string]string
	if locale != "" {
		lang = locale
		catalog = webui.LoadCatalog(func(p string) ([]byte, error) { return fs.ReadFile(s.assets, p) }, locale)
	}
	host, _ := os.Hostname()

	nonce := mintNonce()
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	// The page carries a secret that changes with every server process.
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	connectSrc := "connect-src 'self'"
	if ctl := nativeControlOrigin(r); ctl != "" {
		connectSrc += " " + ctl
	}
	frameSrc := "frame-src 'none'"
	if framed := framedServerOrigin(r); framed != "" {
		frameSrc = "frame-src " + framed
	}
	embed := r.URL.Query().Get("embed") == "1"
	frameAncestors := "frame-ancestors 'none'"
	if embed {
		frameAncestors = embedFrameAncestors
	}
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-"+nonce+"'; "+
		"style-src 'self'; img-src 'self' data:; font-src 'self'; "+connectSrc+"; "+
		"object-src 'none'; base-uri 'none'; form-action 'self'; "+frameSrc+"; "+frameAncestors)

	data := struct {
		AssetBase string
		// IsWindow is set when a desktop app's window shows the page
		// (?window=1): the page then loads the Wails runtime its header
		// drags the window by, which this server serves at its root
		// (WailsBase).
		IsWindow  bool
		WailsBase string
		// Embed is set when the page is framed under a desktop window's own
		// header on another computer (?embed=1, embedFrameAncestors): it is
		// then its body alone, with no header bar and none of a top-level
		// window's chrome, which that window wears.
		Embed bool
		// ThemeMode is the one the user chose, or empty to follow the
		// system's; Theme, a colour for a page with no mode, is never set.
		ThemeMode string
		Theme     string
		CSPNonce  string
		HTMLLang  string
		UILocale  string
		UICatalog map[string]string
		Config    pageConfig
	}{
		AssetBase: "/v" + assetVersion,
		IsWindow:  r.URL.Query().Has("window") && !embed,
		Embed:     embed,
		ThemeMode: s.pageThemeMode(),
		CSPNonce:  nonce,
		HTMLLang:  lang,
		UILocale:  locale,
		UICatalog: catalog,
		Config: pageConfig{Token: s.token, Version: core.Version, Host: host, Local: s.callerKind(r) == "",
			Open: cfg.Open, OpenMissing: cfg.OpenMissing, Confirm: cfg.Confirm},
	}
	w.WriteHeader(status)
	if err := tmpl.Execute(w, data); err != nil {
		jlog.Error("[machineserver] sessions page: %v", err)
	}
}

// embedVersion is the embedded sessions page this server serves (?embed=1),
// reported by GET /api/version: a desktop app on another computer frames the
// page of a server that reports the version it frames, and shows any other
// full-window.
const embedVersion = 1

// embedFrameAncestors is who may frame the embedded sessions page: a page on
// the viewer's own loopback, which is where a desktop app's sessions page is
// served from. The page is the sessions list a whole window would show, so
// framing it adds no power over this server to anyone who may load it.
const embedFrameAncestors = "frame-ancestors http://127.0.0.1:* http://localhost:* http://[::1]:*"

// framedHostPattern is what a server address's host may hold to be admitted
// into a CSP: names, IPv4 and bracketed IPv6 literals, and a port — nothing
// that could end the directive or start another.
var framedHostPattern = regexp.MustCompile(`^[A-Za-z0-9.\-]+(:[0-9]+)?$|^\[[0-9A-Fa-f:.]+\](:[0-9]+)?$`)

// framedServerOrigin is the scheme://host:port of the request's ?server=, when
// it names an http(s) server, else "". A desktop window on another computer's
// server loads this page with that server there and frames its embedded page
// (?embed=1), so the CSP admits that one origin as a frame, and no other.
func framedServerOrigin(r *http.Request) string {
	raw := r.URL.Query().Get("server")
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || !framedHostPattern.MatchString(u.Host) {
		return ""
	}
	return u.Scheme + "://" + strings.ToLower(u.Host)
}

// nativeControlOrigin is the scheme://host:port of the request's ?nativeCtl=
// when it names a loopback http(s) endpoint, else "". A desktop app's window
// loads the page with its own control endpoint there (web/sdk/lib/
// window-control.js), which the page posts to, so the CSP admits that origin —
// only on loopback, so a crafted link cannot open the page's CSP to any host.
func nativeControlOrigin(r *http.Request) string {
	raw := r.URL.Query().Get("nativeCtl")
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	if ip := net.ParseIP(u.Hostname()); u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// mintNonce returns a fresh CSP nonce for one page load. Hex, so the template
// writes it into the page byte for byte (base64's + would be escaped).
func mintNonce() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("machineserver.mintNonce: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// settingsUILocale is the UI language the user chose in settings, or "" for
// none. Read on every page load, so a language chosen in a session shows on
// the sessions page at its next load.
func settingsUILocale() string {
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		jlog.Error("[machineserver] reading settings for the UI language: %v", err)
	}
	return core.NormalizeUILocale(gs.UILocale)
}

// settingsThemeMode is the theme mode the user chose for this machine, or ""
// for none. Read on every page load, as the UI language is.
func settingsThemeMode() string {
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		jlog.Error("[machineserver] reading settings for the theme: %v", err)
	}
	return gs.UIThemeMode()
}

// pageThemeMode is the theme mode the sessions page paints before its first
// frame when its viewer hands it none (web/shell/window-shell.html): the one
// the user chose for this machine, or "" for none.
func (s *Server) pageThemeMode() string {
	if s.themeMode == nil {
		return ""
	}
	switch mode := s.themeMode(); mode {
	case "system", "light", "dark":
		return mode
	}
	return ""
}
