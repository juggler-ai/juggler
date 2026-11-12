//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"

	"juggler/cmd/juggler/msg"
	"juggler/internal/projectpaths"
)

// ProjectStateAPI serves GET /api/project-state: where this project's local
// state lives, for the Settings toggle that keeps it outside the project. Where
// that is is projectpaths'; this only answers for the current project.
type ProjectStateAPI struct {
	pathProvider func() string
}

// NewProjectStateAPI creates a ProjectStateAPI. pathProvider returns the
// project path.
func NewProjectStateAPI(pathProvider func() string) *ProjectStateAPI {
	return &ProjectStateAPI{pathProvider: pathProvider}
}

// projectStateInfo is the answer. Placement changes only when a session starts
// (core.PlaceProjectState), so Outside can disagree with the setting until the
// project is next opened — which is what the tab tells the user.
type projectStateInfo struct {
	// StateDir is the folder the project's state is in.
	StateDir string `json:"stateDir"`
	// Outside reports whether StateDir is outside the project.
	Outside bool `json:"outside"`
	// OutsideDir is where the state lives with the setting on.
	OutsideDir string `json:"outsideDir"`
	// ByEnv reports that projectpaths.StateDirEnv forces the outside placement,
	// so the setting has no effect on this server.
	ByEnv bool `json:"byEnv"`
}

// HandleGet serves GET /api/project-state.
func (api *ProjectStateAPI) HandleGet(w http.ResponseWriter, r *http.Request) {
	project := api.pathProvider()
	if project == "" {
		WriteMessageError(w, r, http.StatusNotFound, msg.New("no project loaded"))
		return
	}
	dirs := projectpaths.For(project)
	WriteJSON(w, r, 0, projectStateInfo{
		StateDir:   dirs.State,
		Outside:    dirs.Outside(),
		OutsideDir: projectpaths.OutsideDir(project),
		ByEnv:      projectpaths.OutsideByEnv(),
	})
}
