//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"juggler/internal/userpaths"
)

// What the Skills Marketplace keeps on disk, and every write it makes:
//
//	<root>/<name>/                       an installed skill (any of the four roots in skills.go)
//	<config>/skill-registries.json       the configured registries
//	<config>/skills-installed.json       provenance of each install, keyed by installed path
//	<cache>/skill-catalog-<id>.json      one registry's fetched catalog
//
// Fetching a registry and deciding what to install is handlers.SkillsRegistryAPI's
// business; it hands the bytes here to be written.

// SkillSource is one configured registry. All sources are equal: a fresh install
// is seeded with the marketplace's defaults, but seeds and user-added sources are
// then persisted together in skill-registries.json and any of them can be
// removed. v1 ships the "github" kind only.
type SkillSource struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`  // "github"
	Label      string `json:"label"` // human-facing name
	Repo       string `json:"repo"`  // "owner/name"
	Ref        string `json:"ref"`   // branch/tag/sha; "" → default branch
	SkillsRoot string `json:"skillsRoot"`
	Trust      string `json:"trust"` // "official" | "community" | "custom"
}

// SkillInstallRecord is the provenance stored for one installed skill (keyed by
// its absolute installed path in skills-installed.json). DirSha is the update
// signal: it differs from the catalog's dirSha exactly when the skill's own
// directory changed upstream — never merely because the repo head moved.
type SkillInstallRecord struct {
	Source      string    `json:"source"` // source id
	Repo        string    `json:"repo"`
	Ref         string    `json:"ref"`
	Commit      string    `json:"commit"`
	DirSha      string    `json:"dirSha"`
	RemotePath  string    `json:"remotePath"`
	TargetName  string    `json:"targetName"`
	Scope       string    `json:"scope"`      // "user" | "project"
	RootSource  string    `json:"rootSource"` // "juggler" | "agents"
	InstalledAt time.Time `json:"installedAt"`
}

func skillSourcesPath() string { return filepath.Join(userpaths.ConfigDir(), "skill-registries.json") }
func skillLedgerPath() string  { return filepath.Join(userpaths.ConfigDir(), "skills-installed.json") }
func skillCatalogCachePath(id string) string {
	return filepath.Join(userpaths.CacheDir(), "skill-catalog-"+id+".json")
}

// ── registries ──────────────────────────────────────────────────────────────

// ReadSkillSources returns the stored registry list. found is false when the
// file has never been written (a fresh install, which the caller seeds) or
// cannot be read.
func ReadSkillSources() (sources []SkillSource, found bool) {
	found, _ = readJSONFile(skillSourcesPath(), &sources)
	return sources, found
}

// WriteSkillSources persists the full registry list atomically. It is the sole
// writer of skill-registries.json.
func WriteSkillSources(sources []SkillSource) error {
	return writeJSONFile(skillSourcesPath(), sources)
}

// ── catalog cache ───────────────────────────────────────────────────────────

// ReadSkillCatalogCache decodes registry id's cached catalog into v. found is
// false when there is no usable cache. The catalog's shape is the
// marketplace's; this owns only where it is kept.
func ReadSkillCatalogCache(id string, v any) (found bool) {
	found, err := readJSONFile(skillCatalogCachePath(id), v)
	return err == nil && found
}

// WriteSkillCatalogCache stores registry id's catalog atomically, so the
// offline/stale story survives a server restart.
func WriteSkillCatalogCache(id string, v any) error {
	return writeJSONFile(skillCatalogCachePath(id), v)
}

// RemoveSkillCatalogCache drops registry id's cached catalog. A missing cache
// is not an error.
func RemoveSkillCatalogCache(id string) error {
	if err := os.Remove(skillCatalogCachePath(id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ── install ledger ──────────────────────────────────────────────────────────

// readSkillLedger returns every provenance record, keyed by installed path. An
// absent or unreadable ledger is empty.
func readSkillLedger() map[string]SkillInstallRecord {
	ledger := map[string]SkillInstallRecord{}
	_, _ = readJSONFile(skillLedgerPath(), &ledger)
	return ledger
}

// InstalledSkillRecords returns the provenance of every install whose directory
// is still present, keyed by installed path. A skill deleted by hand is
// effectively uninstalled, so its record is left out.
func InstalledSkillRecords() map[string]SkillInstallRecord {
	present := map[string]SkillInstallRecord{}
	for path, rec := range readSkillLedger() {
		if dirExists(path) {
			present[path] = rec
		}
	}
	return present
}

// RecordSkillInstall stores rec as the provenance of the skill at dir,
// replacing any earlier record for it.
func RecordSkillInstall(dir string, rec SkillInstallRecord) error {
	ledger := readSkillLedger()
	ledger[dir] = rec
	return writeJSONFile(skillLedgerPath(), ledger)
}

// ── installing and uninstalling ─────────────────────────────────────────────

// ErrUnsafeSkillPath is returned for a file whose path would leave the skill
// being installed.
var ErrUnsafeSkillPath = errors.New("skill contains an unsafe path")

// SkillInstall stages a skill's files in a temp directory inside its root and
// moves them into place with one rename, so a partial fetch never leaves a
// half-written skill. Begin with BeginSkillInstall, WriteFile each file, then
// Commit; defer Abort, which cleans up the staging directory on any path that
// did not commit.
type SkillInstall struct {
	rootDir string
	tmpDir  string
}

// BeginSkillInstall creates rootDir if needed and a staging directory inside
// it. Staging inside the root keeps the final rename on one filesystem.
func BeginSkillInstall(rootDir string) (*SkillInstall, error) {
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return nil, fmt.Errorf("could not create root dir: %w", err)
	}
	tmpDir, err := os.MkdirTemp(rootDir, ".skill-install-")
	if err != nil {
		return nil, fmt.Errorf("could not create temp dir: %w", err)
	}
	return &SkillInstall{rootDir: rootDir, tmpDir: tmpDir}, nil
}

// Accepts reports whether rel (a forward-slash path relative to the skill) stays
// inside the skill, so a caller can refuse a file before spending a fetch on it.
func (s *SkillInstall) Accepts(rel string) bool {
	_, ok := s.stagedPath(rel)
	return ok
}

func (s *SkillInstall) stagedPath(rel string) (string, bool) {
	dest := filepath.Join(s.tmpDir, filepath.FromSlash(rel))
	return dest, pathWithin(s.tmpDir, dest)
}

// WriteFile stages one file at rel. executable marks a file the source tree
// records as executable (git mode 100755).
func (s *SkillInstall) WriteFile(rel string, data []byte, executable bool) error {
	dest, ok := s.stagedPath(rel)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnsafeSkillPath, rel)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return fmt.Errorf("could not create dir: %w", err)
	}
	mode := os.FileMode(0o644)
	if executable {
		mode = 0o755
	}
	if err := os.WriteFile(dest, data, mode); err != nil {
		return fmt.Errorf("could not write %s: %w", rel, err)
	}
	return nil
}

// Commit moves the staged skill into place as finalDir (as SkillDir resolves
// it), replacing any skill already there.
func (s *SkillInstall) Commit(finalDir string) error {
	if err := os.RemoveAll(finalDir); err != nil {
		return fmt.Errorf("could not replace existing skill: %w", err)
	}
	if err := os.Rename(s.tmpDir, finalDir); err != nil {
		return fmt.Errorf("could not finalize install: %w", err)
	}
	s.tmpDir = ""
	return nil
}

// Abort removes the staging directory. It is a no-op after Commit.
func (s *SkillInstall) Abort() {
	if s.tmpDir != "" {
		_ = os.RemoveAll(s.tmpDir)
	}
}

// CollidingSkillDir reports whether rootDir already holds a directory whose name
// matches name case-insensitively (macOS/Windows filesystems fold case),
// returning the existing on-disk name for the message.
func CollidingSkillDir(rootDir, name string) (string, bool) {
	entries, err := os.ReadDir(rootDir)
	if err != nil {
		return "", false
	}
	lower := strings.ToLower(name)
	for _, e := range entries {
		if e.IsDir() && strings.ToLower(e.Name()) == lower {
			return e.Name(), true
		}
	}
	return "", false
}

// UninstallSkill removes the skill directory dir (as SkillDir resolves it) and
// drops its provenance record. It works on any skill in a managed root, not
// only marketplace installs.
func UninstallSkill(dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("could not remove skill: %w", err)
	}
	ledger := readSkillLedger()
	if _, ok := ledger[dir]; ok {
		delete(ledger, dir)
		_ = writeJSONFile(skillLedgerPath(), ledger)
	}
	return nil
}

// ── JSON files ──────────────────────────────────────────────────────────────

// readJSONFile decodes path into v. A missing file returns found=false with no
// error (an unconfigured source / first run is not a failure).
func readJSONFile(path string, v any) (found bool, err error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return false, nil
	}
	if err := json.Unmarshal(data, v); err != nil {
		return false, err
	}
	return true, nil
}

// writeJSONFile marshals v and writes it atomically (temp file + rename in the
// same directory), so a crash mid-write never leaves a truncated config/cache.
func writeJSONFile(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}
