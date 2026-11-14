//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package customprovider holds the user's named custom endpoints: any number of
// gateways, tenants, regions or local servers, each with its own base URL,
// credentials, headers and model list, each appearing as its own provider in the
// model picker.
//
// Each entry registers as a separate provider id rather than as a model under
// one shared id (the shape ACP uses for its agents). That is what gives an entry
// its own credential slot — the credentials store is keyed by provider — and it
// keeps models.hidden and models.limits, which are keyed provider-then-model,
// able to name one endpoint's models without inventing composite model ids.
//
// Each endpoint is a provider account of the openai-compatible type (TypeName),
// kept in the global accounts.json (core.AccountsFile) beside every other
// account the user added, and added, edited, registered and removed by the
// accounts package as every account is; this package supplies the type. They
// are deliberately NOT project-scoped: a provider
// id is persisted into per-conversation documents and into the global
// default-model, cheap-model and settings stores alike, so an id that resolved
// to different endpoints in different projects would make those stores
// ambiguous.
//
// An older build kept them in custom-providers.json, which is migrated once
// (migrate.go) and never written, so that a downgrade still finds them.
package customprovider

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths"
)

// TypeName is the provider type every custom endpoint is an account of. It is
// also LegacyID, the id of the one endpoint that predates there being several;
// that endpoint is an account like the others, which happens to carry the
// type's name.
const TypeName = "openai-compatible"

// ProtocolOpenAI is the OpenAI Chat Completions wire protocol. It is the only
// protocol implemented; the field exists so an Anthropic-compatible protocol can
// be added later without migrating anyone's file.
const ProtocolOpenAI = "openai"

// idPrefix namespaces the provider id an instance registers under, so a
// user-chosen name can never collide with a built-in provider, present or
// future.
//
// It is a hyphen and not a colon on purpose: the settings UI interpolates a
// provider id into DOM element ids and finds them again with
// querySelector("#<id>-key") (providers-tab.js). A colon there parses as a CSS
// pseudo-class and throws, which would break the Providers tab for every custom
// endpoint.
const idPrefix = "custom-"

// Instance is one endpoint's definition: what an account's settings hold, and
// the shape custom-providers.json kept it in.
type Instance struct {
	// DisplayName is the label shown in the picker and settings. It is the only
	// human-facing name, and the only one that can be edited: the id is the key
	// every stored reference uses and never changes.
	DisplayName string `json:"displayName,omitempty"`
	// Protocol is the wire protocol. Empty means ProtocolOpenAI.
	Protocol string            `json:"protocol,omitempty"`
	BaseURL  string            `json:"baseURL,omitempty"`
	Headers  map[string]string `json:"headers,omitempty"`
	// Enabled is custom-providers.json's on/off switch: absent is on. Read only
	// to migrate the file; an account has no "off".
	Enabled *bool `json:"enabled,omitempty"`
}

// IsEnabled reports whether a custom-providers.json entry was switched on.
func (i Instance) IsEnabled() bool { return i.Enabled == nil || *i.Enabled }

// EffectiveProtocol resolves the blank protocol of an entry written before there
// was more than one.
func (i Instance) EffectiveProtocol() string {
	if i.Protocol == "" {
		return ProtocolOpenAI
	}
	return i.Protocol
}

// Config is the parsed custom-providers.json document, the endpoints' home
// before accounts. Read only to migrate it.
type Config struct {
	Providers map[string]Instance `json:"customProviders"`
}

const configFileName = "custom-providers.json"

// configPath is <ConfigDir>/custom-providers.json. Never written: an older
// build reads it, so it keeps what it held when it was migrated.
func configPath() string {
	return filepath.Join(userpaths.ConfigDir(), configFileName)
}

// RegisteredName is the provider id an instance registers under. The endpoint
// carried over from the days of a single custom provider keeps its bare,
// unprefixed id, because that is the id already written into conversations and
// into the default-model, cheap-model and settings stores.
func RegisteredName(id string) string {
	if id == LegacyID {
		return LegacyID
	}
	return idPrefix + id
}

// ValidateInstance checks one endpoint's fields.
func ValidateInstance(inst Instance) error {
	if p := inst.EffectiveProtocol(); p != ProtocolOpenAI {
		return fmt.Errorf("unknown protocol %q", p)
	}
	raw := strings.TrimSpace(inst.BaseURL)
	if raw == "" {
		return fmt.Errorf("base URL is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("base URL %q is not a URL: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("base URL %q must start with http:// or https://", raw)
	}
	if u.Host == "" {
		return fmt.Errorf("base URL %q has no host", raw)
	}
	return nil
}

// instanceID is the instance id of an account of this type: the part of its
// id after the prefix, or LegacyID for the endpoint that keeps that bare id.
func instanceID(accountID string) (string, bool) {
	if accountID == LegacyID {
		return LegacyID, true
	}
	id, ok := strings.CutPrefix(accountID, idPrefix)
	return id, ok && id != ""
}

// lookup reads the endpoint accountID from accounts.json. Every per-request
// resolver goes through it rather than closing over a copy, so an edit is
// live. A read failure answers "not configured", which surfaces as a clear
// error on first use.
func lookup(accountID string) (Instance, bool) {
	f, err := core.LoadAccounts()
	if err != nil {
		return Instance{}, false
	}
	entry, ok := f.Accounts[accountID]
	if !ok || entry.Type != TypeName {
		return Instance{}, false
	}
	return instanceFromEntry(entry), true
}

// entryFromInstance is an instance as accounts.json stores it.
func entryFromInstance(inst Instance) core.AccountEntry {
	settings := map[string]any{"baseURL": inst.BaseURL}
	if inst.Protocol != "" {
		settings["protocol"] = inst.Protocol
	}
	if len(inst.Headers) > 0 {
		settings["headers"] = inst.Headers
	}
	return core.AccountEntry{Type: TypeName, DisplayName: inst.DisplayName, Settings: settings}
}

// instanceFromEntry reads an instance back from its accounts.json entry.
func instanceFromEntry(entry core.AccountEntry) Instance {
	inst := Instance{DisplayName: entry.DisplayName}
	inst.BaseURL, _ = entry.Settings["baseURL"].(string)
	inst.Protocol, _ = entry.Settings["protocol"].(string)
	switch headers := entry.Settings["headers"].(type) {
	case map[string]string:
		inst.Headers = headers
	case map[string]any:
		inst.Headers = make(map[string]string, len(headers))
		for name, value := range headers {
			if s, ok := value.(string); ok {
				inst.Headers[name] = s
			}
		}
	}
	return inst
}

// loadLegacyFile reads custom-providers.json, reporting whether it exists.
func loadLegacyFile() (map[string]Instance, bool, error) {
	data, err := os.ReadFile(configPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, true, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, true, fmt.Errorf("%s: %w", configFileName, err)
	}
	if cfg.Providers == nil {
		cfg.Providers = map[string]Instance{}
	}
	return cfg.Providers, true, nil
}

// validateIDShape checks an instance id against the rules that make it usable
// in a provider id, a DOM element id, a CSS selector and a credential key.
func validateIDShape(id string) error {
	if id == "" {
		return fmt.Errorf("provider id is required")
	}
	if len(id) > provider.MaxAccountIDLength {
		return fmt.Errorf("provider id %q is longer than %d characters", id, provider.MaxAccountIDLength)
	}
	if !provider.AccountIDPattern.MatchString(id) {
		return fmt.Errorf("provider id %q must start with a letter and use only lowercase letters, digits and single hyphens", id)
	}
	return nil
}
