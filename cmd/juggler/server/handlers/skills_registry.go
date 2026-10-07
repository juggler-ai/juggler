//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"juggler/cmd/juggler/core"

	"github.com/gorilla/mux"
)

// The Skills Marketplace lets a user browse external skill registries and pull
// skills into one of the four local roots that core/skills.go already discovers.
// Installing a skill is nothing more than writing its directory into a root and
// asking the frontend to reloadRegistries(); everything downstream (the `skill`
// tool, the system-prompt block, the manager UI) already works. Fetching and
// deciding live here; every byte written to disk (the skill, the registry list,
// the catalog cache, the install ledger) is written by core/skill_store.go.
//
// Identity is (source, remotePath), never (source, name): basenames collide
// across categories, across repos, and within one repo, so every cache key and
// provenance record is keyed on the remote path. The directory basename is only
// a suggested install name, slugified to satisfy core.ValidSkillName and confirmed by
// the client as an explicit targetName the server re-validates.

const (
	// catalogTTL bounds how long a disk-cached catalog is served without a
	// re-fetch; past it the source is refreshed on the next catalog read (a
	// manual Refresh forces it sooner).
	catalogTTL = time.Hour
	// maxSkillTotalSize caps the aggregate bytes of one installed skill,
	// checked against tree-reported sizes before any blob is fetched.
	maxSkillTotalSize = 10 << 20 // 10 MiB
	// descFetchConcurrency bounds parallel SKILL.md description fetches per
	// refresh so a large registry can't open hundreds of sockets at once.
	descFetchConcurrency = 8
)

// repoPattern validates an "owner/repo" slug extracted from a user-supplied URL.
var repoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// InstalledInfo annotates a catalog entry with the local install that provides
// it (if any), so the card can show ✓ Installed / ↑ Update. UpToDate compares
// the installed directory's recorded tree sha against the catalog's current one.
type InstalledInfo struct {
	Scope    string `json:"scope"`  // "user" | "project"
	Source   string `json:"source"` // "juggler" | "agents"
	Path     string `json:"path"`   // absolute installed directory
	UpToDate bool   `json:"upToDate"`
}

// CatalogEntry is one discoverable skill in a source. All string fields are
// remote, attacker-controllable data — the frontend escapes them everywhere and
// renders the body only through the escaping markdown path.
type CatalogEntry struct {
	ID          string         `json:"id"` // "<source>:<path>"
	Source      string         `json:"source"`
	Path        string         `json:"path"` // identity within the source (the skill dir)
	Name        string         `json:"name"` // slugified basename (a valid skill name)
	Slugged     bool           `json:"slugged"`
	Category    []string       `json:"category"`
	Description string         `json:"description"`
	License     string         `json:"license,omitempty"`
	HasScripts  bool           `json:"hasScripts"`
	HasHooks    bool           `json:"hasHooks"`
	FileCount   int            `json:"fileCount"`
	TotalSize   int64          `json:"totalSize"`
	SourceURL   string         `json:"sourceUrl"`
	Ref         string         `json:"ref"`
	Commit      string         `json:"commit"`
	DirSha      string         `json:"dirSha"`
	Installed   *InstalledInfo `json:"installed"`
	Error       string         `json:"error,omitempty"`
}

// SourceCatalog is one source's cached, commit-pinned catalog, persisted to
// CacheDir so the offline/stale story survives a server restart. The full Tree
// is retained so an install resolves a skill's blobs without another API call.
type SourceCatalog struct {
	SourceID  string         `json:"sourceId"`
	Repo      string         `json:"repo"`
	Ref       string         `json:"ref"`
	Commit    string         `json:"commit"`
	ETag      string         `json:"etag,omitempty"`
	FetchedAt time.Time      `json:"fetchedAt"`
	Truncated bool           `json:"truncated,omitempty"`
	Entries   []CatalogEntry `json:"entries"`
	Tree      []treeEntry    `json:"tree"`
}

// CatalogSourceStatus is the per-source fetch state returned by the catalog and
// registries endpoints (drives the source chips and the stale badge).
type CatalogSourceStatus struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	Repo       string    `json:"repo"`
	Trust      string    `json:"trust"`
	FetchedAt  time.Time `json:"fetchedAt,omitempty"`
	Stale      bool      `json:"stale"`
	Truncated  bool      `json:"truncated,omitempty"`
	EntryCount int       `json:"entryCount"`
	Error      string    `json:"error,omitempty"`
}

// CatalogResponse is the GET /api/skills/catalog payload: every source's entries
// merged, plus per-source status. All filtering is client-side over this.
type CatalogResponse struct {
	Entries []CatalogEntry        `json:"entries"`
	Sources []CatalogSourceStatus `json:"sources"`
}

// SkillMarketFile is one file in a preview manifest. Runs marks a file under
// scripts/ or hooks/ — surfaced prominently so "files that run" aren't buried.
type SkillMarketFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Runs bool   `json:"runs"`
}

// CatalogEntryResponse is the GET /api/skills/catalog/entry payload: the entry,
// its SKILL.md body (fetched fresh, pinned to the catalog commit), and its file
// manifest derived from the cached tree.
type CatalogEntryResponse struct {
	Entry CatalogEntry      `json:"entry"`
	Body  string            `json:"body"`
	Files []SkillMarketFile `json:"files"`
}

// InstallRequest is the POST /api/skills/install body. Mode is explicit:
// "overwrite" is the only value that lets an install replace an existing skill.
type InstallRequest struct {
	Source     string `json:"source"`     // source id
	Path       string `json:"path"`       // remote skill directory
	TargetName string `json:"targetName"` // validated install name
	Scope      string `json:"scope"`      // "user" | "project"
	Target     string `json:"target"`     // root source: "juggler" | "agents"
	Mode       string `json:"mode"`       // "install" | "overwrite"
}

// SkillsRegistryAPI serves the marketplace: source config, catalog fetch/cache,
// preview, install, and uninstall. It reuses SkillsAPI for root resolution so
// the four discovery roots and the marketplace agree byte-for-byte on where a
// skill lives. fetcher and now are fields so tests inject fixtures and a clock.
type SkillsRegistryAPI struct {
	projectPathProvider func() string
	skills              *SkillsAPI
	fetcher             registryFetcher
	now                 func() time.Time
}

// NewSkillsRegistryAPI builds the production API (GitHub fetcher, wall clock).
// skills is the existing discovery handler, reused for (scope, source) → root
// resolution.
func NewSkillsRegistryAPI(projectPathProvider func() string, skills *SkillsAPI) *SkillsRegistryAPI {
	return &SkillsRegistryAPI{
		projectPathProvider: projectPathProvider,
		skills:              skills,
		fetcher:             newGitHubFetcher(),
		now:                 time.Now,
	}
}

// defaultSources are the registries a fresh install is seeded with (written to
// skill-registries.json on first use). They are not privileged afterwards — each
// is an ordinary, removable source, and a removed seed stays removed.
func defaultSources() []core.SkillSource {
	return []core.SkillSource{
		{ID: "anthropic", Kind: "github", Label: "Anthropic", Repo: "anthropics/skills", Ref: "main", SkillsRoot: "skills", Trust: "official"},
		{ID: "mattpocock", Kind: "github", Label: "Matt Pocock", Repo: "mattpocock/skills", Ref: "main", SkillsRoot: "skills", Trust: "community"},
		{ID: "superpowers", Kind: "github", Label: "Superpowers", Repo: "obra/superpowers", Ref: "main", SkillsRoot: "skills", Trust: "community"},
	}
}

// ── registries, catalog cache ───────────────────────────────────────────────

// loadSources returns the configured sources from skill-registries.json. On a
// fresh install (the file has never been written) it seeds the file with
// defaultSources() and returns those; thereafter the file is the single source
// of truth, so a removed seed is never re-injected. Entries are de-duplicated by
// id and kept in stored order (seeds first, user additions appended).
func (api *SkillsRegistryAPI) loadSources() []core.SkillSource {
	stored, found := core.ReadSkillSources()
	if !found {
		stored = defaultSources()
		_ = core.WriteSkillSources(stored)
	}
	seen := map[string]bool{}
	var sources []core.SkillSource
	for _, s := range stored {
		if s.ID == "" || seen[s.ID] {
			continue
		}
		seen[s.ID] = true
		if s.Trust == "" {
			s.Trust = "custom"
		}
		sources = append(sources, s)
	}
	return sources
}

// sourceByID returns the configured source with the given id.
func (api *SkillsRegistryAPI) sourceByID(id string) (core.SkillSource, bool) {
	for _, s := range api.loadSources() {
		if s.ID == id {
			return s, true
		}
	}
	return core.SkillSource{}, false
}

func (api *SkillsRegistryAPI) loadCatalog(id string) *SourceCatalog {
	var cat SourceCatalog
	if !core.ReadSkillCatalogCache(id, &cat) {
		return nil
	}
	return &cat
}

func (api *SkillsRegistryAPI) saveCatalog(cat *SourceCatalog) {
	_ = core.WriteSkillCatalogCache(cat.SourceID, cat)
}

// ── catalog build ───────────────────────────────────────────────────────────

// buildCatalog resolves the source ref to a commit and walks its tree into a
// commit-pinned catalog. When the ETag matches the previous catalog's, the
// upstream is unchanged and the cached catalog is reused (only its timestamp is
// refreshed), spending no rate limit on the tree/description fetches.
func (api *SkillsRegistryAPI) buildCatalog(ctx context.Context, src core.SkillSource, prev *SourceCatalog) (*SourceCatalog, error) {
	etag := ""
	if prev != nil {
		etag = prev.ETag
	}
	commit, treeSha, newETag, notModified, err := api.fetcher.Resolve(ctx, src.Repo, src.Ref, etag)
	if err != nil {
		return nil, err
	}
	if notModified && prev != nil {
		refreshed := *prev
		refreshed.FetchedAt = api.now()
		return &refreshed, nil
	}
	entries, truncated, err := api.fetcher.Tree(ctx, src.Repo, treeSha)
	if err != nil {
		return nil, err
	}
	catEntries, tree := deriveEntries(src, commit, entries)
	cat := &SourceCatalog{
		SourceID:  src.ID,
		Repo:      src.Repo,
		Ref:       src.Ref,
		Commit:    commit,
		ETag:      newETag,
		FetchedAt: api.now(),
		Truncated: truncated,
		Entries:   catEntries,
		Tree:      tree,
	}
	api.fetchDescriptions(ctx, src, cat)
	return cat, nil
}

// deriveEntries scans a recursive tree for every **/SKILL.md under the source's
// skillsRoot and turns each into a skeleton catalog entry (descriptions are
// filled later). It also returns the tree entries retained for install-time blob
// resolution (regular files only — symlinks and submodules are dropped by mode).
func deriveEntries(src core.SkillSource, commit string, tree []treeEntry) ([]CatalogEntry, []treeEntry) {
	root := strings.Trim(src.SkillsRoot, "/")
	// Index tree ("directory") entries by path for O(1) dirSha lookups, and a set
	// of directory paths so scripts/ and hooks/ presence is a map probe.
	dirSha := map[string]string{}
	dirSet := map[string]bool{}
	kept := make([]treeEntry, 0, len(tree))
	for _, e := range tree {
		switch e.Type {
		case "tree":
			dirSha[e.Path] = e.Sha
			dirSet[e.Path] = true
		case "blob":
			if e.Mode == "120000" || e.Mode == "160000" {
				continue // symlink / submodule — never installed
			}
			kept = append(kept, e)
		}
	}

	var entries []CatalogEntry
	for _, e := range kept {
		if path.Base(e.Path) != "SKILL.md" {
			continue
		}
		skillDir := path.Dir(e.Path)
		if !underRoot(skillDir, root) {
			continue
		}
		rel := skillDir
		if root != "" {
			rel = strings.TrimPrefix(skillDir, root+"/")
		}
		segs := strings.Split(rel, "/")
		base := segs[len(segs)-1]
		category := append([]string{}, segs[:len(segs)-1]...)
		slug, changed := slugSkillName(base)

		count, size := subtreeStats(kept, skillDir)
		entry := CatalogEntry{
			ID:         src.ID + ":" + skillDir,
			Source:     src.ID,
			Path:       skillDir,
			Name:       slug,
			Slugged:    changed,
			Category:   category,
			HasScripts: dirSet[skillDir+"/scripts"],
			HasHooks:   dirSet[skillDir+"/hooks"],
			FileCount:  count,
			TotalSize:  size,
			SourceURL:  githubTreeURL(src.Repo, src.Ref, skillDir),
			Ref:        src.Ref,
			Commit:     commit,
			DirSha:     dirSha[skillDir],
		}
		if slug == "" {
			entry.Error = "remote skill name cannot be slugified to a valid skill name"
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries, kept
}

// underRoot reports whether dir is the skillsRoot itself or nested beneath it.
// An empty root matches everything (whole-tree walk).
func underRoot(dir, root string) bool {
	if root == "" {
		return true
	}
	return dir == root || strings.HasPrefix(dir, root+"/")
}

// subtreeStats counts the regular files under dir (inclusive) and sums their
// tree-reported sizes — the pre-fetch cap check.
func subtreeStats(blobs []treeEntry, dir string) (count int, size int64) {
	prefix := dir + "/"
	for _, e := range blobs {
		if e.Path == dir || strings.HasPrefix(e.Path, prefix) {
			count++
			size += e.Size
		}
	}
	return count, size
}

// fetchDescriptions fills each entry's Description/License by fetching its
// SKILL.md from the raw CDN (pinned to the commit) and parsing the frontmatter.
// Fetches run in parallel bounded by descFetchConcurrency; each goroutine writes
// its own entry index, so no shared state is mutated concurrently.
func (api *SkillsRegistryAPI) fetchDescriptions(ctx context.Context, src core.SkillSource, cat *SourceCatalog) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, descFetchConcurrency)
	for i := range cat.Entries {
		if cat.Entries[i].Error != "" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			data, err := api.fetcher.Blob(ctx, src.Repo, cat.Commit, cat.Entries[i].Path+"/SKILL.md")
			if err != nil {
				cat.Entries[i].Error = "could not fetch SKILL.md: " + err.Error()
				return
			}
			fm, _, perr := core.ParseSkillFile(data)
			cat.Entries[i].Description = fm.Description
			cat.Entries[i].License = fm.License
			switch {
			case perr != nil:
				cat.Entries[i].Error = perr.Error()
			case strings.TrimSpace(fm.Description) == "":
				cat.Entries[i].Error = "missing required frontmatter field: description"
			}
		}(i)
	}
	wg.Wait()
}

// ── HTTP handlers: catalog ──────────────────────────────────────────────────

// HandleCatalog returns every source's entries merged with per-source status.
// A source is refreshed when ?refresh=1, when it has no disk cache, or when its
// cache is older than catalogTTL; a refresh failure serves the stale disk cache
// with the error attached rather than blanking the source.
func (api *SkillsRegistryAPI) HandleCatalog(w http.ResponseWriter, r *http.Request) {
	refresh := boolParam(r.URL.Query().Get("refresh"))
	ctx := r.Context()
	installed := buildInstalledIndex(core.InstalledSkillRecords())

	resp := CatalogResponse{Entries: []CatalogEntry{}, Sources: []CatalogSourceStatus{}}
	for _, src := range api.loadSources() {
		cat := api.loadCatalog(src.ID)
		stale := cat == nil || api.now().Sub(cat.FetchedAt) > catalogTTL
		var fetchErr string
		if refresh || cat == nil || stale {
			if fresh, err := api.buildCatalog(ctx, src, cat); err != nil {
				fetchErr = err.Error()
			} else {
				cat = fresh
				api.saveCatalog(cat)
			}
		}
		st := CatalogSourceStatus{ID: src.ID, Label: src.Label, Repo: src.Repo, Trust: src.Trust, Error: fetchErr}
		if cat != nil {
			st.FetchedAt = cat.FetchedAt
			st.Truncated = cat.Truncated
			st.EntryCount = len(cat.Entries)
			st.Stale = api.now().Sub(cat.FetchedAt) > catalogTTL
			for _, e := range cat.Entries {
				e.Installed = annotateInstalled(installed, src.ID, e.Path, e.DirSha)
				resp.Entries = append(resp.Entries, e)
			}
		} else {
			st.Stale = true
		}
		resp.Sources = append(resp.Sources, st)
	}
	WriteJSON(w, r, 0, resp)
}

// HandleCatalogEntry returns one entry with its SKILL.md body (fetched fresh,
// pinned to the cached commit) and file manifest. Query params (not path
// segments) carry (source, path) so the lookup never collides with the
// {scope}/{source}/{name} discovery route.
func (api *SkillsRegistryAPI) HandleCatalogEntry(w http.ResponseWriter, r *http.Request) {
	sourceID := r.URL.Query().Get("source")
	skillPath := r.URL.Query().Get("path")
	src, ok := api.sourceByID(sourceID)
	if !ok {
		WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("unknown source %q", sourceID))
		return
	}
	cat := api.loadCatalog(src.ID)
	if cat == nil {
		WriteError(w, r, http.StatusNotFound, "source not fetched yet")
		return
	}
	entry, ok := findEntry(cat, skillPath)
	if !ok {
		WriteError(w, r, http.StatusNotFound, fmt.Sprintf("skill %q not found in %s", skillPath, sourceID))
		return
	}
	prov := buildInstalledIndex(core.InstalledSkillRecords())
	entry.Installed = annotateInstalled(prov, src.ID, entry.Path, entry.DirSha)

	body := ""
	if data, err := api.fetcher.Blob(r.Context(), src.Repo, cat.Commit, entry.Path+"/SKILL.md"); err == nil {
		body = string(data)
	}
	WriteJSON(w, r, 0, CatalogEntryResponse{
		Entry: entry,
		Body:  body,
		Files: manifestUnder(cat.Tree, entry.Path),
	})
}

// manifestUnder builds the preview file manifest for a skill directory from the
// cached tree, flagging files under scripts/ or hooks/ as runnable. Capped at
// core.MaxSkillFileListing (shared with the discovery listing).
func manifestUnder(tree []treeEntry, dir string) []SkillMarketFile {
	prefix := dir + "/"
	files := []SkillMarketFile{}
	for _, e := range tree {
		if e.Type != "blob" || e.Mode == "120000" || e.Mode == "160000" {
			continue
		}
		if !strings.HasPrefix(e.Path, prefix) {
			continue
		}
		rel := strings.TrimPrefix(e.Path, prefix)
		files = append(files, SkillMarketFile{
			Path: rel,
			Size: e.Size,
			Runs: strings.HasPrefix(rel, "scripts/") || strings.HasPrefix(rel, "hooks/"),
		})
		if len(files) >= core.MaxSkillFileListing {
			break
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files
}

// ── HTTP handlers: install / uninstall ──────────────────────────────────────

// HandleInstall writes a skill's directory into the chosen root. Everything
// dangerous is bounded before any byte is fetched: name validation, symlink
// exclusion, file-count and total-size caps against tree data, a case-
// insensitive collision check, and traversal rejection. The write is atomic
// (temp dir + rename) so a partial fetch never leaves a half-written skill.
func (api *SkillsRegistryAPI) HandleInstall(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[InstallRequest](w, r)
	if !ok {
		return
	}
	if !core.ValidSkillName(req.TargetName) {
		WriteError(w, r, http.StatusBadRequest, "invalid target name (lowercase letters, digits, single hyphens; max 64 chars)")
		return
	}
	if req.Target != "juggler" && req.Target != "agents" {
		WriteError(w, r, http.StatusBadRequest, `target must be "juggler" or "agents"`)
		return
	}
	rootDir, ok := api.skills.resolveRootDir(req.Scope, req.Target)
	if !ok {
		WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("unknown or unavailable root %q/%q", req.Scope, req.Target))
		return
	}
	src, ok := api.sourceByID(req.Source)
	if !ok {
		WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("unknown source %q", req.Source))
		return
	}
	cat := api.loadCatalog(src.ID)
	if cat == nil {
		WriteError(w, r, http.StatusBadRequest, "source not fetched yet")
		return
	}
	entry, ok := findEntry(cat, req.Path)
	if !ok {
		WriteError(w, r, http.StatusNotFound, fmt.Sprintf("skill %q not found in %s", req.Path, req.Source))
		return
	}

	blobs := installBlobs(cat.Tree, entry.Path)
	if len(blobs) == 0 {
		WriteError(w, r, http.StatusBadRequest, "skill has no installable files")
		return
	}
	if len(blobs) > core.MaxSkillFileListing {
		WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("skill has too many files (%d > %d)", len(blobs), core.MaxSkillFileListing))
		return
	}
	var total int64
	for _, b := range blobs {
		total += b.Size
	}
	if total > maxSkillTotalSize {
		WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("skill too large (%d bytes > %d)", total, maxSkillTotalSize))
		return
	}

	finalDir, ok := core.SkillDir(rootDir, req.TargetName)
	if !ok {
		WriteError(w, r, http.StatusBadRequest, "invalid install path")
		return
	}
	if existing, clash := core.CollidingSkillDir(rootDir, req.TargetName); clash && req.Mode != "overwrite" {
		WriteJSON(w, r, http.StatusConflict, map[string]any{
			"error":     fmt.Sprintf("a skill named %q already exists here", existing),
			"collision": true,
			"existing":  existing,
		})
		return
	}

	inst, err := core.BeginSkillInstall(rootDir)
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	defer inst.Abort() // no-op after a successful commit; cleans up on any error

	for _, b := range blobs {
		rel := strings.TrimPrefix(b.Path, entry.Path+"/")
		if !inst.Accepts(rel) {
			WriteError(w, r, http.StatusBadRequest, "skill contains an unsafe path: "+rel)
			return
		}
		data, err := api.fetcher.Blob(r.Context(), src.Repo, cat.Commit, b.Path)
		if err != nil {
			WriteError(w, r, http.StatusBadGateway, "could not fetch "+rel+": "+err.Error())
			return
		}
		if err := inst.WriteFile(rel, data, b.Mode == "100755"); err != nil {
			WriteError(w, r, http.StatusInternalServerError, err.Error())
			return
		}
	}

	// Overwrite mode is the only way a collision reaches here, so replacing
	// whatever is at finalDir is what was asked for.
	if err := inst.Commit(finalDir); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	_ = core.RecordSkillInstall(finalDir, core.SkillInstallRecord{
		Source:      src.ID,
		Repo:        src.Repo,
		Ref:         cat.Ref,
		Commit:      cat.Commit,
		DirSha:      entry.DirSha,
		RemotePath:  entry.Path,
		TargetName:  req.TargetName,
		Scope:       req.Scope,
		RootSource:  req.Target,
		InstalledAt: api.now(),
	})

	WriteJSON(w, r, 0, map[string]any{
		"installedPath": finalDir,
		"name":          req.TargetName,
		"scope":         req.Scope,
		"source":        req.Target,
	})
}

// HandleUninstall removes an installed skill directory from one of the four
// managed roots and drops its provenance entry. It works on any skill in a
// managed root (not only marketplace installs); core.SkillDir keeps the delete
// inside the resolved root.
func (api *SkillsRegistryAPI) HandleUninstall(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	scope, source, name := vars["scope"], vars["source"], vars["name"]
	if !core.ValidSkillName(name) {
		WriteError(w, r, http.StatusBadRequest, "invalid skill name")
		return
	}
	rootDir, ok := api.skills.resolveRootDir(scope, source)
	if !ok {
		WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("unknown or unavailable source %q/%q", scope, source))
		return
	}
	dir, ok := core.SkillDir(rootDir, name)
	if !ok {
		WriteError(w, r, http.StatusBadRequest, "invalid skill path")
		return
	}
	if err := core.UninstallSkill(dir); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	WriteJSON(w, r, 0, map[string]bool{"deleted": true})
}

// ── HTTP handlers: registries ───────────────────────────────────────────────

// HandleListRegistries returns the configured sources with their disk-cache
// status (no network). Feeds the source chips and the "stale" badge.
func (api *SkillsRegistryAPI) HandleListRegistries(w http.ResponseWriter, r *http.Request) {
	out := []CatalogSourceStatus{}
	for _, src := range api.loadSources() {
		st := CatalogSourceStatus{ID: src.ID, Label: src.Label, Repo: src.Repo, Trust: src.Trust, Stale: true}
		if cat := api.loadCatalog(src.ID); cat != nil {
			st.FetchedAt = cat.FetchedAt
			st.Truncated = cat.Truncated
			st.EntryCount = len(cat.Entries)
			st.Stale = api.now().Sub(cat.FetchedAt) > catalogTTL
		}
		out = append(out, st)
	}
	WriteJSON(w, r, 0, out)
}

// HandleListDefaultRegistries returns the seed sources a fresh install starts
// with, so the UI can offer to restore any the user has removed. Read-only.
func (api *SkillsRegistryAPI) HandleListDefaultRegistries(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, defaultSources())
}

// HandleRestoreDefaultRegistry re-adds a default source by its seed id, restoring
// the exact curated definition (label, trust, skillsRoot) rather than a generic
// custom source. 404 if the id is not a default; 409 if already configured. The
// prior sourceByID check also materializes the seed file on a fresh install, so
// the raw-file append below never clobbers the other seeds.
func (api *SkillsRegistryAPI) HandleRestoreDefaultRegistry(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	var seed *core.SkillSource
	for _, s := range defaultSources() {
		if s.ID == id {
			seed = &s
			break
		}
	}
	if seed == nil {
		WriteError(w, r, http.StatusNotFound, fmt.Sprintf("unknown default source %q", id))
		return
	}
	if _, exists := api.sourceByID(id); exists {
		WriteError(w, r, http.StatusConflict, fmt.Sprintf("source %q is already configured", id))
		return
	}
	stored, _ := core.ReadSkillSources()
	stored = append(stored, *seed)
	if err := core.WriteSkillSources(stored); err != nil {
		WriteError(w, r, http.StatusInternalServerError, "could not save source: "+err.Error())
		return
	}
	WriteJSON(w, r, 0, *seed)
}

// HandleAddRegistry registers a custom source from any github.com URL or
// "owner/repo". ref/skillsRoot default to main/skills. The catalog is not
// fetched here — the client re-reads /catalog (which fetches the new source).
func (api *SkillsRegistryAPI) HandleAddRegistry(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		URL   string `json:"url"`
		Label string `json:"label"`
	}](w, r)
	if !ok {
		return
	}
	repo, ref, err := parseRepoRef(req.URL)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	id := sourceIDFromRepo(repo)
	if _, exists := api.sourceByID(id); exists {
		WriteError(w, r, http.StatusConflict, fmt.Sprintf("source %q is already configured", id))
		return
	}
	label := strings.TrimSpace(req.Label)
	if label == "" {
		label = repo
	}
	src := core.SkillSource{ID: id, Kind: "github", Label: label, Repo: repo, Ref: ref, SkillsRoot: "skills", Trust: "custom"}

	stored, _ := core.ReadSkillSources()
	stored = append(stored, src)
	if err := core.WriteSkillSources(stored); err != nil {
		WriteError(w, r, http.StatusInternalServerError, "could not save source: "+err.Error())
		return
	}
	WriteJSON(w, r, 0, src)
}

// HandleDeleteRegistry removes a source (seed or user-added — all are equal) and
// its cached catalog. The removal persists, so a seed is not re-injected.
func (api *SkillsRegistryAPI) HandleDeleteRegistry(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if _, ok := api.sourceByID(id); !ok {
		WriteError(w, r, http.StatusNotFound, fmt.Sprintf("unknown source %q", id))
		return
	}
	stored, _ := core.ReadSkillSources()
	kept := stored[:0]
	for _, s := range stored {
		if s.ID != id {
			kept = append(kept, s)
		}
	}
	if err := core.WriteSkillSources(kept); err != nil {
		WriteError(w, r, http.StatusInternalServerError, "could not save sources: "+err.Error())
		return
	}
	_ = core.RemoveSkillCatalogCache(id)
	WriteJSON(w, r, 0, map[string]bool{"deleted": true})
}

// ── helpers ─────────────────────────────────────────────────────────────────

// provEntry is a provenance record joined with its installed path (the map key)
// so annotation can report the path and compare tree shas.
type provEntry struct {
	core.SkillInstallRecord
	installedPath string
}

// buildInstalledIndex keys installs (core.InstalledSkillRecords, which leaves out
// any whose directory has since been deleted) by (source id, remote path) so a
// catalog entry can find its local install in O(1).
func buildInstalledIndex(installed map[string]core.SkillInstallRecord) map[string]provEntry {
	index := map[string]provEntry{}
	for p, rec := range installed {
		index[installedKey(rec.Source, rec.RemotePath)] = provEntry{SkillInstallRecord: rec, installedPath: p}
	}
	return index
}

// annotateInstalled returns the InstalledInfo for one catalog entry, or nil when
// the skill is not installed. upToDate compares recorded vs current dir sha.
func annotateInstalled(index map[string]provEntry, sourceID, remotePath, dirSha string) *InstalledInfo {
	rec, ok := index[installedKey(sourceID, remotePath)]
	if !ok {
		return nil
	}
	return &InstalledInfo{
		Scope:    rec.Scope,
		Source:   rec.RootSource,
		Path:     rec.installedPath,
		UpToDate: rec.DirSha == dirSha,
	}
}

func installedKey(sourceID, remotePath string) string { return sourceID + "\x00" + remotePath }

// findEntry looks up a catalog entry by its remote path.
func findEntry(cat *SourceCatalog, skillPath string) (CatalogEntry, bool) {
	for _, e := range cat.Entries {
		if e.Path == skillPath {
			return e, true
		}
	}
	return CatalogEntry{}, false
}

// installBlobs returns the regular-file tree entries that make up a skill dir
// (inclusive of SKILL.md), excluding symlinks/submodules (re-checked here as
// defense in depth even though deriveEntries already dropped them from Tree).
func installBlobs(tree []treeEntry, dir string) []treeEntry {
	prefix := dir + "/"
	var out []treeEntry
	for _, e := range tree {
		if e.Type != "blob" || e.Mode == "120000" || e.Mode == "160000" {
			continue
		}
		if e.Path == dir || strings.HasPrefix(e.Path, prefix) {
			out = append(out, e)
		}
	}
	return out
}

// slugSkillName lowercases name and collapses every run of non-[a-z0-9] into a
// single hyphen, trimming leading/trailing hyphens and bounding length, so a
// remote basename that isn't a valid skill name yields a valid suggestion. The
// second return reports whether the slug differs from the original.
func slugSkillName(name string) (string, bool) {
	var b strings.Builder
	prevHyphen := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevHyphen = false
		} else if !prevHyphen {
			b.WriteByte('-')
			prevHyphen = true
		}
	}
	slug := strings.Trim(b.String(), "-")
	if len(slug) > core.MaxSkillNameLen {
		slug = strings.Trim(slug[:core.MaxSkillNameLen], "-")
	}
	return slug, slug != name
}

// parseRepoRef extracts "owner/repo" (and an optional ref from a /tree/<ref>
// URL) from a github.com URL or a bare "owner/repo". Only github.com is
// accepted in v1.
func parseRepoRef(input string) (repo, ref string, err error) {
	s := strings.TrimSpace(input)
	if s == "" {
		return "", "", fmt.Errorf("empty repository")
	}
	s = strings.TrimSuffix(s, "/")
	s = strings.TrimPrefix(s, "https://")
	s = strings.TrimPrefix(s, "http://")
	s = strings.TrimPrefix(s, "github.com/")
	s = strings.TrimPrefix(s, "www.github.com/")
	s = strings.TrimSuffix(s, ".git")
	parts := strings.Split(s, "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("expected a github.com/owner/repo URL or owner/repo")
	}
	repo = parts[0] + "/" + parts[1]
	if !repoPattern.MatchString(repo) {
		return "", "", fmt.Errorf("invalid repository %q", repo)
	}
	// github.com/owner/repo/tree/<ref>/... → capture ref.
	if len(parts) >= 4 && parts[2] == "tree" {
		ref = parts[3]
	}
	return repo, ref, nil
}

// sourceIDFromRepo derives a stable, filesystem-safe id from "owner/repo".
func sourceIDFromRepo(repo string) string {
	id, _ := slugSkillName(strings.ReplaceAll(repo, "/", "-"))
	return id
}

// githubTreeURL builds the human "View on GitHub" URL for a skill directory.
func githubTreeURL(repo, ref, dir string) string {
	if ref == "" {
		ref = "HEAD"
	}
	return fmt.Sprintf("https://github.com/%s/tree/%s/%s", repo, ref, dir)
}

// boolParam interprets a query flag ("1"/"true"/"yes").
func boolParam(v string) bool {
	switch strings.ToLower(v) {
	case "1", "true", "yes":
		return true
	}
	return false
}
