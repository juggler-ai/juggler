//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

// coreManifest is a minimal valid manifest mirroring web/extensions/juggler-core/juggler.extension.json.
const coreManifest = `{
  "id": "@juggler/core",
  "name": "Juggler Core",
  "version": "1.0.0",
  "engineApi": "^1.0.0",
  "permissions": ["filesystem.read"],
  "provides": {
    "contextItems": ["context-items/*-context-item.js"],
    "strategies": ["strategies/*-strategy-type.js"],
    "commands": ["commands/*-command-type.js"],
    "infoCards": ["cards/*-card.js"],
    "pinboardItems": ["pins/*-pin.js"],
    "pinboardItemMeta": ["pins/*-pin.meta.js"]
  }
}`

// coreFS builds an in-memory filesystem resembling the embedded web/ tree, with the
// core extension under extensions/juggler-core/ (discovered as a container subdir)
// and a sdk/version.js pinning the host engine API version.
func coreFS(manifest, version string) fstest.MapFS {
	return fstest.MapFS{
		"extensions/juggler-core/juggler.extension.json":                  {Data: []byte(manifest)},
		"extensions/juggler-core/context-items/read-file-context-item.js": {Data: []byte("//")},
		"extensions/juggler-core/context-items/execute-context-item.js":   {Data: []byte("//")},
		"extensions/juggler-core/context-items/edit-base.js":              {Data: []byte("// not a capability")},
		"extensions/juggler-core/context-items/rules/go-idioms.js":        {Data: []byte("// nested, not matched")},
		"extensions/juggler-core/strategies/default-strategy-type.js":     {Data: []byte("//")},
		"extensions/juggler-core/commands/clear-command-type.js":          {Data: []byte("//")},
		"extensions/juggler-core/cards/usage-card.js":                     {Data: []byte("//")},
		"extensions/juggler-core/pins/file-pin.js":                        {Data: []byte("//")},
		"extensions/juggler-core/pins/file-pin.meta.js":                   {Data: []byte("//")},
		"sdk/version.js": {Data: []byte("export const ENGINE_API_VERSION = '" + version + "';")},
	}
}

func loadOne(t *testing.T, fsys fstest.MapFS) Extension {
	t.Helper()
	api := NewExtensionsAPI(fsys, "", "")
	req := httptest.NewRequest(http.MethodGet, "/api/extensions", nil)
	rec := httptest.NewRecorder()
	api.HandleListExtensions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var exts []Extension
	if err := json.Unmarshal(rec.Body.Bytes(), &exts); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(exts) != 1 {
		t.Fatalf("got %d extensions, want 1", len(exts))
	}
	return exts[0]
}

func TestExtensionsValidCore(t *testing.T) {
	ext := loadOne(t, coreFS(coreManifest, "1.0.0"))
	if ext.Error != "" {
		t.Fatalf("unexpected error: %s", ext.Error)
	}
	if ext.Manifest.ID != "@juggler/core" {
		t.Errorf("id = %q", ext.Manifest.ID)
	}
	if ext.Source != "builtin" {
		t.Errorf("source = %q, want builtin", ext.Source)
	}
	// Glob expansion: only suffix-matching top-level files, not edit-base.js or nested rules.
	wantCtx := []string{
		"/extensions/juggler-core/context-items/execute-context-item.js",
		"/extensions/juggler-core/context-items/read-file-context-item.js",
	}
	assertURLs(t, "contextItems", ext.Capabilities.ContextItems, wantCtx)
	assertURLs(t, "strategies", ext.Capabilities.Strategies, []string{"/extensions/juggler-core/strategies/default-strategy-type.js"})
	assertURLs(t, "commands", ext.Capabilities.Commands, []string{"/extensions/juggler-core/commands/clear-command-type.js"})
	assertURLs(t, "infoCards", ext.Capabilities.InfoCards, []string{"/extensions/juggler-core/cards/usage-card.js"})
	// The two pin globs must not swallow each other: a descriptor is not an item type
	// (it is loaded in the engine worker, where the item type would fail on import),
	// and an item type is not a descriptor.
	assertURLs(t, "pinboardItems", ext.Capabilities.PinboardItems, []string{"/extensions/juggler-core/pins/file-pin.js"})
	assertURLs(t, "pinboardItemMeta", ext.Capabilities.PinboardItemMeta, []string{"/extensions/juggler-core/pins/file-pin.meta.js"})
}

// TestExtensionsWorkspaceProviderOnly pins that a workspace provider is a
// capability in its own right.
//
// An extension that ships only a way to make workspaces — a worktree provider,
// say — provides nothing else, so if the "provides no capabilities" check does
// not count it, the whole extension is rejected at load with a message about
// providing nothing while its manifest plainly provides something.
func TestExtensionsWorkspaceProviderOnly(t *testing.T) {
	manifest := `{
	  "id":"@you/worktrees","name":"Worktrees","version":"1.0.0","engineApi":"^1.0.0",
	  "provides":{"workspaceProviders":["workspaces/*-workspace-provider.js"]}
	}`
	fsys := coreFS(manifest, "1.0.0")
	fsys["extensions/juggler-core/workspaces/git-worktree-workspace-provider.js"] = &fstest.MapFile{Data: []byte("//")}
	ext := loadOne(t, fsys)
	if ext.Error != "" {
		t.Fatalf("unexpected error: %s", ext.Error)
	}
	assertURLs(t, "workspaceProviders", ext.Capabilities.WorkspaceProviders,
		[]string{"/extensions/juggler-core/workspaces/git-worktree-workspace-provider.js"})
}

// TestExtensionsHookOnly pins that a tool hook is a capability in its own right:
// an extension that ships nothing but a hook (a sandbox-denial explainer, a
// "never touch migrations/" guard) must load, not be rejected as providing
// nothing — and its hooks must be served.
func TestExtensionsHookOnly(t *testing.T) {
	manifest := `{
	  "id":"@you/nono","name":"nono","version":"1.0.0","engineApi":"^1.0.0",
	  "provides":{"hooks":["hooks/*-hook.js"]}
	}`
	fsys := coreFS(manifest, "1.0.0")
	fsys["extensions/juggler-core/hooks/nono-denial-hook.js"] = &fstest.MapFile{Data: []byte("//")}
	ext := loadOne(t, fsys)
	if ext.Error != "" {
		t.Fatalf("unexpected error: %s", ext.Error)
	}
	assertURLs(t, "hooks", ext.Capabilities.Hooks,
		[]string{"/extensions/juggler-core/hooks/nono-denial-hook.js"})
}

// TestExtensionsSearchBackendOnly pins that a web-search backend is a
// capability in its own right: an extension that ships nothing but a backend
// must load, not be rejected as providing nothing, and its backends must be
// served.
func TestExtensionsSearchBackendOnly(t *testing.T) {
	manifest := `{
	  "id":"@you/acme","name":"acme","version":"1.0.0","engineApi":"^1.0.0",
	  "provides":{"searchBackends":["search-backends/*-backend.js"]}
	}`
	fsys := coreFS(manifest, "1.0.0")
	fsys["extensions/juggler-core/search-backends/acme-backend.js"] = &fstest.MapFile{Data: []byte("//")}
	ext := loadOne(t, fsys)
	if ext.Error != "" {
		t.Fatalf("unexpected error: %s", ext.Error)
	}
	assertURLs(t, "searchBackends", ext.Capabilities.SearchBackends,
		[]string{"/extensions/juggler-core/search-backends/acme-backend.js"})
}

// TestExtensionsSystemPromptPresetsOnly pins that identity presets are a
// capability in their own right — an extension that ships nothing but presets
// must load — and that the server serves them parsed, ids namespaced by the
// extension. A file that does not parse (here, an unterminated frontmatter,
// whose header must never become a prompt) costs only itself, with a warning.
func TestExtensionsSystemPromptPresetsOnly(t *testing.T) {
	manifest := `{
	  "id":"@you/voices","name":"voices","version":"1.0.0","engineApi":"^1.0.0",
	  "provides":{"systemPromptPresets":["presets/*.md"]}
	}`
	fsys := coreFS(manifest, "1.0.0")
	fsys["extensions/juggler-core/presets/assistant.md"] = &fstest.MapFile{Data: []byte("---\nname: \"A\"\ndescription: d\n---\n\nbody\n")}
	fsys["extensions/juggler-core/presets/broken.md"] = &fstest.MapFile{Data: []byte("---\nname: B\nbody")}
	ext := loadOne(t, fsys)
	if ext.Error != "" {
		t.Fatalf("unexpected error: %s", ext.Error)
	}
	want := []ExtensionPreset{{
		ID: "@you/voices/assistant", URL: "/extensions/juggler-core/presets/assistant.md",
		Name: "A", Description: "d", Content: "body",
	}}
	if !reflect.DeepEqual(ext.Capabilities.SystemPromptPresets, want) {
		t.Fatalf("presets = %+v, want %+v", ext.Capabilities.SystemPromptPresets, want)
	}
	if len(ext.Warnings) != 1 || !strings.Contains(ext.Warnings[0], "broken.md") {
		t.Fatalf("warnings = %q, want one naming broken.md", ext.Warnings)
	}
}

// TestExtensionsNewerEngineAPIBeatsUnknownField pins the diagnostic for a
// manifest written for a newer host: the range it asks for, not the field this
// host does not know.
func TestExtensionsNewerEngineAPIBeatsUnknownField(t *testing.T) {
	manifest := `{
	  "id":"@you/future","name":"future","version":"1.0.0","engineApi":"^9.0.0",
	  "provides":{"strategies":["strategies/*-strategy-type.js"],"fromTheFuture":["x"]}
	}`
	ext := loadOne(t, coreFS(manifest, "1.0.0"))
	if !strings.Contains(ext.Error, "requires engineApi") {
		t.Fatalf("error = %q, want the engineApi mismatch", ext.Error)
	}
}

// assertURLs compares two URL slices as sets (glob order is filesystem-dependent).
func assertURLs(t *testing.T, label string, got, want []string) {
	t.Helper()
	gotSet := map[string]bool{}
	for _, u := range got {
		gotSet[u] = true
	}
	if len(got) != len(want) {
		t.Errorf("%s: got %v, want %v", label, got, want)
		return
	}
	for _, w := range want {
		if !gotSet[w] {
			t.Errorf("%s: missing %q in %v", label, w, got)
		}
	}
}

func TestExtensionsSurfaceSettingsSchema(t *testing.T) {
	manifest := `{
	  "id":"@juggler/core","name":"Juggler Core","version":"1.0.0","engineApi":"^1.0.0",
	  "settings":[{"key":"enabled","type":"boolean","label":"Enabled","default":true}],
	  "provides":{"commands":["commands/*-command-type.js"]}
	}`
	ext := loadOne(t, coreFS(manifest, "1.0.0"))
	if ext.Error != "" {
		t.Fatalf("unexpected error: %s", ext.Error)
	}
	if len(ext.Manifest.Settings) != 1 || ext.Manifest.Settings[0].Key != "enabled" {
		t.Fatalf("settings = %#v", ext.Manifest.Settings)
	}
}

func TestExtensionsEngineAPIMismatch(t *testing.T) {
	// Manifest requires ^2.0.0 but the host SDK is 1.0.0 → incompatible.
	m := `{"id":"@x/y","name":"Y","version":"1.0.0","engineApi":"^2.0.0",` +
		`"provides":{"commands":["commands/clear-command-type.js"]}}`
	ext := loadOne(t, coreFS(m, "1.0.0"))
	if ext.Error == "" {
		t.Fatal("expected engineApi mismatch error, got none")
	}
}

func TestExtensionsEngineAPIVersionFromSDK(t *testing.T) {
	// Host SDK is 1.4.0; ^1.2.0 must be satisfied.
	m := `{"id":"@x/y","name":"Y","version":"1.0.0","engineApi":"^1.2.0",` +
		`"provides":{"commands":["commands/clear-command-type.js"]}}`
	ext := loadOne(t, coreFS(m, "1.4.0"))
	if ext.Error != "" {
		t.Fatalf("expected compatible, got error: %s", ext.Error)
	}
}

func TestExtensionsMissingRequiredField(t *testing.T) {
	m := `{"name":"No ID","version":"1.0.0",` +
		`"provides":{"commands":["commands/clear-command-type.js"]}}`
	ext := loadOne(t, coreFS(m, "1.0.0"))
	if ext.Error == "" {
		t.Fatal("expected missing-id error, got none")
	}
}

func TestExtensionsNoCapabilities(t *testing.T) {
	m := `{"id":"@x/y","name":"Y","version":"1.0.0","provides":{}}`
	ext := loadOne(t, coreFS(m, "1.0.0"))
	if ext.Error == "" {
		t.Fatal("expected no-capabilities error, got none")
	}
}

func TestExtensionsInvalidJSON(t *testing.T) {
	ext := loadOne(t, coreFS("{ not json", "1.0.0"))
	if ext.Error == "" {
		t.Fatal("expected parse error, got none")
	}
}

func TestExtensionsUnknownField(t *testing.T) {
	// DisallowUnknownFields: a typo'd key is surfaced, not silently ignored.
	m := `{"id":"@x/y","name":"Y","version":"1.0.0","permision":["x"],` +
		`"provides":{"commands":["commands/clear-command-type.js"]}}`
	ext := loadOne(t, coreFS(m, "1.0.0"))
	if ext.Error == "" {
		t.Fatal("expected unknown-field error, got none")
	}
}

func TestExtensionsTraversalGuard(t *testing.T) {
	traversals := []string{
		`{"id":"@x/y","name":"Y","version":"1.0.0","provides":{"commands":["../../../etc/passwd"]}}`,
		`{"id":"@x/y","name":"Y","version":"1.0.0","provides":{"commands":["../secrets/*.js"]}}`,
		`{"id":"@x/y","name":"Y","version":"1.0.0","provides":{"commands":["/etc/*.js"]}}`,
	}
	for _, m := range traversals {
		ext := loadOne(t, coreFS(m, "1.0.0"))
		if ext.Error == "" {
			t.Errorf("expected traversal rejection for %q", m)
		}
	}
}

func TestExtensionsNoManifestNoExtension(t *testing.T) {
	// A container subdir with files but no manifest yields zero extensions (not an error entry).
	fsys := fstest.MapFS{
		"extensions/juggler-core/context-items/read-file-context-item.js": {Data: []byte("//")},
		"sdk/version.js": {Data: []byte("export const ENGINE_API_VERSION = '1.0.0';")},
	}
	api := NewExtensionsAPI(fsys, "", "")
	req := httptest.NewRequest(http.MethodGet, "/api/extensions", nil)
	rec := httptest.NewRecorder()
	api.HandleListExtensions(rec, req)
	var exts []Extension
	if err := json.Unmarshal(rec.Body.Bytes(), &exts); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(exts) != 0 {
		t.Fatalf("got %d extensions, want 0", len(exts))
	}
}

// The pure manifest helpers (Parse/Validate/Warnings/SatisfiesEngineAPI/
// ReadEngineAPIVersion/ExpandGlobs) are unit-tested in the extmanifest package;
// the tests here exercise the HTTP handler that composes them.

// --- Phase 3: user/project extension roots ---

// builtinOnlyFS is an embedded filesystem with just the core manifest + sdk
// version, used as the builtin root while exercising disk-based user/project
// roots passed separately to NewExtensionsAPI.
func builtinOnlyFS() fstest.MapFS {
	return coreFS(coreManifest, "1.0.0")
}

// runHandler executes HandleListExtensions and returns the decoded response.
func runHandler(t *testing.T, api *ExtensionsAPI) []Extension {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/extensions", nil)
	rec := httptest.NewRecorder()
	api.HandleListExtensions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var exts []Extension
	if err := json.Unmarshal(rec.Body.Bytes(), &exts); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return exts
}

// writeFileTree writes files (relative path → contents) under root, creating dirs.
func writeFileTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
}

// findExt returns the extension with the given id, or nil.
func findExt(exts []Extension, id string) *Extension {
	for i := range exts {
		if exts[i].Manifest.ID == id {
			return &exts[i]
		}
	}
	return nil
}

func TestExtensionsUserExtensionDiscovered(t *testing.T) {
	userExtDir := t.TempDir()
	writeFileTree(t, userExtDir, map[string]string{
		"code-review/juggler.extension.json": `{
			"id": "@jules/code-review", "name": "Code Review", "version": "1.0.0",
			"engineApi": "^1.0.0",
			"provides": {"contextItems": ["context-items/*-context-item.js"]}
		}`,
		"code-review/context-items/lint-context-item.js": "//",
		"code-review/README.md":                          "ignore me",
	})

	api := NewExtensionsAPI(builtinOnlyFS(), "", userExtDir)
	exts := runHandler(t, api)

	if findExt(exts, "@juggler/core") == nil {
		t.Fatal("core extension missing")
	}
	ext := findExt(exts, "@jules/code-review")
	if ext == nil {
		t.Fatal("user extension not discovered")
	}
	if ext.Source != "user" {
		t.Errorf("source = %q, want user", ext.Source)
	}
	if ext.Error != "" {
		t.Fatalf("unexpected error: %s", ext.Error)
	}
	want := api.UserExtensionURLPrefix() + "code-review/context-items/lint-context-item.js"
	if len(ext.Capabilities.ContextItems) != 1 || ext.Capabilities.ContextItems[0] != want {
		t.Errorf("contextItems = %v, want [%s]", ext.Capabilities.ContextItems, want)
	}
}

// An extension's translations reach the UI through Catalogs: the catalogue for
// the asked locale, per extension id, from built-in and user extensions alike,
// along the same chain as the core catalogue and never as English.
func TestExtensionsCatalogs(t *testing.T) {
	builtin := coreFS(strings.Replace(coreManifest, `"provides": {`, `"provides": {"i18n": "i18n",`, 1), "1.1.0")
	builtin["extensions/juggler-core/i18n/en.json"] = &fstest.MapFile{Data: []byte(`{"Read":"Read"}`)}
	builtin["extensions/juggler-core/i18n/zh.json"] = &fstest.MapFile{Data: []byte(`{"Read":"读取"}`)}
	builtin["extensions/juggler-core/i18n/en-XA.json"] = &fstest.MapFile{Data: []byte(`{"Read":"[Ŕéåð ··]"}`)}

	userExtDir := t.TempDir()
	writeFileTree(t, userExtDir, map[string]string{
		"good/juggler.extension.json": `{"id":"@you/good","name":"Good","version":"1.0.0","engineApi":"^1.1.0",
			"provides":{"commands":["c/*-command-type.js"],"i18n":"i18n"}}`,
		"good/c/x-command-type.js": "//",
		"good/i18n/zh-Hant.json":   `{"Go":"去"}`,
		// Only Stop is in zh: the merge gives a zh-Hant reader both.
		"good/i18n/zh.json": `{"Go":"去 (zh)","Stop":"停"}`,
		"broken/juggler.extension.json": `{"id":"@you/broken","name":"Broken","version":"1.0.0","engineApi":"^1.1.0",
			"provides":{"commands":["c/*-command-type.js"],"i18n":"i18n"}}`,
		"broken/c/x-command-type.js": "//",
		"broken/i18n/zh.json":        `{"Go":1}`,
		"failed/juggler.extension.json": `{"id":"@you/failed","name":"Failed","version":"1.0.0","engineApi":"^9.0.0",
			"provides":{"commands":["c/*-command-type.js"],"i18n":"i18n"}}`,
		"failed/c/x-command-type.js": "//",
		"failed/i18n/zh.json":        `{"Go":"去"}`,
		// A user extension reusing a built-in id does not replace its catalogue.
		"impostor/juggler.extension.json": `{"id":"@juggler/core","name":"Impostor","version":"1.0.0","engineApi":"^1.1.0",
			"provides":{"commands":["c/*-command-type.js"],"i18n":"i18n"}}`,
		"impostor/c/x-command-type.js": "//",
		"impostor/i18n/zh.json":        `{"Read":"冒充"}`,
	})
	api := NewExtensionsAPI(builtin, "", userExtDir)

	got := api.Catalogs("zh-Hant-TW")
	if got["@juggler/core"]["Read"] != "读取" {
		t.Errorf("built-in zh-Hant-TW → zh: got %v", got["@juggler/core"])
	}
	if got["@you/good"]["Go"] != "去" {
		t.Errorf("user zh-Hant-TW → zh-Hant: got %v", got["@you/good"])
	}
	// The chain falls back per message, not per file: what zh-Hant lacks comes
	// from zh, and what both have comes from the more specific one.
	if got["@you/good"]["Stop"] != "停" {
		t.Errorf("a message zh-Hant lacks falls back to zh: got %v", got["@you/good"])
	}
	if _, ok := got["@you/broken"]; ok {
		t.Error("a catalogue that will not parse must be skipped")
	}
	if _, ok := got["@you/failed"]; ok {
		t.Error("an extension that does not load contributes no catalogue")
	}
	if xa := api.Catalogs("en-XA"); xa["@juggler/core"]["Read"] != "[Ŕéåð ··]" {
		t.Errorf("en-XA: got %v", xa["@juggler/core"])
	}
	for _, locale := range []string{"en", "en-GB", "de", "", "../x"} {
		if c := api.Catalogs(locale); len(c) != 0 {
			t.Errorf("Catalogs(%q) = %v, want none (English is the source; nothing else matches)", locale, c)
		}
	}

	// The broken catalogue still loads its extension, with a warning saying why
	// its translations are missing.
	broken := findExt(runHandler(t, api), "@you/broken")
	if broken == nil || broken.Error != "" {
		t.Fatalf("a broken catalogue must not stop the extension loading: %+v", broken)
	}
	if len(broken.Warnings) == 0 || !strings.Contains(strings.Join(broken.Warnings, " "), "i18n") {
		t.Errorf("warnings = %v, want one naming the catalogue", broken.Warnings)
	}
}

func TestExtensionsProjectContainerIgnored(t *testing.T) {
	// Project-scoped extensions were removed: only builtin and user containers
	// are discovery sources. A <project>/.juggler/extensions tree is never a
	// source — discovery scans a container's immediate subdirs for a manifest,
	// so even pointed at a project root the nested extension is not loaded.
	projectDir := t.TempDir()
	writeFileTree(t, projectDir, map[string]string{
		".juggler/extensions/myext/juggler.extension.json": `{
			"id": "@me/myext", "name": "My Ext", "version": "2.1.0",
			"provides": {"commands": ["commands/*-command-type.js"]}
		}`,
		".juggler/extensions/myext/commands/hi-command-type.js": "//",
	})

	// Pass the project root even as the user container: the extension lives two
	// levels down under .juggler/extensions and must still not be discovered.
	api := NewExtensionsAPI(builtinOnlyFS(), "", projectDir)
	exts := runHandler(t, api)

	if ext := findExt(exts, "@me/myext"); ext != nil {
		t.Fatalf("a <project>/.juggler/extensions extension must not be discovered, got %+v", ext)
	}
}

func TestExtensionsSymlinkedExtensionDiscovered(t *testing.T) {
	// `juggler ext link ./dev-ext` symlinks an external dev directory into the
	// extension container. Discovery must follow that symlink (its DirEntry
	// reports IsDir()==false) and expand globs against the real target.
	devDir := t.TempDir()
	writeFileTree(t, devDir, map[string]string{
		"dev-ext/juggler.extension.json": `{
			"id": "@jules/dev-ext", "name": "Dev Ext", "version": "0.1.0",
			"engineApi": "^1.0.0",
			"provides": {"contextItems": ["context-items/*-context-item.js"]}
		}`,
		"dev-ext/context-items/word-count-context-item.js": "//",
	})

	userExtDir := t.TempDir()
	link := filepath.Join(userExtDir, "dev-ext")
	if err := os.Symlink(filepath.Join(devDir, "dev-ext"), link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	api := NewExtensionsAPI(builtinOnlyFS(), "", userExtDir)
	exts := runHandler(t, api)

	ext := findExt(exts, "@jules/dev-ext")
	if ext == nil {
		t.Fatal("symlinked extension not discovered")
	}
	if ext.Error != "" {
		t.Fatalf("unexpected error: %s", ext.Error)
	}
	if ext.Source != "user" {
		t.Errorf("source = %q, want user", ext.Source)
	}
	want := api.UserExtensionURLPrefix() + "dev-ext/context-items/word-count-context-item.js"
	if len(ext.Capabilities.ContextItems) != 1 || ext.Capabilities.ContextItems[0] != want {
		t.Errorf("contextItems = %v, want [%s]", ext.Capabilities.ContextItems, want)
	}
}

func TestExtensionsFilePathsForOnDiskExtension(t *testing.T) {
	// An on-disk extension exposes the absolute manifest path and a served-URL →
	// absolute-disk-path map for every capability, so the catalog can show the
	// file and reveal it in Finder.
	userExtDir := t.TempDir()
	writeFileTree(t, userExtDir, map[string]string{
		"pack/juggler.extension.json": `{
			"id": "@jules/pack", "name": "Pack", "version": "1.0.0",
			"engineApi": "^1.0.0",
			"provides": {"contextItems": ["context-items/*-context-item.js"]}
		}`,
		"pack/context-items/word-count-context-item.js": "//",
	})

	api := NewExtensionsAPI(builtinOnlyFS(), "", userExtDir)
	exts := runHandler(t, api)

	ext := findExt(exts, "@jules/pack")
	if ext == nil {
		t.Fatal("pack extension not discovered")
	}
	wantManifest := filepath.Join(userExtDir, "pack", "juggler.extension.json")
	if ext.ManifestPath != wantManifest {
		t.Errorf("ManifestPath = %q, want %q", ext.ManifestPath, wantManifest)
	}
	url := api.UserExtensionURLPrefix() + "pack/context-items/word-count-context-item.js"
	wantFile := filepath.Join(userExtDir, "pack", "context-items", "word-count-context-item.js")
	if got := ext.Files[url]; got != wantFile {
		t.Errorf("Files[%q] = %q, want %q", url, got, wantFile)
	}
}

func TestUserExtensionURLPrefixEpoch(t *testing.T) {
	// Served capability URLs carry a reload epoch, and BumpEpoch must move it:
	// ES module identity is keyed by URL, so a reload that re-imported the same
	// URL would replay the cached module and the user's edit would never run.
	// Builtin extension URLs are unaffected — they cache-bust on staticVersion.
	userExtDir := t.TempDir()
	writeFileTree(t, userExtDir, map[string]string{
		"pack/juggler.extension.json": `{
			"id": "@jules/pack", "name": "Pack", "version": "1.0.0",
			"engineApi": "^1.0.0",
			"provides": {"contextItems": ["context-items/*-context-item.js"]}
		}`,
		"pack/context-items/word-count-context-item.js": "//",
	})

	api := NewExtensionsAPI(builtinOnlyFS(), "", userExtDir)
	if got := api.UserExtensionURLPrefix(); got != UserExtensionURLBase+"e0/" {
		t.Errorf("initial prefix = %q, want %q", got, UserExtensionURLBase+"e0/")
	}

	before := findExt(runHandler(t, api), "@jules/pack")
	if before == nil {
		t.Fatal("pack extension not discovered")
	}

	api.BumpEpoch()

	after := findExt(runHandler(t, api), "@jules/pack")
	if after == nil {
		t.Fatal("pack extension not discovered after bump")
	}
	if len(after.Capabilities.ContextItems) != 1 {
		t.Fatalf("contextItems = %v, want one entry", after.Capabilities.ContextItems)
	}
	if after.Capabilities.ContextItems[0] == before.Capabilities.ContextItems[0] {
		t.Errorf("capability URL unchanged after BumpEpoch: %q", after.Capabilities.ContextItems[0])
	}
	// The reveal map is keyed by served URL, so it must follow the epoch too or
	// the catalog loses the on-disk path for every capability after a reload.
	if _, ok := after.Files[after.Capabilities.ContextItems[0]]; !ok {
		t.Errorf("Files has no entry for %q", after.Capabilities.ContextItems[0])
	}
}

func TestExtensionsEmbeddedExtensionHasNoFilePaths(t *testing.T) {
	// A builtin extension embedded in the binary (no builtinDir) has no revealable
	// file, so ManifestPath/Files are empty rather than pointing at bogus paths.
	api := NewExtensionsAPI(builtinOnlyFS(), "", "")
	exts := runHandler(t, api)

	ext := findExt(exts, "@juggler/core")
	if ext == nil {
		t.Fatal("embedded @juggler/core not discovered")
	}
	if ext.ManifestPath != "" {
		t.Errorf("embedded ManifestPath = %q, want empty", ext.ManifestPath)
	}
	if len(ext.Files) != 0 {
		t.Errorf("embedded Files = %v, want empty", ext.Files)
	}
}

// TestExtensionsReloadBumpsEpochBeforeBroadcast pins the order HandleReload
// depends on: the clients the broadcast reaches refetch the catalog at once, so
// the epoch must already have moved or they re-import the stale module URLs and
// the reload appears to do nothing.
func TestExtensionsReloadBumpsEpochBeforeBroadcast(t *testing.T) {
	api := NewExtensionsAPI(builtinOnlyFS(), "", "")
	before := api.UserExtensionURLPrefix()
	var atBroadcast []string
	api.SetReloadBroadcast(func() { atBroadcast = append(atBroadcast, api.UserExtensionURLPrefix()) })

	rec := httptest.NewRecorder()
	api.HandleReload(rec, httptest.NewRequest(http.MethodPost, "/api/extensions/reload", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if len(atBroadcast) != 1 {
		t.Fatalf("broadcast ran %d times, want 1", len(atBroadcast))
	}
	if atBroadcast[0] == before {
		t.Fatalf("broadcast saw prefix %q, the one from before the reload", atBroadcast[0])
	}
}

// TestExtensionsReloadUnwiredRefuses verifies an API with no broadcast wired
// says so instead of reporting a reload that reached no client.
func TestExtensionsReloadUnwiredRefuses(t *testing.T) {
	api := NewExtensionsAPI(builtinOnlyFS(), "", "")
	rec := httptest.NewRecorder()
	api.HandleReload(rec, httptest.NewRequest(http.MethodPost, "/api/extensions/reload", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}
