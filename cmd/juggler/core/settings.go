//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"juggler/internal/userpaths"
)

// GlobalSettings is the user's global (not per-project) preference document,
// stored at <ConfigDir>/settings.json (~/.juggler/settings.json on macOS/Win,
// $XDG_CONFIG_HOME/juggler/settings.json on Linux). It is distinct from the
// per-project .juggler/config.json (Config): this file holds preferences that
// apply to the user across every project. Built to grow — add new sections as
// sibling fields; unknown keys are ignored on read, so the format is additive.
type GlobalSettings struct {
	Updates      UpdateSettings       `json:"updates"`
	Connectivity ConnectivitySettings `json:"connectivity"`
	Network      NetworkSettings      `json:"network"`
}

// NetworkSettings holds outbound-HTTP preferences. Unlike Connectivity (applied
// only on a GUI launch), these apply on every launch — terminal included — and
// at runtime, so a proxy change takes effect without a restart. Additive; like
// GlobalSettings, unknown keys are tolerated on read.
type NetworkSettings struct {
	Proxy ProxySettings `json:"proxy"`
}

// ProxySettings selects how outbound requests reach the network.
type ProxySettings struct {
	// Mode is one of ProxyModeSystem / ProxyModeNone / ProxyModeManual. An
	// empty value normalises to system (the shipped default), so an absent file
	// or an untouched setting honours the OS/env proxy and degrades to direct.
	Mode string `json:"mode,omitempty"`
	// URL is the proxy used when Mode == ProxyModeManual, e.g.
	// "http://127.0.0.1:7890" or "socks5://host:port". Ignored in other modes.
	URL string `json:"url,omitempty"`
}

// ConnectivitySettings holds launch-time connectivity preferences. They are
// applied only on a GUI/desktop-app launch (no controlling terminal); a
// terminal launch controls connectivity through CLI flags instead, so the saved
// toggles never interfere there. Additive — like GlobalSettings, unknown keys
// are tolerated on read.
type ConnectivitySettings struct {
	// LANOnLaunch starts LAN access at launch when true.
	LANOnLaunch bool `json:"lanOnLaunch,omitempty"`
	// WANOnLaunch names the tunnel-mode id to start at launch, or "" for none.
	// Only one WAN tunnel can ever be active, so this is a single selection
	// rather than a per-mode toggle. The core does not enumerate which modes
	// exist — the id is validated against the live TunnelModes() registry when
	// used, and an unknown/unavailable id simply means "no WAN on launch".
	WANOnLaunch string `json:"wanOnLaunch,omitempty"`
}

// UpdateSettings controls how the app looks for and applies new versions.
type UpdateSettings struct {
	// Mode is one of UpdateModeAutomatic / UpdateModeNotify / UpdateModeOff.
	// An empty value normalises to automatic (the shipped default), so an
	// absent file or an untouched setting behaves exactly as before.
	Mode string `json:"mode,omitempty"`
}

// Update-mode values persisted in UpdateSettings.Mode.
const (
	// UpdateModeAutomatic checks on a schedule and auto-downloads (default).
	UpdateModeAutomatic = "automatic"
	// UpdateModeNotify checks on a schedule and surfaces an "Update"
	// affordance, but never auto-downloads — the user starts the download.
	UpdateModeNotify = "notify"
	// UpdateModeOff disables automatic checking entirely; an explicit manual
	// "Check for updates" still runs on demand.
	UpdateModeOff = "off"
)

// Proxy-mode values persisted in ProxySettings.Mode. They match the string
// constants in internal/httpx (httpx.Mode*), so the saved mode passes straight
// through to httpx.SetConfig.
const (
	// ProxyModeSystem honours the proxy env vars and the OS system proxy,
	// degrading to direct when neither is set (default).
	ProxyModeSystem = "system"
	// ProxyModeNone forces every request direct.
	ProxyModeNone = "none"
	// ProxyModeManual routes through ProxySettings.URL.
	ProxyModeManual = "manual"
)

// NormalizeProxyMode maps any value to a known proxy mode, defaulting anything
// unrecognised (including "") to system. Use this on read and before comparing.
func NormalizeProxyMode(mode string) string {
	switch mode {
	case ProxyModeNone:
		return ProxyModeNone
	case ProxyModeManual:
		return ProxyModeManual
	default:
		return ProxyModeSystem
	}
}

// IsKnownProxyMode reports whether mode is one of the three recognised values.
// The API validator uses this to reject a hand-posted or typo'd mode; the empty
// string is NOT known (callers that accept "as default" check for "" first).
func IsKnownProxyMode(mode string) bool {
	return mode == ProxyModeSystem || mode == ProxyModeNone || mode == ProxyModeManual
}

// NormalizeUpdateMode maps any value to a known mode, defaulting anything
// unrecognised (including the empty string) to automatic. Use this on read and
// before comparing modes, so callers never have to special-case "".
func NormalizeUpdateMode(mode string) string {
	switch mode {
	case UpdateModeNotify:
		return UpdateModeNotify
	case UpdateModeOff:
		return UpdateModeOff
	default:
		return UpdateModeAutomatic
	}
}

// IsKnownUpdateMode reports whether mode is one of the three recognised values.
// The API validator uses this to reject a hand-posted or typo'd mode; the empty
// string is NOT known (callers that accept "as default" check for "" first).
func IsKnownUpdateMode(mode string) bool {
	return mode == UpdateModeAutomatic || mode == UpdateModeNotify || mode == UpdateModeOff
}

// defaultGlobalSettings returns the settings a fresh install (no file) uses.
func defaultGlobalSettings() *GlobalSettings {
	return &GlobalSettings{
		Updates: UpdateSettings{Mode: UpdateModeAutomatic},
		Network: NetworkSettings{Proxy: ProxySettings{Mode: ProxyModeSystem}},
	}
}

// globalSettingsPath is the on-disk location of the settings document.
func globalSettingsPath() string {
	return filepath.Join(userpaths.ConfigDir(), "settings.json")
}

// LoadGlobalSettings reads the global settings, tolerating a missing or corrupt
// file by returning defaults (a hand-edit typo must never brick startup). The
// returned pointer is always non-nil and fully normalised, so callers can use
// it even when a non-nil error is also returned (missing file returns nil
// error; a real read/parse failure returns defaults plus the error for logging).
func LoadGlobalSettings() (*GlobalSettings, error) {
	data, err := os.ReadFile(globalSettingsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return defaultGlobalSettings(), nil
		}
		return defaultGlobalSettings(), fmt.Errorf("failed to read settings: %w", err)
	}
	gs := defaultGlobalSettings()
	if err := json.Unmarshal(data, gs); err != nil {
		// Corrupt file: fall back to clean defaults but report what happened.
		return defaultGlobalSettings(), fmt.Errorf("failed to parse settings: %w", err)
	}
	gs.Updates.Mode = NormalizeUpdateMode(gs.Updates.Mode)
	gs.Network.Proxy.Mode = NormalizeProxyMode(gs.Network.Proxy.Mode)
	return gs, nil
}

// SaveGlobalSettings writes gs as indented JSON (0644), creating the config
// directory if needed. The mode is normalised before writing so the file always
// holds a canonical value.
func SaveGlobalSettings(gs *GlobalSettings) error {
	if gs == nil {
		gs = defaultGlobalSettings()
	}
	gs.Updates.Mode = NormalizeUpdateMode(gs.Updates.Mode)
	gs.Network.Proxy.Mode = NormalizeProxyMode(gs.Network.Proxy.Mode)

	dir := userpaths.ConfigDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}
	data, err := json.MarshalIndent(gs, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal settings: %w", err)
	}
	if err := os.WriteFile(globalSettingsPath(), data, 0o644); err != nil {
		return fmt.Errorf("failed to write settings: %w", err)
	}
	return nil
}
