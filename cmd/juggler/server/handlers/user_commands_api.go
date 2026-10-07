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

// UserCommandsAPI serves user-defined slash commands over HTTP. The commands
// themselves, their two scope directories and their file format are
// core/user_commands.go's. The project path is read through a provider func so
// a runtime project switch is reflected without reconstructing the handler
// (mirrors ConfigAPI).
type UserCommandsAPI struct {
	projectPathProvider func() string
}

// NewUserCommandsAPI creates a UserCommandsAPI. projectPathProvider returns the
// current project root ("" in no-project mode).
func NewUserCommandsAPI(projectPathProvider func() string) *UserCommandsAPI {
	return &UserCommandsAPI{projectPathProvider: projectPathProvider}
}

// UserCommandDir is the user-scope command directory.
func (api *UserCommandsAPI) UserCommandDir() string {
	return core.UserCommandDir()
}

// ProjectCommandDir is the current project's command directory, or "" in
// no-project mode.
func (api *UserCommandsAPI) ProjectCommandDir() string {
	return core.ProjectCommandDir(api.projectPathProvider())
}

// scopeDir maps a scope name to its command directory, or "" if unknown/absent.
func (api *UserCommandsAPI) scopeDir(scope string) string {
	switch scope {
	case "user":
		return api.UserCommandDir()
	case "project":
		return api.ProjectCommandDir()
	default:
		return ""
	}
}

// resolveTarget extracts the {scope}/{name} route vars and resolves the scope's
// command directory, writing a 400 (and returning ok=false) when the scope is
// unknown or unavailable (project scope in no-project mode).
func (api *UserCommandsAPI) resolveTarget(w http.ResponseWriter, r *http.Request) (scope, name, dir string, ok bool) {
	scope = mux.Vars(r)["scope"]
	name = mux.Vars(r)["name"]
	dir = api.scopeDir(scope)
	if dir == "" {
		WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("unknown or unavailable scope %q", scope))
		return "", "", "", false
	}
	return scope, name, dir, true
}

// HandleList returns every discovered command across both scopes, malformed
// ones included with Error set.
func (api *UserCommandsAPI) HandleList(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, core.ListUserCommands(api.UserCommandDir(), api.ProjectCommandDir()))
}

// HandlePut creates or overwrites a command file for {scope}/{name}. Validation
// failures are structured field errors ({"errors": {field: message}}) with 400,
// for inline display in the editor.
func (api *UserCommandsAPI) HandlePut(w http.ResponseWriter, r *http.Request) {
	scope, name, dir, ok := api.resolveTarget(w, r)
	if !ok {
		return
	}

	spec, ok := DecodeJSON[core.UserCommandSpec](w, r)
	if !ok {
		return
	}

	if fieldErrors := core.ValidateUserCommand(name, spec); len(fieldErrors) > 0 {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{"errors": fieldErrors})
		return
	}

	cmd, err := core.WriteUserCommand(dir, scope, name, spec)
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	WriteJSON(w, r, 0, cmd)
}

// HandleDelete removes a command file for {scope}/{name}. A missing file is a
// no-op success (idempotent delete).
func (api *UserCommandsAPI) HandleDelete(w http.ResponseWriter, r *http.Request) {
	_, name, dir, ok := api.resolveTarget(w, r)
	if !ok {
		return
	}
	if !core.ValidUserCommandName(name) {
		WriteError(w, r, http.StatusBadRequest, "invalid command name")
		return
	}
	if err := core.DeleteUserCommand(dir, name); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	WriteJSON(w, r, 0, map[string]bool{"deleted": true})
}
