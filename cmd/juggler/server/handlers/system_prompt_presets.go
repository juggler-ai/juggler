//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"fmt"
	"net/http"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
)

// SystemPromptPresetsAPI serves the user's saved system-prompt presets and the
// chosen session-default preset id, all held by core's SystemPromptPresetStore.
type SystemPromptPresetsAPI struct {
	store *core.SystemPromptPresetStore
}

// NewSystemPromptPresetsAPI creates a SystemPromptPresetsAPI over store.
func NewSystemPromptPresetsAPI(store *core.SystemPromptPresetStore) *SystemPromptPresetsAPI {
	return &SystemPromptPresetsAPI{store: store}
}

// HandleGetPresets returns the user's saved presets and the chosen default
// preset id. Built-in presets are NOT included — they live in the frontend; the
// client merges the two. An empty defaultId means the client should fall back to
// the built-in `default` preset.
//
//	GET /api/system-prompt-presets → {presets: [{id,name,content}], defaultId}
func (api *SystemPromptPresetsAPI) HandleGetPresets(w http.ResponseWriter, r *http.Request) {
	presets, defaultID, err := api.store.Load()
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't load system prompt presets: %v", err))
		return
	}
	WriteJSON(w, r, 0, map[string]any{
		"presets":   presets,
		"defaultId": defaultID,
	})
}

// HandleCreatePreset saves the current prompt body as a new named user preset
// and returns it (with its generated id).
//
//	POST /api/system-prompt-presets {name, content} → {success, preset}
func (api *SystemPromptPresetsAPI) HandleCreatePreset(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}](w, r)
	if !ok {
		return
	}
	preset, err := api.store.Create(req.Name, req.Content)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	WriteSuccess(w, r, map[string]any{"preset": preset})
}

// HandleDeletePreset removes a user preset by id (idempotent).
//
//	DELETE /api/system-prompt-presets/{id} → {success}
func (api *SystemPromptPresetsAPI) HandleDeletePreset(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if err := api.store.Delete(id); err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't delete preset: %v", err))
		return
	}
	WriteSuccess(w, r, nil)
}

// HandleUpdatePreset replaces the name and content of an existing user preset
// by id.
//
//	PUT /api/system-prompt-presets/{id} {name, content} → {success, preset}
func (api *SystemPromptPresetsAPI) HandleUpdatePreset(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	req, ok := DecodeJSON[struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}](w, r)
	if !ok {
		return
	}
	preset, err := api.store.Update(id, req.Name, req.Content)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	WriteSuccess(w, r, map[string]any{"preset": preset})
}

// HandleSetDefaultPreset records which preset (built-in or user) new
// conversations are seeded from. An empty id clears the explicit default.
//
//	PUT /api/system-prompt-presets/default {id} → {success}
func (api *SystemPromptPresetsAPI) HandleSetDefaultPreset(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		ID string `json:"id"`
	}](w, r)
	if !ok {
		return
	}
	if err := api.store.SetDefault(req.ID); err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't set default preset: %v", err))
		return
	}
	WriteSuccess(w, r, nil)
}
