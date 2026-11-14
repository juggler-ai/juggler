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
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// baseURL, when non-empty, overrides the API host (tests point it at an httptest
// server). In production it stays empty and the host comes from the token
// exchange via core.CopilotAPIBase — the account-correct endpoints.api — so
// Business/Enterprise plans hit api.business./api.enterprise.githubcopilot.com
// rather than the individual host (which 400s model_not_supported for them).
var baseURL = ""

// apiBaseFor is the API host of account accountID ("" for the default
// account), for both /models and /chat/completions: the one its own plan's
// token exchange reported.
func apiBaseFor(accountID string) func() string {
	return func() string {
		if baseURL != "" {
			return baseURL
		}
		return core.CopilotAPIBase(accountID)
	}
}

// Register adds the GitHub Copilot provider to the global registry. It uses a
// GitHub Copilot OAuth login (exchanged for a short-lived bearer in core), not a
// Platform API key. The login can be made here through the device flow, or
// picked up from one an editor already holds.
func Register() {
	openaibase.Register(descriptor(TypeName, displayName, "github_copilot", apiBaseFor("")))
}

// displayName is the default account's name, and the type's.
const displayName = "GitHub Copilot"

// descriptor is the provider for one account: its id and name, the OAuth
// source its login comes from, and where its plan's API is.
func descriptor(name, shownAs, authSource string, base func() string) openaibase.Descriptor {
	return openaibase.Descriptor{
		Name:         name,
		DisplayName:  shownAs,
		Description:  msg.New("Uses your GitHub Copilot plan, including the free one. No API key required — sign in with GitHub here, or reuse a Copilot login from VS Code, a JetBrains IDE, or Neovim."),
		AuthType:     provider.AuthTypeOAuthBearer,
		AuthSource:   authSource,
		SignInMethod: "github_device",
		BaseURLFunc:  base, // account-correct host from the token exchange
		// No ContextWindows map: there is no static catalog. On a failed/empty
		// live list the provider shows zero models (ProviderInfo.ModelContextWindows
		// stays nil, so the menu publishes no fallback rows) — connecting is
		// pointless if we can't enumerate what's actually callable.
		DisplayProvider: "GitHub Copilot",
		ListModelsOverride: func(ctx context.Context, bearerToken string, headers map[string]string) ([]provider.ModelInfo, error) {
			return listModelsAt(ctx, base(), bearerToken, headers)
		},
		ThinkingSpecFn: openaibase.OpenAIThinkingSpec,
		Quirks: openaibase.Quirks{
			MaxTokensParamName:        "max_tokens",
			ForcedToolChoiceSupported: true,
		},
	}
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

// listModelsAt fetches the live Copilot catalog from base, the account's own
// plan's API host, and returns the models Juggler can
// structurally drive over Chat Completions (see callable for the conservative,
// account-agnostic filter — non-chat, Responses-API-only, and no-tool-call
// models are the only ones dropped). The live catalog is the sole source of
// truth; we never advertise a model it didn't return, and there is no static
// fallback. Some listed models may still be unavailable on a given account
// (policy not yet enabled, etc.) and will surface their own model_not_supported
// error when picked — that's the deliberate tradeoff for not hiding models that
// work on other accounts.
func listModelsAt(ctx context.Context, base, bearerToken string, headers map[string]string) ([]provider.ModelInfo, error) {
	var parsed copilotModelsResponse
	if err := utils.GetJSON(ctx, base+"/models", utils.JSONGetOptions{
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
		windowAssumed := contextWindow == 0
		if windowAssumed {
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
			WindowAssumed:        windowAssumed,
			ThinkingLevels:       spec.Options(),
			DefaultThinkingLevel: spec.Default,
		})
	}

	if len(infos) == 0 {
		return nil, fmt.Errorf("GitHub Copilot /models returned no chat-completions-capable models")
	}
	return infos, nil
}
