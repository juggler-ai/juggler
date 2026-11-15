//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// engineEntryAsset is the engine module graph's root: the real EngineApp.
const engineEntryAsset = "/js/engine-app.js"

// nodeHostGlueAsset is the checked-in Node entry glue (the Node twin of
// engine-worker-runtime.js). It is copied verbatim to the snapshot root as
// engineSnapshotEntry, from where its runtime `import('./js/engine-app.js')`
// resolves against the mirrored graph.
const nodeHostGlueAsset = "/js/engine-host-node.mjs"

// engineSnapshotEntry is the generated entry file's name at the snapshot root.
const engineSnapshotEntry = "engine-host.mjs"

// engineSnapshotManifest is the package.json written at the snapshot root, and
// engineSnapshotManifestBody its contents. Every mirrored module keeps the .js
// extension it has as a web asset, so this manifest is what tells Node to parse
// the graph as ES modules. Without it Node has to fall back to module syntax
// detection, which Node 22 releases before 22.7 only do behind a flag — there
// the host dies with "Cannot use import statement outside a module".
const (
	engineSnapshotManifest     = "package.json"
	engineSnapshotManifestBody = "{\"type\":\"module\"}\n"
)

// nodeLoaderHooksAsset is the checked-in ESM customization-hooks module the glue
// registers (via module.register) so extension modules loaded at runtime through
// `import('/worker-module?url=…')` are fetched from the server over HTTP instead
// of resolving to a bogus filesystem path. It is copied verbatim to the snapshot
// root under engineLoaderHooksName, where the glue's relative register call
// (`./engine-loader-hooks.mjs`) resolves it.
const nodeLoaderHooksAsset = "/js/engine-loader-hooks.mjs"

// engineLoaderHooksName is the loader-hooks file's name at the snapshot root.
const engineLoaderHooksName = "engine-loader-hooks.mjs"

// nodeRootModules are the checked-in glue modules copied verbatim to the
// snapshot root beside engine-host.mjs. They have no static engine imports (only
// node built-ins and each other, resolved relative to the root), so they need no
// rewriting: the entry glue and the query_code worker_threads sandbox
// (delegate + worker entry + its loader hooks) all sit here and reference each
// other by relative path.
var nodeRootModules = []string{
	nodeLoaderHooksAsset,
	"/js/engine-sandbox-node.mjs",
	"/js/engine-sandbox-worker.mjs",
	"/js/engine-sandbox-loader-hooks.mjs",
}

// EngineHostSpec bundles everything the out-of-process Node engine host needs
// to launch. It is produced by PrepareNodeEngineHost and consumed by the app
// layer's nodeHost — a single purpose-built seam, so the per-instance token
// never leaks through a general getter.
type EngineHostSpec struct {
	Entry       string // absolute path to the snapshot entry (engine-host.mjs)
	Addr        string // server address the engine dials (host:port)
	Token       string // per-instance API token, passed to node via JUGGLER_TOKEN
	ProjectRoot string // project root, exposed to the query_code sandbox as projectRoot
	Cleanup     func() // removes the per-boot snapshot once the Node host exits
}

// PrepareNodeEngineHost snapshots the engine module graph to a fresh temporary
// directory and returns the spec the Node host launches from.
//
// The snapshot is per-boot (a temp dir, GC'd by the OS) rather than a
// content-keyed cache: writing ~100 small files costs a few milliseconds and
// only happens on the node path, and a per-boot directory never needs
// invalidating — staticVersion would not key one when assets are served from
// disk, where it is random per process (see mintStaticVersion).
func (s *Server) PrepareNodeEngineHost() (EngineHostSpec, error) {
	dir, err := os.MkdirTemp("", "juggler-engine-snapshot-")
	if err != nil {
		return EngineHostSpec{}, fmt.Errorf("create engine snapshot dir: %w", err)
	}
	entry, err := s.snapshotEngineGraph(dir)
	if err != nil {
		_ = os.RemoveAll(dir)
		return EngineHostSpec{}, err
	}
	return EngineHostSpec{
		Entry:       entry,
		Addr:        s.addr,
		Token:       s.apiToken,
		ProjectRoot: filepath.ToSlash(s.ProjectPath()),
		Cleanup: func() {
			_ = os.RemoveAll(dir)
		},
	}, nil
}

// snapshotEngineGraph walks the engine module graph from engineEntryAsset,
// rewriting every import specifier to a snapshot-relative file path (Node can't
// import('http://…') or resolve the bare juggler/* SDK specifiers), and writes
// each module into destDir mirroring the asset URL layout. It returns the path
// to the generated entry file.
//
// It reuses the exact rewriter machinery the /worker-module HTTP loader uses
// (workerModuleImportRe + workerSDKImports), so the graph a Node host runs is a
// transform of — never a fork of — the graph a webview worker runs.
func (s *Server) snapshotEngineGraph(destDir string) (string, error) {
	visited := map[string]bool{}
	queue := []string{engineEntryAsset}
	for len(queue) > 0 {
		asset := queue[0]
		queue = queue[1:]
		if visited[asset] {
			continue
		}
		visited[asset] = true

		content, err := s.readWorkerModule(asset)
		if err != nil {
			// A matched specifier that resolves to no asset is almost always a
			// JSDoc-comment import() (e.g. `@type {import('../internals.js')}` in
			// vendor/yjs.mjs → /js/internals.js). The regex matches inside
			// comments, but comments never execute, so the file legitimately does
			// not exist. Skip it — matching the webview worker, which would also
			// never fetch it — rather than failing the whole snapshot.
			continue
		}
		rewritten, deps := s.rewriteEngineModule(asset, string(content))
		if err := writeSnapshotFile(destDir, asset, rewritten); err != nil {
			return "", err
		}
		queue = append(queue, deps...)
	}

	// Declare the snapshot root an ES module scope, so Node parses the mirrored
	// .js modules as ESM rather than leaning on syntax detection.
	manifestPath := filepath.Join(destDir, engineSnapshotManifest)
	if err := os.WriteFile(manifestPath, []byte(engineSnapshotManifestBody), 0o644); err != nil {
		return "", fmt.Errorf("write engine snapshot manifest: %w", err)
	}

	// Generate the entry: the checked-in Node glue, copied verbatim to the
	// snapshot root. It has no static imports (only a runtime import of
	// ./js/engine-app.js), so it needs no rewriting.
	glue, err := s.readWorkerModule(nodeHostGlueAsset)
	if err != nil {
		return "", fmt.Errorf("read node host glue %s: %w", nodeHostGlueAsset, err)
	}
	entryPath := filepath.Join(destDir, engineSnapshotEntry)
	if err := os.WriteFile(entryPath, glue, 0o644); err != nil {
		return "", fmt.Errorf("write engine host entry: %w", err)
	}

	// Copy the sibling glue modules (loader hooks + query_code sandbox) beside
	// the entry at the snapshot root, each under its own basename. They are
	// copied verbatim — they import only node built-ins and each other by
	// relative path, so nothing to rewrite.
	for _, asset := range nodeRootModules {
		content, err := s.readWorkerModule(asset)
		if err != nil {
			return "", fmt.Errorf("read node root module %s: %w", asset, err)
		}
		if err := os.WriteFile(filepath.Join(destDir, path.Base(asset)), content, 0o644); err != nil {
			return "", fmt.Errorf("write node root module %s: %w", asset, err)
		}
	}
	return entryPath, nil
}

// rewriteEngineModule rewrites one module's import specifiers to snapshot-
// relative file paths and returns the rewritten source plus the concrete asset
// paths it depends on (for the graph walk).
func (s *Server) rewriteEngineModule(moduleURL, source string) (string, []string) {
	var deps []string
	out := workerModuleImportRe.ReplaceAllStringFunc(source, func(match string) string {
		parts := workerModuleImportRe.FindStringSubmatch(match)
		if len(parts) != 5 {
			return match
		}
		prefix, quote, spec, endQuote := parts[1], parts[2], parts[3], parts[4]
		asset := s.resolveEngineAsset(moduleURL, spec)
		if asset == "" {
			return match
		}
		deps = append(deps, asset)
		return prefix + quote + snapshotRelPath(moduleURL, asset) + endQuote
	})
	return out, deps
}

// resolveEngineAsset resolves an import specifier to the concrete asset path it
// points at, or "" when it is not a local module we snapshot (a bare specifier
// we don't map, a data: URL, etc.). It mirrors resolveWorkerModuleSpecifier but
// returns the asset path instead of a loader URL.
func (s *Server) resolveEngineAsset(moduleURL, spec string) string {
	if sdkPath, ok := workerSDKImports[spec]; ok {
		return s.canonicalAssetPath(sdkPath)
	}
	if strings.HasPrefix(spec, "/") {
		return s.canonicalAssetPath(spec)
	}
	if strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") {
		return s.canonicalAssetPath(path.Join(path.Dir(moduleURL), spec))
	}
	return ""
}

// canonicalAssetPath strips any "/v<staticVersion>" cache-busting prefix,
// matching workerModuleURL's canonicalization so a module referenced both with
// and without the prefix maps to a single snapshot file (one ES module
// identity), never two.
func (s *Server) canonicalAssetPath(p string) string {
	vPrefix := "/v" + s.staticVersion
	if strings.HasPrefix(p, vPrefix+"/") {
		p = strings.TrimPrefix(p, vPrefix)
	}
	return p
}

// snapshotRelPath returns the path of toAsset relative to the directory holding
// fromModule, both given as absolute URL-style paths ("/js/engine-app.js"). The
// result is a POSIX relative specifier with a leading "./" or "../", suitable
// for an ES import in the mirrored on-disk snapshot. Computed with the path
// package (not filepath) so it is identical on every OS.
func snapshotRelPath(fromModule, toAsset string) string {
	baseParts := splitPath(path.Dir(fromModule))
	targetParts := splitPath(toAsset)
	i := 0
	for i < len(baseParts) && i < len(targetParts) && baseParts[i] == targetParts[i] {
		i++
	}
	var rel []string
	for j := i; j < len(baseParts); j++ {
		rel = append(rel, "..")
	}
	rel = append(rel, targetParts[i:]...)
	joined := strings.Join(rel, "/")
	if joined == "" {
		return "./"
	}
	if !strings.HasPrefix(joined, ".") {
		joined = "./" + joined
	}
	return joined
}

// splitPath splits an absolute URL path into its non-empty segments.
func splitPath(p string) []string {
	var out []string
	for _, seg := range strings.Split(p, "/") {
		if seg != "" {
			out = append(out, seg)
		}
	}
	return out
}

// writeSnapshotFile writes content to destDir at the location mirroring asset's
// URL path, creating parent directories. It refuses to write outside destDir
// (defence in depth against a "../"-escaping resolved specifier).
func writeSnapshotFile(destDir, asset, content string) error {
	rel := filepath.FromSlash(strings.TrimPrefix(asset, "/"))
	dest := filepath.Join(destDir, rel)
	cleanRoot := filepath.Clean(destDir) + string(filepath.Separator)
	if !strings.HasPrefix(filepath.Clean(dest)+string(filepath.Separator), cleanRoot) {
		return fmt.Errorf("snapshot path %q escapes %q", asset, destDir)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dest, []byte(content), 0o644)
}
