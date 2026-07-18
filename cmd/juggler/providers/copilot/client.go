//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package copilot exposes GitHub Copilot as a provider. It speaks the
// OpenAI-compatible Chat Completions protocol at api.githubcopilot.com, but
// authenticates with a short-lived Copilot bearer that the core credentials
// store mints from the user's editor Copilot login (AuthSource
// "github_copilot"; see core/copilot_auth.go). This package therefore only
// describes the wire shape and the model catalog — all auth lives in core.
package copilot

import (
	"context"
	"fmt"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/openaibase"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

// baseURL, when non-empty, overrides the API host (tests point it at an httptest
// server). In production it stays empty and the host comes from the token
// exchange via core.CopilotAPIBase() — the account-correct endpoints.api — so
// Business/Enterprise plans hit api.business./api.enterprise.githubcopilot.com
// rather than the individual host (which 400s model_not_supported for them).
var baseURL = ""

// apiBase resolves the Copilot API host for both /models and /chat/completions.
func apiBase() string {
	if baseURL != "" {
		return baseURL
	}
	return core.CopilotAPIBase()
}

// Register adds the GitHub Copilot provider to the global registry. It uses the
// editor's Copilot OAuth login (exchanged for a short-lived bearer in core), not
// a Platform API key.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:         "copilot",
		DisplayName:  "GitHub Copilot",
		Description:  "Uses your GitHub Copilot subscription via your editor's Copilot login. No API key required — sign in to Copilot in VS Code, a JetBrains IDE, or Neovim first.",
		AuthType:     provider.AuthTypeOAuthBearer,
		AuthSource:   "github_copilot",
		SignInMethod: "github_device",
		BaseURLFunc:  apiBase, // account-correct host from the token exchange
		// No ContextWindows map: there is no static catalog. On a failed/empty
		// live list the provider shows zero models (ProviderInfo.ModelContextWindows
		// stays nil, so the menu publishes no fallback rows) — connecting is
		// pointless if we can't enumerate what's actually callable.
		DisplayProvider:    "GitHub Copilot",
		ListModelsOverride: listModels,
		ThinkingSpecFn:     openaibase.OpenAIThinkingSpec,
		Quirks: openaibase.Quirks{
			MaxTokensParamName: "max_tokens",
		},
	})
}

const chatCompletionsEndpoint = "/chat/completions"

type copilotModelsResponse struct {
	Data []copilotModel `json:"data"`
}

type copilotModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// SupportedEndpoints lists the API surfaces a model serves. The decisive
	// structural field: newer models (the GPT-5.x family) are Responses-API-only
	// (["/responses"]) and reject our Chat Completions calls with 400
	// model_not_supported for every account. Legacy models (gpt-4.1/4o/4/3.5)
	// omit the field and default to /chat/completions. See supportsChatCompletions.
	SupportedEndpoints []string `json:"supported_endpoints"`
	Capabilities       struct {
		Type   string `json:"type"`
		Limits struct {
			MaxContextWindowTokens int `json:"max_context_window_tokens"`
			MaxPromptTokens        int `json:"max_prompt_tokens"`
			MaxOutputTokens        int `json:"max_output_tokens"`
		} `json:"limits"`
		Supports struct {
			ToolCalls bool `json:"tool_calls"`
		} `json:"supports"`
	} `json:"capabilities"`
}

// supportsChatCompletions reports whether a model can be driven over the Chat
// Completions endpoint Juggler uses. An empty list means the legacy default
// (chat completions); a non-empty list must explicitly include it — a model that
// lists only /responses cannot be called this way.
func (m copilotModel) supportsChatCompletions() bool {
	if len(m.SupportedEndpoints) == 0 {
		return true
	}
	for _, ep := range m.SupportedEndpoints {
		if ep == chatCompletionsEndpoint {
			return true
		}
	}
	return false
}

// callable reports whether Juggler can drive this model over Chat Completions.
// It filters ONLY on structural facts that hold for EVERY account — a model
// excluded here can never work on our path, regardless of whose token is used:
//
//   - not a chat model (embeddings / completion)
//   - Responses-API-only (no /chat/completions endpoint; e.g. the GPT-5.x family)
//   - no tool-call support (Juggler sends a tools array on every turn)
//
// It deliberately does NOT gate on policy state or the preview flag. The Copilot
// catalog carries no reliable per-account "is this callable" signal — models
// that fail for one account are byte-identical to ones that work — so any
// account-specific guess would both leave failing models in the list and hide
// models that are perfectly good on other accounts (a policy-gated model works
// once enabled at github.com/settings/copilot; a preview model may be the one
// that works elsewhere). We stay conservative and let a model the account can't
// use surface its own model_not_supported error rather than second-guess it.
func (m copilotModel) callable() bool {
	switch {
	case m.ID == "" || m.Capabilities.Type != "chat":
		return false
	case !m.supportsChatCompletions():
		return false // Responses-API-only models (e.g. GPT-5.x)
	case !m.Capabilities.Supports.ToolCalls:
		return false // Juggler sends tools every turn
	default:
		return true
	}
}

// listModels fetches the live Copilot catalog and returns the models Juggler can
// structurally drive over Chat Completions (see callable for the conservative,
// account-agnostic filter — non-chat, Responses-API-only, and no-tool-call
// models are the only ones dropped). The live catalog is the sole source of
// truth; we never advertise a model it didn't return, and there is no static
// fallback. Some listed models may still be unavailable on a given account
// (policy not yet enabled, etc.) and will surface their own model_not_supported
// error when picked — that's the deliberate tradeoff for not hiding models that
// work on other accounts.
func listModels(ctx context.Context, bearerToken string, headers map[string]string) ([]provider.ModelInfo, error) {
	var parsed copilotModelsResponse
	if err := utils.GetJSON(ctx, apiBase()+"/models", utils.JSONGetOptions{
		Bearer:  bearerToken,
		Headers: headers,
		Label:   "GitHub Copilot /models",
	}, &parsed); err != nil {
		return nil, fmt.Errorf("failed to list models from GitHub Copilot: %w", err)
	}

	infos := make([]provider.ModelInfo, 0, len(parsed.Data))
	seen := map[string]bool{}
	for _, model := range parsed.Data {
		if !model.callable() || seen[model.ID] {
			continue
		}
		seen[model.ID] = true

		contextWindow := model.Capabilities.Limits.MaxContextWindowTokens
		if contextWindow == 0 {
			contextWindow = model.Capabilities.Limits.MaxPromptTokens
		}
		if contextWindow == 0 {
			contextWindow = DefaultContextWindow
		}
		maxOutputTokens := model.Capabilities.Limits.MaxOutputTokens
		if maxOutputTokens == 0 {
			maxOutputTokens = DefaultMaxOutputTokens
		}
		displayName := model.Name
		if displayName == "" {
			displayName = utils.ModelDisplayName(model.ID)
		}
		spec := openaibase.OpenAIThinkingSpec(model.ID)
		infos = append(infos, provider.ModelInfo{
			ID:                   model.ID,
			DisplayName:          displayName,
			ContextWindow:        contextWindow,
			MaxOutputTokens:      maxOutputTokens,
			FromAPI:              true,
			ThinkingLevels:       spec.Levels,
			DefaultThinkingLevel: spec.Default,
		})
	}

	if len(infos) == 0 {
		return nil, fmt.Errorf("GitHub Copilot /models returned no chat-completions-capable models")
	}
	return infos, nil
}
