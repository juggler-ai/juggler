//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"path"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/workspace"
)

// sandboxImportRoot normalises a root (the project's, or a workspace's) for the
// query_code sandbox's absolute-path module loader: forward slashes so it
// matches the worker's origin-resolved import URLs on every OS (a Windows path
// uses backslashes, but the sandbox and its URLs are POSIX-style throughout).
func sandboxImportRoot(root string) string {
	return filepath.ToSlash(root)
}

// sandboxImportPath aligns a request URL path with sandboxImportRoot. A POSIX
// root is itself absolute ("/Users/…"), so the worker's origin+spec
// already yields a matching "/Users/…/web/…" path. A Windows drive-letter root
// ("C:/…") has no leading slash, so the worker resolves it against the origin as
// "/C:/…/web/…"; drop that synthetic leading slash so the prefix lines up.
func sandboxImportPath(urlPath, root string) string {
	if len(root) >= 2 && root[1] == ':' {
		return strings.TrimPrefix(urlPath, "/")
	}
	return urlPath
}

// sandboxModule is one module a sandbox import names: the tree it is in, and
// its forward-slashed path within that tree.
type sandboxModule struct {
	tree workspace.Workspace
	rel  string
}

// sandboxImportFile maps a query_code sandbox import URL to a real module inside
// a tree the sandbox may import from, or reports ok=false. The sandbox worker
// resolves user code's `import('<projectRoot>/rel/path')` against its http
// origin, so the request path is that absolute path. We serve it only when it
// (a) stays strictly inside one of those trees and (b) is an importable module,
// so the ACAO=* response never exposes arbitrary files (secrets, source) to a
// cross-origin reader — only JavaScript/JSON modules the sandbox can import().
//
// The trees are the project and every ready workspace, because `projectRoot` is
// the root of the tree the asking CONVERSATION works in: a bound one builds its
// module paths inside its workspace, and clamping this to the project would 404
// every one of them. Nothing widens on its own — a workspace is on the table
// only because the user registered it through the flow that also authorises ops
// there — and neither the module-extension list nor the containment check moves.
// The file itself is read through the tree's own Open.
func (s *Server) sandboxImportFile(urlPath string) (sandboxModule, bool) {
	// Cheapest filter first: this runs as a route matcher, so every request that
	// reaches the fallthrough asks it, and almost none of them name a module.
	if !sandboxImportableExt(urlPath) {
		return sandboxModule{}, false
	}
	resolve := s.Workspaces().Resolve
	if project, err := resolve(core.DefaultWorkspaceID); err == nil {
		if mod, ok := sandboxModuleIn(urlPath, project); ok {
			return mod, true
		}
	}
	// Only now ask the session for its workspaces, so an ordinary project import
	// costs nothing but the one look at the file.
	for _, id := range s.sandboxWorkspaceIDs() {
		tree, err := resolve(id)
		if err != nil {
			continue
		}
		if mod, ok := sandboxModuleIn(urlPath, tree); ok {
			return mod, true
		}
	}
	return sandboxModule{}, false
}

// sandboxModuleIn resolves an import URL against one tree, or reports ok=false.
func sandboxModuleIn(urlPath string, tree workspace.Workspace) (sandboxModule, bool) {
	root := sandboxImportRoot(tree.Root())
	if root == "" {
		return sandboxModule{}, false
	}
	p := path.Clean(sandboxImportPath(urlPath, root))
	// Clean has collapsed any "..", so a path still under the root cannot escape
	// it. Reject the root itself and anything outside it.
	if !strings.HasPrefix(p, root+"/") {
		return sandboxModule{}, false
	}
	mod := sandboxModule{tree: tree, rel: strings.TrimPrefix(p, root+"/")}
	f, err := tree.Open(mod.rel)
	if err != nil {
		return sandboxModule{}, false
	}
	_ = f.Close()
	return mod, true
}

// sandboxWorkspaceIDs are the registered workspaces a sandbox may import from.
// Ready ones only: a workspace still being provisioned is half a tree, and a
// closed one is finished with — both refuse every other operation, and serving
// their files would be the one way to keep reading a workspace after it was
// tombstoned.
func (s *Server) sandboxWorkspaceIDs() []string {
	mgr := s.SessionManager()
	if mgr == nil {
		return nil
	}
	var ids []string
	for _, ws := range mgr.ListWorkspaces() {
		if ws.State == core.WorkspaceStateReady && ws.Root != "" {
			ids = append(ids, ws.ID)
		}
	}
	return ids
}

// sandboxImportableExt reports whether p has an extension the sandbox may load
// over HTTP. Restricted to browser-importable module types so the ACAO=* static
// route can never be used to read non-module project files cross-origin.
func sandboxImportableExt(p string) bool {
	switch strings.ToLower(path.Ext(p)) {
	case ".js", ".mjs", ".cjs", ".json":
		return true
	default:
		return false
	}
}

// serveSandboxImportFile writes a module resolved by sandboxImportFile.
// It sets an explicit JavaScript/JSON MIME because .mjs/.cjs are absent from
// Go's mime table and a module import() requires a JavaScript media type — a
// sniffed text/plain would make the browser reject the module.
func serveSandboxImportFile(w http.ResponseWriter, r *http.Request, mod sandboxModule) {
	f, err := mod.tree.Open(mod.rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	// Reuse the shared web-asset MIME map, defaulting to JavaScript since
	// sandbox project files are imported as ES modules.
	ct := staticAssetContentType(mod.rel)
	if ct == "" {
		ct = "text/javascript; charset=utf-8"
	}
	w.Header().Set("Content-Type", ct)
	http.ServeContent(w, r, path.Base(mod.rel), info.ModTime(), f)
}

// staticAssetContentType returns a stable Content-Type for the web-asset
// extensions the app serves, or "" to defer to the file server's own detection.
//
// http.FileServer derives the type from mime.TypeByExtension, which consults the
// host MIME database — and on Windows that comes from the registry, where .mjs is
// frequently mapped to text/plain (and other web types are unreliable too). A
// module script served as text/plain is rejected by the browser's strict MIME
// check, which silently breaks the app's entire ES-module graph (e.g.
// web/js/vendor/yjs.mjs) while leaving unrelated standalone modules loading — so
// we set these types explicitly rather than trust the OS. Mirrors the explicit
// Content-Type in serveSandboxImportFile.
func staticAssetContentType(p string) string {
	switch strings.ToLower(path.Ext(p)) {
	case ".js", ".mjs", ".cjs":
		return "text/javascript; charset=utf-8"
	case ".json", ".map":
		return "application/json; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".wasm":
		return "application/wasm"
	default:
		return ""
	}
}

// staticAssetHandler wraps a static file server, forcing a stable Content-Type
// for known web-asset extensions so serving is correct regardless of the host
// MIME database. See staticAssetContentType. http.ServeContent (used by
// http.FileServer) only sniffs a type when Content-Type is unset, so a header we
// set here is preserved.
func staticAssetHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ct := staticAssetContentType(r.URL.Path); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		next.ServeHTTP(w, r)
	})
}
