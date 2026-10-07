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
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths"

	"github.com/gorilla/mux"
)

// newTestSkillsAPI builds a SkillsAPI with fully isolated roots: JUGGLER_CONFIG_DIR
// relocates the user-juggler root, and HOME + USERPROFILE relocate the user-agents
// root (os.UserHomeDir reads USERPROFILE on Windows, HOME elsewhere), so a test
// never reads or writes the developer's real ~/.juggler or ~/.agents.
func newTestSkillsAPI(t *testing.T, projectDir string) *SkillsAPI {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // Windows: os.UserHomeDir reads USERPROFILE, not HOME
	return NewSkillsAPI(func() string { return projectDir })
}

// root path helpers mirror SkillsAPI.roots() so tests can seed files directly.
func projectJugglerRoot(project string) string { return filepath.Join(project, ".juggler", "skills") }
func projectAgentsRoot(project string) string  { return filepath.Join(project, ".agents", "skills") }
func userJugglerRoot() string                  { return filepath.Join(userpaths.ConfigDir(), "skills") }
func userAgentsRoot(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("home dir: %v", err)
	}
	return filepath.Join(home, ".agents", "skills")
}

// writeSkill creates <root>/<name>/SKILL.md with the given content.
func writeSkill(t *testing.T, root, name, content string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// writeSkillFile creates an arbitrary resource file under a skill directory.
func writeSkillFile(t *testing.T, root, name, rel, content string) {
	t.Helper()
	full := filepath.Join(root, name, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func listSkills(t *testing.T, api *SkillsAPI) []core.Skill {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/skills", nil)
	rec := httptest.NewRecorder()
	api.HandleList(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var skills []core.Skill
	if err := json.Unmarshal(rec.Body.Bytes(), &skills); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return skills
}

func skillsByName(skills []core.Skill) map[string]core.Skill {
	m := map[string]core.Skill{}
	for _, s := range skills {
		m[s.Name] = s
	}
	return m
}

func getSkill(t *testing.T, api *SkillsAPI, scope, source, name string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/skills/x/x/x", nil)
	r = mux.SetURLVars(r, map[string]string{"scope": scope, "source": source, "name": name})
	rec := httptest.NewRecorder()
	api.HandleGet(rec, r)
	return rec
}

func TestSkillsDiscoverValid(t *testing.T) {
	project := t.TempDir()
	api := newTestSkillsAPI(t, project)
	root := projectJugglerRoot(project)
	writeSkill(t, root, "pdf-tools", "---\nname: pdf-tools\ndescription: Extract and merge PDFs. Use when handling PDFs.\nlicense: MIT\n---\n# PDF tools\n\nInstructions.\n")
	writeSkillFile(t, root, "pdf-tools", "references/api.md", "reference docs\n")
	writeSkillFile(t, root, "pdf-tools", "scripts/run.sh", "echo hi\n")

	skills := listSkills(t, api)
	if len(skills) != 1 {
		t.Fatalf("got %d skills, want 1", len(skills))
	}
	s := skills[0]
	if s.Error != "" {
		t.Fatalf("unexpected error: %s", s.Error)
	}
	if s.Name != "pdf-tools" || s.Scope != "project" || s.Source != "juggler" {
		t.Errorf("name/scope/source = %q/%q/%q", s.Name, s.Scope, s.Source)
	}
	if s.Description != "Extract and merge PDFs. Use when handling PDFs." {
		t.Errorf("description = %q", s.Description)
	}
	if s.Frontmatter.License != "MIT" {
		t.Errorf("license = %q", s.Frontmatter.License)
	}
	if !s.HasScripts || !s.HasReferences {
		t.Errorf("hasScripts/hasReferences = %v/%v, want true/true", s.HasScripts, s.HasReferences)
	}
}

func TestSkillsDiscoverAcrossRoots(t *testing.T) {
	project := t.TempDir()
	api := newTestSkillsAPI(t, project)
	writeSkill(t, projectJugglerRoot(project), "alpha", "---\ndescription: a\n---\nbody\n")
	writeSkill(t, projectAgentsRoot(project), "beta", "---\ndescription: b\n---\nbody\n")
	writeSkill(t, userJugglerRoot(), "gamma", "---\ndescription: g\n---\nbody\n")
	writeSkill(t, userAgentsRoot(t), "delta", "---\ndescription: d\n---\nbody\n")

	skills := listSkills(t, api)
	if len(skills) != 4 {
		t.Fatalf("got %d skills, want 4", len(skills))
	}
	by := skillsByName(skills)
	for name, want := range map[string][2]string{
		"alpha": {"project", "juggler"},
		"beta":  {"project", "agents"},
		"gamma": {"user", "juggler"},
		"delta": {"user", "agents"},
	} {
		s, ok := by[name]
		if !ok {
			t.Fatalf("missing skill %q", name)
		}
		if s.Scope != want[0] || s.Source != want[1] {
			t.Errorf("%s: scope/source = %q/%q, want %q/%q", name, s.Scope, s.Source, want[0], want[1])
		}
		if s.ShadowedBy != "" || s.Error != "" {
			t.Errorf("%s: unexpected shadow/error %q/%q", name, s.ShadowedBy, s.Error)
		}
	}
}

func TestSkillsShadowing(t *testing.T) {
	project := t.TempDir()
	api := newTestSkillsAPI(t, project)
	// Same name in three roots; project-juggler has highest precedence.
	writeSkill(t, projectJugglerRoot(project), "dup", "---\ndescription: winner\n---\nbody\n")
	writeSkill(t, projectAgentsRoot(project), "dup", "---\ndescription: agents\n---\nbody\n")
	writeSkill(t, userJugglerRoot(), "dup", "---\ndescription: user\n---\nbody\n")

	skills := listSkills(t, api)
	if len(skills) != 3 {
		t.Fatalf("got %d skills, want 3 (shadowed still listed)", len(skills))
	}
	var winner, shadowedCount int
	for _, s := range skills {
		if s.Scope == "project" && s.Source == "juggler" {
			winner++
			if s.ShadowedBy != "" {
				t.Errorf("winner should not be shadowed, got %q", s.ShadowedBy)
			}
		} else if s.ShadowedBy != "project-juggler" {
			t.Errorf("%s-%s: shadowedBy = %q, want project-juggler", s.Scope, s.Source, s.ShadowedBy)
		} else {
			shadowedCount++
		}
	}
	if winner != 1 || shadowedCount != 2 {
		t.Errorf("winner=%d shadowed=%d, want 1 and 2", winner, shadowedCount)
	}
}

func TestSkillsMalformed(t *testing.T) {
	project := t.TempDir()
	api := newTestSkillsAPI(t, project)
	root := projectJugglerRoot(project)
	writeSkill(t, root, "no-desc", "---\nname: no-desc\n---\nbody\n")
	writeSkill(t, root, "no-fm", "just a body, no frontmatter\n")
	writeSkill(t, root, "bad-fm", "---\ndescription: x\nunterminated\n")

	by := skillsByName(listSkills(t, api))
	for _, n := range []string{"no-desc", "no-fm", "bad-fm"} {
		s, ok := by[n]
		if !ok {
			t.Fatalf("missing skill %q", n)
		}
		if s.Error == "" {
			t.Errorf("%s: expected error, got none", n)
		}
	}
}

func TestSkillsNestedMetadataDoesNotStompFields(t *testing.T) {
	project := t.TempDir()
	api := newTestSkillsAPI(t, project)
	// A foreign skill carrying a nested metadata map whose children reuse the
	// spec's key names: the indented lines must be skipped, not scanned as
	// top-level fields (which would corrupt name/description).
	writeSkill(t, projectJugglerRoot(project), "nested", "---\n"+
		"name: nested\n"+
		"description: real description\n"+
		"metadata:\n"+
		"  name: something-else\n"+
		"  description: internal note\n"+
		"---\nbody\n")

	by := skillsByName(listSkills(t, api))
	s, ok := by["nested"]
	if !ok {
		t.Fatalf("missing skill %q, got %+v", "nested", by)
	}
	if s.Error != "" {
		t.Fatalf("unexpected error (nested keys stomped top-level fields?): %s", s.Error)
	}
	if s.Description != "real description" {
		t.Errorf("description = %q, want %q", s.Description, "real description")
	}
	if s.Frontmatter.Name != "nested" {
		t.Errorf("frontmatter name = %q, want %q", s.Frontmatter.Name, "nested")
	}
}

func TestSkillsNameDirMismatch(t *testing.T) {
	project := t.TempDir()
	api := newTestSkillsAPI(t, project)
	writeSkill(t, projectJugglerRoot(project), "real-name", "---\nname: other-name\ndescription: x\n---\nbody\n")
	by := skillsByName(listSkills(t, api))
	s := by["real-name"]
	if s.Error == "" {
		t.Fatalf("expected name/dir mismatch error, got none")
	}
}

func TestSkillsInvalidDirNameAndNonSkillDirs(t *testing.T) {
	project := t.TempDir()
	api := newTestSkillsAPI(t, project)
	root := projectJugglerRoot(project)
	// Invalid directory name (underscore, uppercase) but has a SKILL.md.
	writeSkill(t, root, "Bad_Name", "---\ndescription: x\n---\nbody\n")
	// A plain directory with no SKILL.md must be ignored entirely.
	if err := os.MkdirAll(filepath.Join(root, "not-a-skill"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	skills := listSkills(t, api)
	if len(skills) != 1 {
		t.Fatalf("got %d skills, want 1 (only the invalid-named skill, not the empty dir)", len(skills))
	}
	if skills[0].Name != "Bad_Name" || skills[0].Error == "" {
		t.Errorf("expected Bad_Name flagged with error, got %+v", skills[0])
	}
}

func TestSkillsGetBodyAndListing(t *testing.T) {
	project := t.TempDir()
	api := newTestSkillsAPI(t, project)
	root := projectJugglerRoot(project)
	writeSkill(t, root, "pdf-tools", "---\nname: pdf-tools\ndescription: d\n---\n# PDF tools\n\nStep one.\n")
	writeSkillFile(t, root, "pdf-tools", "references/api.md", "reference docs\n")
	writeSkillFile(t, root, "pdf-tools", "scripts/run.sh", "echo hi\n")

	rec := getSkill(t, api, "project", "juggler", "pdf-tools")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var detail SkillDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if detail.Body != "# PDF tools\n\nStep one.\n" {
		t.Errorf("body = %q", detail.Body)
	}
	files := map[string]int64{}
	for _, f := range detail.Files {
		files[f.Path] = f.Size
	}
	if _, ok := files["references/api.md"]; !ok {
		t.Errorf("listing missing references/api.md; got %v", files)
	}
	if _, ok := files["scripts/run.sh"]; !ok {
		t.Errorf("listing missing scripts/run.sh; got %v", files)
	}
	if _, ok := files["SKILL.md"]; !ok {
		t.Errorf("listing missing SKILL.md; got %v", files)
	}
}

func TestSkillsGetTraversalAndUnknownSource(t *testing.T) {
	project := t.TempDir()
	api := newTestSkillsAPI(t, project)
	writeSkill(t, projectJugglerRoot(project), "real", "---\ndescription: d\n---\nbody\n")

	// Directory-traversal name is rejected by the name validator (400).
	if rec := getSkill(t, api, "project", "juggler", "../../etc"); rec.Code != http.StatusBadRequest {
		t.Errorf("traversal name: status = %d, want 400", rec.Code)
	}
	// Unknown source is rejected (400).
	if rec := getSkill(t, api, "project", "bogus", "real"); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown source: status = %d, want 400", rec.Code)
	}
	// Missing skill is 404.
	if rec := getSkill(t, api, "project", "juggler", "absent"); rec.Code != http.StatusNotFound {
		t.Errorf("absent skill: status = %d, want 404", rec.Code)
	}
}

func TestSkillsNoProjectMode(t *testing.T) {
	api := newTestSkillsAPI(t, "") // no project
	writeSkill(t, userJugglerRoot(), "userskill", "---\ndescription: d\n---\nbody\n")

	skills := listSkills(t, api)
	for _, s := range skills {
		if s.Scope == "project" {
			t.Errorf("unexpected project-scope skill in no-project mode: %+v", s)
		}
	}
	if by := skillsByName(skills); len(by) == 0 || by["userskill"].Name != "userskill" {
		t.Fatalf("user skill should still be discovered, got %+v", skills)
	}
	// A project-scope GET is unavailable (400) with no project.
	if rec := getSkill(t, api, "project", "juggler", "userskill"); rec.Code != http.StatusBadRequest {
		t.Errorf("project GET in no-project mode: status = %d, want 400", rec.Code)
	}
}
