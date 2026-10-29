//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/webui"
	"juggler/internal/jlog"
	"juggler/internal/srcroot"
	"juggler/web"
)

// generateCSPNonce returns a fresh per-response base64 nonce for inline scripts.
func generateCSPNonce() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(b[:])
}

// setHTMLSecurityHeaders writes the Content-Security-Policy and related
// hardening headers for HTML responses. The nonce is consumed by the
// {{.CSPNonce}} placeholders in the template's inline <script> blocks.
func setHTMLSecurityHeaders(w http.ResponseWriter, nonce string) {
	setHTMLSecurityHeadersFramed(w, nonce, false, "")
}

// setHTMLSecurityHeadersFramed is like setHTMLSecurityHeaders but allows the
// page to be embedded as a same-origin frame (used by the test-pool host page
// to tile N copies of /headless-test in iframes) and to widen connect-src by
// one extra origin (extraConnect, empty for none). The extra origin is the
// desktop app's loopback window-control endpoint: when the app opens a window
// it serves the page from the server's origin but the page must POST window
// controls to the app's own loopback port, which 'self' would block.
func setHTMLSecurityHeadersFramed(w http.ResponseWriter, nonce string, sameOriginFrameable bool, extraConnect string) {
	frameAncestors := "frame-ancestors 'none'"
	if sameOriginFrameable {
		frameAncestors = "frame-ancestors 'self'"
	}
	connectSrc := "connect-src 'self' ws: wss:"
	if extraConnect != "" {
		connectSrc += " " + extraConnect
	}
	// Extensions embed local dev servers in an iframe — a Cmajor patch GUI, a docs
	// preview, a Storybook — and default-src 'self' refuses every one of them, so
	// loopback is named here and nothing else is. Two things to be clear about:
	// framing a document is a wider permission than the ws:/wss: connect-src
	// above, not a narrower one, and loopback means the loopback of whichever
	// machine renders the page, so a browser attached over the network resolves
	// these against its own — which is a thing the viewer could have opened in a
	// tab anyway, and which an https page refuses as mixed content regardless.
	// What may frame Juggler is a separate question, answered by frame-ancestors
	// below, and the answer there is nothing.
	frameSrc := "frame-src 'self' " +
		"http://127.0.0.1:* http://localhost:* http://[::1]:* " +
		"https://127.0.0.1:* https://localhost:* https://[::1]:*"
	csp := "default-src 'self'; " +
		"script-src 'self' 'nonce-" + nonce + "'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; " +
		// The media file viewer plays from the content route, or from a blob of
		// the bytes for a file outside the project, which that route refuses.
		"media-src 'self' blob:; " +
		"font-src 'self' data:; " +
		connectSrc + "; " +
		frameSrc + "; " +
		"object-src 'none'; " +
		"base-uri 'self'; " +
		frameAncestors
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

// nativeControlOrigin returns the scheme://host:port of the request's
// `nativeCtl` query param when it is an http(s) loopback URL, else "". The
// desktop app passes its loopback control endpoint here; we widen the served
// page's connect-src to exactly that origin so window-control POSTs succeed.
// Restricted to loopback so a crafted ?nativeCtl on a remote browser cannot
// open that page's CSP to an arbitrary host.
func nativeControlOrigin(r *http.Request) string {
	raw := r.URL.Query().Get("nativeCtl")
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	ip := net.ParseIP(u.Hostname())
	if u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// requestOrigin returns the scheme://host:port the client used to reach this
// server, derived from the request (Host header + TLS state). Used to add the
// server's own origin to the sandbox CSP for the blob-URL worker (see
// setSandboxSecurityHeaders).
func requestOrigin(r *http.Request) string {
	if r.Host == "" {
		return ""
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// setSandboxSecurityHeaders writes the Content-Security-Policy for the host
// sandbox iframe (juggler/sandbox). Isolation is provided by the parent
// loading the iframe with `sandbox="allow-scripts"` (no allow-same-origin),
// so even hostile code has no DOM/storage/cookie access to the main page —
// only the explicit RPC channel. The nested sandbox worker the iframe spawns
// inherits this opaque origin, so it is isolated the same way.
//
// frame-ancestors 'self' ensures only same-origin parents can embed the
// sandbox; default-src 'none' denies anything not explicitly permitted.
//
// selfOrigin is the server's own scheme://host:port (e.g. http://127.0.0.1:PORT).
// It is added to script-src explicitly because the nested worker runs from a
// blob: URL: in that worker's CSP context 'self' resolves to the worker's opaque
// origin (NOT the http host the way it does for the http-loaded iframe), so
// 'self' alone would block the worker from `import()`ing the absolute-project-
// path modules user code pulls in. The explicit origin re-permits exactly those
// cross-origin (opaque-to-host) module loads (CORS-gated by ACAO=*).
func setSandboxSecurityHeaders(w http.ResponseWriter, nonce, selfOrigin string) {
	// script-src covers the absolute-project-path modules user code `import()`s,
	// fetched cross-origin with ACAO=* from the opaque-origin worker. The nonce
	// covers this HTML's inline script. worker-src 'self' blob: permits spawning
	// the nested worker, which is created from a blob: URL whose source is inlined
	// in the iframe (a worker script must be same-origin with its creating
	// context; the opaque-origin frame has no same-origin http URL but a blob:
	// URL it mints is same-origin to it; a cross-origin served module worker does
	// not load in WebKit). 'unsafe-eval' is load-bearing in the worker, which
	// compiles user code via the Function constructor (the worker inherits this
	// CSP, having no CSP of its own).
	scriptSrc := "script-src 'self' 'nonce-" + nonce + "' 'unsafe-eval'"
	if selfOrigin != "" {
		scriptSrc += " " + selfOrigin
	}
	csp := "default-src 'none'; " +
		scriptSrc + "; " +
		"worker-src 'self' blob:; " +
		"connect-src 'self'; " +
		"frame-ancestors 'self'; " +
		"base-uri 'none'"
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

// corsMiddleware adds CORS headers. Cross-Origin-Resource-Policy is set
// to cross-origin so the query_code sandbox iframe — which runs with an
// opaque/null origin (no allow-same-origin) — can fetch and `import()`
// static assets served by this handler. ACAO=* alone permits the load
// against the CORS check; CORP is a separate, stricter gate WebKit
// enforces on module loads from opaque-origin readers.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The permissive ACAO:* + CORP:cross-origin exists ONLY so the
		// query_code sandbox iframe (opaque/null origin) can fetch and
		// import() static module assets. The /api surface is same-origin — a
		// wildcard ACAO there would let any website read tool/provider/session
		// responses, so scope the permissive headers to non-/api (static asset)
		// routes only (§S.3). A cross-origin /api request therefore fails the
		// browser's CORS check even before the token middleware sees it.
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")

			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

// loadIndexTemplate loads the index.html template for cache busting
func (s *Server) loadIndexTemplate() error {
	var tmplContent string

	if s.assetsFromDisk {
		// Assets-from-disk: load from disk
		staticDir, err := s.findStaticDir()
		if err != nil {
			return fmt.Errorf("failed to find static dir: %w", err)
		}
		indexPath := filepath.Join(staticDir, "index.html")
		content, err := os.ReadFile(indexPath)
		if err != nil {
			return fmt.Errorf("failed to read index.html: %w", err)
		}
		tmplContent = string(content)
	} else {
		// In production, load from embedded files
		content, err := web.Files.ReadFile("index.html")
		if err != nil {
			return fmt.Errorf("failed to read embedded index.html: %w", err)
		}
		tmplContent = string(content)
	}

	// Parse template
	tmpl, err := template.New("index").Parse(tmplContent)
	if err != nil {
		return fmt.Errorf("failed to parse template: %w", err)
	}

	s.indexTemplate = tmpl
	return nil
}

// readWebAsset reads a static asset by its forward-slash path relative to the
// web root. When assets-from-disk is active it reads from the on-disk web dir
// (so live edits take effect) and falls back to the embedded copy on any miss;
// otherwise it reads straight from fallbackFS. relPath is used verbatim as the
// embedded FS key and, split on '/', as the on-disk path segments.
func (s *Server) readWebAsset(relPath string, fallbackFS fs.FS) ([]byte, error) {
	if s.assetsFromDisk {
		if staticDir, derr := s.findStaticDir(); derr == nil {
			segs := append([]string{staticDir}, strings.Split(relPath, "/")...)
			if content, rerr := os.ReadFile(filepath.Join(segs...)); rerr == nil {
				return content, nil
			}
		}
	}
	return fs.ReadFile(fallbackFS, relPath)
}

// serveTemplatedHTML writes body as a no-cache HTML response after substituting
// each {{.Key}} placeholder with its value — a lightweight stand-in for
// html/template used by the static pages that only need literal string
// substitution. setHeaders installs the page-specific security headers.
func serveTemplatedHTML(w http.ResponseWriter, body string, vars map[string]string, setHeaders func()) {
	for k, v := range vars {
		body = strings.ReplaceAll(body, "{{."+k+"}}", v)
	}
	setHeaders()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")
	_, _ = w.Write([]byte(body))
}

// serveEngine serves the engine page for the hidden headless browser.
// External access is harmless — the engine page only exposes a WS upgrade
// path which is itself loopback-gated in handleWebSocket.
func (s *Server) serveEngine(w http.ResponseWriter, r *http.Request) {
	content, err := s.readWebAsset("engine.html", web.Files)
	if err != nil {
		http.Error(w, "Engine page not found", http.StatusNotFound)
		return
	}

	nonce := generateCSPNonce()
	serveTemplatedHTML(w, string(content), map[string]string{
		"StaticVersion": s.staticVersion,
		"CSPNonce":      nonce,
		"APIToken":      s.apiToken,
		// Safe to substitute unescaped: requestBasePath admits only plain
		// path segments.
		"BasePath": requestBasePath(r),
	}, func() { setHTMLSecurityHeaders(w, nonce) })
}

// serveSandbox serves the host sandbox page (juggler/sandbox). The page runs
// untrusted code inside a sandboxed iframe with its own CSP, isolating it from
// the host page. See setSandboxSecurityHeaders for the served CSP.
func (s *Server) serveSandbox(w http.ResponseWriter, r *http.Request) {
	content, err := s.readWebAsset("sandbox.html", web.Files)
	if err != nil {
		http.Error(w, "Sandbox page not found", http.StatusNotFound)
		return
	}

	nonce := generateCSPNonce()
	// projectRoot is the user-visible absolute path the LLM thinks in
	// (e.g. "/Users/jules/code/juggler"). The sandbox's import map
	// rewrites "<projectRoot>/web/" → "/v<ver>/" so dynamic imports of
	// absolute project paths resolve to the same-origin static handler.
	// Empty projectRoot leaves the mapping as "/web/" → "/v<ver>/", which
	// is harmless — no caller imports starting with bare "/web/".
	// Forward slashes even on Windows: the sandbox is entirely POSIX-path based
	// (its path module uses '/'), and every other tool result is normalised the
	// same way, so a backslash projectRoot would mismatch when joined or prefix-
	// stripped against those forward-slash paths.
	projectRoot := filepath.ToSlash(s.ProjectPath())
	serveTemplatedHTML(w, string(content), map[string]string{
		"CSPNonce":      nonce,
		"StaticVersion": s.staticVersion,
		"ProjectRoot":   template.JSEscapeString(projectRoot),
	}, func() { setSandboxSecurityHeaders(w, nonce, requestOrigin(r)) })
}

// serveFavicon serves the logo SVG directly as the favicon. Serving the bytes
// (rather than 301-redirecting to the versioned asset path) is robust across
// every transport: a fetch/service-worker context that doesn't follow a
// cross-path redirect — a request a rendezvous page tunnels over a data
// channel — still gets the icon.
func (s *Server) serveFavicon(w http.ResponseWriter, r *http.Request) {
	content, err := s.readWebAsset("resources/juggler-logo.svg", web.Files)
	if err != nil {
		http.Error(w, "favicon not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
	_, _ = w.Write(content)
}

// projectStorageKeyLen is how much of the path hash the viewer's storage key
// carries: 8 bytes, plenty to separate one user's project folders.
const projectStorageKeyLen = 16

// projectStorageKey derives an opaque, stable per-project key that the viewer
// uses to namespace its own localStorage.
//
// The page origin identifies the machine server, not a project: every session
// it runs is served from that one origin under /s/<id>/, so a bare key can hold
// the value another project left behind; and a viewer reaching the server over
// the studio relay sees a single origin for every project on every machine it
// connects to. Keyed by this, a cached preference belongs to
// the project it was set in.
//
// It hashes the path rather than carrying it because the key is visible in a
// localStorage that origin shares with other pages, and where a project lives is
// nobody else's business. Empty for an empty path, where the viewer falls back
// to the bare key.
func projectStorageKey(projectPath string) string {
	if projectPath == "" {
		return ""
	}
	abs := projectPath
	if a, err := filepath.Abs(projectPath); err == nil {
		abs = a
	}
	sum := sha256.Sum256([]byte(filepath.Clean(abs)))
	return hex.EncodeToString(sum[:])[:projectStorageKeyLen]
}

// The names the viewer stores the theme mode and the UI zoom under in the
// machine realm of settings.json's ui section (web/js/utils/theme-manager.js,
// zoom-manager.js). The page applies both before its first paint, so this
// server reads them to inject them; nothing else in Go does.
const (
	machineThemePref = "juggler-theme"
	machineZoomPref  = "juggler-zoom"
)

// machineAppearance is the theme mode (system|light|dark) and UI zoom (root
// font-size %) the viewer stored for this machine, or ""/0 for either it has
// not stored or stored as something unusable. A server without a settings store
// (a bare test server) has none.
func (s *Server) machineAppearance() (themeMode string, zoom int) {
	if s.settings == nil {
		return "", 0
	}
	ui := s.settings.get().UI
	if raw, ok := ui[machineThemePref]; ok {
		var mode string
		if json.Unmarshal(raw, &mode) == nil && (mode == "system" || mode == "light" || mode == "dark") {
			themeMode = mode
		}
	}
	if raw, ok := ui[machineZoomPref]; ok {
		var z int
		if json.Unmarshal(raw, &z) == nil && z > 0 {
			zoom = z
		}
	}
	return themeMode, zoom
}

// serveIndex serves the index.html template
func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	// Reload template from disk on each request when serving assets from disk
	if s.assetsFromDisk {
		if err := s.loadIndexTemplate(); err != nil {
			jlog.Error("Error reloading template: %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
	}

	nonce := generateCSPNonce()
	// A test server lets a browser test host the whole shell in a same-origin
	// frame (see testPageUILocale); every other server lets nothing frame it.
	setHTMLSecurityHeadersFramed(w, nonce, s.test.frameableIndex, nativeControlOrigin(r))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")

	// The machine's UI theme mode and zoom (root font-size %), from the machine
	// realm of settings.json, or ""/0 when it has none. Injected so the page
	// paints in the right colour and at the right scale on the very first frame —
	// a font-size change reflows the whole UI, so a late correction is a visible
	// jump. They are the settings of this machine's own desktop windows. A
	// remote viewer is sent them too, so a phone opens the way the desktop looks
	// rather than at a stock default, but there they rank below the device's own
	// stored preference and the device never writes back (see
	// web/js/utils/theme-manager.js and zoom-manager.js).
	machineThemeMode, machineZoom := s.machineAppearance()

	// What this project's session stored, offered to the server's own window
	// only while the machine has nothing: that window adopts it for the machine
	// once, so the look a project was left in carries over.
	var projectThemeMode string
	var projectZoom int
	if machineThemeMode == "" {
		projectThemeMode, _ = s.SessionManager().GetUITheme()
	}
	if machineZoom == 0 {
		projectZoom, _ = s.SessionManager().GetUIZoom()
	}

	// The UI language, and its catalogue inline, so the first frame is already
	// in that language (see ui_locale.go). Unlike theme and zoom it is the
	// person's rather than the window's, so every window and every remote
	// viewer gets the same one. With none chosen the page is plain English and
	// carries no catalogue at all.
	uiLocale := s.uiLocale()
	pinned, uiLocalePinned := s.testPageUILocale(r)
	if uiLocalePinned {
		uiLocale = pinned
	}
	htmlLang := webui.SourceLocale
	var uiCatalog map[string]string
	if uiLocale != "" {
		htmlLang = uiLocale
		uiCatalog = s.uiCatalog(uiLocale)
	}

	data := struct {
		StaticVersion    string
		HarnessPage      bool
		IsDevMode        bool
		IsWindowMode     bool
		RemoteViewer     bool
		CSPNonce         string
		APIToken         string
		BasePath         string
		MachineZoom      int
		MachineThemeMode string
		ProjectZoom      int
		ProjectThemeMode string
		HTMLLang         string
		UILocale         string
		UILocalePinned   bool
		UICatalog        map[string]string
		ProjectKey       string
	}{
		StaticVersion: s.staticVersion,
		HarnessPage:   s.test.harnessPage,
		IsDevMode:     s.devMode,
		APIToken:      s.apiToken,
		// Where the client mounted this server: "" directly, /s/<id> behind
		// the machine server's session proxy.
		BasePath:         requestBasePath(r),
		MachineZoom:      machineZoom,
		MachineThemeMode: machineThemeMode,
		ProjectZoom:      projectZoom,
		ProjectThemeMode: projectThemeMode,
		HTMLLang:         htmlLang,
		UILocale:         uiLocale,
		// The page keeps this language when the setting changes (app.js).
		UILocalePinned: uiLocalePinned,
		UICatalog:      uiCatalog,
		// Namespaces the viewer's localStorage so a cached zoom/theme belongs to
		// the project it was set in, whichever origin the viewer arrived on.
		ProjectKey: projectStorageKey(s.ProjectPath()),
		// The desktop app opens the page with ?window=1; remote browsers never
		// have it. Mirrors the client-side check in index.html and gates the
		// Wails runtime <script>, which only does anything in a native window.
		IsWindowMode: r.URL.Query().Has("window"),
		// Whether the page is viewing this server from another machine. A native
		// window can be (the desktop app's Connect to Server), and then the UI
		// preferences it changes are its own, not this machine's. Decided by the
		// test localViewerOnly applies to their writes, so the page never
		// believes it owns what the server will refuse it.
		RemoteViewer: !isLocalDirect(r),
		CSPNonce:     nonce,
	}

	if err := s.indexTemplate.Execute(w, data); err != nil {
		jlog.Error("Error executing template: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
	}
}

// findWebDir finds the web directory for dev mode (package-level, used during server creation)
func findWebDir() string {
	projectRoot, err := srcroot.Find("")
	if err != nil {
		return ""
	}

	webPath := filepath.Join(projectRoot, "web")
	if _, err := os.Stat(webPath); err == nil {
		return webPath
	}

	return ""
}

// findStaticDir finds the static directory by looking for the juggler project root.
// Falls back to bootProjectPath when ProjectPath is empty.
func (s *Server) findStaticDir() (string, error) {
	root := s.ProjectPath()
	if root == "" {
		root = s.bootProjectPath
	}
	projectRoot, err := srcroot.Find(root)
	if err != nil {
		return "", err
	}

	webPath := filepath.Join(projectRoot, "web")
	if _, err := os.Stat(webPath); err == nil {
		return webPath, nil
	}

	return "", fmt.Errorf("project root found at %s but web dir missing", projectRoot)
}

// cacheControlMiddleware adds appropriate cache headers based on file type
func (s *Server) cacheControlMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// Skip API routes and the index (they have their own cache headers)
		if strings.HasPrefix(path, "/api/") || path == "/" {
			next.ServeHTTP(w, r)
			return
		}

		// Versioned paths get immutable caching (the version changes on each deploy)
		if strings.HasPrefix(path, "/v"+s.staticVersion+"/") {
			if !s.assetsFromDisk {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			next.ServeHTTP(w, r)
			return
		}

		// Non-versioned paths: live-reload (assets-from-disk) vs production
		if s.assetsFromDisk {
			if strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".css") {
				w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
				w.Header().Set("Pragma", "no-cache")
				w.Header().Set("Expires", "0")
			}
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
		}

		next.ServeHTTP(w, r)
	})
}
