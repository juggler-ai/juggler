//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"fmt"
	"net/http"

	"juggler/cmd/juggler/core"

	"github.com/gorilla/mux"
)

// SkillDetail is the GET /api/skills/{scope}/{source}/{name} response: the full
// SKILL.md body plus the directory listing. Metadata mirrors the list entry.
type SkillDetail struct {
	Name   string           `json:"name"`
	Scope  string           `json:"scope"`
	Source string           `json:"source"`
	Path   string           `json:"path"`
	Body   string           `json:"body"`
	Files  []core.SkillFile `json:"files"`
}

// SkillsAPI serves Agent Skills over HTTP: discovery and read only. Where the
// skill roots are and how a skill is read is core/skills.go's. The project path
// is read through a provider func so a runtime project switch is reflected
// without reconstructing the handler (mirrors UserCommandsAPI / ConfigAPI).
type SkillsAPI struct {
	projectPathProvider func() string
}

// NewSkillsAPI creates a SkillsAPI. projectPathProvider returns the current
// project root ("" in no-project mode).
func NewSkillsAPI(projectPathProvider func() string) *SkillsAPI {
	return &SkillsAPI{projectPathProvider: projectPathProvider}
}

// resolveRootDir maps a (scope, source) pair to its skills directory for the
// current project. Returns ok=false for an unknown or unavailable pair.
func (api *SkillsAPI) resolveRootDir(scope, source string) (string, bool) {
	return core.SkillRootDir(api.projectPathProvider(), scope, source)
}

// HandleList returns every discovered skill across all roots, with shadowed and
// error flags set. Bodies are never included.
func (api *SkillsAPI) HandleList(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, core.ListSkills(api.projectPathProvider()))
}

// HandleGet returns one skill's SKILL.md body and directory listing for
// {scope}/{source}/{name}. The name must match the spec pattern (which excludes
// path separators and dots), and the resolved directory must stay inside its
// root — so directory traversal is impossible by construction and re-checked
// defensively.
func (api *SkillsAPI) HandleGet(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	scope, source, name := vars["scope"], vars["source"], vars["name"]

	if !core.ValidSkillName(name) {
		WriteError(w, r, http.StatusBadRequest, "invalid skill name")
		return
	}
	rootDir, ok := api.resolveRootDir(scope, source)
	if !ok {
		WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("unknown or unavailable source %q/%q", scope, source))
		return
	}
	dir, ok := core.SkillDir(rootDir, name)
	if !ok {
		WriteError(w, r, http.StatusBadRequest, "invalid skill path")
		return
	}
	body, files, err := core.ReadSkill(dir)
	if err != nil {
		WriteError(w, r, http.StatusNotFound, fmt.Sprintf("skill %q not found in %s/%s", name, scope, source))
		return
	}
	WriteJSON(w, r, 0, SkillDetail{
		Name:   name,
		Scope:  scope,
		Source: source,
		Path:   dir,
		Body:   body,
		Files:  files,
	})
}
