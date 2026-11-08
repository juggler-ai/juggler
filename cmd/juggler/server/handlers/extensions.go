//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"

	"juggler/cmd/juggler/extmanifest"
	"juggler/cmd/juggler/msg"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
)

// extensionManifestFile is the well-known manifest filename at an extension root.
const extensionManifestFile = extmanifest.ManifestFileName

// ExtensionProvides and ExtensionManifest are the manifest types, defined in the
// server-independent extmanifest package and aliased here so the HTTP response
// types and the `juggler ext validate` CLI share one definition.
type ExtensionProvides = extmanifest.Provides
type ExtensionManifest = extmanifest.Manifest

// ExtensionCapabilities holds the concrete served URLs an extension contributes,
// per plugin type, after glob expansion.
type ExtensionCapabilities struct {
	ContextItems  []string `json:"contextItems"`
	Strategies    []string `json:"strategies"`
	Commands      []string `json:"commands"`
	InfoCards     []string `json:"infoCards"`
	FileViewers   []string `json:"fileViewers"`
	PinboardItems []string `json:"pinboardItems"`
	// PinboardItemMeta holds the served URLs of the agent-facing descriptors for
	// those item types. Loaded in the engine worker, unlike the item types.
	PinboardItemMeta []string `json:"pinboardItemMeta"`
	// WorkspaceProviders holds the served URLs of the extension's workspace
	// providers — what can make and look after a place a conversation works in.
	WorkspaceProviders []string `json:"workspaceProviders"`
	// Hooks holds the served URLs of the extension's tool hooks.
	Hooks []string `json:"hooks"`
	// SystemPrompt is the single served URL of the extension's system-prompt
	// contribution module (empty when the manifest declares none).
	SystemPrompt string `json:"systemPrompt,omitempty"`
}

// Extension is one entry in the GET /api/extensions response. A manifest that
// fails to parse or validate is still returned with Error set so the UI can show
// diagnostics — never a silent drop.
type Extension struct {
	Manifest     ExtensionManifest     `json:"manifest"`
	Source       string                `json:"source"`
	Capabilities ExtensionCapabilities `json:"capabilities"`
	Error        string                `json:"error,omitempty"`
	// Warnings are non-fatal advisories surfaced beside the extension in the
	// catalog (e.g. a manifest that omits engineApi, disabling the compat check).
	// Unlike Error they never prevent the extension from loading.
	Warnings []string `json:"warnings,omitempty"`
	// ManifestPath is the absolute on-disk path of the extension's
	// juggler.extension.json, and Files maps each capability's served URL to its
	// absolute on-disk path. Both are populated only when the extension is backed
	// by real files the host can open/reveal: on-disk user/project extensions
	// and — in dev mode — builtin extensions served from the web/ tree. They are
	// empty for builtin extensions embedded in the production binary (no
	// revealable file). The catalog uses them for its file-path display (open /
	// reveal in Finder).
	ManifestPath string            `json:"manifestPath,omitempty"`
	Files        map[string]string `json:"files,omitempty"`
}

// extensionRoot locates one extension on a filesystem and how to map its files
// to served URLs.
type extensionRoot struct {
	fsys      fs.FS  // filesystem to read the manifest and capability files from
	dir       string // directory within fsys holding the manifest (e.g. "extensions/juggler-core")
	urlPrefix string // URL prefix files are served under (e.g. "/extensions/juggler-core/")
	source    string // provenance: "builtin", "user"
	diskDir   string // absolute on-disk dir of the extension root, "" when embedded (no revealable file)
}

// ExtensionsAPI handles unified extension discovery via GET /api/extensions.
//
// Discovery order is precedence low→high: the embedded extensions baked into
// the binary (web/extensions/*, including @juggler/core), then user extensions
// (~/.juggler/extensions/*). The frontend registry resolves collisions in this
// order: the lowest-precedence entry holds a capability id and any duplicate is
// surfaced as a load error.
type ExtensionsAPI struct {
	builtinFS        fs.FS
	builtinDir       string // absolute on-disk path of the builtin web/ root in dev mode, "" when embedded
	userExtensionDir string // ~/.juggler/extensions (container of extension subdirs)
	engineVersion    string
	// reloadEpoch is the cache-busting counter embedded in every served
	// user-extension URL (see UserExtensionURLPrefix). Bumped on each reload so
	// the catalog hands out fresh URLs and the JS module cache, which is keyed by
	// URL, is forced to re-fetch the edited file from disk.
	reloadEpoch atomic.Uint64
	// broadcastReload tells every connected client to reload its capability
	// registries. Set once by the server, which owns the clients, before routes
	// are served; nil leaves HandleReload refusing.
	broadcastReload func()
}

// NewExtensionsAPI creates an ExtensionsAPI. The host SDK version is read from
// web/sdk/version.js on the builtin filesystem so the engineApi compat check has
// a single source of truth. builtinDir is the on-disk web/ root when builtin
// assets are served from disk (dev mode), or "" when they are embedded — it lets
// builtin extensions expose real file paths for the catalog's reveal-in-Finder.
// userExtensionDir locates the user-level extension container.
func NewExtensionsAPI(builtinFS fs.FS, builtinDir, userExtensionDir string) *ExtensionsAPI {
	return &ExtensionsAPI{
		builtinFS:        builtinFS,
		builtinDir:       builtinDir,
		userExtensionDir: userExtensionDir,
		engineVersion:    extmanifest.ReadEngineAPIVersion(builtinFS),
	}
}

// UserExtensionDir returns the global extension container (~/.juggler/extensions),
// or "" if unset.
func (api *ExtensionsAPI) UserExtensionDir() string { return api.userExtensionDir }

// UserExtensionURLBase is the route prefix the on-disk user extension container
// is served under. Everything after it is an epoch segment (see
// UserExtensionURLPrefix) followed by the container-relative file path.
const UserExtensionURLBase = "/user-extensions/"

// UserExtensionURLPrefix is the prefix served user-extension URLs carry right
// now: the container route plus the current reload epoch, e.g.
// "/user-extensions/e3/". The epoch lives in the PATH rather than a query string
// so that relative imports inside a multi-file extension inherit it — a
// "?v=" URL would reload an entry module but rebind it to its stale siblings.
func (api *ExtensionsAPI) UserExtensionURLPrefix() string {
	return UserExtensionURLBase + "e" + strconv.FormatUint(api.reloadEpoch.Load(), 10) + "/"
}

// BumpEpoch advances the reload epoch, so capability URLs minted from here on
// differ from the ones already in the JS module cache. Callers bump BEFORE
// broadcasting plugin-changed, so the catalog refetch that the broadcast
// triggers already sees the new URLs.
func (api *ExtensionsAPI) BumpEpoch() { api.reloadEpoch.Add(1) }

// SetReloadBroadcast wires the callback HandleReload uses to tell every
// connected client to reload. It must not bump the epoch itself: HandleReload
// does that first.
func (api *ExtensionsAPI) SetReloadBroadcast(fn func()) { api.broadcastReload = fn }

// HandleReload serves POST /api/extensions/reload — the Extensions page's
// explicit Reload. It goes through the server rather than reloading in the
// clicking viewer alone because the engine worker, where tools actually run,
// holds its own copy of every capability module: a local-only reload would
// leave it running the old code. Broadcasting also keeps every connected client
// on one epoch, so no two of them load the same file under different URLs.
func (api *ExtensionsAPI) HandleReload(w http.ResponseWriter, r *http.Request) {
	if api.broadcastReload == nil {
		WriteMessageError(w, r, http.StatusServiceUnavailable, msg.New("Extension reload is not available"))
		return
	}
	jlog.Info("[PluginWatcher] Reload requested")
	api.BumpEpoch()
	api.broadcastReload()
	WriteSuccess(w, r, nil)
}

// ExtensionLocations reports the on-disk directories Juggler scans for
// extensions, so the catalog can show a developer exactly where to install new
// ones. Empty fields are omitted by the UI. Each is for reading, not for
// opening: a directory under the home directory is written "~/…", the way the
// catalog's header names it.
type ExtensionLocations struct {
	UserExtensions string `json:"userExtensions"`
}

// HandleListLocations returns the extension install directories.
func (api *ExtensionsAPI) HandleListLocations(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, ExtensionLocations{
		UserExtensions: userpaths.ShortenHome(api.userExtensionDir),
	})
}

// HandleListExtensions returns all discovered extensions with expanded capabilities.
func (api *ExtensionsAPI) HandleListExtensions(w http.ResponseWriter, r *http.Request) {
	extensions := []Extension{}
	for _, root := range api.roots() {
		if ext, ok := api.loadExtension(root); ok {
			extensions = append(extensions, ext)
		}
	}
	WriteJSON(w, r, 0, extensions)
}

// roots lists every candidate extension root in discovery order, precedence
// low→high:
//
//  1. Embedded extensions (web/extensions/* baked into the binary), scanned as a
//     container so the embedded FS goes through the same per-subdir shape as the
//     on-disk user container below.
//  2. User extensions (~/.juggler/extensions/*).
func (api *ExtensionsAPI) roots() []extensionRoot {
	roots := api.embeddedContainerRoots("extensions", "/extensions/")
	return append(roots, api.containerRoots(api.userExtensionDir, api.UserExtensionURLPrefix(), "user")...)
}

// embeddedContainerRoots lists the immediate subdirectories of a container
// inside the embedded filesystem (web/extensions/*) as candidate extension
// roots. It mirrors containerRoots but over api.builtinFS (an fs.FS, not a disk
// path). Files are served under urlPrefix+<subdir>/ with source "builtin".
func (api *ExtensionsAPI) embeddedContainerRoots(containerDir, urlPrefix string) []extensionRoot {
	entries, err := fs.ReadDir(api.builtinFS, containerDir)
	if err != nil {
		return nil
	}
	var out []extensionRoot
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		// In dev mode the builtin assets are served from disk, so each embedded
		// extension also has a revealable on-disk dir; embedded-in-binary has none.
		diskDir := ""
		if api.builtinDir != "" {
			diskDir = filepath.Join(api.builtinDir, containerDir, entry.Name())
		}
		out = append(out, extensionRoot{
			fsys:      api.builtinFS,
			dir:       path.Join(containerDir, entry.Name()),
			urlPrefix: urlPrefix + entry.Name() + "/",
			source:    "builtin",
			diskDir:   diskDir,
		})
	}
	return out
}

// containerRoots lists a container directory's immediate subdirectories, each a
// candidate extension (one juggler.extension.json apiece). Files are served
// under urlPrefix+<subdir>/. A missing/empty container yields nothing.
func (api *ExtensionsAPI) containerRoots(containerDir, urlPrefix, source string) []extensionRoot {
	if containerDir == "" {
		return nil
	}
	entries, err := os.ReadDir(containerDir)
	if err != nil {
		return nil // container absent or unreadable — no extensions here
	}
	var out []extensionRoot
	for _, entry := range entries {
		full := filepath.Join(containerDir, entry.Name())
		// Follow symlinks: a dev extension installed via `juggler ext link` is a
		// symlink whose DirEntry reports IsDir()==false, so stat the resolved
		// target rather than trusting the entry type directly.
		if !isDirFollowingSymlinks(full, entry) {
			continue
		}
		name := entry.Name()
		// Root the extension filesystem at its real directory (resolving a
		// symlink), so manifest reads and glob expansion never depend on
		// os.DirFS symlink-traversal behaviour. Served URLs still use the
		// container-relative name, which the static file server resolves.
		rootDir := full
		if entry.Type()&os.ModeSymlink != 0 {
			if resolved, err := filepath.EvalSymlinks(full); err == nil {
				rootDir = resolved
			}
		}
		out = append(out, extensionRoot{
			fsys:      os.DirFS(rootDir),
			dir:       ".",
			urlPrefix: urlPrefix + name + "/",
			source:    source,
			diskDir:   rootDir,
		})
	}
	return out
}

// isDirFollowingSymlinks reports whether path is a directory, treating a symlink
// to a directory as a directory. Non-symlink entries use the cheap DirEntry type;
// symlinks are resolved with os.Stat (the target may be a dir even though the
// link entry's IsDir() is false).
func isDirFollowingSymlinks(path string, entry os.DirEntry) bool {
	if entry.IsDir() {
		return true
	}
	if entry.Type()&os.ModeSymlink == 0 {
		return false
	}
	info, err := os.Stat(path) // follows the symlink
	return err == nil && info.IsDir()
}

// loadExtension reads and validates one root's manifest and expands its globs.
// The bool is false only when the root has no manifest at all (not an extension
// dir); a present-but-invalid manifest returns true with Error set.
func (api *ExtensionsAPI) loadExtension(root extensionRoot) (Extension, bool) {
	manifestPath := path.Join(root.dir, extensionManifestFile)
	data, err := fs.ReadFile(root.fsys, manifestPath)
	if err != nil {
		return Extension{}, false
	}

	ext := Extension{Source: root.source}
	if root.diskDir != "" {
		ext.ManifestPath = filepath.Join(root.diskDir, extensionManifestFile)
	}

	manifest, err := extmanifest.Parse(data)
	if err != nil {
		ext.Error = fmt.Sprintf("invalid manifest: %v", err)
		return ext, true
	}
	ext.Manifest = manifest

	if err := extmanifest.Validate(manifest, api.engineVersion); err != nil {
		ext.Error = err.Error()
		return ext, true
	}
	ext.Warnings = extmanifest.Warnings(manifest)

	caps, files, err := expandCapabilities(root, manifest.Provides)
	if err != nil {
		ext.Error = err.Error()
		return ext, true
	}
	ext.Capabilities = caps
	if len(files) > 0 {
		ext.Files = files
	}
	// A broken catalogue costs the extension its translations, never its load:
	// it is skipped by Catalogs and said here, beside the extension.
	if manifest.Provides.I18n != "" {
		if _, err := extmanifest.ReadCatalogs(root.fsys, root.dir, manifest.Provides.I18n); err != nil {
			ext.Warnings = append(ext.Warnings, "translations not loaded: "+err.Error())
		}
	}
	return ext, true
}

// Catalogs returns each loadable extension's UI translation catalogue for
// locale, keyed by extension id — its catalogues along the locale's chain
// merged, each message from the most specific file that has it
// (extmanifest.MergeChain), never English. Extensions
// that fail to load, declare no i18n directory, or whose catalogues will not
// read are left out; for a repeated id the first in discovery order (built-in
// before user) keeps its catalogue, as it keeps its capabilities.
func (api *ExtensionsAPI) Catalogs(locale string) map[string]map[string]string {
	out := map[string]map[string]string{}
	chain := extmanifest.LocaleChain(locale)
	if len(chain) == 0 {
		return out
	}
	seen := map[string]bool{}
	for _, root := range api.roots() {
		ext, ok := api.loadExtension(root)
		if !ok || ext.Error != "" || seen[ext.Manifest.ID] {
			continue
		}
		seen[ext.Manifest.ID] = true
		if ext.Manifest.Provides.I18n == "" {
			continue
		}
		catalogs, err := extmanifest.ReadCatalogs(root.fsys, root.dir, ext.Manifest.Provides.I18n)
		if err != nil {
			jlog.Error("[i18n] %s: %v", ext.Manifest.ID, err)
			continue
		}
		if messages := extmanifest.MergeChain(catalogs, chain); messages != nil {
			out[ext.Manifest.ID] = messages
		}
	}
	return out
}

// expandCapabilities resolves each provides glob to concrete served URLs, with a
// path-traversal guard keeping every served file inside the extension root. It
// also returns a served-URL → absolute-disk-path map (populated only when the
// root has a disk dir) for the catalog's reveal-in-Finder file display.
func expandCapabilities(root extensionRoot, p ExtensionProvides) (ExtensionCapabilities, map[string]string, error) {
	files := map[string]string{}
	contextItems, err := expandGlobs(root, p.ContextItems, files)
	if err != nil {
		return ExtensionCapabilities{}, nil, err
	}
	strategies, err := expandGlobs(root, p.Strategies, files)
	if err != nil {
		return ExtensionCapabilities{}, nil, err
	}
	commands, err := expandGlobs(root, p.Commands, files)
	if err != nil {
		return ExtensionCapabilities{}, nil, err
	}
	infoCards, err := expandGlobs(root, p.InfoCards, files)
	if err != nil {
		return ExtensionCapabilities{}, nil, err
	}
	fileViewers, err := expandGlobs(root, p.FileViewers, files)
	if err != nil {
		return ExtensionCapabilities{}, nil, err
	}
	pinboardItems, err := expandGlobs(root, p.PinboardItems, files)
	if err != nil {
		return ExtensionCapabilities{}, nil, err
	}
	pinboardItemMeta, err := expandGlobs(root, p.PinboardItemMeta, files)
	if err != nil {
		return ExtensionCapabilities{}, nil, err
	}
	workspaceProviders, err := expandGlobs(root, p.WorkspaceProviders, files)
	if err != nil {
		return ExtensionCapabilities{}, nil, err
	}
	hooks, err := expandGlobs(root, p.Hooks, files)
	if err != nil {
		return ExtensionCapabilities{}, nil, err
	}
	// systemPrompt is a single module path, not a glob list. Resolve it through
	// the same expander (traversal guard + disk-path mapping) and take the one
	// match, if any.
	var systemPrompt string
	if strings.TrimSpace(p.SystemPrompt) != "" {
		spURLs, err := expandGlobs(root, []string{p.SystemPrompt}, files)
		if err != nil {
			return ExtensionCapabilities{}, nil, err
		}
		if len(spURLs) > 0 {
			systemPrompt = spURLs[0]
		}
	}
	return ExtensionCapabilities{
		ContextItems:       contextItems,
		Strategies:         strategies,
		Commands:           commands,
		InfoCards:          infoCards,
		FileViewers:        fileViewers,
		PinboardItems:      pinboardItems,
		PinboardItemMeta:   pinboardItemMeta,
		WorkspaceProviders: workspaceProviders,
		Hooks:              hooks,
		SystemPrompt:       systemPrompt,
	}, files, nil
}

// expandGlobs resolves a list of root-relative globs to served URLs. Duplicate
// matches across globs are de-duplicated while preserving first-seen order. For
// each served URL it records the absolute on-disk path in files when the root is
// backed by disk (root.diskDir set).
func expandGlobs(root extensionRoot, globs []string, files map[string]string) ([]string, error) {
	urls := []string{}
	seen := map[string]bool{}
	for _, g := range globs {
		// Traversal guard: reject any glob that tries to escape the root before
		// it ever reaches the filesystem. path.Clean collapses interior traversal,
		// so a leading ".." (or an absolute path) is the sole escape signature — a
		// name that merely CONTAINS ".." (e.g. "foo..bar-context-item.js") is fine.
		clean := path.Clean(g)
		if g == "" || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
			return nil, fmt.Errorf("invalid provides glob %q: must stay inside the extension root", g)
		}

		full := path.Join(root.dir, clean)
		matches, err := fs.Glob(root.fsys, full)
		if err != nil {
			return nil, fmt.Errorf("invalid provides glob %q: %w", g, err)
		}
		// When the fsys is rooted at the extension dir itself, root.dir is "." and
		// matches are already root-relative; otherwise they carry the dir prefix.
		prefix := ""
		if root.dir != "." {
			prefix = root.dir + "/"
		}
		for _, match := range matches {
			// Second traversal guard: the resolved path must stay within the root.
			if !strings.HasPrefix(match, prefix) {
				return nil, fmt.Errorf("provides glob %q escaped the extension root: %q", g, match)
			}
			rel := strings.TrimPrefix(match, prefix)
			url := root.urlPrefix + rel
			if seen[url] {
				continue
			}
			seen[url] = true
			urls = append(urls, url)
			if root.diskDir != "" {
				files[url] = filepath.Join(root.diskDir, filepath.FromSlash(rel))
			}
		}
	}
	return urls, nil
}
