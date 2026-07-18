//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/mux"
)

// ── fake GitHub ─────────────────────────────────────────────────────────────

// fakeRepo is an in-memory GitHub repository served over httptest so the whole
// marketplace handler runs hermetically — make test-all never touches live
// GitHub. It implements just the three endpoints registryFetcher uses (commits,
// recursive tree, raw blobs) for a single repo; requests for any other repo 404,
// so the second built-in source simply reports a fetch error with zero entries.
type fakeRepo struct {
	repo      string            // "owner/name" this fixture answers for
	commit    string            // resolved commit sha
	treeSha   string            // root tree sha
	etag      string            // ETag returned by the commits endpoint
	truncated bool              // git tree truncated flag
	files     map[string]string // path → content (blobs)
	execFiles map[string]bool   // paths served with mode 100755
	symlinks  map[string]bool   // paths served with mode 120000
	sizes     map[string]int64  // tree-reported size override (advisory, pre-fetch caps)
	dirShas   map[string]string // per-directory tree sha override (update-detection signal)
	requests  atomic.Int64      // count of served requests (rate-limit assertions)
}

func newFakeRepo(repo string) *fakeRepo {
	return &fakeRepo{
		repo:      repo,
		commit:    "commit-1",
		treeSha:   "roottree-1",
		etag:      `"etag-1"`,
		files:     map[string]string{},
		execFiles: map[string]bool{},
		symlinks:  map[string]bool{},
		sizes:     map[string]int64{},
		dirShas:   map[string]string{},
	}
}

// add registers a blob at path with content.
func (fr *fakeRepo) add(p, content string) *fakeRepo { fr.files[p] = content; return fr }

// treeEntries synthesizes the recursive tree: one blob per file (with mode and
// size), plus a tree entry for every intermediate directory (with a deterministic
// or overridden sha).
func (fr *fakeRepo) treeEntries() []treeEntry {
	dirs := map[string]bool{}
	var entries []treeEntry
	for p, content := range fr.files {
		mode := "100644"
		switch {
		case fr.symlinks[p]:
			mode = "120000"
		case fr.execFiles[p]:
			mode = "100755"
		}
		size := int64(len(content))
		if s, ok := fr.sizes[p]; ok {
			size = s
		}
		entries = append(entries, treeEntry{Path: p, Mode: mode, Type: "blob", Sha: "blob-" + p, Size: size})
		for d := path.Dir(p); d != "." && d != "/" && d != ""; d = path.Dir(d) {
			dirs[d] = true
		}
	}
	for d := range dirs {
		sha := "tree-" + d
		if s, ok := fr.dirShas[d]; ok {
			sha = s
		}
		entries = append(entries, treeEntry{Path: d, Mode: "040000", Type: "tree", Sha: sha})
	}
	return entries
}

func (fr *fakeRepo) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fr.requests.Add(1)
		p := r.URL.Path
		switch {
		case strings.HasPrefix(p, "/raw/"+fr.repo+"/"):
			// /raw/{owner}/{repo}/{commit}/{filepath...}
			rest := strings.TrimPrefix(p, "/raw/")
			parts := strings.SplitN(rest, "/", 4)
			if len(parts) < 4 {
				http.NotFound(w, r)
				return
			}
			file, _ := url.PathUnescape(parts[3])
			content, ok := fr.files[file]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(content))
		case strings.HasPrefix(p, "/repos/"+fr.repo+"/commits/"):
			if inm := r.Header.Get("If-None-Match"); inm != "" && inm == fr.etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", fr.etag)
			resp := map[string]any{
				"sha":    fr.commit,
				"commit": map[string]any{"tree": map[string]any{"sha": fr.treeSha}},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(p, "/repos/"+fr.repo+"/git/trees/"):
			resp := map[string]any{"tree": fr.treeEntries(), "truncated": fr.truncated}
			_ = json.NewEncoder(w).Encode(resp)
		default:
			http.NotFound(w, r)
		}
	}
}

// ── test harness ────────────────────────────────────────────────────────────

// newTestRegistryAPI isolates all per-user state (JUGGLER_CONFIG_DIR + HOME) and
// points the fetcher at a fake-GitHub httptest server, with a frozen clock.
func newTestRegistryAPI(t *testing.T, projectDir string, fr *fakeRepo) *SkillsRegistryAPI {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	srv := httptest.NewServer(fr.handler())
	t.Cleanup(srv.Close)
	skills := NewSkillsAPI(func() string { return projectDir })
	api := NewSkillsRegistryAPI(func() string { return projectDir }, skills)
	api.fetcher = &githubFetcher{apiBase: srv.URL, rawBase: srv.URL + "/raw", client: srv.Client()}
	api.now = func() time.Time { return time.Unix(1700000000, 0) }
	return api
}

func skillMD(description string) string {
	return "---\ndescription: " + description + "\n---\nInstructions body.\n"
}

func getCatalog(t *testing.T, api *SkillsRegistryAPI, refresh bool) CatalogResponse {
	t.Helper()
	target := "/api/skills/catalog"
	if refresh {
		target += "?refresh=1"
	}
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	api.HandleCatalog(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("catalog status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	var resp CatalogResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal catalog: %v", err)
	}
	return resp
}

// entriesFor returns just the entries belonging to one source id, keyed by name.
func entriesFor(resp CatalogResponse, source string) map[string]CatalogEntry {
	m := map[string]CatalogEntry{}
	for _, e := range resp.Entries {
		if e.Source == source {
			m[e.Name] = e
		}
	}
	return m
}

func superpowers() *fakeRepo { return newFakeRepo("obra/superpowers") }

// ── catalog build ───────────────────────────────────────────────────────────

func TestCatalogFlatLayout(t *testing.T) {
	fr := superpowers().
		add("skills/systematic-debugging/SKILL.md", skillMD("Root-cause a failing test")).
		add("skills/tdd/SKILL.md", skillMD("Test-driven development"))
	// Non-skill noise the walk must ignore.
	fr.add(".claude-plugin/manifest.json", "{}")
	fr.add("README.md", "# hi")
	api := newTestRegistryAPI(t, "", fr)

	got := entriesFor(getCatalog(t, api, true), "superpowers")
	if len(got) != 2 {
		t.Fatalf("got %d skills, want 2: %+v", len(got), got)
	}
	e := got["tdd"]
	if e.Path != "skills/tdd" {
		t.Errorf("path = %q, want skills/tdd", e.Path)
	}
	if len(e.Category) != 0 {
		t.Errorf("category = %v, want empty", e.Category)
	}
	if e.Description != "Test-driven development" {
		t.Errorf("description = %q", e.Description)
	}
	if e.ID != "superpowers:skills/tdd" {
		t.Errorf("id = %q", e.ID)
	}
}

func TestCatalogNestedCategories(t *testing.T) {
	fr := superpowers().
		add("skills/engineering/tdd/SKILL.md", skillMD("TDD")).
		add("skills/productivity/inbox-zero/SKILL.md", skillMD("Inbox zero"))
	api := newTestRegistryAPI(t, "", fr)

	got := entriesFor(getCatalog(t, api, true), "superpowers")
	e, ok := got["tdd"]
	if !ok {
		t.Fatalf("tdd missing: %+v", got)
	}
	if len(e.Category) != 1 || e.Category[0] != "engineering" {
		t.Errorf("category = %v, want [engineering]", e.Category)
	}
	if e.Path != "skills/engineering/tdd" {
		t.Errorf("path = %q", e.Path)
	}
}

func TestCatalogScriptsAndSizes(t *testing.T) {
	fr := superpowers().
		add("skills/deploy/SKILL.md", skillMD("Deploy")).
		add("skills/deploy/scripts/run.sh", "echo hi").
		add("skills/deploy/references/notes.md", "notes")
	api := newTestRegistryAPI(t, "", fr)

	e := entriesFor(getCatalog(t, api, true), "superpowers")["deploy"]
	if !e.HasScripts {
		t.Errorf("hasScripts = false, want true")
	}
	if e.FileCount != 3 {
		t.Errorf("fileCount = %d, want 3", e.FileCount)
	}
	wantSize := int64(len("echo hi") + len("notes") + len(skillMD("Deploy")))
	if e.TotalSize != wantSize {
		t.Errorf("totalSize = %d, want %d", e.TotalSize, wantSize)
	}
}

func TestCatalogSluggedName(t *testing.T) {
	fr := superpowers().add("skills/My_Cool Skill/SKILL.md", skillMD("Cool"))
	api := newTestRegistryAPI(t, "", fr)

	got := entriesFor(getCatalog(t, api, true), "superpowers")
	e, ok := got["my-cool-skill"]
	if !ok {
		t.Fatalf("slugified name missing: %+v", got)
	}
	if !e.Slugged {
		t.Errorf("slugged = false, want true")
	}
}

func TestCatalogMalformedListedWithError(t *testing.T) {
	fr := superpowers().add("skills/broken/SKILL.md", "no frontmatter here")
	api := newTestRegistryAPI(t, "", fr)

	got := entriesFor(getCatalog(t, api, true), "superpowers")
	e, ok := got["broken"]
	if !ok {
		t.Fatalf("broken skill dropped: %+v", got)
	}
	if e.Error == "" {
		t.Errorf("expected an error on malformed skill")
	}
}

func TestCatalogSymlinkExcluded(t *testing.T) {
	fr := superpowers().add("skills/link/SKILL.md", skillMD("Link"))
	fr.add("skills/link/evil", "target")
	fr.symlinks["skills/link/evil"] = true
	api := newTestRegistryAPI(t, "", fr)

	e := entriesFor(getCatalog(t, api, true), "superpowers")["link"]
	if e.FileCount != 1 {
		t.Errorf("fileCount = %d, want 1 (symlink excluded)", e.FileCount)
	}
}

func TestCatalogTruncatedFlag(t *testing.T) {
	fr := superpowers().add("skills/tdd/SKILL.md", skillMD("TDD"))
	fr.truncated = true
	api := newTestRegistryAPI(t, "", fr)

	resp := getCatalog(t, api, true)
	var found bool
	for _, s := range resp.Sources {
		if s.ID == "superpowers" {
			found = true
			if !s.Truncated {
				t.Errorf("source truncated = false, want true")
			}
		}
	}
	if !found {
		t.Fatalf("superpowers source status missing")
	}
}

func TestCatalogStaleOnFetchError(t *testing.T) {
	fr := superpowers().add("skills/tdd/SKILL.md", skillMD("TDD"))
	api := newTestRegistryAPI(t, "", fr)
	getCatalog(t, api, true) // warm the disk cache

	// Break the upstream (point the repo elsewhere): a refresh now fails, but the
	// cached catalog must still be served, marked with the error.
	fr.repo = "nonexistent/repo"
	resp := getCatalog(t, api, true)
	if len(entriesFor(resp, "superpowers")) != 1 {
		t.Errorf("stale catalog not served after fetch error")
	}
	for _, s := range resp.Sources {
		if s.ID == "superpowers" && s.Error == "" {
			t.Errorf("expected fetch error recorded on source status")
		}
	}
}

// ── catalog entry (preview) ─────────────────────────────────────────────────

func TestCatalogEntryPreview(t *testing.T) {
	fr := superpowers().
		add("skills/deploy/SKILL.md", skillMD("Deploy")).
		add("skills/deploy/scripts/run.sh", "echo hi")
	api := newTestRegistryAPI(t, "", fr)
	getCatalog(t, api, true)

	req := httptest.NewRequest(http.MethodGet, "/api/skills/catalog/entry?source=superpowers&path="+url.QueryEscape("skills/deploy"), nil)
	rec := httptest.NewRecorder()
	api.HandleCatalogEntry(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("entry status = %d (%s)", rec.Code, rec.Body.String())
	}
	var resp CatalogEntryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !strings.Contains(resp.Body, "Instructions body") {
		t.Errorf("body not returned: %q", resp.Body)
	}
	var runs bool
	for _, f := range resp.Files {
		if f.Path == "scripts/run.sh" {
			runs = f.Runs
		}
	}
	if !runs {
		t.Errorf("scripts/run.sh not flagged as runnable")
	}
}

// ── install / uninstall ─────────────────────────────────────────────────────

func install(t *testing.T, api *SkillsRegistryAPI, req InstallRequest) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(req)
	r := httptest.NewRequest(http.MethodPost, "/api/skills/install", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	api.HandleInstall(rec, r)
	return rec
}

func TestInstallWritesSkillAndProvenance(t *testing.T) {
	fr := superpowers().
		add("skills/deploy/SKILL.md", skillMD("Deploy")).
		add("skills/deploy/scripts/run.sh", "echo hi")
	api := newTestRegistryAPI(t, "", fr)
	getCatalog(t, api, true)

	rec := install(t, api, InstallRequest{Source: "superpowers", Path: "skills/deploy", TargetName: "deploy", Scope: "user", Target: "agents", Mode: "install"})
	if rec.Code != http.StatusOK {
		t.Fatalf("install status = %d (%s)", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	installed := out["installedPath"].(string)

	if _, err := os.Stat(filepath.Join(installed, "SKILL.md")); err != nil {
		t.Errorf("SKILL.md not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(installed, "scripts", "run.sh")); err != nil {
		t.Errorf("scripts/run.sh not written: %v", err)
	}
	// Provenance recorded, and reflected as installed on the next catalog read.
	got := entriesFor(getCatalog(t, api, false), "superpowers")["deploy"]
	if got.Installed == nil || !got.Installed.UpToDate {
		t.Errorf("installed annotation missing/stale: %+v", got.Installed)
	}
}

func TestInstallCollisionRequiresOverwrite(t *testing.T) {
	fr := superpowers().add("skills/tdd/SKILL.md", skillMD("TDD v1"))
	api := newTestRegistryAPI(t, "", fr)
	getCatalog(t, api, true)

	first := install(t, api, InstallRequest{Source: "superpowers", Path: "skills/tdd", TargetName: "tdd", Scope: "user", Target: "agents", Mode: "install"})
	if first.Code != http.StatusOK {
		t.Fatalf("first install = %d", first.Code)
	}
	// Second install without overwrite → 409 collision.
	clash := install(t, api, InstallRequest{Source: "superpowers", Path: "skills/tdd", TargetName: "tdd", Scope: "user", Target: "agents", Mode: "install"})
	if clash.Code != http.StatusConflict {
		t.Fatalf("collision status = %d, want 409 (%s)", clash.Code, clash.Body.String())
	}
	// Overwrite succeeds.
	over := install(t, api, InstallRequest{Source: "superpowers", Path: "skills/tdd", TargetName: "tdd", Scope: "user", Target: "agents", Mode: "overwrite"})
	if over.Code != http.StatusOK {
		t.Fatalf("overwrite status = %d (%s)", over.Code, over.Body.String())
	}
}

func TestInstallRejectsInvalidName(t *testing.T) {
	fr := superpowers().add("skills/tdd/SKILL.md", skillMD("TDD"))
	api := newTestRegistryAPI(t, "", fr)
	getCatalog(t, api, true)

	rec := install(t, api, InstallRequest{Source: "superpowers", Path: "skills/tdd", TargetName: "Bad_Name", Scope: "user", Target: "agents", Mode: "install"})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for invalid name", rec.Code)
	}
}

func TestInstallEnforcesTotalSizeCap(t *testing.T) {
	fr := superpowers().add("skills/big/SKILL.md", skillMD("Big"))
	fr.add("skills/big/huge.bin", "x")
	fr.sizes["skills/big/huge.bin"] = maxSkillTotalSize + 1 // advertised oversize; rejected pre-fetch
	api := newTestRegistryAPI(t, "", fr)
	getCatalog(t, api, true)

	rec := install(t, api, InstallRequest{Source: "superpowers", Path: "skills/big", TargetName: "big", Scope: "user", Target: "agents", Mode: "install"})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for oversize skill (%s)", rec.Code, rec.Body.String())
	}
}

func TestUninstallRemovesDirAndProvenance(t *testing.T) {
	fr := superpowers().add("skills/tdd/SKILL.md", skillMD("TDD"))
	api := newTestRegistryAPI(t, "", fr)
	getCatalog(t, api, true)
	install(t, api, InstallRequest{Source: "superpowers", Path: "skills/tdd", TargetName: "tdd", Scope: "user", Target: "agents", Mode: "install"})

	r := httptest.NewRequest(http.MethodDelete, "/api/skills/user/agents/tdd", nil)
	r = mux.SetURLVars(r, map[string]string{"scope": "user", "source": "agents", "name": "tdd"})
	rec := httptest.NewRecorder()
	api.HandleUninstall(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("uninstall status = %d (%s)", rec.Code, rec.Body.String())
	}
	// Gone from catalog annotation.
	got := entriesFor(getCatalog(t, api, false), "superpowers")["tdd"]
	if got.Installed != nil {
		t.Errorf("still marked installed after uninstall: %+v", got.Installed)
	}
}

func TestUpdateDetection(t *testing.T) {
	fr := superpowers().add("skills/tdd/SKILL.md", skillMD("TDD"))
	api := newTestRegistryAPI(t, "", fr)
	getCatalog(t, api, true)
	install(t, api, InstallRequest{Source: "superpowers", Path: "skills/tdd", TargetName: "tdd", Scope: "user", Target: "agents", Mode: "install"})

	// Upstream changes the skill dir: new commit + etag forces a rebuild, and the
	// dir's tree sha differs → update available (installed but not up to date).
	fr.commit = "commit-2"
	fr.treeSha = "roottree-2"
	fr.etag = `"etag-2"`
	fr.dirShas["skills/tdd"] = "tree-CHANGED"

	got := entriesFor(getCatalog(t, api, true), "superpowers")["tdd"]
	if got.Installed == nil {
		t.Fatalf("expected installed annotation")
	}
	if got.Installed.UpToDate {
		t.Errorf("upToDate = true, want false after upstream change")
	}
}

// ── registries CRUD ─────────────────────────────────────────────────────────

func TestAddAndRemoveCustomRegistry(t *testing.T) {
	fr := superpowers()
	api := newTestRegistryAPI(t, "", fr)

	body, _ := json.Marshal(map[string]string{"url": "https://github.com/octocat/hello-world"})
	r := httptest.NewRequest(http.MethodPost, "/api/skills/registries", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	api.HandleAddRegistry(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("add status = %d (%s)", rec.Code, rec.Body.String())
	}
	var src SkillSource
	_ = json.Unmarshal(rec.Body.Bytes(), &src)
	if src.Repo != "octocat/hello-world" {
		t.Errorf("repo = %q", src.Repo)
	}

	// Appears in the list.
	if !hasSource(t, api, src.ID) {
		t.Errorf("added source not listed")
	}

	// Delete it.
	dr := httptest.NewRequest(http.MethodDelete, "/api/skills/registries/"+src.ID, nil)
	dr = mux.SetURLVars(dr, map[string]string{"id": src.ID})
	drec := httptest.NewRecorder()
	api.HandleDeleteRegistry(drec, dr)
	if drec.Code != http.StatusOK {
		t.Fatalf("delete status = %d (%s)", drec.Code, drec.Body.String())
	}
	if hasSource(t, api, src.ID) {
		t.Errorf("source still listed after delete")
	}
}

// A seeded default is an ordinary source: it can be deleted, and the deletion
// sticks — loadSources must not re-inject it on the next read.
func TestCanDeleteSeededRegistry(t *testing.T) {
	api := newTestRegistryAPI(t, "", superpowers())
	if !hasSource(t, api, "superpowers") {
		t.Fatalf("expected superpowers to be seeded")
	}
	dr := httptest.NewRequest(http.MethodDelete, "/api/skills/registries/superpowers", nil)
	dr = mux.SetURLVars(dr, map[string]string{"id": "superpowers"})
	rec := httptest.NewRecorder()
	api.HandleDeleteRegistry(rec, dr)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if hasSource(t, api, "superpowers") {
		t.Errorf("seeded source resurrected after delete")
	}
}

func TestListDefaultRegistries(t *testing.T) {
	api := newTestRegistryAPI(t, "", superpowers())
	r := httptest.NewRequest(http.MethodGet, "/api/skills/registries/defaults", nil)
	rec := httptest.NewRecorder()
	api.HandleListDefaultRegistries(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var list []SkillSource
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 3 {
		t.Errorf("got %d defaults, want 3: %+v", len(list), list)
	}
}

// A removed default can be restored by its seed id, and the restore brings back
// the curated label/trust (not a generic custom source). Restoring twice or
// restoring an unknown id are rejected.
func TestRestoreDefaultRegistry(t *testing.T) {
	api := newTestRegistryAPI(t, "", superpowers())
	if !hasSource(t, api, "superpowers") {
		t.Fatalf("expected superpowers seeded")
	}
	del := mux.SetURLVars(httptest.NewRequest(http.MethodDelete, "/x", nil), map[string]string{"id": "superpowers"})
	api.HandleDeleteRegistry(httptest.NewRecorder(), del)
	if hasSource(t, api, "superpowers") {
		t.Fatalf("still present after delete")
	}

	rr := mux.SetURLVars(httptest.NewRequest(http.MethodPost, "/x", nil), map[string]string{"id": "superpowers"})
	rec := httptest.NewRecorder()
	api.HandleRestoreDefaultRegistry(rec, rr)
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d (%s)", rec.Code, rec.Body.String())
	}
	var src SkillSource
	_ = json.Unmarshal(rec.Body.Bytes(), &src)
	if src.Trust != "community" || src.Label == "" {
		t.Errorf("restored seed lost curated metadata: %+v", src)
	}
	if !hasSource(t, api, "superpowers") {
		t.Errorf("not present after restore")
	}

	// Restoring an already-configured default conflicts.
	rec2 := httptest.NewRecorder()
	api.HandleRestoreDefaultRegistry(rec2, mux.SetURLVars(httptest.NewRequest(http.MethodPost, "/x", nil), map[string]string{"id": "superpowers"}))
	if rec2.Code != http.StatusConflict {
		t.Errorf("re-restore status = %d, want 409", rec2.Code)
	}

	// A non-default id is not restorable.
	rec3 := httptest.NewRecorder()
	api.HandleRestoreDefaultRegistry(rec3, mux.SetURLVars(httptest.NewRequest(http.MethodPost, "/x", nil), map[string]string{"id": "octocat-hello-world"}))
	if rec3.Code != http.StatusNotFound {
		t.Errorf("unknown-default status = %d, want 404", rec3.Code)
	}
}

func hasSource(t *testing.T, api *SkillsRegistryAPI, id string) bool {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/skills/registries", nil)
	rec := httptest.NewRecorder()
	api.HandleListRegistries(rec, r)
	var list []CatalogSourceStatus
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	for _, s := range list {
		if s.ID == id {
			return true
		}
	}
	return false
}

// ── unit: parseRepoRef ──────────────────────────────────────────────────────

func TestParseRepoRef(t *testing.T) {
	cases := []struct {
		in       string
		wantRepo string
		wantRef  string
		wantErr  bool
	}{
		{"owner/repo", "owner/repo", "", false},
		{"https://github.com/owner/repo", "owner/repo", "", false},
		{"https://github.com/owner/repo.git", "owner/repo", "", false},
		{"github.com/owner/repo/tree/dev", "owner/repo", "dev", false},
		{"https://github.com/owner/repo/", "owner/repo", "", false},
		{"", "", "", true},
		{"not-a-repo", "", "", true},
	}
	for _, c := range cases {
		repo, ref, err := parseRepoRef(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("parseRepoRef(%q): expected error", c.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseRepoRef(%q): %v", c.in, err)
			continue
		}
		if repo != c.wantRepo || ref != c.wantRef {
			t.Errorf("parseRepoRef(%q) = (%q,%q), want (%q,%q)", c.in, repo, ref, c.wantRef, c.wantRepo)
		}
	}
}

// ── unit: caching avoids re-fetch within TTL ────────────────────────────────

func TestCatalogUsesDiskCacheWithinTTL(t *testing.T) {
	fr := superpowers().add("skills/tdd/SKILL.md", skillMD("TDD"))
	api := newTestRegistryAPI(t, "", fr)
	getCatalog(t, api, true) // initial fetch populates disk cache
	after := fr.requests.Load()
	if after == 0 {
		t.Fatalf("expected requests during warm-up")
	}
	// A non-refresh read within TTL must not hit the network for this source.
	getCatalog(t, api, false)
	// The unfixtured seeds (anthropic + mattpocock, no fixture) still 404 each
	// call, so allow one resolve request apiece; superpowers must add none.
	if delta := fr.requests.Load() - after; delta > 2 {
		t.Errorf("expected ≤2 extra requests (the unfixtured seeds), got %d", delta)
	}
}
