//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"fmt"
	"net"
	"net/url"
	"slices"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/modelsdev"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/jlog"
)

// Default context/output caps for an endpoint's models, used only for a model
// the endpoint says nothing about.
//
// Most OpenAI-compatible servers do say something — vLLM publishes
// max_model_len, llama.cpp meta.n_ctx, LiteLLM max_input_tokens — and
// openaibase reads whichever of those a listing carries,
// which beats anything set here because it describes the server that will serve
// the request. What is left is a server whose rows are bare ids, and for that
// there is nothing to know: the window is a guess, wrong in both directions for
// somebody, and the per-model override in settings is how a user who knows
// better corrects it. The UI marks it as assumed, and so does every compaction
// that runs against it.
//
// Which guess depends on where the endpoint is (defaultContextWindowFor). The
// rule is that an assumed window must never exceed what the server would
// plausibly serve, because the two errors are not symmetric: too small
// compacts early and shortens replies, visibly, while too large is silent on a
// server like LM Studio that drops the middle of an over-long conversation. A
// hosted gateway serves full-size models, so 128000 is a floor there. A server
// on the user's own machine or network is serving a model it loaded itself, at
// whatever length it was loaded with — and local servers default to a few
// thousand tokens, so 8192 is the most that can be assumed without over-stating.
const (
	defaultContextWindow      = 128000
	localDefaultContextWindow = 8192
	defaultMaxOutputTokens    = 16384
)

// catalog is the models.dev catalogue endpoints are sized from; a variable so
// a test can catalogue its own local server.
var catalog = modelsdev.Embedded

// catalogLimit returns a ModelCaps.Fallback answering one limit from the
// catalogue's entry for a model served at baseURL. It answers only when the
// endpoint is a provider models.dev catalogues and the model is one it lists
// (modelsdev.Catalog.Lookup); every other model keeps the default above, and
// the UI goes on marking it assumed.
func catalogLimit(baseURL string, pick func(modelsdev.Model) int) func(string) (int, bool) {
	return func(model string) (int, bool) {
		m, ok := catalog().Lookup(baseURL, model)
		if !ok {
			return 0, false
		}
		return pick(m), true
	}
}

// defaultContextWindowFor returns the window assumed for an endpoint's models
// that the endpoint says nothing about: localDefaultContextWindow for a server
// on this machine or a private network, defaultContextWindow for anything
// else (including a base URL that does not parse, which never lists models).
func defaultContextWindowFor(baseURL string) int {
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" {
		return defaultContextWindow
	}
	host := u.Hostname()
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return localDefaultContextWindow
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
		return localDefaultContextWindow
	}
	return defaultContextWindow
}

// RegisterType registers the openai-compatible type and, on the first start that
// needs to, moves the endpoints into accounts.json. Call it at startup before
// the accounts are registered: they are instantiated through this type.
//
// A failed migration is logged rather than fatal — the rest of the providers
// still work, and the settings page is how the user would fix it.
func RegisterType() {
	provider.RegisterType(provider.TypeInfo{
		Name:            TypeName,
		DisplayName:     "OpenAI-compatible endpoint",
		Description:     msg.New("A gateway, a tenant or a server speaking the OpenAI API"),
		Category:        provider.CategoryCustom,
		IDPrefix:        idPrefix,
		Instantiate:     instantiate,
		PrepareSettings: prepareSettings,
		KeySlot:         keySlot,
	})
	if err := migrateToAccounts(); err != nil {
		jlog.Error("[CustomProvider] Could not move the custom endpoints into accounts.json: %v", err)
	}
}

// instantiate builds the provider for one endpoint account. An entry edited by
// hand into one that could never have been saved is refused, so it never puts
// a provider in the picker that errors on first use.
func instantiate(acct provider.Account) (provider.ProviderInfo, provider.ProviderInitializer, error) {
	if _, ok := instanceID(acct.ID); !ok || !provider.AccountIDPattern.MatchString(acct.ID) {
		return provider.ProviderInfo{}, nil, fmt.Errorf("%q is not an OpenAI-compatible endpoint id", acct.ID)
	}
	inst := instanceFromEntry(core.AccountEntry{DisplayName: acct.DisplayName, Settings: acct.Settings})
	if err := ValidateInstance(inst); err != nil {
		return provider.ProviderInfo{}, nil, err
	}
	info, initializer := openaibase.Build(descriptorFor(acct.ID, inst))
	return info, initializer, nil
}

// prepareSettings validates an endpoint's settings and keeps only those an
// endpoint has, in the form accounts.json stores them.
func prepareSettings(settings map[string]any) (map[string]any, error) {
	inst := instanceFromEntry(core.AccountEntry{Settings: settings})
	inst.BaseURL = strings.TrimSpace(inst.BaseURL)
	if err := ValidateInstance(inst); err != nil {
		return nil, err
	}
	return entryFromInstance(inst).Settings, nil
}

// keySlot is where an endpoint keeps its API key: a credential slot and an
// environment variable of its own, so several endpoints hold distinct secrets.
// The id is kept verbatim so the key reads back as the endpoint it belongs to;
// the environment form folds the hyphens an id may carry to underscores, since
// a shell cannot set a variable whose name contains one. The endpoint that
// keeps LegacyID keeps the key and variable it always had, so its key is found
// without being moved.
func keySlot(accountID string) (configKey, envVar string) {
	id, _ := instanceID(accountID)
	if id == LegacyID {
		return legacyAPIKeyCredKey, legacyEnvVarName
	}
	return "custom_" + id + "_api_key", "CUSTOM_" + strings.ToUpper(strings.ReplaceAll(id, "-", "_")) + "_API_KEY"
}

// descriptorFor is the descriptor one endpoint registers through.
func descriptorFor(accountID string, inst Instance) openaibase.Descriptor {
	displayName := strings.TrimSpace(inst.DisplayName)
	if displayName == "" {
		displayName, _ = instanceID(accountID)
	}
	configKey, envVar := keySlot(accountID)
	return openaibase.Descriptor{
		Name:            accountID,
		Type:            TypeName,
		DisplayName:     displayName,
		Description:     msg.New("A custom endpoint speaking the OpenAI Chat Completions API. Its base URL and request headers are set in the Custom Providers tab; the API key is optional, for endpoints that need one. Models come from the endpoint's own model list, along with their context windows where it publishes them (vLLM, llama.cpp and LiteLLM all do; for LM Studio, use the LM Studio provider, which reads each model's loaded window). For a hosted provider that models.dev lists, models the endpoint says nothing about take that catalogue's figures. For any other model it says nothing about, Juggler assumes 128k, or 8k for a server on this machine or your local network — set the real figure per model below."),
		ConfigKeyName:   configKey,
		EnvVarName:      envVar,
		DisplayProvider: displayName,
		// Fixed at registration, which Sync repeats after every edit, so a
		// changed base URL re-decides both the default and which catalogue
		// entry, if any, sizes the endpoint's models.
		ContextWindowCaps: utils.ModelCaps{
			Default:  defaultContextWindowFor(inst.BaseURL),
			Fallback: catalogLimit(inst.BaseURL, func(m modelsdev.Model) int { return m.Context }),
		},
		MaxOutputCaps: utils.ModelCaps{
			Default:  defaultMaxOutputTokens,
			Fallback: catalogLimit(inst.BaseURL, func(m modelsdev.Model) int { return m.Output }),
		},
		// The catalogue labels the models it knows, and withholds images only
		// from the ones it knows cannot take them. Every other model is sent
		// images as given: the endpoint may serve a vision model nobody
		// catalogued, and its own error is a better answer than a guess.
		InputModalitiesFn: func(model string) []string {
			if m, ok := catalog().Lookup(inst.BaseURL, model); ok && len(m.Input) > 0 {
				return m.Input
			}
			return nil
		},
		ImagesWithheldFn: func(model string) bool {
			m, ok := catalog().Lookup(inst.BaseURL, model)
			return ok && !slices.Contains(m.InputModalities(), "image")
		},
		BaseURLFunc: func() string { return liveBaseURL(accountID) },
		HeadersFunc: func() map[string]string { return liveHeaders(accountID) },
		// The key is optional: an endpoint may serve a public model list and
		// need no auth at all. Availability rests instead on the base URL being
		// configured — not a network probe, since the health path of an
		// arbitrary endpoint is unknown.
		APIKeyOptional: true,
		AutoDetect:     func() bool { return liveBaseURL(accountID) != "" },
		// Zero-value Quirks: the standard OpenAI request shape, the safe default
		// for an endpoint whose divergences are unknown.
	}
}

// liveBaseURL resolves an endpoint's base URL. Trailing slashes are trimmed so
// the SDK does not build "//v1/..." paths.
func liveBaseURL(accountID string) string {
	inst, ok := lookup(accountID)
	if !ok {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(inst.BaseURL), "/")
}

// liveHeaders resolves an endpoint's extra request headers.
func liveHeaders(accountID string) map[string]string {
	inst, ok := lookup(accountID)
	if !ok || len(inst.Headers) == 0 {
		return nil
	}
	headers := make(map[string]string, len(inst.Headers))
	for name, value := range inst.Headers {
		headers[name] = value
	}
	return headers
}
