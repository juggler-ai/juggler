//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package lmstudio is the LM Studio provider: a keyless local server speaking
// the OpenAI-compatible API, whose per-model context windows are read from LM
// Studio's own model table — the OpenAI-compatible model list carries none.
package lmstudio

import (
	"context"
	"fmt"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// DefaultHost is the URL used when no explicit host is configured: LM Studio's
// own default server port.
const DefaultHost = "http://127.0.0.1:1234"

// HostCredKey is the credentials.json field where the user-configured LM Studio
// URL lives. Set via the settings panel; read by the shared LocalHost.
const HostCredKey = "lmstudio_host"

// server describes LM Studio as a keyless, host-configurable OpenAI-compatible
// endpoint. Detection asks for the model table and checks that the body is one:
// LM Studio answers 200 to every path it does not implement, and so might
// something else on the same port, so a status code proves only that a server
// is listening. legacyServer is the same server as LM Studio 0.3 describes
// itself, before the v1 table existed.
var (
	server = openaibase.LocalHost{
		CredKey:     HostCredKey,
		EnvVar:      "LMSTUDIO_HOST",
		DefaultHost: DefaultHost,
		HealthPath:  "/api/v1/models",
		ValidBody:   isNativeTable,
	}
	legacyServer = openaibase.LocalHost{
		CredKey:     HostCredKey,
		EnvVar:      "LMSTUDIO_HOST",
		DefaultHost: DefaultHost,
		HealthPath:  "/api/v0/models",
		ValidBody:   isLegacyTable,
	}
)

// Host returns the LM Studio server URL this provider is configured for.
func Host() string { return server.Host() }

// autoDetect reports whether an LM Studio server answers at the configured host.
func autoDetect() bool {
	return server.AutoDetect()() || legacyServer.AutoDetect()()
}

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		ReasoningReplayFn: reasoningReplay,
		Name:              "lmstudio",
		DisplayName:       "LM Studio (local)",
		Description:       msg.New("Runs models locally through LM Studio's server. Start the server in LM Studio first (Juggler doesn't launch it); point at a non-default host (LAN, custom port) below, otherwise defaults to http://127.0.0.1:1234. Each loaded model's context window is read from LM Studio. A model that isn't loaded yet is assumed to have 8192 until it is, and Juggler says so."),
		AutoDetect:        autoDetect,
		// The OpenAI-compatible model list carries no window; LM Studio's own
		// table does.
		DisplayProvider:    "LM Studio",
		ContextWindowFn:    getContextWindowInfo,
		ListModelsOverride: listModels,
		BaseURLFunc:        server.BaseURLFunc(),
		APIKeyDefault:      "lmstudio", // placeholder so the OpenAI SDK accepts the request
		// Served off the user's own hardware at no per-token cost, so a
		// micro-task re-uses the conversation's model rather than needing a cheap
		// tier from a catalog LM Studio doesn't have.
		FreeToRun: true,
	})
}

// getContextWindowInfo resolves the window LM Studio will serve for one model,
// falling back to DefaultContextWindow when the model or the table is not
// there.
//
// Max output tokens is left at 0 (unknown): LM Studio has no output ceiling
// distinct from the context window, so the caller derives the shared safety
// reserve from the window instead.
func getContextWindowInfo(modelID string) (int, int) {
	models, err := Models(context.Background(), server.Host(), nil)
	if err == nil {
		for _, m := range models {
			if m.ID == modelID {
				window, _ := m.ContextWindow()
				return window, 0
			}
		}
	}
	return DefaultContextWindow, 0
}

// listModels publishes the models LM Studio can serve, each with the window it
// will serve them at. When neither of LM Studio's own tables can be read, the
// OpenAI-compatible list still names the models, each on the assumed window,
// so an LM Studio release that changes its tables degrades to guesses rather
// than to an empty picker.
func listModels(ctx context.Context, _ string, headers map[string]string) ([]provider.ModelInfo, error) {
	models, err := Models(ctx, server.Host(), headers)
	if err != nil {
		ids, idsErr := fetchModelIDs(ctx, headers)
		if idsErr != nil {
			return nil, fmt.Errorf("list LM Studio models: %w", idsErr)
		}
		models = make([]Model, 0, len(ids))
		for _, id := range ids {
			models = append(models, Model{ID: id})
		}
	}

	out := make([]provider.ModelInfo, 0, len(models))
	for _, m := range models {
		window, assumed := m.ContextWindow()
		name := m.DisplayName
		if name == "" {
			name = utils.ModelDisplayName(m.ID)
		}
		var modalities []string
		if m.Vision {
			modalities = []string{"text", "image"}
		}
		out = append(out, provider.ModelInfo{
			ID:              m.ID,
			DisplayName:     name,
			ContextWindow:   window,
			FromAPI:         !assumed,
			WindowAssumed:   assumed,
			InputModalities: modalities,
		})
	}
	return out, nil
}

// fetchModelIDs reads the ids from the OpenAI-compatible /v1/models.
func fetchModelIDs(ctx context.Context, headers map[string]string) ([]string, error) {
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := getJSON(ctx, server.Host()+"/v1/models", headers, &list); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(list.Data))
	for _, entry := range list.Data {
		if entry.ID != "" {
			ids = append(ids, entry.ID)
		}
	}
	return ids, nil
}
