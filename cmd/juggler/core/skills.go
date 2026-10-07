//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"juggler/internal/userpaths"
)

// Agent Skills are directories following the open Agent Skills standard
// (agentskills.io): each skill is a folder holding at minimum a SKILL.md
// (YAML frontmatter + markdown instructions), optionally with scripts/,
// references/, and assets/. Juggler discovers them across a fixed set of source
// roots, in two scopes:
//
//	<project>/.juggler/skills/<name>/SKILL.md   project + juggler (native)
//	<project>/.agents/skills/<name>/SKILL.md    project + agents  (cross-agent alias)
//	<config>/skills/<name>/SKILL.md             user + juggler    (native)
//	~/.agents/skills/<name>/SKILL.md            user + agents     (cross-agent alias)
//
// This file is where those roots are and how a skill in one is read: every
// skill's *metadata* (name + description, always cheap) and, on demand, one
// skill's SKILL.md body plus a listing of its directory. Writing a skill into a
// root is skill_store.go's. The HTTP surface is handlers.SkillsAPI, and bodies
// never appear in its list — the model loads a body through the `skill` tool
// only when a task matches (progressive disclosure). Files under a skill
// (scripts/, references/) are read by the model through the ordinary
// read/execute tools, under normal approval, so skills add no new execution or
// file-access path.

// skillNamePattern is the spec-mandated skill name: lowercase letters/digits in
// hyphen-separated groups, so no leading, trailing, or doubled hyphen. Length is
// bounded separately (<= MaxSkillNameLen). The name must also equal the skill's
// directory name.
var skillNamePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// MaxSkillNameLen is the spec cap on a skill name.
const MaxSkillNameLen = 64

// MaxSkillFileListing bounds the per-skill file listing ReadSkill returns, so a
// pathological skill directory can't produce an unbounded response (the listing
// is advisory — the model reads real files via read). The marketplace applies
// the same cap to a skill's install.
const MaxSkillFileListing = 500

// skillFileName is the file that makes a directory a skill.
const skillFileName = "SKILL.md"

// SkillFrontmatter is the parsed YAML frontmatter of a SKILL.md. Only the spec's
// top-level scalar fields are interpreted; unknown keys and nested mappings
// (Claude-Code's when_to_use, a `metadata:` map, etc.) are preserved-and-ignored
// rather than rejected, so a skill authored for another agent still loads. Absence of a required field
// (description) surfaces as an Error on the owning Skill, never a silent drop.
type SkillFrontmatter struct {
	Name          string `json:"name,omitempty"`
	Description   string `json:"description,omitempty"`
	License       string `json:"license,omitempty"`
	Compatibility string `json:"compatibility,omitempty"`
	AllowedTools  string `json:"allowedTools,omitempty"` // surfaced read-only; NOT honored in v1 (see plan §4)
}

// Skill is one discovered skill — metadata only, never the SKILL.md body. A
// directory that fails to parse or validate is still returned with Error set
// so the manager UI can show exactly why it is broken. A skill whose name is
// claimed by a higher-precedence root carries ShadowedBy (the winning
// "<scope>-<source>") but is still listed — never a silent drop.
type Skill struct {
	Name          string           `json:"name"`
	Description   string           `json:"description"`
	Scope         string           `json:"scope"`  // "user" | "project"
	Source        string           `json:"source"` // "juggler" | "agents"
	Path          string           `json:"path"`   // absolute on-disk skill directory
	Frontmatter   SkillFrontmatter `json:"frontmatter"`
	HasScripts    bool             `json:"hasScripts"`
	HasReferences bool             `json:"hasReferences"`
	ShadowedBy    string           `json:"shadowedBy,omitempty"`
	Error         string           `json:"error,omitempty"`
}

// SkillFile is one entry in a skill's directory listing (relative path + size),
// so the tool result can tell the model what is available under references/,
// scripts/, assets/, etc.
type SkillFile struct {
	Path string `json:"path"` // forward-slash path relative to the skill directory
	Size int64  `json:"size"`
}

// SkillRoot is one source directory: a (scope, source) pair mapped to its
// on-disk skills directory. Roots are enumerated in precedence order (see
// SkillRoots), so the first occurrence of a name wins and later ones are
// shadowed.
type SkillRoot struct {
	Scope  string
	Source string
	Dir    string
}

// Label is the "<scope>-<source>" identifier surfaced to the frontend (badge,
// shadowedBy origin, tool-result header).
func (r SkillRoot) Label() string { return r.Scope + "-" + r.Source }

// SkillRoots returns the skill source roots in precedence order (first wins on
// a name collision): project-juggler, project-agents, user-juggler, user-agents.
// Project roots are omitted in no-project mode (projectPath ""). A root
// directory that doesn't exist is harmless — discovery simply finds nothing
// there.
func SkillRoots(projectPath string) []SkillRoot {
	var roots []SkillRoot
	if projectPath != "" {
		roots = append(roots,
			SkillRoot{Scope: "project", Source: "juggler", Dir: filepath.Join(projectPath, ".juggler", "skills")},
			SkillRoot{Scope: "project", Source: "agents", Dir: filepath.Join(projectPath, ".agents", "skills")},
		)
	}
	return append(roots, userSkillRoots()...)
}

// userSkillRoots returns the two user-scoped skill roots: user-juggler under the
// config dir (<ConfigDir>/skills) and user-agents under the home dir
// ($HOME/.agents/skills).
//
// JUGGLER_SKILLS_USER_DIR relocates BOTH beneath a single base
// (<base>/juggler/skills and <base>/agents/skills), leaving project roots and
// everything else untouched. The browser integration harness sets it to an empty
// throwaway dir so a server subprocess — which inherits the developer's real
// $HOME — never discovers their personal ~/.juggler or ~/.agents skills. Such a
// skill would auto-instantiate a Skills context item into every conversation and
// perturb assertions on thread item counts, making tests pass or fail by the
// host's installed skills. Unset (production), behavior is unchanged.
func userSkillRoots() []SkillRoot {
	if base := os.Getenv("JUGGLER_SKILLS_USER_DIR"); base != "" {
		return []SkillRoot{
			{Scope: "user", Source: "juggler", Dir: filepath.Join(base, "juggler", "skills")},
			{Scope: "user", Source: "agents", Dir: filepath.Join(base, "agents", "skills")},
		}
	}
	roots := []SkillRoot{{Scope: "user", Source: "juggler", Dir: filepath.Join(userpaths.ConfigDir(), "skills")}}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		roots = append(roots, SkillRoot{Scope: "user", Source: "agents", Dir: filepath.Join(home, ".agents", "skills")})
	}
	return roots
}

// SkillRootDir maps a (scope, source) pair to its skills directory, honoring
// no-project mode (project scopes are absent from SkillRoots then). Returns
// ok=false for an unknown or unavailable pair.
func SkillRootDir(projectPath, scope, source string) (string, bool) {
	for _, root := range SkillRoots(projectPath) {
		if root.Scope == scope && root.Source == source {
			return root.Dir, true
		}
	}
	return "", false
}

// SkillDir is the directory of skill name inside rootDir. ok is false when name
// is not a spec-valid skill name or the path would leave the root — which the
// name check already precludes, and which is re-checked defensively.
func SkillDir(rootDir, name string) (string, bool) {
	if !ValidSkillName(name) {
		return "", false
	}
	dir := filepath.Join(rootDir, name)
	if !pathWithin(rootDir, dir) {
		return "", false
	}
	return dir, true
}

// ListSkills returns every discovered skill across all roots, with shadowed and
// error flags set (never a silent drop), sorted by name then scope then source
// for deterministic, cache-stable output. Bodies are never included.
func ListSkills(projectPath string) []Skill {
	skills := []Skill{}
	winners := map[string]SkillRoot{} // skill name -> highest-precedence root that provides it
	for _, root := range SkillRoots(projectPath) {
		for _, skill := range discoverSkills(root) {
			// Only well-formed skills participate in shadowing: a broken skill
			// neither wins a name nor is marked "shadowed" (its Error already
			// explains why it is unusable).
			if skill.Error == "" {
				if win, ok := winners[skill.Name]; ok {
					skill.ShadowedBy = win.Label()
				} else {
					winners[skill.Name] = root
				}
			}
			skills = append(skills, skill)
		}
	}
	sort.Slice(skills, func(i, j int) bool {
		if skills[i].Name != skills[j].Name {
			return skills[i].Name < skills[j].Name
		}
		if skills[i].Scope != skills[j].Scope {
			return skills[i].Scope < skills[j].Scope
		}
		return skills[i].Source < skills[j].Source
	})
	return skills
}

// ReadSkill returns the SKILL.md body of the skill in dir (as SkillDir resolves
// it) and a listing of its directory. A malformed frontmatter still returns its
// body (best effort), so the manager preview and the tool can show what the file
// contains. The error is the read's: in practice, no such skill.
func ReadSkill(dir string) (body string, files []SkillFile, err error) {
	data, err := os.ReadFile(filepath.Join(dir, skillFileName))
	if err != nil {
		return "", nil, err
	}
	_, body, _ = ParseSkillFile(data) // body is served even when frontmatter is malformed
	return body, listSkillFiles(dir), nil
}

// discoverSkills scans one root directory for skill subdirectories (each holding
// a SKILL.md). A missing/unreadable root yields nothing. Every candidate is
// returned; parse/validation failures carry Error rather than being dropped.
func discoverSkills(root SkillRoot) []Skill {
	entries, err := os.ReadDir(root.Dir)
	if err != nil {
		return nil // absent or unreadable — no skills here
	}
	var out []Skill
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		dir := filepath.Join(root.Dir, name)
		if _, err := os.Stat(filepath.Join(dir, skillFileName)); err != nil {
			continue // a plain directory, not a skill — silently ignored
		}
		skill := Skill{
			Name:          name,
			Scope:         root.Scope,
			Source:        root.Source,
			Path:          dir,
			HasScripts:    dirExists(filepath.Join(dir, "scripts")),
			HasReferences: dirExists(filepath.Join(dir, "references")),
		}
		if !ValidSkillName(name) {
			skill.Error = "invalid skill name (lowercase letters, digits, and single hyphens; max 64 chars)"
			out = append(out, skill)
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, skillFileName))
		if err != nil {
			skill.Error = fmt.Sprintf("could not read SKILL.md: %v", err)
			out = append(out, skill)
			continue
		}
		fm, _, parseErr := ParseSkillFile(data)
		skill.Frontmatter = fm
		skill.Description = fm.Description
		switch {
		case parseErr != nil:
			skill.Error = parseErr.Error()
		case strings.TrimSpace(fm.Description) == "":
			skill.Error = "missing required frontmatter field: description"
		case fm.Name != "" && fm.Name != name:
			skill.Error = fmt.Sprintf("frontmatter name %q does not match directory name %q", fm.Name, name)
		}
		out = append(out, skill)
	}
	return out
}

// ParseSkillFile splits a SKILL.md into frontmatter and body using the shared
// frontmatter splitter/scanner, mapping the spec's scalar keys onto
// SkillFrontmatter. Unknown keys are ignored (preserve-and-ignore), so a skill
// carrying another agent's non-spec fields still parses. The marketplace parses
// remote SKILL.md files with it too, so a catalog entry and an installed skill
// read the same way.
func ParseSkillFile(data []byte) (SkillFrontmatter, string, error) {
	var fm SkillFrontmatter
	fmLines, body, err := splitFrontmatter(data)
	if err != nil {
		return fm, body, err
	}
	scanFrontmatterFields(fmLines, func(key, value string) {
		switch key {
		case "name":
			fm.Name = value
		case "description":
			fm.Description = value
		case "license":
			fm.License = value
		case "compatibility":
			fm.Compatibility = value
		case "allowed-tools", "allowedTools":
			fm.AllowedTools = value
		}
	})
	return fm, body, nil
}

// listSkillFiles walks a skill directory and returns every regular file as a
// forward-slash path relative to the directory, with its size, sorted for
// deterministic output and capped at MaxSkillFileListing (the walk stops at the
// cap, so a pathological directory isn't traversed in full — WalkDir's lexical
// order keeps the retained subset deterministic). Errors mid-walk are tolerated
// (best-effort listing); the model reads real files via the read tool.
func listSkillFiles(dir string) []SkillFile {
	files := []SkillFile{}
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if len(files) >= MaxSkillFileListing {
			return fs.SkipAll
		}
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // skip unreadable entries, keep walking
		}
		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return nil
		}
		info, infoErr := d.Info()
		size := int64(0)
		if infoErr == nil {
			size = info.Size()
		}
		files = append(files, SkillFile{Path: filepath.ToSlash(rel), Size: size})
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files
}

// ValidSkillName reports whether name is a spec-valid skill name (pattern +
// length bound). Because it forbids '/', '.', and '\', a valid name can never
// escape its root directory.
func ValidSkillName(name string) bool {
	return len(name) <= MaxSkillNameLen && skillNamePattern.MatchString(name)
}

// pathWithin reports whether child resolves inside root (defense-in-depth
// against traversal, though ValidSkillName already precludes it).
func pathWithin(root, child string) bool {
	rel, err := filepath.Rel(root, child)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// dirExists reports whether path exists and is a directory.
func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
