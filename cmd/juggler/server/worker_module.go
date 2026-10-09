//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"juggler/web"
)

var workerModuleImportRe = regexp.MustCompile(`(?m)(\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?|\bimport\s*\(\s*)(['"])([^'"]+)(['"])`)

var workerSDKImports = map[string]string{
	"juggler/context-item":           "/sdk/context-item.js",
	"juggler/strategy-type":          "/sdk/strategy-type.js",
	"juggler/command-type":           "/sdk/command-type.js",
	"juggler/info-card-type":         "/sdk/info-card-type.js",
	"juggler/pinboard":               "/sdk/pinboard.js",
	"juggler/pinboard-item-type":     "/sdk/pinboard-item-type.js",
	"juggler/file-viewer":            "/sdk/file-viewer.js",
	"juggler/workspace-provider":     "/sdk/workspace-provider.js",
	"juggler/hook-type":              "/sdk/hook-type.js",
	"juggler/file-source":            "/sdk/file-source.js",
	"juggler/ops":                    "/sdk/ops.js",
	"juggler/sandbox":                "/sdk/sandbox.js",
	"juggler/ui":                     "/sdk/ui-worker.js",
	"juggler/model":                  "/sdk/model.js",
	"juggler/item-utils":             "/sdk/item-utils-worker.js",
	"juggler/registry":               "/sdk/registry.js",
	"juggler/version":                "/sdk/version.js",
	"juggler/utils/html":             "/sdk/lib/html.js",
	"juggler/utils/path-containment": "/sdk/lib/path-containment.js",
}

// serveWorkerModule serves a JS module transformed for module-worker imports.
// Workers do not inherit the document import map, so extension modules that use
// the public `juggler/*` SDK specifiers need those imports rewritten to concrete
// URLs. Relative imports are also routed back through this handler so nested
// extension modules receive the same treatment.
func (s *Server) serveWorkerModule(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" || !strings.HasPrefix(rawURL, "/") || strings.Contains(rawURL, "..") {
		http.Error(w, "invalid module url", http.StatusBadRequest)
		return
	}

	content, err := s.readWorkerModule(rawURL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	source := s.rewriteWorkerModuleImports(rawURL, string(content))
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")
	_, _ = w.Write([]byte(source))
}

func (s *Server) readWorkerModule(moduleURL string) ([]byte, error) {
	path := moduleURL
	vPrefix := "/v" + s.staticVersion
	if strings.HasPrefix(path, vPrefix+"/") {
		path = strings.TrimPrefix(path, vPrefix)
	}
	path = strings.TrimPrefix(path, "/")

	// User extensions live on disk under ExtensionsAPI.UserExtensionDir(), served
	// to the viewer by the /user-extensions/ static route (http.Dir). The engine
	// worker has no import map, so it fetches the SAME capability URLs through
	// this loader — which otherwise only sees embedded/static assets and would
	// 404 a discovered /user-extensions/ module, leaving it unloaded in the
	// engine. Resolve those URLs against the container here, matching
	// http.Dir's semantics exactly so the two loaders agree: reject lexical ".."
	// traversal, then read while FOLLOWING symlinks — `juggler ext link` symlinks
	// an extension's whole subdir out of the container, and both routes must load
	// it identically.
	const userExtPrefix = "user-extensions/"
	if strings.HasPrefix(path, userExtPrefix) {
		var userDir string
		if s.extensionsAPI != nil {
			userDir = s.extensionsAPI.UserExtensionDir()
		}
		if userDir == "" {
			return nil, fmt.Errorf("user extension directory is unavailable")
		}
		rel := trimUserExtEpoch(strings.TrimPrefix(path, userExtPrefix))
		if rel == "" || hasDotDotSegment(rel) {
			return nil, fmt.Errorf("invalid user extension module path: %q", rel)
		}
		return os.ReadFile(filepath.Join(userDir, filepath.FromSlash(rel)))
	}

	if s.assetsFromDisk {
		if staticDir, err := s.findStaticDir(); err == nil {
			if content, err := os.ReadFile(filepath.Join(staticDir, filepath.FromSlash(path))); err == nil {
				return content, nil
			}
		}
	}
	return web.Files.ReadFile(path)
}

// userExtEpochRe matches the leading reload-epoch segment ("e12/") of a
// container-relative user-extension path.
var userExtEpochRe = regexp.MustCompile(`^e\d+/`)

// trimUserExtEpoch removes the leading reload-epoch segment from a
// container-relative user-extension path. Served URLs carry the epoch (minted by
// handlers.ExtensionsAPI.UserExtensionURLPrefix) purely to give the browser's
// URL-keyed ES module cache a new key after an edit; no such directory exists on
// disk, so both the static route and this loader strip it before resolving
// against the container. A path with no epoch segment is returned unchanged —
// the one consequence being that a user extension directory literally named
// "e<digits>" at the container root is unreachable without one.
func trimUserExtEpoch(rel string) string {
	return userExtEpochRe.ReplaceAllString(rel, "")
}

// stripUserExtEpoch wraps h so the reload-epoch segment is removed from the
// request path first. It sits between the /user-extensions/ prefix strip and the
// file server, which resolves what is left against the container on disk. The
// request is copied rather than mutated in place, as net/http's own
// StripPrefix does.
func stripUserExtEpoch(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r2 := *r
		u := *r.URL
		u.Path = trimUserExtEpoch(u.Path)
		if u.RawPath != "" {
			u.RawPath = trimUserExtEpoch(u.RawPath)
		}
		r2.URL = &u
		h.ServeHTTP(w, &r2)
	})
}

// hasDotDotSegment reports whether a slash-separated path contains a ".."
// component, mirroring net/http's containsDotDot used by http.Dir. A filename
// that merely contains ".." (e.g. "a..b.js") is allowed; only a standalone ".."
// segment can traverse.
func hasDotDotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

func (s *Server) rewriteWorkerModuleImports(moduleURL, source string) string {
	return workerModuleImportRe.ReplaceAllStringFunc(source, func(match string) string {
		parts := workerModuleImportRe.FindStringSubmatch(match)
		if len(parts) != 5 {
			return match
		}
		prefix, quote, spec, endQuote := parts[1], parts[2], parts[3], parts[4]
		rewritten := s.resolveWorkerModuleSpecifier(moduleURL, spec)
		if rewritten == spec {
			return match
		}
		return prefix + quote + rewritten + endQuote
	})
}

func (s *Server) resolveWorkerModuleSpecifier(moduleURL, spec string) string {
	if sdkPath, ok := workerSDKImports[spec]; ok {
		return s.workerModuleURL(sdkPath)
	}
	if strings.HasPrefix(spec, "/") {
		return s.workerModuleURL(spec)
	}
	if strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") {
		base, err := url.Parse(moduleURL)
		if err != nil {
			return spec
		}
		resolved := base.ResolveReference(&url.URL{Path: spec}).Path
		return s.workerModuleURL(resolved)
	}
	return spec
}

// workerModuleURL builds the loader URL for a module, CANONICALIZING the path by
// stripping any "/v<staticVersion>" cache-busting prefix first. ES module identity
// is keyed by resolved URL, so a file referenced both with the version prefix
// (e.g. via the SDK import map, "/v123/sdk/ops.js" → "/v123/js/services/websocket.js")
// and without it (the engine graph entry "/js/engine-app.js" → "/js/services/websocket.js")
// would otherwise load TWICE as two separate instances — duplicating singletons
// like wsService, one of which never connects. Canonicalizing to the unprefixed
// path guarantees one instance per file.
func (s *Server) workerModuleURL(moduleURL string) string {
	vPrefix := "/v" + s.staticVersion
	if strings.HasPrefix(moduleURL, vPrefix+"/") {
		moduleURL = strings.TrimPrefix(moduleURL, vPrefix)
	}
	return fmt.Sprintf("/worker-module?url=%s", url.QueryEscape(moduleURL))
}
