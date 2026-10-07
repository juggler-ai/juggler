//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// Raw credentials.json keys for non-API-key settings persisted via /api/config.
// Kept in sync with the producing packages (e.g. ollama.HostCredKey,
// claudecode.BinaryPathCredKey) — the frontend posts these literal names.
const (
	ollamaHostKey           = "ollama_host"
	llamacppHostKey         = "llamacpp_host"
	localaiHostKey          = "localai_host"
	lmstudioHostKey         = "lmstudio_host"
	claudecodeBinaryPathKey = "claudecode_binary_path"
	streamIdleTimeoutKey    = "stream_idle_timeout" // mirrors streamidle.CredKey
	// spendLimitTokensKey stores the conversation spend ceiling in cumulative
	// NEW input tokens — cache reads excluded, as the counter meters them
	// (worker/spend.go) — as a string. Absent/unparseable ⇒ the shipped default
	// (worker.DefaultSpendCeilingTokens); "0" ⇒ no ceiling. Read live by the
	// resolver in server/llm_caller.go, which this key mirrors.
	spendLimitTokensKey = "spend_limit_tokens"
	// autoCompactDisabledKey stores the disabled state of automatic compaction,
	// so an absent/empty value means enabled (the default). "1" means disabled.
	// Mirrored by createAutoCompactGate in server/llm_caller.go.
	autoCompactDisabledKey = "auto_compact_disabled"
	// autoNameDisabledKey stores the disabled state of tab auto-naming, so an
	// absent/empty value means enabled (the default). "1" means disabled. Read
	// live by server/auto_name.go's autoNamer (gates the LLM namer) and mirrored
	// on the client by services/auto-name-setting.js (gates the new-tab rename
	// prompt vs. focusing the composer).
	autoNameDisabledKey = "auto_name_disabled"
	// autoNameInstructionKey stores an optional custom title instruction for the
	// tab auto-namer, replacing the built-in autoNameTitleInstruction. Empty ⇒ the
	// built-in one applies. The fixed data guard is appended server-side either way.
	autoNameInstructionKey = "auto_name_instruction"
	// replySuggestionsDisabledKey stores the disabled state of reply suggestions,
	// so an absent/empty value means enabled (the default). "1" means disabled.
	// Read only on the client, by services/reply-suggestions-setting.js — the
	// suggestions are generated in the browser through /api/llm/complete, so the
	// server never consults this key itself and only persists it.
	replySuggestionsDisabledKey = "reply_suggestions_disabled"
)

// ConfigAPI handles configuration-related HTTP requests. It reads the
// project path through a provider func so that runtime project switches
// transparently retarget config I/O. onCredsChanged is invoked whenever
// the credentials store has been mutated, so the server can refresh and
// broadcast the provider list.
type ConfigAPI struct {
	pathProvider     func() string
	credStore        *core.CredentialsStore
	onCredsChanged   func()
	onPluginsChanged func()
	// AutoNameDefaultPrompt is the built-in tab auto-naming system prompt, echoed
	// to the client in the config GET so the settings UI shows it verbatim as the
	// custom-instruction placeholder — the exact prompt a custom one replaces.
	// Owned by server/auto_name.go and set by the server after construction;
	// empty for handlers that don't wire it (e.g. one-shot CLI tools).
	AutoNameDefaultPrompt string
}

// NewConfigAPI creates a new ConfigAPI. pathProvider must return the current
// project path on each call (empty string indicates no-project mode, in
// which case config reads/writes return errors). onCredsChanged is called
// after every credential mutation; may be nil for handlers that don't need
// to refresh the provider list (e.g. one-shot CLI tools).
func NewConfigAPI(pathProvider func() string, onCredsChanged func(), onPluginsChanged func()) (*ConfigAPI, error) {
	if pathProvider == nil {
		return nil, fmt.Errorf("pathProvider is required")
	}
	credStore, err := core.NewCredentialsStore()
	if err != nil {
		return nil, fmt.Errorf("failed to create credentials store: %w", err)
	}
	return &ConfigAPI{
		pathProvider:     pathProvider,
		credStore:        credStore,
		onCredsChanged:   onCredsChanged,
		onPluginsChanged: onPluginsChanged,
	}, nil
}

func (c *ConfigAPI) fireCredsChanged() {
	if c.onCredsChanged != nil {
		c.onCredsChanged()
	}
}

func (c *ConfigAPI) firePluginsChanged() {
	if c.onPluginsChanged != nil {
		c.onPluginsChanged()
	}
}

// projectPath returns the current project path, or "" if none.
func (c *ConfigAPI) projectPath() string { return c.pathProvider() }

// storeDisabledFlag persists one of the "off switch" raw credentials from a
// config PUT body, if the request carried it. Each is stored as the DISABLED
// state, so an absent or empty key means enabled — which is what makes every
// one of these settings ship on without writing anything to disk.
//
// The wire value is a bool or the string "1"/""; anything else reads as false,
// so a malformed body turns a feature on rather than off. label names the
// setting in the failure log. A write failure is logged, never fatal: the rest
// of the config PUT is unrelated and still worth applying.
func (c *ConfigAPI) storeDisabledFlag(req map[string]any, key, label string) {
	v, ok := req[key]
	if !ok {
		return
	}
	disabled := false
	switch t := v.(type) {
	case bool:
		disabled = t
	case string:
		disabled = strings.TrimSpace(t) == "1"
	}
	stored := ""
	if disabled {
		stored = "1"
	}
	if err := c.credStore.SetRawKey(key, stored); err != nil {
		jlog.Error("Failed to save %s setting: %v", label, err)
	}
}

// HandleGetConfig returns the current configuration (without sensitive data)
func (c *ConfigAPI) HandleGetConfig(w http.ResponseWriter, r *http.Request) {
	// Load current config
	cfg, err := core.LoadConfig(c.projectPath())
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't load config: %v", err))
		return
	}

	// Build keys map dynamically from registered providers
	keys := make(map[string]any)
	providerInfos := provider.ListProviderInfos()
	for _, info := range providerInfos {
		keys[info.Name] = c.credStore.HasKey(info.Name)
	}

	// Return config without exposing actual API keys (just show if they're set)
	response := map[string]any{
		"model": cfg.GetModel(),
		"keys":  keys,
		// The directory the credentials file is in (XDG on Linux, ~/.juggler
		// on macOS/Windows), so the settings UI can name the real credentials
		// path instead of a hardcoded, wrong-on-Linux literal.
		"configDir": filepath.Dir(core.CredentialsPath()),
		"server": map[string]any{
			"host": cfg.Server.Host,
			"port": cfg.Server.Port,
		},
		"ollamaHost":               c.credStore.GetRawKey(ollamaHostKey),
		"llamacppHost":             c.credStore.GetRawKey(llamacppHostKey),
		"localaiHost":              c.credStore.GetRawKey(localaiHostKey),
		"lmstudioHost":             c.credStore.GetRawKey(lmstudioHostKey),
		"claudecodeBinaryPath":     c.credStore.GetRawKey(claudecodeBinaryPathKey),
		"streamIdleTimeout":        c.credStore.GetRawKey(streamIdleTimeoutKey),
		"spendLimitTokens":         c.credStore.GetRawKey(spendLimitTokensKey),
		"autoCompactDisabled":      c.credStore.GetRawKey(autoCompactDisabledKey) == "1",
		"autoNameDisabled":         c.credStore.GetRawKey(autoNameDisabledKey) == "1",
		"autoNameInstruction":      c.credStore.GetRawKey(autoNameInstructionKey),
		"autoNameDefaultPrompt":    c.AutoNameDefaultPrompt,
		"replySuggestionsDisabled": c.credStore.GetRawKey(replySuggestionsDisabledKey) == "1",
	}

	WriteSuccess(w, r, response)
}

// HandleUpdateConfig updates the configuration
func (c *ConfigAPI) HandleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	// Decode as generic map to handle dynamic provider keys
	req, ok := DecodeJSON[map[string]any](w, r)
	if !ok {
		return
	}

	// Track which providers now have keys
	providersWithKeys := []string{}

	// Get all registered providers to validate incoming keys
	providerInfos := provider.ListProviderInfos()
	configKeyToProvider := make(map[string]string)
	for _, info := range providerInfos {
		if info.ConfigKeyName == "" {
			continue
		}
		configKeyToProvider[info.ConfigKeyName] = info.Name
	}

	// Update API keys in credentials store (stored in ~/.juggler/credentials.json)
	// Process all fields that match provider config key names
	for key, value := range req {
		// Check if this key matches a provider's config key name
		if providerName, ok := configKeyToProvider[key]; ok {
			// This is a provider API key
			if apiKey, ok := value.(string); ok {
				// Empty string means delete, non-empty means save
				if err := c.credStore.SetAPIKey(providerName, apiKey); err != nil {
					WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't save %s API key: %v", providerName, err))
					return
				}
				if apiKey != "" {
					providersWithKeys = append(providersWithKeys, providerName)
				}
			}
		}
	}

	// Handle Ollama daemon host override (raw credential). Triggers a provider refresh via fireCredsChanged so the model
	// list re-fetches against the new host.
	if hostValue, ok := req[ollamaHostKey]; ok {
		if hostStr, ok := hostValue.(string); ok {
			if err := c.credStore.SetRawKey(ollamaHostKey, hostStr); err != nil {
				jlog.Error("Failed to save Ollama host: %v", err)
			}
		}
	}

	// Handle the local OpenAI-compatible server host override (raw credential),
	// same shape as the Ollama one above: fireCredsChanged refreshes the
	// provider list so the model list, and each model's context window, re-fetch
	// against the new host. The window is probed live, from whichever endpoint
	// the server there answers.
	if hostValue, ok := req[llamacppHostKey]; ok {
		if hostStr, ok := hostValue.(string); ok {
			if err := c.credStore.SetRawKey(llamacppHostKey, hostStr); err != nil {
				jlog.Error("Failed to save llama.cpp host: %v", err)
			}
		}
	}

	// Handle the LocalAI host override (raw credential). Same shape again: the
	// provider re-reads the host on the refresh fireCredsChanged triggers, so
	// the model list and the window each model reports come from the new server.
	if hostValue, ok := req[localaiHostKey]; ok {
		if hostStr, ok := hostValue.(string); ok {
			if err := c.credStore.SetRawKey(localaiHostKey, hostStr); err != nil {
				jlog.Error("Failed to save LocalAI host: %v", err)
			}
		}
	}

	// Handle the LM Studio host override (raw credential), the same shape as the
	// two above: the refresh fireCredsChanged triggers re-reads the model table,
	// and each model's loaded window, from the new server.
	if hostValue, ok := req[lmstudioHostKey]; ok {
		if hostStr, ok := hostValue.(string); ok {
			if err := c.credStore.SetRawKey(lmstudioHostKey, hostStr); err != nil {
				jlog.Error("Failed to save LM Studio host: %v", err)
			}
		}
	}

	// Handle the Claude Code CLI binary-path override (raw credential). The
	// claudecode provider reads it live, ahead of auto-detection, so a path for
	// an obscure install location takes effect on the next turn. fireCredsChanged
	// (below) refreshes the provider list. Enabling the provider is left to the
	// settings UI's toggle (the frontend flips it when a path is saved).
	if pathValue, ok := req[claudecodeBinaryPathKey]; ok {
		if pathStr, ok := pathValue.(string); ok {
			if err := c.credStore.SetRawKey(claudecodeBinaryPathKey, strings.TrimSpace(pathStr)); err != nil {
				jlog.Error("Failed to save Claude Code binary path: %v", err)
			}
		}
	}

	// Handle the global stream idle timeout (raw credential, whole seconds). The
	// streamidle resolver reads it live at each stream start, so a new value
	// takes effect on the next turn without a restart. Blank/invalid clears the
	// override (the provider watchdog falls back to its 180s default).
	if v, ok := req[streamIdleTimeoutKey]; ok {
		if s, ok := v.(string); ok {
			if err := c.credStore.SetRawKey(streamIdleTimeoutKey, strings.TrimSpace(s)); err != nil {
				jlog.Error("Failed to save stream idle timeout: %v", err)
			}
		}
	}

	// The conversation spend ceiling (raw credential, cumulative input tokens).
	// The resolver reads it live at each turn boundary, so a new value takes
	// effect on the next turn. Blank clears the override (the shipped default
	// applies); "0" switches the ceiling off.
	if v, ok := req[spendLimitTokensKey]; ok {
		if str, ok := v.(string); ok {
			if err := c.credStore.SetRawKey(spendLimitTokensKey, strings.TrimSpace(str)); err != nil {
				jlog.Error("Failed to save spend ceiling: %v", err)
			}
		}
	}

	// The global auto-compaction off switch. The gate resolver reads it live
	// (GetRawKey re-reads disk), so a toggle takes effect on the next turn
	// without a restart.
	c.storeDisabledFlag(req, autoCompactDisabledKey, "auto-compaction")

	// The global tab auto-naming off switch, same shape as the auto-compaction
	// one. autoNamer reads it live, so a toggle takes effect on the next
	// auto-name attempt without a restart.
	c.storeDisabledFlag(req, autoNameDisabledKey, "auto-naming")

	// The global reply-suggestions off switch, same shape again. Nothing
	// server-side reads it back: the suggestions are generated in the browser,
	// which mirrors this key in its own cache.
	c.storeDisabledFlag(req, replySuggestionsDisabledKey, "reply suggestions")

	// Handle the optional custom auto-name instruction (raw credential). Read
	// live by autoNamer as the first-attempt system prompt; blank clears it back
	// to the built-in prompt.
	if v, ok := req[autoNameInstructionKey]; ok {
		if s, ok := v.(string); ok {
			if err := c.credStore.SetRawKey(autoNameInstructionKey, strings.TrimSpace(s)); err != nil {
				jlog.Error("Failed to save auto-name instruction: %v", err)
			}
		}
	}

	// Update model in project config if provided
	if modelValue, ok := req["model"]; ok {
		if model, ok := modelValue.(string); ok && model != "" {
			cfg, err := core.LoadConfig(c.projectPath())
			if err != nil {
				WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't load config: %v", err))
				return
			}

			cfg.Model = model

			if err := cfg.Save(c.projectPath()); err != nil {
				WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't save config: %v", err))
				return
			}
		}
	}

	response := map[string]any{
		"message": "Configuration updated successfully",
	}

	// If keys were added, include them in response so UI can auto-select
	if len(providersWithKeys) > 0 {
		response["providersWithKeys"] = providersWithKeys
	}

	c.fireCredsChanged()
	WriteJSON(w, r, 0, response)
}

// HandleGetPluginConfig returns the ids that are switched off for this project:
// the build's defaults plus the project's own entries, minus what it switched
// back on. Callers get that one resolved answer and never see the two stored
// lists, so nothing outside this file has to know how a default is countermanded.
func (c *ConfigAPI) HandleGetPluginConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := core.LoadConfig(c.projectPath())
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't load config: %v", err))
		return
	}

	WriteJSON(w, r, 0, map[string]any{
		"disabled":    cfg.ResolvedDisabledPlugins(),
		"attribution": cfg.Plugins.Attribution,
	})
}

// HandleUpdatePluginConfig records the ids that should be switched off. The
// caller states the resolved set it wants; splitting that across the stored
// disabled/enabled lists is this server's job.
func (c *ConfigAPI) HandleUpdatePluginConfig(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Disabled    []string                          `json:"disabled"`
		Attribution map[string]core.PluginAttribution `json:"attribution"`
	}](w, r)
	if !ok {
		return
	}

	cfg, err := core.LoadConfig(c.projectPath())
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't load config: %v", err))
		return
	}

	cfg.SetResolvedDisabledPlugins(req.Disabled)
	cfg.RememberPluginAttribution(req.Attribution)

	if err := cfg.Save(c.projectPath()); err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't save config: %v", err))
		return
	}

	c.firePluginsChanged()

	WriteSuccess(w, r, nil)
}

// HandleSetProviderEnabled switches a keyless or OAuth provider on or off.
// Keyless providers are off until enabled; OAuth providers are on until
// switched off (core.CredentialsStore.IsProviderSwitchedOff).
// POST /api/config/provider-enabled
// Body: { "provider": "claudecode", "enabled": true }
func (c *ConfigAPI) HandleSetProviderEnabled(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Provider string `json:"provider"`
		Enabled  bool   `json:"enabled"`
	}](w, r)
	if !ok {
		return
	}

	if req.Provider == "" {
		WriteError(w, r, http.StatusBadRequest, "Provider name is required")
		return
	}

	// Verify provider exists and has a switch: keyless or OAuth.
	info, found := provider.GetProviderInfo(req.Provider)
	if found && info.EffectiveAuthType() != provider.AuthTypeToggle && info.EffectiveAuthType() != provider.AuthTypeOAuthBearer {
		WriteError(w, r, http.StatusBadRequest, "This provider cannot be enabled with a toggle")
		return
	}

	if !found {
		WriteError(w, r, http.StatusBadRequest, "Unknown provider")
		return
	}

	if err := c.credStore.SetProviderEnabled(req.Provider, req.Enabled); err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't update provider: %v", err))
		return
	}

	c.fireCredsChanged()
	WriteSuccess(w, r, nil)
}
