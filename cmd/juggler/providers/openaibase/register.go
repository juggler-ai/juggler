//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
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
	Description   msg.Message // Blurb shown in the settings UI, as a msg.New literal. May be zero.
	AuthType      provider.AuthType
	AuthSource    string
	SignInMethod  string // e.g. "github_device"; enables in-app Sign in / Sign out UI
	ConfigKeyName string
	EnvVarName    string
	APIKeyURL     string
	AutoDetect    func() bool
	// APIKeyOptional marks a provider whose API key is optional: it stays
	// available with no key configured provided AutoDetect reports it is
	// otherwise usable (e.g. an OpenAI-compatible gateway with a public,
	// no-auth model list, available once its base URL is set). When true and no
	// key is present, the client is built keyless — the SDK sends no
	// Authorization header at all.
	APIKeyOptional bool
	// CheapModel names this provider's preferred low-cost / fast model id for
	// out-of-band micro-tasks (auto-naming a tab). Empty ⇒ no cheap tier.
	// Surfaced on ProviderInfo.CheapModel; validated against the live list
	// before use.
	CheapModel string
	// DefaultModels ranks the models a new conversation may start on when the
	// user has no explicit default. Surfaced on ProviderInfo.DefaultModels.
	DefaultModels []string
	// FreeToRun marks a local runtime that bills nothing per token, so a
	// micro-task may re-run the conversation's own model rather than needing a
	// CheapModel of its own. Surfaced on ProviderInfo.FreeToRun.
	FreeToRun bool
	// Successor names a provider better suited to the server this one is
	// pointed at. Surfaced on ProviderInfo.Successor.
	Successor func(ctx context.Context) *provider.Successor

	// Static context-window map exposed via ProviderInfo.ModelContextWindows.
	// May be nil for providers whose model list is discovered at runtime. When
	// nil, Register derives it from ContextWindowCaps.Overrides.
	ContextWindows map[string]int
	// StaticWindowsAssumed and RejectsContextOverflow are surfaced on the
	// ProviderInfo fields of the same names: ContextWindows are stand-ins for a
	// live catalogue, and the backend rejects an over-long request rather than
	// truncating it.
	StaticWindowsAssumed   bool
	RejectsContextOverflow bool

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

	// ServiceTierSpecFn looks up a model's non-standard serving classes (the
	// advertised tiers + the provider's declared default). nil ⇒ the provider
	// exposes no speed control on any model, which is the case for every vendor
	// that bills a single serving speed.
	ServiceTierSpecFn ServiceTierSpecFunc

	// ReasoningReplayFn picks a model's ReasoningReplay, overriding
	// Quirks.ReasoningReplay, for a provider whose models do not all share
	// one contract (a gateway serving several vendors, a local server whose
	// template support varies by model).
	ReasoningReplayFn func(modelID string) ReasoningReplay

	// LimitDiscoveryUnsupported opts a provider OUT of reading the token limits
	// its own model list publishes. Discovery is on by default because the
	// endpoint describes the server that will serve the request, where a
	// compiled-in catalog only describes what a vendor documented once — but a
	// gateway that advertises a window it will not honour needs the catalog to
	// stay in charge, and this is the switch for it.
	LimitDiscoveryUnsupported bool

	// ListModelsOverride, if non-nil, replaces the standard
	// SDK Models.List + Filter + ContextWindowFn flow. Use for providers
	// whose model catalog lives at a custom HTTP endpoint.
	ListModelsOverride func(ctx context.Context, credential string, headers map[string]string) ([]provider.ModelInfo, error)

	// UsageStatsOverride, if non-nil, enables provider-level usage/quota stats
	// for providers whose account plan exposes a custom endpoint.
	UsageStatsOverride func(ctx context.Context, credential string, headers map[string]string) (provider.UsageStats, error)

	// LiveUsageUnsupported opts a provider OUT of the live-growing footer token
	// meter. The OpenAI-compatible wire reports authoritative per-call prompt
	// usage (final-chunk `usage` on Chat Completions, `response.completed` usage
	// on the Responses API), which the stream loop re-emits as a transient usage
	// chunk, so ProviderInfo.StreamsLiveUsage defaults ON for every openaibase
	// provider. Set this only for an endpoint whose reported prompt tokens are
	// absent, cumulative across calls, or otherwise unfit for the context meter.
	LiveUsageUnsupported bool

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
		Name:                   d.Name,
		DisplayName:            d.DisplayName,
		Description:            d.Description,
		AuthType:               d.AuthType,
		AuthSource:             d.AuthSource,
		SignInMethod:           d.SignInMethod,
		ConfigKeyName:          d.ConfigKeyName,
		EnvVarName:             d.EnvVarName,
		APIKeyURL:              d.APIKeyURL,
		AutoDetect:             d.AutoDetect,
		APIKeyOptional:         d.APIKeyOptional,
		ModelContextWindows:    d.ContextWindows,
		StaticWindowsAssumed:   d.StaticWindowsAssumed,
		RejectsContextOverflow: d.RejectsContextOverflow,
		CheapModel:             d.CheapModel,
		DefaultModels:          d.DefaultModels,
		FreeToRun:              d.FreeToRun,
		Successor:              d.Successor,
		// A provider that does not opt into forced tool choice cannot reliably
		// honor a named tool_choice, so the worker runs those turns unforced
		// rather than send a choice the upstream rejects.
		ForcedToolChoiceUnsupported: !d.Quirks.ForcedToolChoiceSupported,
		// An endpoint that rejects max_output_tokens is sent none, so it cannot
		// be sent a raised one either.
		FixedOutputCap: d.Quirks.OmitResponsesMaxOutputTokens,
		// The OpenAI-compatible wire reports authoritative per-call prompt usage,
		// which the stream loop re-emits as a transient usage chunk; the footer
		// meter can grow against it live. On by default, opt-out per descriptor.
		StreamsLiveUsage: !d.LiveUsageUnsupported,
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
			return capabilitiesFromPair(cw.Lookup(model), mo.Lookup(model))
		}
	case d.ContextWindowFn != nil:
		info.ResolveModelCapabilities = func(model string) (provider.ModelCapabilities, bool) {
			return capabilitiesFromPair(d.ContextWindowFn(model))
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
		// An endpoint carried on the config outranks the descriptor's own, so a
		// single descriptor can serve several user-configured endpoints instead of
		// needing one registration per URL. Empty leaves the descriptor deciding,
		// which is every built-in vendor.
		if cfg.BaseURL != "" {
			baseURL = cfg.BaseURL
		}
		staticHeaders := d.Headers
		if d.HeadersFunc != nil {
			staticHeaders = d.HeadersFunc()
		}
		cfg.Headers = mergeHeaders(staticHeaders, cfg.Headers)
		base, err := NewClientFromProviderConfig(cfg, baseURL, d.Quirks, d.APIKeyOptional)
		if err != nil {
			return nil, err
		}
		base.limitDiscoveryDisabled = d.LimitDiscoveryUnsupported
		base.catalogMaxOutput = catalogMaxOutputLookup(d, capsSynthesised)
		// Label this client's provider-boundary errors (notably the idle-stall
		// message) with the id the user configured, not the shared "openai".
		if d.Name != "" {
			base.providerName = d.Name
		}
		// Resolve this model's reasoning-effort support once, so the per-turn
		// request builder can map req.ThinkingLevel without re-classifying.
		if d.ThinkingSpecFn != nil {
			base.thinkingSpec = d.ThinkingSpecFn(cfg.Model)
		}
		// Likewise resolve the serving classes once, so the request builder can
		// gate req.ServiceTier without re-consulting the catalog per turn.
		if d.ServiceTierSpecFn != nil {
			base.serviceTierSpec = d.ServiceTierSpecFn(cfg.Model)
		}
		if d.ReasoningReplayFn != nil {
			base.quirks.ReasoningReplay = d.ReasoningReplayFn(cfg.Model)
		}
		client := &openAICompatClient{
			Client:     base,
			desc:       d,
			baseURL:    baseURL,
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

// catalogMaxOutputLookup returns the client's authoritative per-model output
// ceiling: the value the wire cap is clamped down to even when the capability
// snapshot carries a higher one (a derived reserve, or a live limit reported
// above the model's real cap, which is a hard 400 on the wire).
//
// It answers only for models the catalog actually KNOWS, and that distinction
// is the whole of it. A provider-wide default is not knowledge about a model:
// clamping to it would discard the larger cap the endpoint published for that
// exact id, which is the number closest to what the server will accept. So
// data-driven caps vouch for an explicit override and nothing else.
//
// A descriptor supplying its own ContextWindowFn (the local servers: ollama,
// llama.cpp, LM Studio, LocalAI) gets no lookup at all. Its function is a
// fallback guess at the serving window, not a ceiling the server enforces —
// none of them reject a large max_tokens — and the snapshot already holds the
// best number available: the live listing's, or the user's Max output tokens
// override, which a clamp here would silently undo on the wire while admission
// and the truncation notice went on quoting it.
//
// Nil means nothing is authoritative and the snapshot stands unclamped.
func catalogMaxOutputLookup(d Descriptor, capsSynthesised bool) func(model string) (int, bool) {
	if !capsSynthesised {
		return nil
	}
	maxOutputCaps := d.MaxOutputCaps
	return func(model string) (int, bool) {
		value, known := maxOutputCaps.LookupKnown(model)
		return value, known && value > 0
	}
}

// capabilitiesFromPair builds ModelCapabilities from a (contextWindow,
// maxOutputTokens) pair, keeping only positive values and returning ok=false
// when neither is known. Shared by both ResolveModelCapabilities closures.
func capabilitiesFromPair(contextWindow, maxOutputTokens int) (provider.ModelCapabilities, bool) {
	capabilities := provider.ModelCapabilities{}
	if contextWindow > 0 {
		capabilities.ContextWindowTokens = int64(contextWindow)
	}
	if maxOutputTokens > 0 {
		capabilities.MaxOutputTokens = int64(maxOutputTokens)
	}
	return capabilities, capabilities != (provider.ModelCapabilities{})
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
	desc Descriptor
	// baseURL is the endpoint this client was built against, resolved through
	// the same precedence the SDK client used (config, then descriptor
	// resolver, then descriptor field). Kept so the extra metadata routes a
	// listing may consult — see fillWindowsFromCapabilities — are reached on
	// the server that is actually serving this client.
	baseURL    string
	credential string
	headers    map[string]string
}

func (c *openAICompatClient) Name() string { return c.desc.Name }

var _ provider.ConversationProvider = (*openAICompatClient)(nil)

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
	models, err := c.Client.ListModelsWithInfo(ctx, filter, c.desc.ContextWindowFn, c.desc.InputModalitiesFn, c.desc.ThinkingSpecFn, c.desc.ServiceTierSpecFn, c.desc.DisplayProvider)
	if err != nil {
		return nil, err
	}
	return markDefaultWindows(c.desc.ContextWindowCaps, c.fillWindowsFromCapabilities(ctx, models)), nil
}

// markDefaultWindows flags the models whose window is the catalogue's
// provider-wide Default: nothing on the endpoint sized them and no per-model
// entry knows them. A catalogued figure for a bare-id endpoint is not flagged —
// it is a statement about that model, merely not the server's own.
func markDefaultWindows(caps utils.ModelCaps, models []provider.ModelInfo) []provider.ModelInfo {
	if caps.Default <= 0 {
		return models
	}
	for i := range models {
		if models[i].FromAPI {
			continue
		}
		if _, known := caps.LookupKnown(models[i].ID); !known {
			models[i].WindowAssumed = true
		}
	}
	return models
}

type usageOpenAICompatClient struct {
	*openAICompatClient
}

func (c *usageOpenAICompatClient) UsageStats(ctx context.Context) (provider.UsageStats, error) {
	return c.desc.UsageStatsOverride(ctx, c.credential, c.headers)
}
