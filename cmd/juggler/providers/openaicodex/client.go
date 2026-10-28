//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"sync/atomic"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

var baseURL = "https://chatgpt.com/backend-api/codex"

const (
	// codexClientVersion is the Codex client version announced to /models, and
	// the only thing it affects: it rides that one query and no turn request.
	// The catalog gates rows on it: each model declares a minimal_client_version
	// and is simply omitted from the response for anything older, with no error
	// to notice — the model just never appears. gpt-6.1-sol is withheld below
	// 0.159.0, so this must not be moved backwards past the newest slug we list.
	//
	// The gate is a numeric comparison and nothing more: the backend serves an
	// unreleased future version quite happily, and a version it has never heard
	// of returns the same rows as the newest one it has. We pin a real published
	// release anyway, so that a claim we make about ourselves stays true.
	codexClientVersion = "0.160.0"
)

// Register adds the OpenAI Codex-plan provider to the global registry. It
// uses the ChatGPT OAuth token of the local ChatGPT app or Codex CLI, not a Platform API key.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:           "openaicodex",
		DisplayName:    "OpenAI Codex (ChatGPT plan)",
		Description:    msg.New("Uses your local ChatGPT app or Codex CLI login, so any ChatGPT plan including Free can run Codex here without an OpenAI Platform API key."),
		AuthType:       provider.AuthTypeOAuthBearer,
		AuthSource:     "codex_cli",
		BaseURL:        baseURL,
		ContextWindows: ModelContextWindows,
		// The static windows are catalogContextWindow guesses (see models.go), and
		// the backend answers an over-long request with "exceeds the context
		// window of this model" — so a guessed window is left for it to judge
		// rather than compacted against.
		StaticWindowsAssumed:   true,
		RejectsContextOverflow: true,
		DisplayProvider:        "OpenAI Codex",
		// The reason to name one at all: this provider is second in
		// defaultProviderPreference, so a fresh install that signs in to Codex
		// and nothing else lands here. The plan catalog has no mini, so this is
		// the cheapest full model in it — and deliberately not the cheaper
		// gpt-6-luna, because nothing asks the user before spending this model:
		// GPT-6 access is off by default for Enterprise accounts, and a cheap
		// model the account cannot call fails work the user never chose it for.
		CheapModel: "gpt-5.6-luna",
		// The catalog's priority order puts gpt-6-astra, its most expensive
		// model, first, and the automatic default would then spend plan quota
		// on it that the user never chose to. Sol is the everyday tier; newest
		// first, with gpt-5.6-sol for accounts without GPT-6.
		DefaultModels:      []string{"gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"},
		ListModelsOverride: listModels,
		UsageStatsOverride: usageStats,
		ThinkingSpecFn:     codexThinkingSpec,
		ServiceTierSpecFn:  codexServiceTierSpec,
		Quirks: openaibase.Quirks{
			MaxTokensParamName:           "max_completion_tokens",
			ForceResponsesAPI:            true,
			OmitResponsesMaxOutputTokens: true,
			ForcedToolChoiceSupported:    true,
			SessionAffinityHeader:        true,
		},
	})
}

type codexModelsResponse struct {
	Models []codexModel `json:"models"`
}

type codexModel struct {
	Slug             string `json:"slug"`
	Visibility       string `json:"visibility"`
	ContextWindow    int    `json:"context_window"`
	MaxContextWindow int    `json:"max_context_window"`
	MaxOutputTokens  int    `json:"max_output_tokens"`
	Priority         int    `json:"priority"`
	// DefaultReasoningLevel and SupportedReasoningLevels are the backend's
	// authoritative per-model reasoning-effort declaration — the single source
	// of truth for which effort tiers this model accepts. The valid set varies
	// per model (e.g. gpt-5.6-sol advertises low/medium/high/xhigh/max/ultra)
	// and the current catalog's slugs carry no "codex" marker at all, so a slug
	// heuristic cannot classify them. We advertise and wire-gate from these
	// fields, never from the slug.
	DefaultReasoningLevel    string                `json:"default_reasoning_level"`
	SupportedReasoningLevels []codexReasoningLevel `json:"supported_reasoning_levels"`

	// ServiceTiers is the backend's declaration of the non-standard serving
	// classes this model offers, carrying its own id, label and blurb (e.g.
	// {"priority", "Fast", "2x speed, increased usage"}). It is the sole
	// authority for what may be requested: a tier absent here is not offered
	// and never sent. DefaultServiceTier is the backend's declared default and
	// is displayed, never applied — see ServiceTierSpec.tierFor.
	//
	// The response also carries additional_speed_tiers, which the Codex client
	// marks deprecated in favour of this field. It is deliberately not parsed.
	ServiceTiers       []codexServiceTier `json:"service_tiers"`
	DefaultServiceTier string             `json:"default_service_tier"`
}

type codexReasoningLevel struct {
	Effort string `json:"effort"`
}

type codexServiceTier struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// reasoningSpecs is the latest complete API-declared reasoning catalog, keyed
// by model slug. Each successful /models response replaces the whole immutable
// snapshot so a model removed from (or no longer declaring levels in) a later
// response cannot retain stale capabilities from an earlier fetch.
var reasoningSpecs atomic.Value // stores map[string]openaibase.ThinkingSpec

func replaceReasoningSpecs(specs map[string]openaibase.ThinkingSpec) {
	reasoningSpecs.Store(specs)
}

// codexThinkingSpec is the descriptor's ThinkingSpecFn. The ChatGPT-plan
// catalog is authoritative for reasoning levels, so only a spec populated from
// /models is returned. A saved/static model that was not present in the live
// catalog gets no reasoning control and no reasoning_effort on the wire — never
// a model-name guess or hard-coded fallback.
func codexThinkingSpec(modelID string) openaibase.ThinkingSpec {
	if snapshot, ok := reasoningSpecs.Load().(map[string]openaibase.ThinkingSpec); ok {
		return snapshot[modelID]
	}
	return openaibase.ThinkingSpec{}
}

// serviceTierSpecs is the latest complete API-declared serving-class catalog,
// keyed by model slug, on the same wholesale-replacement terms as
// reasoningSpecs: a model that stops offering a tier must lose it immediately,
// because continuing to offer it would spend the user's money on a request the
// backend will decline.
var serviceTierSpecs atomic.Value // stores map[string]openaibase.ServiceTierSpec

func replaceServiceTierSpecs(specs map[string]openaibase.ServiceTierSpec) {
	serviceTierSpecs.Store(specs)
}

// codexServiceTierSpec is the descriptor's ServiceTierSpecFn. Only a spec
// populated from /models is returned: a saved or static model absent from the
// live catalog gets no speed control and no service_tier on the wire.
func codexServiceTierSpec(modelID string) openaibase.ServiceTierSpec {
	if snapshot, ok := serviceTierSpecs.Load().(map[string]openaibase.ServiceTierSpec); ok {
		return snapshot[modelID]
	}
	return openaibase.ServiceTierSpec{}
}

// serviceTierSpecFromCatalog builds a ServiceTierSpec from a model's
// service_tiers, preserving the backend's order, ids and labels. A model that
// declares no tiers yields the zero spec (standard serving only).
func serviceTierSpecFromCatalog(model codexModel) openaibase.ServiceTierSpec {
	tiers := make([]provider.ServiceTier, 0, len(model.ServiceTiers))
	for _, tier := range model.ServiceTiers {
		if tier.ID == "" {
			continue
		}
		tiers = append(tiers, provider.ServiceTier{
			ID:          tier.ID,
			Name:        tier.Name,
			Description: tier.Description,
		})
	}
	if len(tiers) == 0 {
		return openaibase.ServiceTierSpec{}
	}
	return openaibase.ServiceTierSpec{Tiers: tiers, Default: model.DefaultServiceTier}
}

// thinkingSpecFromCatalog builds a ThinkingSpec from a model's
// supported_reasoning_levels, preserving the backend's order and default. A
// model that declares no levels yields the zero spec (no reasoning control).
func thinkingSpecFromCatalog(model codexModel) openaibase.ThinkingSpec {
	levels := make([]string, 0, len(model.SupportedReasoningLevels))
	for _, level := range model.SupportedReasoningLevels {
		if level.Effort != "" {
			levels = append(levels, level.Effort)
		}
	}
	if len(levels) == 0 {
		return openaibase.ThinkingSpec{}
	}
	return openaibase.ThinkingSpec{Levels: levels, Default: model.DefaultReasoningLevel}
}

// admitModel decides whether a catalog row becomes a selectable model.
//
// `visibility` gates the picker, not the model: "list" is the catalog's own
// front page, while "hide" marks a model that is fully usable but which Codex
// declines to show, configurable by name only.
// Admitting every hidden row instead would put the catalog's internal and
// evaluation entries in front of users, so the second gate is our own list:
// a hidden model is admitted when it is a slug we ship in ModelContextWindows.
//
// This only decides admission. Everything about an admitted model — its
// windows, reasoning levels, serving classes — still comes from the live row,
// which stays the sole authority wherever it speaks.
func admitModel(model codexModel) bool {
	if model.Visibility == "list" {
		return true
	}
	_, known := ModelContextWindows[model.Slug]
	return known
}

func listModels(ctx context.Context, bearerToken string, headers map[string]string) ([]provider.ModelInfo, error) {
	endpoint, err := url.Parse(baseURL + "/models")
	if err != nil {
		return nil, fmt.Errorf("failed to build OpenAI Codex models URL: %w", err)
	}
	query := endpoint.Query()
	query.Set("client_version", codexClientVersion)
	endpoint.RawQuery = query.Encode()

	var parsed codexModelsResponse
	if err := utils.GetJSON(ctx, endpoint.String(), utils.JSONGetOptions{
		Bearer:  bearerToken,
		Headers: headers,
		Label:   "OpenAI Codex /models",
	}, &parsed); err != nil {
		return nil, fmt.Errorf("failed to list models from OpenAI Codex: %w", err)
	}

	sort.SliceStable(parsed.Models, func(i, j int) bool {
		return parsed.Models[i].Priority < parsed.Models[j].Priority
	})

	infos := make([]provider.ModelInfo, 0, len(parsed.Models))
	specs := make(map[string]openaibase.ThinkingSpec, len(parsed.Models))
	tierSpecs := make(map[string]openaibase.ServiceTierSpec, len(parsed.Models))
	for _, model := range parsed.Models {
		if model.Slug == "" || !admitModel(model) {
			continue
		}
		// The catalog states two windows, and they mean different things.
		// `context_window` is the operating point the Codex CLI picks for
		// itself and auto-compacts against; `max_context_window` is the ceiling
		// the backend actually enforces — for the gpt-5.6 family, 872000 above
		// a 272000 operating point.
		//
		// Juggler is not the Codex CLI and brings its own compaction policy, so
		// what it needs from the catalog is the limit the wire imposes. A prompt
		// between the two is accepted and billed like any other; measuring it
		// against the operating point reports a conversation with half a million
		// tokens of room to spare as over its limit.
		contextWindow := model.MaxContextWindow
		if contextWindow == 0 {
			contextWindow = model.ContextWindow
		}
		windowAssumed := contextWindow == 0
		if windowAssumed {
			contextWindow = DefaultContextWindow
		}
		maxOutputTokens := model.MaxOutputTokens
		if maxOutputTokens == 0 {
			maxOutputTokens = DefaultMaxOutputTokens
		}
		spec := thinkingSpecFromCatalog(model)
		specs[model.Slug] = spec
		tierSpec := serviceTierSpecFromCatalog(model)
		tierSpecs[model.Slug] = tierSpec
		infos = append(infos, provider.ModelInfo{
			ID:                   model.Slug,
			DisplayName:          utils.ModelDisplayName(model.Slug) + " (ChatGPT plan)",
			ContextWindow:        contextWindow,
			MaxOutputTokens:      maxOutputTokens,
			FromAPI:              true,
			WindowAssumed:        windowAssumed,
			ThinkingLevels:       spec.Options(),
			DefaultThinkingLevel: spec.Default,
			ServiceTiers:         tierSpec.Options(),
			DefaultServiceTier:   tierSpec.Default,
		})
	}
	if len(infos) == 0 {
		return nil, fmt.Errorf("OpenAI Codex /models returned no visible models")
	}
	replaceReasoningSpecs(specs)
	replaceServiceTierSpecs(tierSpecs)
	return withStaticFallbackModels(infos), nil
}

func withStaticFallbackModels(infos []provider.ModelInfo) []provider.ModelInfo {
	seen := make(map[string]bool, len(infos))
	for _, info := range infos {
		seen[info.ID] = true
	}

	ids := make([]string, 0, len(ModelContextWindows))
	for id := range ModelContextWindows {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)

	for _, id := range ids {
		// These compatibility entries contribute only static admission limits. The
		// ChatGPT-plan /models response is the sole authority for reasoning levels
		// and serving classes, so a model absent from that response advertises
		// neither a thinking control nor a speed control. Their windows are the
		// same stand-ins, so they are assumed.
		infos = append(infos, provider.ModelInfo{
			ID:              id,
			DisplayName:     utils.ModelDisplayName(id) + " (ChatGPT plan)",
			ContextWindow:   ModelContextWindows[id],
			MaxOutputTokens: DefaultMaxOutputTokens,
			FromAPI:         false,
			WindowAssumed:   true,
		})
	}
	return infos
}
