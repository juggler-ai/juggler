//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"juggler/cmd/juggler/core"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/internal/jlog"
)

// Raw credentials.json keys for non-API-key settings persisted via /api/config.
// Kept in sync with the producing packages (e.g. ollama.HostCredKey,
// claudecode.BinaryPathCredKey) — the frontend posts these literal names.
const (
	ollamaHostKey              = "ollama_host"
	llamacppHostKey            = "llamacpp_host"
	claudecodeBinaryPathKey    = "claudecode_binary_path"
	openaiCompatibleBaseURLKey = "openai_compatible_base_url"
	openaiCompatibleHeadersKey = "openai_compatible_headers"
	streamIdleTimeoutKey       = "stream_idle_timeout" // mirrors streamidle.CredKey
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

// HandleGetConfig returns the current configuration (without sensitive data)
func (c *ConfigAPI) HandleGetConfig(w http.ResponseWriter, r *http.Request) {
	// Load current config
	cfg, err := core.LoadConfig(c.projectPath())
	if err != nil {
		WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   fmt.Sprintf("Failed to load config: %v", err),
		})
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
		"server": map[string]any{
			"host": cfg.Server.Host,
			"port": cfg.Server.Port,
		},
		"ollamaHost":              c.credStore.GetRawKey(ollamaHostKey),
		"llamacppHost":            c.credStore.GetRawKey(llamacppHostKey),
		"claudecodeBinaryPath":    c.credStore.GetRawKey(claudecodeBinaryPathKey),
		"openaiCompatibleBaseURL": c.credStore.GetRawKey(openaiCompatibleBaseURLKey),
		"openaiCompatibleHeaders": c.credStore.GetRawKey(openaiCompatibleHeadersKey),
		"streamIdleTimeout":       c.credStore.GetRawKey(streamIdleTimeoutKey),
	}

	WriteJSON(w, r, 0, response)
}

// HandleUpdateConfig updates the configuration
func (c *ConfigAPI) HandleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	// Decode as generic map to handle dynamic provider keys
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "Invalid request body",
		})
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
					WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
						"success": false,
						"error":   fmt.Sprintf("Failed to save %s API key: %v", providerName, err),
					})
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

	// Handle the llama-server host override (raw credential), same shape as the
	// Ollama one above: fireCredsChanged refreshes the provider list so the
	// model list (and its context window, queried live from /props) re-fetches
	// against the new host.
	if hostValue, ok := req[llamacppHostKey]; ok {
		if hostStr, ok := hostValue.(string); ok {
			if err := c.credStore.SetRawKey(llamacppHostKey, hostStr); err != nil {
				jlog.Error("Failed to save llama.cpp host: %v", err)
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

	// Handle the OpenAI-compatible gateway base URL and custom headers (raw
	// credentials). The openaicompat provider reads both live at client
	// construction; fireCredsChanged (below) refreshes the provider list so the
	// model catalogue re-fetches against the new gateway.
	if v, ok := req[openaiCompatibleBaseURLKey]; ok {
		if s, ok := v.(string); ok {
			if err := c.credStore.SetRawKey(openaiCompatibleBaseURLKey, strings.TrimSpace(s)); err != nil {
				jlog.Error("Failed to save OpenAI-compatible base URL: %v", err)
			}
		}
	}
	if v, ok := req[openaiCompatibleHeadersKey]; ok {
		if s, ok := v.(string); ok {
			if err := c.credStore.SetRawKey(openaiCompatibleHeadersKey, strings.TrimSpace(s)); err != nil {
				jlog.Error("Failed to save OpenAI-compatible headers: %v", err)
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

	// Update model in project config if provided
	if modelValue, ok := req["model"]; ok {
		if model, ok := modelValue.(string); ok && model != "" {
			cfg, err := core.LoadConfig(c.projectPath())
			if err != nil {
				WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
					"success": false,
					"error":   fmt.Sprintf("Failed to load config: %v", err),
				})
				return
			}

			cfg.Model = model

			if err := cfg.Save(c.projectPath()); err != nil {
				WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
					"success": false,
					"error":   fmt.Sprintf("Failed to save config: %v", err),
				})
				return
			}
		}
	}

	response := map[string]any{
		"success": true,
		"message": "Configuration updated successfully",
	}

	// If keys were added, include them in response so UI can auto-select
	if len(providersWithKeys) > 0 {
		response["providersWithKeys"] = providersWithKeys
	}

	c.fireCredsChanged()
	WriteJSON(w, r, 0, response)
}

// HandleGetPluginConfig returns the resolved plugin disabled/enabled lists
func (c *ConfigAPI) HandleGetPluginConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := core.LoadConfig(c.projectPath())
	if err != nil {
		WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
			"error": fmt.Sprintf("Failed to load config: %v", err),
		})
		return
	}

	WriteJSON(w, r, 0, map[string]any{
		"disabled": cfg.GetDisabledPlugins(),
		"enabled":  cfg.GetEnabledPlugins(),
	})
}

// HandleUpdatePluginConfig updates the plugin disabled/enabled lists
func (c *ConfigAPI) HandleUpdatePluginConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Disabled []string `json:"disabled"`
		Enabled  []string `json:"enabled"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "Invalid request body",
		})
		return
	}

	cfg, err := core.LoadConfig(c.projectPath())
	if err != nil {
		WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   fmt.Sprintf("Failed to load config: %v", err),
		})
		return
	}

	cfg.Plugins.Disabled = req.Disabled
	cfg.Plugins.Enabled = req.Enabled

	if err := cfg.Save(c.projectPath()); err != nil {
		WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   fmt.Sprintf("Failed to save config: %v", err),
		})
		return
	}

	c.firePluginsChanged()

	WriteJSON(w, r, 0, map[string]any{
		"success": true,
	})
}

// HandleSetProviderEnabled enables or disables a keyless provider
// POST /api/config/provider-enabled
// Body: { "provider": "claudecode", "enabled": true }
func (c *ConfigAPI) HandleSetProviderEnabled(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
		Enabled  bool   `json:"enabled"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "Invalid request body",
		})
		return
	}

	if req.Provider == "" {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "Provider name is required",
		})
		return
	}

	// Verify provider exists and is a toggle-style keyless provider.
	info, found := provider.GetProviderInfo(req.Provider)
	if found && info.EffectiveAuthType() != provider.AuthTypeToggle {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "This provider cannot be enabled with a toggle",
		})
		return
	}

	if !found {
		WriteJSON(w, r, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "Unknown provider",
		})
		return
	}

	if err := c.credStore.SetProviderEnabled(req.Provider, req.Enabled); err != nil {
		WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   fmt.Sprintf("Failed to update provider: %v", err),
		})
		return
	}

	c.fireCredsChanged()
	WriteJSON(w, r, 0, map[string]any{
		"success": true,
	})
}
