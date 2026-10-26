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

// The set of instances currently registered, keyed by instance id, so Sync can
// tell which registrations are its own and retire the ones the user removed.
// Scanning the registry for the id prefix would not do: the migrated singleton
// keeps its historic bare name.
//
// Guarded by a 1-capacity channel used as a binary semaphore (the codebase
// forbids sync.Mutex): acquire by sending, release by receiving. syncLock
// serialises whole reconciliations, so two concurrent edits cannot interleave
// their register and unregister passes.
var (
	syncLock       = make(chan struct{}, 1)
	registeredLock = make(chan struct{}, 1)
	registeredIDs  = make(map[string]bool)
)

// RegisterAll registers every enabled instance at startup. It is called before
// any credential is read, which it must be: the credentials store resolves a
// provider's key through its registered ConfigKeyName, so an instance that is
// not registered has no key to find.
//
// A file that cannot be read is logged rather than fatal — the rest of the
// providers still work, and the settings UI is how the user would fix it.
func RegisterAll() {
	if err := migrateLegacySingleton(); err != nil {
		jlog.Error("[CustomProvider] Could not migrate the existing OpenAI-compatible endpoint: %v", err)
	}
	if err := Sync(); err != nil {
		jlog.Error("[CustomProvider] Could not register custom providers: %v", err)
	}
}

// Sync reconciles the registry with the file: instances added or edited are
// registered (re-registering a name replaces its definition), and ones removed,
// disabled or no longer valid are unregistered. Callers run it after every edit,
// so a new endpoint reaches the model picker without a restart.
func Sync() error {
	syncLock <- struct{}{}
	defer func() { <-syncLock }()

	instances, err := Load()
	if err != nil {
		return err
	}

	desired := make(map[string]bool, len(instances))
	for id, inst := range instances {
		if !inst.IsEnabled() {
			continue
		}
		// A file edited by hand can hold an entry that could never have been
		// saved through the UI. Registering it would put a provider in the picker
		// that errors on first use, so it is skipped and named in the log.
		if err := validateIDShape(id); err != nil {
			jlog.Error("[CustomProvider] Skipping entry: %v", err)
			continue
		}
		if err := ValidateInstance(inst); err != nil {
			jlog.Error("[CustomProvider] Skipping %q: %v", id, err)
			continue
		}
		desired[id] = true
		registerInstance(id, inst)
	}

	registeredLock <- struct{}{}
	var retired []string
	for id := range registeredIDs {
		if !desired[id] {
			retired = append(retired, id)
		}
	}
	registeredIDs = desired
	<-registeredLock

	for _, id := range retired {
		provider.UnregisterProvider(RegisteredName(id))
	}
	return nil
}

// registerInstance registers one endpoint under its own provider id, from a
// descriptor template shared by every instance.
//
// The record is passed only for the values that are fixed at registration
// (the label). Everything the request itself needs is resolved from a fresh read
// at client-construction time, so editing an endpoint's URL or headers takes
// effect on the next turn rather than at the next restart.
func registerInstance(id string, inst Instance) {
	displayName := strings.TrimSpace(inst.DisplayName)
	if displayName == "" {
		displayName = id
	}
	openaibase.Register(openaibase.Descriptor{
		Name:        RegisteredName(id),
		DisplayName: displayName,
		Description: msg.New("A custom endpoint speaking the OpenAI Chat Completions API. Its base URL and request headers are set in the Custom Providers tab; the API key is optional, for endpoints that need one. Models come from the endpoint's own model list, along with their context windows where it publishes them (vLLM, llama.cpp and LiteLLM all do; for LM Studio, use the LM Studio provider, which reads each model's loaded window). For a hosted provider that models.dev lists, models the endpoint says nothing about take that catalogue's figures. For any other model it says nothing about, Juggler assumes 128k, or 8k for a server on this machine or your local network — set the real figure per model below."),
		// Per-instance credential slot and environment variable, so several
		// endpoints hold distinct secrets. The environment form folds the
		// hyphens an id may carry to underscores, since a shell cannot set a
		// variable whose name contains one.
		ConfigKeyName:   ConfigKeyName(id),
		EnvVarName:      EnvVarName(id),
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
		BaseURLFunc: func() string { return liveBaseURL(id) },
		HeadersFunc: func() map[string]string { return liveHeaders(id) },
		// The key is optional: an endpoint may serve a public model list and
		// need no auth at all. Availability rests instead on the base URL being
		// configured — not a network probe, since the health path of an
		// arbitrary endpoint is unknown.
		APIKeyOptional: true,
		AutoDetect:     func() bool { return liveBaseURL(id) != "" },
		// Zero-value Quirks: the standard OpenAI request shape, the safe default
		// for an endpoint whose divergences are unknown.
	})
}

// ConfigKeyName is the credentials-store key holding an instance's API key. The
// id is kept verbatim so the key reads back as the endpoint it belongs to; the
// migrated endpoint keeps the key name it was already stored under, so its key
// is found without being moved.
func ConfigKeyName(id string) string {
	if id == LegacyID {
		return legacyAPIKeyCredKey
	}
	return "custom_" + id + "_api_key"
}

// EnvVarName is the environment variable an instance's API key can be supplied
// in instead.
func EnvVarName(id string) string {
	if id == LegacyID {
		return legacyEnvVarName
	}
	return "CUSTOM_" + strings.ToUpper(strings.ReplaceAll(id, "-", "_")) + "_API_KEY"
}

// lookup reads one instance from the file. Every per-request resolver goes
// through it rather than closing over a copy, so an edit is live. A read failure
// answers "not configured", which surfaces as a clear error on first use.
func lookup(id string) (Instance, bool) {
	instances, err := Load()
	if err != nil {
		return Instance{}, false
	}
	inst, ok := instances[id]
	return inst, ok
}

// liveBaseURL resolves an instance's endpoint. Trailing slashes are trimmed so
// the SDK does not build "//v1/..." paths.
func liveBaseURL(id string) string {
	inst, ok := lookup(id)
	if !ok {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(inst.BaseURL), "/")
}

// liveHeaders resolves an instance's extra request headers.
func liveHeaders(id string) map[string]string {
	inst, ok := lookup(id)
	if !ok || len(inst.Headers) == 0 {
		return nil
	}
	headers := make(map[string]string, len(inst.Headers))
	for name, value := range inst.Headers {
		headers[name] = value
	}
	return headers
}

// validateIDShape checks an id against the rules that make it usable as a
// provider id, a DOM element id, a CSS selector and a credential key. It leaves
// out the collision check ValidateID adds, because an id already registered by
// the very instance being checked is not a collision.
func validateIDShape(id string) error {
	if id == "" {
		return fmt.Errorf("provider id is required")
	}
	if len(id) > maxIDLength {
		return fmt.Errorf("provider id %q is longer than %d characters", id, maxIDLength)
	}
	if !idPattern.MatchString(id) {
		return fmt.Errorf("provider id %q must start with a letter and use only lowercase letters, digits and single hyphens", id)
	}
	return nil
}
