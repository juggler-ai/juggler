//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package testing

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"juggler/cmd/juggler/extmanifest"
	"juggler/cmd/juggler/server/handlers"
)

// SessionResetter is the minimum SessionManager surface the test API needs
// to wipe stale conversations between tests. *core.SessionManager satisfies
// it. The interface keeps the production stub free of any core import.
type SessionResetter interface {
	ConvNames() map[string]string
	DeleteConversation(convID string, permanent bool) error
}

// TestAPI handles benchmark test endpoints.
//
// tapeDumper is wired by the server with worker.Manager.DumpTape and used by
// HandleDumpTape to return per-conv worker event tapes. Stored as a literal
// func type (not a named typedef) so interface-method-signature matching in
// routes.go works — two function types with identical signatures only match
// if both refer to the same NAMED type or both are unnamed.
type TestAPI struct {
	testsDir      string
	fixturesDir   string
	webExtDir     string
	session       SessionResetter
	tapeDumper    func(string) any
	tapeHead      func(string) int64
	convOwnership *ConvOwnership
}

// NewTestAPIWithSession creates a test API that can bulldoze conversations
// via the supplied SessionResetter. session may be nil if no manager is
// available yet.
func NewTestAPIWithSession(projectRoot string, session SessionResetter) *TestAPI {
	return &TestAPI{
		testsDir:      filepath.Join(projectRoot, "tests", "benchmarks", "tasks"),
		fixturesDir:   filepath.Join(projectRoot, "tests", "benchmarks", "fixtures"),
		webExtDir:     filepath.Join(projectRoot, "web", "extensions"),
		session:       session,
		convOwnership: NewConvOwnership(),
	}
}

// SetTapeDumper wires the worker manager so the dump-tape endpoint can
// surface per-worker event tapes at test-failure time. Optional; if unset,
// HandleDumpTape returns an empty list.
func (api *TestAPI) SetTapeDumper(fn func(string) any) {
	api.tapeDumper = fn
}

// SetTapeHead wires the worker manager so the tape-head endpoint can say when
// each conversation's worker last recorded anything. Optional; if unset,
// HandleTapeHead reports 0 for every conversation.
func (api *TestAPI) SetTapeHead(fn func(string) int64) {
	api.tapeHead = fn
}

// RecordConvOwner / CheckConvDelete / ReleaseConvOwner expose the ownership
// ledger to the server's conversation-ownership middleware (installed by
// RegisterTestRoutes). See ConvOwnership for the invariant they enforce.

// RecordConvOwner registers lane as the creator of convID, tagged with reason
// (the creating test's name) so a leak dump can name the culprit test.
func (api *TestAPI) RecordConvOwner(convID, lane, reason string) {
	api.convOwnership.Record(convID, lane, reason)
}

// CheckConvDelete reports whether lane may delete convID.
func (api *TestAPI) CheckConvDelete(convID, lane string) error {
	return api.convOwnership.CheckDelete(convID, lane)
}

// ReleaseConvOwner clears ownership after a successful delete.
func (api *TestAPI) ReleaseConvOwner(convID string) {
	api.convOwnership.Release(convID)
}

// HandleConversationOwners returns the current ownership map
// (convID → {lane, reason}). GET /api/test/conversation-owners. A non-empty
// map at suite end means those conversations leaked — created by a test, never
// deleted — and the Go harness fails the run with this list (each entry named
// by its creating test's reason) so leaks can't silently accumulate toward the
// MAX_CONVERSATIONS cap.
func (api *TestAPI) HandleConversationOwners(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, map[string]any{"owners": api.convOwnership.Dump()})
}

// extensionTest is one discovered extension-owned test suite: its addressable
// name (e.g. "unit:exa-search") and the served, extension-root-relative path
// of its module (e.g. "/extensions/exa/_tests/exa-search-test.js"). The browser
// harness prepends the version prefix and dynamic-imports the module, whose
// runTests export it registers as a unit suite.
type extensionTest struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// HandleExtensionTests discovers extension-owned test suites by scanning the
// on-disk web/extensions/* tree, reading each juggler.extension.json, and
// expanding its `provides.tests` globs (unit suites, served by name and path)
// and its `provides.integrationTests` globs (integration modules, served by
// path: each names its own tests). GET /api/test/extension-tests.
//
// Test suites are discovered from disk (not the embedded FS) because the test
// files live under a "_tests/" directory that `//go:embed extensions/*` skips
// so they never ship in a production binary — and the test harness always runs
// with --assets-from-disk, so the real files are present. This is the
// manifest-driven replacement for hand-listing each extension test in
// integration-test-executor.js: an extension owns its tests via its manifest.
func (api *TestAPI) HandleExtensionTests(w http.ResponseWriter, r *http.Request) {
	tests := []extensionTest{}
	integrationModules := []string{}

	entries, err := os.ReadDir(api.webExtDir)
	if err != nil {
		// No extensions dir (e.g. running outside a source checkout) — return an
		// empty list rather than an error; the harness treats it as "no extension
		// tests" and runs the internal suites normally.
		handlers.WriteJSON(w, r, 0, map[string]any{"tests": tests, "integrationModules": integrationModules})
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		extDir := filepath.Join(api.webExtDir, entry.Name())
		data, err := os.ReadFile(filepath.Join(extDir, extmanifest.ManifestFileName))
		if err != nil {
			continue // not an extension dir
		}
		manifest, err := extmanifest.Parse(data)
		if err != nil {
			continue
		}
		// Expand the globs against the extension root, applying the same
		// traversal guard the server uses for capability globs.
		if len(manifest.Provides.Tests) > 0 {
			if matches, err := extmanifest.ExpandGlobs(os.DirFS(extDir), manifest.Provides.Tests); err == nil {
				for _, rel := range matches {
					tests = append(tests, extensionTest{
						Name: extensionTestName(rel),
						Path: "/extensions/" + entry.Name() + "/" + rel,
					})
				}
			}
		}
		if len(manifest.Provides.IntegrationTests) > 0 {
			if matches, err := extmanifest.ExpandGlobs(os.DirFS(extDir), manifest.Provides.IntegrationTests); err == nil {
				for _, rel := range matches {
					integrationModules = append(integrationModules, "/extensions/"+entry.Name()+"/"+rel)
				}
			}
		}
	}

	// Stable order so the discovered list (and thus test scheduling) is
	// deterministic across runs regardless of filesystem enumeration order.
	sort.Slice(tests, func(i, j int) bool { return tests[i].Name < tests[j].Name })
	sort.Strings(integrationModules)
	handlers.WriteJSON(w, r, 0, map[string]any{"tests": tests, "integrationModules": integrationModules})
}

// extensionTestName derives the harness-addressable suite name from a test
// module's root-relative path, e.g. "_tests/exa-search-test.js" →
// "unit:exa-search". The "unit:" prefix and "-test" suffix stripping match the
// naming the shared js-tests/ pool already uses, so an extension test keeps the
// same name after being moved into its extension.
func extensionTestName(rel string) string {
	base := filepath.Base(rel)
	base = strings.TrimSuffix(base, ".js")
	base = strings.TrimSuffix(base, "-test")
	return "unit:" + base
}

// HandleGetTask returns a specific task by ID
func (api *TestAPI) HandleGetTask(w http.ResponseWriter, r *http.Request) {
	taskID := r.URL.Query().Get("id")
	if taskID == "" {
		http.Error(w, "Task ID is required", http.StatusBadRequest)
		return
	}

	// Find task file
	var taskPath string
	err := filepath.Walk(api.testsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}

		var task map[string]any
		if err := json.Unmarshal(data, &task); err != nil {
			return nil
		}

		if id, ok := task["id"].(string); ok && id == taskID {
			taskPath = path
			return filepath.SkipAll
		}

		return nil
	})

	if err != nil {
		http.Error(w, fmt.Sprintf("Error searching for task: %v", err), http.StatusInternalServerError)
		return
	}

	if taskPath == "" {
		http.Error(w, "Task not found", http.StatusNotFound)
		return
	}

	// Read and return task
	data, err := os.ReadFile(taskPath)
	if err != nil {
		http.Error(w, "Failed to read task", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

// HandleResetFixture resets a fixture directory by deleting contents and re-copying from template
func (api *TestAPI) HandleResetFixture(w http.ResponseWriter, r *http.Request) {
	fixtureName := r.URL.Query().Get("fixture")
	fixtureDir := r.URL.Query().Get("dir")

	if fixtureName == "" || fixtureDir == "" {
		http.Error(w, "fixture and dir query params required", http.StatusBadRequest)
		return
	}

	sourcePath := filepath.Join(api.fixturesDir, fixtureName)
	if _, err := os.Stat(sourcePath); os.IsNotExist(err) {
		http.Error(w, "Fixture template not found: "+sourcePath, http.StatusNotFound)
		return
	}

	// Delete fixture contents EXCEPT .juggler (session runtime state)
	// The .juggler directory is actively used by the session manager and can't be deleted
	entries, err := os.ReadDir(fixtureDir)
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, "ReadDir failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	for _, entry := range entries {
		if entry.Name() == ".juggler" {
			continue // Skip runtime state directory
		}
		entryPath := filepath.Join(fixtureDir, entry.Name())
		if err := os.RemoveAll(entryPath); err != nil {
			http.Error(w, "RemoveAll failed for "+entry.Name()+": "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if err := os.MkdirAll(fixtureDir, 0o755); err != nil {
		http.Error(w, "MkdirAll failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Copy from template (same pattern as setupFixture in main.go)
	var copiedFiles []string
	err = filepath.Walk(sourcePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relPath, _ := filepath.Rel(sourcePath, path)
		dstPath := filepath.Join(fixtureDir, relPath)
		if info.IsDir() {
			return os.MkdirAll(dstPath, info.Mode())
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		copiedFiles = append(copiedFiles, relPath)
		return os.WriteFile(dstPath, src, info.Mode())
	})
	if err != nil {
		http.Error(w, "Copy failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Return list of files for debugging
	handlers.WriteJSON(w, r, 0, map[string]any{
		"success": true,
		"files":   copiedFiles,
	})
}

// resolveFixturePath validates that relPath resolves inside fixtureDir and
// returns the absolute target. Shared by HandleDeleteFile / HandleMkdir so
// both use the same containment check.
func resolveFixturePath(fixtureDir, relPath string) (string, error) {
	if fixtureDir == "" || relPath == "" {
		return "", fmt.Errorf("dir and path query params required")
	}
	absDir, err := filepath.Abs(fixtureDir)
	if err != nil {
		return "", fmt.Errorf("invalid dir: %w", err)
	}
	absTarget, err := filepath.Abs(filepath.Join(absDir, relPath))
	if err != nil {
		return "", fmt.Errorf("invalid path: %w", err)
	}
	rel, err := filepath.Rel(absDir, absTarget)
	if err != nil || strings.HasPrefix(rel, "..") || rel == ".." {
		return "", fmt.Errorf("path is outside fixture dir")
	}
	return absTarget, nil
}

// HandleDeleteFile removes a path (file or directory) within a fixture dir.
// Used by the integration test runner to wipe the per-test subfolder on
// teardown — `rm -rf ${fixtureDir}/${testDir}`. Path-traversal guarded: the
// target must resolve under fixtureDir.
func (api *TestAPI) HandleDeleteFile(w http.ResponseWriter, r *http.Request) {
	absTarget, err := resolveFixturePath(r.URL.Query().Get("dir"), r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := os.RemoveAll(absTarget); err != nil {
		http.Error(w, "RemoveAll failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"success": true})
}

// HandleDumpTape returns the per-worker event tape for the given
// conversation, serialised as JSON. Used by the integration test runner's
// failure-message builder to splice worker-side events into the failure
// block. Tracing is enabled via JUGGLER_TRACE on the server; when off, the
// dump is an empty list (no diagnostic spam in production builds).
func (api *TestAPI) HandleDumpTape(w http.ResponseWriter, r *http.Request) {
	convID := r.URL.Query().Get("convId")
	if convID == "" {
		http.Error(w, "convId query param required", http.StatusBadRequest)
		return
	}
	var entries any
	if api.tapeDumper != nil {
		entries = api.tapeDumper(convID)
	}
	if entries == nil {
		entries = []any{}
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"entries": entries})
}

// HandleTapeHead reports, for each conversation in the comma-separated
// convIds, when its worker last recorded a tape entry (Unix milliseconds, 0 for
// none), and under "*" when any worker did. A lane's stall watchdog polls it as
// progress: a worker working through a backlog, or a server working through
// the other lanes' work in front of this one's, is visible here long before
// the lane hears any of it.
func (api *TestAPI) HandleTapeHead(w http.ResponseWriter, r *http.Request) {
	heads := map[string]int64{}
	for _, id := range append(strings.Split(r.URL.Query().Get("convIds"), ","), "*") {
		if id = strings.TrimSpace(id); id == "" {
			continue
		}
		if api.tapeHead != nil {
			heads[id] = api.tapeHead(id)
		} else {
			heads[id] = 0
		}
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"heads": heads})
}

// HandleMkdir creates a directory (mkdir -p) within a fixture dir. Used by
// the integration test runner to prepare a per-test subfolder before the
// test body runs. Path-traversal guarded the same way as delete-file.
func (api *TestAPI) HandleMkdir(w http.ResponseWriter, r *http.Request) {
	absTarget, err := resolveFixturePath(r.URL.Query().Get("dir"), r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(absTarget, 0o755); err != nil {
		http.Error(w, "MkdirAll failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"success": true})
}
