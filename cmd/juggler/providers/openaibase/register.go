//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

// Descriptor describes a provider that speaks the OpenAI Chat-Completions
// protocol. Per-provider packages build one of these and pass
// it to Register, which handles the boilerplate (registry registration, Name,
// Info, NewClient, ListModelsWithInfo) uniformly.
type Descriptor struct {
	// Registry metadata
	Name          string
	DisplayName   string
	Description   string // Human-readable blurb shown in the settings UI. May be empty.
	AuthType      provider.AuthType
	AuthSource    string
	SignInMethod  string // e.g. "github_device"; enables in-app Sign in / Sign out UI
	ConfigKeyName string
	EnvVarName    string
	APIKeyURL     string
	AutoDetect    func() bool

	// Static context-window map exposed via ProviderInfo.ModelContextWindows.
	// May be nil for providers whose model list is discovered at runtime. When
	// nil, Register derives it from ContextWindowCaps.Overrides.
	ContextWindows map[string]int

	// ContextWindowCaps / MaxOutputCaps supply per-model context-window and
	// max-output-tokens lookups as data (default + exact-id overrides). When
	// ContextWindowFn is nil, Register synthesises it from these. Use these for
	// providers with a fixed model catalog; supply ContextWindowFn directly
	// only when the lookup needs custom logic (e.g. ollama's prefix matching).
	ContextWindowCaps utils.ModelCaps
	MaxOutputCaps     utils.ModelCaps

	// Display label used in ListModelsWithInfo log lines (e.g. "OpenAI").
	DisplayProvider string

	// Filter passed to ListModelsWithInfo. nil ⇒ accept all.
	Filter ModelFilterFunc

	// ContextWindowFn looks up (context, maxOutput) for a model id during
	// ListModelsWithInfo. Required unless ListModelsOverride is set.
	ContextWindowFn ContextWindowFunc

	// InputModalitiesFn looks up the input modalities for a model id during
	// ListModelsWithInfo (e.g. ["text","image"]). nil ⇒ all models text-only.
	InputModalitiesFn ModalitiesFunc

	// ThinkingSpecFn looks up a model's reasoning-effort support (advertised
	// levels + native mapping). nil ⇒ the provider exposes no thinking control
	// on any model (non-reasoning vendors, or passthrough gateways that would
	// 400 on an unexpected reasoning param).
	ThinkingSpecFn ThinkingSpecFunc

	// ListModelsOverride, if non-nil, replaces the standard
	// SDK Models.List + Filter + ContextWindowFn flow. Use for providers
	// whose model catalog lives at a custom HTTP endpoint.
	ListModelsOverride func(ctx context.Context, credential string, headers map[string]string) ([]provider.ModelInfo, error)

	// UsageStatsOverride, if non-nil, enables provider-level usage/quota stats
	// for providers whose account plan exposes a custom endpoint.
	UsageStatsOverride func(ctx context.Context, credential string, headers map[string]string) (provider.UsageStats, error)

	// openaibase.Client options
	BaseURL     string        // Static base URL.
	BaseURLFunc func() string // If set, resolved at NewClient time (overrides BaseURL).
	Quirks      Quirks        // Per-vendor request-shape divergences. Zero value = standard OpenAI.
	Headers     map[string]string
	// HeadersFunc resolves the static (per-provider) headers at NewClient time,
	// overriding Headers when set. Use for user-configured headers (e.g. a
	// gateway that requires a custom User-Agent) that aren't known at
	// registration. Merged under any per-request cfg.Headers, same as Headers.
	HeadersFunc   func() map[string]string
	APIKeyDefault string // Fallback when cfg.APIKey is empty (keyless providers).
}

// Register wires a Descriptor into the provider registry. Each provider
// package calls this from its own Register, invoked explicitly from main.
func Register(d Descriptor) {
	// Data-driven caps: synthesise the per-model (context, maxOutput) lookup and
	// the static context map from ContextWindowCaps/MaxOutputCaps when the
	// provider didn't supply the function/map forms directly.
	capsSynthesised := false
	if d.ContextWindowFn == nil && (capsConfigured(d.ContextWindowCaps) || capsConfigured(d.MaxOutputCaps)) {
		cw, mo := d.ContextWindowCaps, d.MaxOutputCaps
		d.ContextWindowFn = func(model string) (int, int) {
			return cw.Lookup(model), mo.Lookup(model)
		}
		capsSynthesised = true
	}
	if d.ContextWindows == nil {
		d.ContextWindows = d.ContextWindowCaps.Overrides
	}

	info := provider.ProviderInfo{
		Name:                d.Name,
		DisplayName:         d.DisplayName,
		Description:         d.Description,
		AuthType:            d.AuthType,
		AuthSource:          d.AuthSource,
		SignInMethod:        d.SignInMethod,
		ConfigKeyName:       d.ConfigKeyName,
		EnvVarName:          d.EnvVarName,
		APIKeyURL:           d.APIKeyURL,
		AutoDetect:          d.AutoDetect,
		ModelContextWindows: d.ContextWindows,
	}
	switch {
	case capsSynthesised:
		// Static admission resolution vouches only for ids the provider
		// catalogued in an override; a Default alone never resolves. Defaults
		// still apply to catalogued ids (and to provider-reported live lists
		// via ContextWindowFn), but an uncatalogued id — typically a
		// user-invented alias — fails closed instead of inheriting a
		// fabricated limit.
		cw, mo := d.ContextWindowCaps, d.MaxOutputCaps
		info.ResolveModelCapabilities = func(model string) (provider.ModelCapabilities, bool) {
			_, cwKnown := cw.LookupKnown(model)
			_, moKnown := mo.LookupKnown(model)
			if !cwKnown && !moKnown {
				return provider.ModelCapabilities{}, false
			}
			contextWindow, maxOutputTokens := cw.Lookup(model), mo.Lookup(model)
			capabilities := provider.ModelCapabilities{}
			if contextWindow > 0 {
				capabilities.ContextWindowTokens = int64(contextWindow)
			}
			if maxOutputTokens > 0 {
				capabilities.MaxOutputTokens = int64(maxOutputTokens)
			}
			return capabilities, capabilities != (provider.ModelCapabilities{})
		}
	case d.ContextWindowFn != nil:
		info.ResolveModelCapabilities = func(model string) (provider.ModelCapabilities, bool) {
			contextWindow, maxOutputTokens := d.ContextWindowFn(model)
			capabilities := provider.ModelCapabilities{}
			if contextWindow > 0 {
				capabilities.ContextWindowTokens = int64(contextWindow)
			}
			if maxOutputTokens > 0 {
				capabilities.MaxOutputTokens = int64(maxOutputTokens)
			}
			return capabilities, capabilities != (provider.ModelCapabilities{})
		}
	}

	initializer := func(cfg provider.Config) (provider.Provider, error) {
		if cfg.APIKey == "" && d.APIKeyDefault != "" {
			cfg.APIKey = d.APIKeyDefault
		}
		baseURL := d.BaseURL
		if d.BaseURLFunc != nil {
			baseURL = d.BaseURLFunc()
		}
		staticHeaders := d.Headers
		if d.HeadersFunc != nil {
			staticHeaders = d.HeadersFunc()
		}
		cfg.Headers = mergeHeaders(staticHeaders, cfg.Headers)
		base, err := NewClientFromProviderConfig(cfg, baseURL, d.Quirks)
		if err != nil {
			return nil, err
		}
		// Resolve this model's reasoning-effort support once, so the per-turn
		// request builder can map req.ThinkingLevel without re-classifying.
		if d.ThinkingSpecFn != nil {
			base.thinkingSpec = d.ThinkingSpecFn(cfg.Model)
		}
		client := &openAICompatClient{
			Client:     base,
			desc:       d,
			credential: firstNonEmpty(cfg.APIKey, cfg.BearerToken),
			headers:    cfg.Headers,
		}
		if d.UsageStatsOverride != nil {
			return &usageOpenAICompatClient{openAICompatClient: client}, nil
		}
		return client, nil
	}

	provider.RegisterProvider(info, initializer)
}

// capsConfigured reports whether a ModelCaps carries any data (a default or at
// least one override), distinguishing a populated caps from the zero value.
func capsConfigured(c utils.ModelCaps) bool {
	return c.Default != 0 || len(c.Overrides) > 0
}

func mergeHeaders(base, override map[string]string) map[string]string {
	if len(base) == 0 && len(override) == 0 {
		return nil
	}
	merged := make(map[string]string, len(base)+len(override))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range override {
		merged[key] = value
	}
	return merged
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// openAICompatClient adapts the shared Client to the provider.Provider interface,
// supplying per-descriptor Name() and ListModelsWithInfo() behaviour.
type openAICompatClient struct {
	*Client
	desc       Descriptor
	credential string
	headers    map[string]string
}

func (c *openAICompatClient) Name() string { return c.desc.Name }

// OpenConversation returns a native Conversation handle. openaibase-
// derived providers are stateless from the conversation's point of view
// (every turn is one HTTP request that carries its own history) so the
// handle just owns the per-turn dispatch.
func (c *openAICompatClient) OpenConversation(ctx context.Context, convID string) (provider.Conversation, error) {
	// CacheTTL 5m: OpenAI's prefix cache is automatic with a sliding ~5–10 min
	// TTL; 5m is the conservative end so the UI's cached-anchor expires before
	// the upstream cache does rather than displaying a phantom hit. Embedding
	// derived providers inherit this.
	return &provider.StatelessConversation{ConvID: convID, TTL: 5 * time.Minute, Dispatch: c.streamMessage}, nil
}

func (c *openAICompatClient) ListModelsWithInfo(ctx context.Context) ([]provider.ModelInfo, error) {
	if c.desc.ListModelsOverride != nil {
		return c.desc.ListModelsOverride(ctx, c.credential, c.headers)
	}
	filter := c.desc.Filter
	if filter == nil {
		filter = func(string) bool { return true }
	}
	return c.Client.ListModelsWithInfo(ctx, filter, c.desc.ContextWindowFn, c.desc.InputModalitiesFn, c.desc.ThinkingSpecFn, c.desc.DisplayProvider)
}

type usageOpenAICompatClient struct {
	*openAICompatClient
}

func (c *usageOpenAICompatClient) UsageStats(ctx context.Context) (provider.UsageStats, error) {
	return c.desc.UsageStatsOverride(ctx, c.credential, c.headers)
}
