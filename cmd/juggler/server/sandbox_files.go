//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"path"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/webui"
	"juggler/cmd/juggler/workspace"
)

// sandboxImportPrefix is where the query_code sandbox loads modules from:
// "/sandbox-import/<capability>/<absolute path>". The sandbox runs with an
// opaque origin, so these responses carry ACAO=* and CORP cross-origin — which
// means any page that can reach the port can read them. The capability in the
// path is what makes that safe: a page that knows the port and a project path
// still cannot name a URL this route answers. It rides in the path rather than
// a query string so a served module's own relative imports inherit it.
const sandboxImportPrefix = "/sandbox-import/"

// sandboxImportLabel is the HMAC message that derives the capability from the
// API token. sandboxImportCapability in web/sdk/lib/sandbox-runner.js and
// web/js/engine-sandbox-node.mjs derive the same value, so the realms that hold
// the API token can build import URLs while the sandbox is handed only the
// capability: a leaked one opens module reads here and nothing on /api.
const sandboxImportLabel = "juggler-sandbox-import"

// sandboxImportCapability derives the import capability from the API token.
func sandboxImportCapability(apiToken string) string {
	mac := hmac.New(sha256.New, []byte(apiToken))
	mac.Write([]byte(sandboxImportLabel))
	return hex.EncodeToString(mac.Sum(nil))
}

// sandboxImportTarget strips a valid capability off an import URL path and
// returns the absolute path it names (leading slash kept, as sandboxImportPath
// expects), or ok=false when the prefix or the capability is wrong.
func (s *Server) sandboxImportTarget(urlPath string) (string, bool) {
	rest, ok := strings.CutPrefix(urlPath, sandboxImportPrefix)
	if !ok || s.apiToken == "" {
		return "", false
	}
	capability, target, ok := strings.Cut(rest, "/")
	want := sandboxImportCapability(s.apiToken)
	if !ok || subtle.ConstantTimeCompare([]byte(capability), []byte(want)) != 1 {
		return "", false
	}
	return "/" + target, true
}

// registerSandboxImportRoutes mounts the query_code sandbox's module loader
// under sandboxImportPrefix. A real module inside the project or a ready
// workspace (sandboxImportFile) is served off disk — what lets query_code load
// and test any JavaScript module in the user's own tree. Failing that, a path
// under `<projectRoot>/web/` is served from the app's own web root, for the
// common case of developing Juggler itself against its embedded assets. No
// project loaded, or no staticFileServer, means only the first applies.
func (s *Server) registerSandboxImportRoutes(staticFileServer http.Handler) {
	s.router.PathPrefix(sandboxImportPrefix).HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target, ok := s.sandboxImportTarget(r.URL.Path)
		if !ok || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
			http.NotFound(w, r)
			return
		}
		if mod, ok := s.sandboxImportFile(target); ok {
			serveSandboxImportFile(w, r, mod)
			return
		}
		root := sandboxImportRoot(s.ProjectPath())
		rest, underWeb := strings.CutPrefix(sandboxImportPath(target, root), root+"/web/")
		if root == "" || !underWeb || staticFileServer == nil {
			http.NotFound(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + rest
		r2.URL.RawPath = ""
		staticFileServer.ServeHTTP(w, r2)
	})
}

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

// sandboxImportFile maps the absolute path a sandbox import names (the request
// path with its capability stripped by sandboxImportTarget) to a real module
// inside a tree the sandbox may import from, or reports ok=false. We serve it
// only when it (a) stays strictly inside one of those trees once symlinks are
// resolved, (b) passes through no dot-directory — .juggler holds the session
// and every transcript, .git and .env-style trees hold credentials — and (c) is
// an importable module. The response is readable from any origin, so a leaked
// capability yields project JavaScript/JSON modules and nothing else.
//
// The trees are the project and every ready workspace, because `projectRoot` is
// the root of the tree the asking CONVERSATION works in: a bound one builds its
// module paths inside its workspace, and clamping this to the project would 404
// every one of them. Nothing widens on its own — a workspace is on the table
// only because the user registered it through the flow that also authorises ops
// there — and neither the module-extension list nor the containment check moves.
// The file itself is read through the tree's own Open.
func (s *Server) sandboxImportFile(urlPath string) (sandboxModule, bool) {
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
	for _, seg := range strings.Split(mod.rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return sandboxModule{}, false
		}
	}
	// Open judges the path lexically and follows links, so a symlink planted in
	// the tree would reach anywhere. The path scope resolves them first.
	if res, err := ops.NewPathScope(tree.Root(), nil).Resolve(filepath.FromSlash(mod.rel)); err != nil || res == nil || !res.IsValid {
		return sandboxModule{}, false
	}
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
	ct := webui.ContentType(mod.rel)
	if ct == "" {
		ct = "text/javascript; charset=utf-8"
	}
	w.Header().Set("Content-Type", ct)
	http.ServeContent(handlers.SendfileFallback(w), r, path.Base(mod.rel), info.ModTime(), f)
}
