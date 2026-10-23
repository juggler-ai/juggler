//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"context"
	"fmt"

	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// baseURL is a var (not a const) so tests can point listModels at a fake
// server, mirroring creditsURL/keyURL in the usage path.
var baseURL = "https://openrouter.ai/api/v1"

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		ReasoningReplayFn:  reasoningReplay,
		Name:               "openrouter",
		DisplayName:        "OpenRouter",
		ConfigKeyName:      "openrouter_api_key",
		EnvVarName:         "OPENROUTER_API_KEY",
		APIKeyURL:          "https://openrouter.ai/keys",
		ContextWindows:     ModelContextWindows,
		BaseURL:            baseURL,
		ListModelsOverride: listModels,
		UsageStatsOverride: usageStats,
	})
}

// openRouterModel mirrors the subset of fields we consume from
// https://openrouter.ai/api/v1/models.
type openRouterModel struct {
	ID            string `json:"id"`
	Name          string `json:"name"` // Human label OpenRouter ships, e.g. "Anthropic: Claude Sonnet 4.5"
	ContextLength int    `json:"context_length"`
	Architecture  struct {
		InputModalities []string `json:"input_modalities"`
	} `json:"architecture"`
	// TopProvider describes the endpoint that will actually serve the request,
	// as opposed to the top-level ContextLength, which is the maximum across
	// every endpoint OpenRouter can route the id to.
	TopProvider struct {
		ContextLength       int `json:"context_length"`
		MaxCompletionTokens int `json:"max_completion_tokens"`
	} `json:"top_provider"`
}

type openRouterModelsResponse struct {
	Data []openRouterModel `json:"data"`
}

// listModels fetches the model catalog directly from OpenRouter. The OpenAI
// SDK's Models.List does not surface context_length, so we hit the REST
// endpoint to get authoritative context windows for each model. The account's
// presets are then appended (see presets.go), since OpenRouter accepts one in
// place of a model id.
func listModels(ctx context.Context, apiKey string, headers map[string]string) ([]provider.ModelInfo, error) {
	var parsed openRouterModelsResponse
	if err := utils.GetJSON(ctx, baseURL+"/models", utils.JSONGetOptions{
		Bearer:  apiKey,
		Headers: headers,
		Label:   "OpenRouter /models",
	}, &parsed); err != nil {
		return nil, fmt.Errorf("failed to list models from OpenRouter: %w", err)
	}

	infos := make([]provider.ModelInfo, 0, len(parsed.Data))
	for _, m := range parsed.Data {
		// The serving endpoint's window, not the aggregate one, whenever it is
		// the smaller of the two. OpenRouter reports both, and for an alias id
		// they differ by a quarter of a million tokens; the request is served by
		// one endpoint, so the aggregate overstates what will be accepted.
		//
		// Taking the smaller also keeps this window in the same denominator as
		// max_completion_tokens below, which top_provider reports too. Mixing the
		// two is what makes a cap like 943718 — 90% of the serving window —
		// survive the clamp as though it were 72% of a larger one, and admission
		// then charges the whole thing as its output reserve.
		ctxWindow := m.ContextLength
		if served := m.TopProvider.ContextLength; served > 0 && (ctxWindow <= 0 || served < ctxWindow) {
			ctxWindow = served
		}
		if ctxWindow == 0 {
			ctxWindow = GetContextWindow(m.ID)
		}
		// OpenRouter's catalog contains entries whose max_completion_tokens
		// equals context_length; a cap at/above the window leaves no input room
		// and is a catalog artifact, not a usable limit. The shared rule replaces
		// both that and an unreported cap with the reserve derived from the
		// window, so the listed data is already hygienic before the server's
		// normalizeOutputLimit sees it. A model with no window at all keeps the
		// flat default, since there is nothing to derive a reserve from.
		maxOut, derived := utils.ResolveOutputCap(ctxWindow, m.TopProvider.MaxCompletionTokens)
		if maxOut <= 0 {
			maxOut, derived = DefaultMaxOutputTokens, false
		}
		// Map OpenRouter's reported input modalities, keeping only the kinds we
		// model (text/image). Anything else (e.g. "file") is dropped; a result
		// of just ["text"] is normalised to nil (text-only by convention).
		var inputModalities []string
		for _, mod := range m.Architecture.InputModalities {
			if mod == "image" {
				inputModalities = []string{"text", "image"}
				break
			}
		}

		infos = append(infos, provider.ModelInfo{
			ID:               m.ID,
			DisplayName:      utils.FirstNonEmpty(m.Name, utils.ModelDisplayName(m.ID)),
			ContextWindow:    ctxWindow,
			MaxOutputTokens:  maxOut,
			MaxOutputDerived: derived,
			FromAPI:          true,
			InputModalities:  inputModalities,
		})
	}

	// The account's presets, appended as "@preset/<slug>" entries whose limits are
	// resolved against the catalog just fetched. Never fatal: a preset list that
	// cannot be read costs the user the presets, not the models.
	return append(infos, listPresets(ctx, apiKey, headers, infos)...), nil
}
