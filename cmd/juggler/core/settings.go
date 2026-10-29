//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gofrs/flock"

	"juggler/cmd/juggler/extmanifest"
	"juggler/internal/jlog"
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
	Models       ModelSettings        `json:"models"`

	// UILocale is the language the UI is shown in, as a BCP 47 tag ("fr",
	// "zh-Hant-TW", or the pseudo-locale "en-XA"), or "" for the default,
	// English. A typed field rather than one of the opaque UI preferences below
	// because the server reads it: it is written into the page before first
	// paint, along with that language's catalogue.
	UILocale string `json:"uiLocale,omitempty"`

	// UI holds the viewer preferences that belong to the person rather than to
	// a project or a window — the tips they have seen, what Escape does,
	// whether the bell rings. Stored verbatim and opaquely, like the other UI
	// realms (see ui_prefs.go): the client owns the keys and their shapes, and
	// nothing in Go reads one. Putting them here rather than in a project's
	// session is what stops every new project re-teaching every tip.
	UI map[string]json.RawMessage `json:"ui,omitempty"`
}

// ModelSettings holds preferences about which models the user wants to see.
// Additive; like GlobalSettings, unknown keys are tolerated on read.
type ModelSettings struct {
	// Hidden lists, per provider name, the model ids the user has turned off.
	// It is a deny-list on purpose: a provider that publishes a new model shows
	// it immediately, and only what the user explicitly hid stays hidden — the
	// alternative (an allow-list) would silently swallow every future model.
	//
	// Keyed by provider rather than flattened to "provider/model" strings
	// because model ids contain slashes of their own (OpenRouter's
	// "z-ai/glm-4.6"), so a flat key could not be split back apart reliably.
	Hidden map[string][]string `json:"hidden,omitempty"`

	// Limits overrides the token limits Juggler assumes for a model, keyed by
	// provider name and then by model id. Only what the user set is stored; a
	// model with no entry uses whatever its provider reports or Juggler has
	// catalogued, which is right almost always and is always preferred.
	//
	// It exists because a wrong window is not cosmetic: it decides admission and
	// when a conversation compacts, so a model catalogued at 128k that really
	// serves 1M compacts eight times sooner than it needs to, and the user has
	// no other way to correct it without waiting for a build carrying a new
	// table. It applies to every provider, not just custom endpoints — the
	// models found wrong in practice are usually built-in ones whose published
	// window moved.
	//
	// Keyed by provider then model for the same reason Hidden is: model ids
	// contain slashes of their own.
	Limits map[string]map[string]ModelLimits `json:"limits,omitempty"`
}

// ModelLimits is a user-supplied replacement for a model's token limits. The
// two fields are independent — a non-positive one means "not overridden" and
// leaves that limit to the provider, so a user can correct a wrong context
// window without also having to state an output cap.
type ModelLimits struct {
	ContextWindow   int `json:"contextWindow,omitempty"`
	MaxOutputTokens int `json:"maxOutputTokens,omitempty"`
}

// IsZero reports whether this override carries nothing worth storing.
func (ml ModelLimits) IsZero() bool {
	return ml.ContextWindow <= 0 && ml.MaxOutputTokens <= 0
}

// ModelLimitsFor returns the user's limit overrides for one provider/model pair.
// The zero value means nothing was overridden, so callers can apply the result
// unconditionally and let the non-positive fields fall through.
func (gs *GlobalSettings) ModelLimitsFor(providerName, modelID string) ModelLimits {
	return gs.Models.Limits[providerName][modelID]
}

// IsModelHidden reports whether the user turned this model off. Lists are small
// (a provider's whole catalogue is a few hundred at most, and the hidden subset
// far fewer), so a linear scan beats maintaining a parallel index.
func (gs *GlobalSettings) IsModelHidden(providerName, modelID string) bool {
	for _, id := range gs.Models.Hidden[providerName] {
		if id == modelID {
			return true
		}
	}
	return false
}

// normalizeModelSettings canonicalises every section of the model preferences.
// Applied on read and on write, so a hand-edited file behaves exactly like one
// the UI wrote, and the file stays diff-friendly.
//
// Provider names are NOT validated here: core has no view of the provider
// registry, and a provider being temporarily unregistered (a build without it,
// a key removed) must not destroy the preferences the user curated for it.
func normalizeModelSettings(ms *ModelSettings) {
	normalizeHiddenModels(ms)
	normalizeModelLimits(ms)
}

// normalizeHiddenModels canonicalises the hidden-model lists: ids are trimmed,
// blanks and duplicates dropped, each list sorted, and any provider left with no
// ids removed entirely.
func normalizeHiddenModels(ms *ModelSettings) {
	for providerName, ids := range ms.Hidden {
		seen := make(map[string]struct{}, len(ids))
		cleaned := make([]string, 0, len(ids))
		for _, id := range ids {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			if _, dup := seen[id]; dup {
				continue
			}
			seen[id] = struct{}{}
			cleaned = append(cleaned, id)
		}
		if len(cleaned) == 0 {
			delete(ms.Hidden, providerName)
			continue
		}
		sort.Strings(cleaned)
		ms.Hidden[providerName] = cleaned
	}
	if len(ms.Hidden) == 0 {
		ms.Hidden = nil
	}
}

// normalizeModelLimits canonicalises the per-model limit overrides: model ids
// are trimmed, negative values flattened to zero ("not overridden"), entries
// left carrying no value dropped, and any provider left with no entries removed
// entirely. A zero is stored as an absence rather than a number, so clearing a
// field in the UI and never having set it are the same state on disk.
func normalizeModelLimits(ms *ModelSettings) {
	for providerName, byModel := range ms.Limits {
		cleaned := make(map[string]ModelLimits, len(byModel))
		for modelID, limits := range byModel {
			modelID = strings.TrimSpace(modelID)
			if modelID == "" {
				continue
			}
			limits.ContextWindow = max(limits.ContextWindow, 0)
			limits.MaxOutputTokens = max(limits.MaxOutputTokens, 0)
			if limits.IsZero() {
				continue
			}
			cleaned[modelID] = limits
		}
		if len(cleaned) == 0 {
			delete(ms.Limits, providerName)
			continue
		}
		ms.Limits[providerName] = cleaned
	}
	if len(ms.Limits) == 0 {
		ms.Limits = nil
	}
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

// ConnectivitySettings holds the machine server's start-time connectivity
// preferences, each read once when it starts. Additive — like GlobalSettings,
// unknown keys are tolerated on read.
type ConnectivitySettings struct {
	// AllowedHosts are extra Host names a server accepts on top of the names
	// that always identify this machine — the name a reverse proxy on this
	// machine (tailscale serve, caddy) publishes it under. Applied on every
	// launch, terminal included, together with any --allow-host flags, and read
	// once at startup, so a change takes effect on the next start. See
	// ResolveAllowedHosts.
	AllowedHosts []string `json:"allowedHosts,omitempty"`
	// LANOnLaunch turns the machine server's LAN access on at every start,
	// beside serve --lan. Under --test it is not read.
	LANOnLaunch bool `json:"lanOnLaunch,omitempty"`
	// WANOnLaunch is the tunnel mode the machine server opens at every start,
	// or "" for none; --tunnel names one over it. One tunnel runs at a time,
	// so it is one choice, not a switch per mode. A mode this build lacks, or
	// that cannot start on this machine, opens nothing and stays saved, so it
	// comes back with the mode. Under --test it is not read.
	WANOnLaunch string `json:"wanOnLaunch,omitempty"`
}

// UpdateSettings controls how the app looks for and applies new versions.
type UpdateSettings struct {
	// Mode is one of UpdateModeAutomatic / UpdateModeNotify / UpdateModeOff.
	// An empty value normalises to automatic (the shipped default), so an
	// absent file or an untouched setting behaves exactly as before.
	Mode string `json:"mode,omitempty"`
	// Bookkeeping for the update check: the UTC day ("2006-01-02") and month
	// ("2006-01") it last reported on. Server-owned — the settings API never
	// posts these, and nothing outside the update check reads them.
	LastCountedDay   string `json:"lastCountedDay,omitempty"`
	LastCountedMonth string `json:"lastCountedMonth,omitempty"`
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

// IsValidUILocale reports whether locale is a usable UI language tag, in any
// letter case — the check extension catalogue names pass too
// (extmanifest.IsLocaleTag), since a catalogue is found by the UI language.
// The empty string is NOT valid here (callers that accept "default" check for
// "" first).
func IsValidUILocale(locale string) bool {
	return extmanifest.IsLocaleTag(locale)
}

// NormalizeUILocale returns locale with canonical case and aliases ("iw" →
// "he") if it is a usable tag and "" otherwise, so a hand-edited typo
// falls back to English instead of reaching the page.
func NormalizeUILocale(locale string) string {
	return extmanifest.CanonicalLocaleTag(locale)
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

// GlobalSettingsPath is the on-disk location of the settings document, for a
// caller that must watch the file rather than read it through this package.
func GlobalSettingsPath() string { return globalSettingsPath() }

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
	gs.UILocale = NormalizeUILocale(gs.UILocale)
	normalizeModelSettings(&gs.Models)
	return gs, nil
}

// settingsLockPath is the cross-process lock guarding writes to the settings
// document. Reads are unlocked: a write lands by rename, so a reader sees
// either the whole old document or the whole new one, never a mix.
func settingsLockPath() string {
	return filepath.Join(userpaths.ConfigDir(), "settings.lock")
}

// settingsLockTimeout bounds the wait for the settings lock. Writes are short
// and rare, so reaching this means a stuck holder rather than contention; the
// caller reports the failure instead of blocking a poll loop indefinitely.
const settingsLockTimeout = 5 * time.Second

// withSettingsLock runs fn holding an exclusive lock on the settings document.
func withSettingsLock(fn func() error) error {
	return withFileLock(settingsLockPath(), "settings", fn)
}

// withFileLock runs fn holding an exclusive lock on lockPath.
//
// A machine runs one juggler server per open project, so "load, change one field,
// write it back" on a file in the shared config directory is genuinely concurrent
// ACROSS PROCESSES and has to be serialised or one writer silently reverts
// another. An in-process lock cannot see the other servers; this can.
//
// `what` names the thing being locked, for the error a caller shows and the log
// line a failed release leaves.
func withFileLock(lockPath, what string, fn func() error) error {
	dir := userpaths.ConfigDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}
	l := flock.New(lockPath)
	ctx, cancel := context.WithTimeout(context.Background(), settingsLockTimeout)
	defer cancel()
	locked, err := l.TryLockContext(ctx, 20*time.Millisecond)
	if err != nil {
		return fmt.Errorf("failed to lock %s: %w", what, err)
	}
	if !locked {
		return fmt.Errorf("timed out waiting for the %s lock", what)
	}
	defer func() {
		if err := l.Unlock(); err != nil {
			jlog.Error("[%s] failed to release the %s lock: %v", what, what, err)
		}
	}()
	return fn()
}

// writeSettings normalises and writes gs. It must be called with the settings
// lock held. The write goes to a temp file in the same directory and is renamed
// into place, so an interrupted write leaves the previous document intact
// rather than a truncated one that would reset every preference to its default.
func writeSettings(gs *GlobalSettings) error {
	gs.Updates.Mode = NormalizeUpdateMode(gs.Updates.Mode)
	gs.Network.Proxy.Mode = NormalizeProxyMode(gs.Network.Proxy.Mode)
	gs.UILocale = NormalizeUILocale(gs.UILocale)
	normalizeModelSettings(&gs.Models)

	data, err := json.MarshalIndent(gs, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal settings: %w", err)
	}

	dir := userpaths.ConfigDir()
	tmp, err := os.CreateTemp(dir, "settings-*.json.tmp")
	if err != nil {
		return fmt.Errorf("failed to write settings: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }() // no-op once the rename succeeds

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("failed to write settings: %w", err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("failed to write settings: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to write settings: %w", err)
	}
	if err := os.Rename(tmpPath, globalSettingsPath()); err != nil {
		return fmt.Errorf("failed to write settings: %w", err)
	}
	return nil
}

// UpdateGlobalSettings applies mutate to the settings document and saves the
// result, all under the settings lock. mutate is handed the document as it is
// on disk right now — never a copy the caller has been holding — and reports
// whether it changed anything; false skips the write. The stored document is
// returned either way.
//
// This is how anything long-running should change a setting. A machine runs one
// juggler server per open project, so two of them writing whole documents from
// their own copies will silently revert each other: change the proxy in one
// window and hide a model in another, and whichever saves last wins outright.
func UpdateGlobalSettings(mutate func(*GlobalSettings) bool) (*GlobalSettings, error) {
	var gs *GlobalSettings
	err := withSettingsLock(func() error {
		var err error
		if gs, err = LoadGlobalSettings(); err != nil {
			// Defaults, matching LoadGlobalSettings' documented tolerance: a
			// hand-edit typo must not wedge every later write.
			jlog.Info("settings: reading before update: %v", err)
		}
		if !mutate(gs) {
			return nil
		}
		return writeSettings(gs)
	})
	return gs, err
}
