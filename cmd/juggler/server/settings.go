//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/httpx"
	"juggler/internal/jlog"
	"juggler/internal/updatecheck"
)

// settingsStore is the single-writer owner of the global settings document
// (core.GlobalSettings, ~/.juggler/settings.json). One goroutine owns the file
// and the in-memory copy; the HTTP write path and the update-checker read path
// both go through its request channel, so they are serialised without a mutex —
// mirroring workspaceStore's pattern. The proprietary updater overlay reads the
// same file directly from its own process (read-only), so there is no shared
// state to coordinate across processes.
type settingsStore struct {
	reqs chan func(*core.GlobalSettings) *core.GlobalSettings
}

// newSettingsStore seeds from disk (tolerant of a missing/corrupt file) and
// starts the owner goroutine.
func newSettingsStore() *settingsStore {
	s := &settingsStore{reqs: make(chan func(*core.GlobalSettings) *core.GlobalSettings)}
	go func() {
		cur, err := core.LoadGlobalSettings()
		if err != nil {
			jlog.Info("settings: load failed, using defaults: %v", err)
		}
		for fn := range s.reqs {
			if next := fn(cur); next != nil {
				cur = next
			}
		}
	}()
	return s
}

// get returns a copy of the current settings.
func (s *settingsStore) get() core.GlobalSettings {
	resp := make(chan core.GlobalSettings, 1)
	s.reqs <- func(cur *core.GlobalSettings) *core.GlobalSettings {
		resp <- *cur
		return nil
	}
	return <-resp
}

// set persists next and, on a successful save, adopts it as the in-memory copy.
// A save failure leaves the in-memory state unchanged and returns the error.
func (s *settingsStore) set(next core.GlobalSettings) error {
	resp := make(chan error, 1)
	s.reqs <- func(cur *core.GlobalSettings) *core.GlobalSettings {
		// Merge onto the document as it stands on disk rather than replacing it:
		// another project's server may have written since this one loaded, and
		// the four sections below are the whole of what the API owns.
		stored, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
			gs.Updates.Mode = next.Updates.Mode
			gs.Connectivity = next.Connectivity
			gs.Network = next.Network
			gs.Models = next.Models
			return true
		})
		if err != nil {
			resp <- err
			return nil // keep the old in-memory state on a failed write
		}
		resp <- nil
		return stored
	}
	return <-resp
}

// updateMode returns the effective, normalised update mode. Defaults to
// automatic when the settings store isn't wired (e.g. a bare test Server).
func (s *Server) updateMode() string {
	if s.settings == nil {
		return core.UpdateModeAutomatic
	}
	return core.NormalizeUpdateMode(s.settings.get().Updates.Mode)
}

// handleGetSettings returns the whole global settings document.
func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	gs := core.GlobalSettings{Updates: core.UpdateSettings{Mode: core.UpdateModeAutomatic}}
	if s.settings != nil {
		gs = s.settings.get()
	}
	gs.Updates.Mode = core.NormalizeUpdateMode(gs.Updates.Mode)
	gs.Network.Proxy.Mode = core.NormalizeProxyMode(gs.Network.Proxy.Mode)
	handlers.WriteJSON(w, r, 0, gs)
}

// validProxyURL reports whether raw is a usable proxy URL (non-empty, parseable,
// with a host). Mirrors the manual-mode acceptance in internal/httpx so the API
// rejects a URL the resolver would silently drop to direct.
func validProxyURL(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.Host != ""
}

// cloneHiddenModels deep-copies a hidden-model map, so the copy can be mutated
// without touching the settings the store still owns.
func cloneHiddenModels(in map[string][]string) map[string][]string {
	if in == nil {
		return nil
	}
	out := make(map[string][]string, len(in))
	for providerName, ids := range in {
		out[providerName] = slices.Clone(ids)
	}
	return out
}

// sameHiddenModels reports whether two hidden-model maps describe the same set.
// Both come from normalised documents, so the lists are already sorted and
// de-duplicated and a plain element-wise comparison is exact.
func sameHiddenModels(a, b map[string][]string) bool {
	if len(a) != len(b) {
		return false
	}
	for providerName, ids := range a {
		if !slices.Equal(ids, b[providerName]) {
			return false
		}
	}
	return true
}

// handlePutSettings validates and persists the posted settings. An unknown
// update mode is rejected with 400 and the file is left unchanged. Flipping the
// update mode off→on kicks an immediate check so the UI reflects availability
// without waiting for the next scheduled poll.
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	if s.settings == nil {
		handlers.WriteError(w, r, http.StatusServiceUnavailable, "settings unavailable")
		return
	}
	// Seed the decode target from the current document so a partial PUT (e.g. the
	// Updates tab sending only {updates:{mode}}, or the Connectivity tab sending
	// only {connectivity:{...}}) merges into the existing settings rather than
	// zeroing the sections it omits. Absent JSON keys keep their current values.
	//
	// The same seeding gives models.hidden add-only merge semantics: unmarshalling
	// an object into an existing non-nil map ADDS and replaces keys but never
	// deletes the ones the body omits. So a client un-hiding a provider's last
	// model must send that provider an explicit empty array — omitting the key
	// leaves the old list in place. (normalizeModelSettings then drops the empty
	// entry, so nothing accumulates on disk.)
	incoming := s.settings.get()
	// get() copies the struct but not the map inside it, and the merge above
	// writes into that map in place — so without this clone a decode would reach
	// straight into the stored settings, and a request rejected below (or one
	// whose save fails) would leave its changes behind in memory anyway.
	incoming.Models.Hidden = cloneHiddenModels(incoming.Models.Hidden)
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&incoming); err != nil {
		handlers.WriteError(w, r, http.StatusBadRequest, "invalid JSON body")
		return
	}
	// A non-empty mode must be one we recognise; empty normalises to automatic.
	if incoming.Updates.Mode != "" && !core.IsKnownUpdateMode(incoming.Updates.Mode) {
		handlers.WriteError(w, r, http.StatusBadRequest, "invalid update mode")
		return
	}
	// A non-empty wanOnLaunch must name a registered tunnel mode; "" means none.
	if incoming.Connectivity.WANOnLaunch != "" && !isRegisteredTunnelMode(incoming.Connectivity.WANOnLaunch) {
		handlers.WriteError(w, r, http.StatusBadRequest, "invalid WAN launch mode")
		return
	}
	// A non-empty proxy mode must be recognised; manual mode needs a usable URL.
	if incoming.Network.Proxy.Mode != "" && !core.IsKnownProxyMode(incoming.Network.Proxy.Mode) {
		handlers.WriteError(w, r, http.StatusBadRequest, "invalid proxy mode")
		return
	}
	if incoming.Network.Proxy.Mode == core.ProxyModeManual && !validProxyURL(incoming.Network.Proxy.URL) {
		handlers.WriteError(w, r, http.StatusBadRequest, "invalid proxy URL")
		return
	}
	// Every hidden-model list must name a provider this build registers, so a
	// typo'd or hand-posted key can't sit in the file hiding nothing.
	for providerName := range incoming.Models.Hidden {
		if _, ok := provider.GetProviderInfo(providerName); !ok {
			handlers.WriteError(w, r, http.StatusBadRequest, "unknown provider in hidden models: "+providerName)
			return
		}
	}
	prevMode := s.updateMode()
	prevHidden := s.settings.get().Models.Hidden
	incoming.Updates.Mode = core.NormalizeUpdateMode(incoming.Updates.Mode)
	incoming.Network.Proxy.Mode = core.NormalizeProxyMode(incoming.Network.Proxy.Mode)
	if err := s.settings.set(incoming); err != nil {
		jlog.Error("settings: save failed: %v", err)
		handlers.WriteError(w, r, http.StatusInternalServerError, "failed to save settings")
		return
	}
	// Read back the stored document: the save normalises the hidden-model lists
	// (trimming, de-duping, dropping emptied providers), so this is what the
	// client should see and what the comparison below must be made against.
	incoming = s.settings.get()
	// Hidden models change what the model menu offers and what the default and
	// cheap-model resolvers may pick, so republish the provider list instead of
	// leaving the change invisible until something else triggers a refresh.
	if !sameHiddenModels(prevHidden, incoming.Models.Hidden) {
		s.RefreshProviders()
	}
	// Apply the proxy policy live so a change takes effect without a restart; the
	// atomic resolver makes already-built clients pick it up on their next request.
	httpx.SetConfig(httpx.Config{Mode: incoming.Network.Proxy.Mode, URL: incoming.Network.Proxy.URL})
	if prevMode == core.UpdateModeOff && incoming.Updates.Mode != core.UpdateModeOff {
		s.kickUpdateCheck()
	}
	handlers.WriteJSON(w, r, 0, incoming)
}

// manualCheckResponse is the update-status fresh from a manual check, with an
// optional error field when the network fetch failed (the status is then the
// last-good one).
type manualCheckResponse struct {
	updatecheck.Status
	Error string `json:"error,omitempty"`
}

// handleManualUpdateCheck runs an explicit "Check for updates" that bypasses the
// automatic-off gate. It never runs in test mode (the suite must not reach the
// network) — there it just returns the seeded status. A network failure returns
// the last-good status plus an error field so the page can report it without a
// crash.
func (s *Server) handleManualUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if s.updateChecker == nil {
		handlers.WriteJSON(w, r, 0, updatecheck.Status{CurrentVersion: core.Version})
		return
	}
	if s.testMode {
		handlers.WriteJSON(w, r, 0, s.updateChecker.Current())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.updateChecker.CheckNow(ctx); err != nil {
		jlog.Info("updatecheck: manual check failed: %v", err)
		handlers.WriteJSON(w, r, 0, manualCheckResponse{
			Status: s.updateChecker.Current(),
			Error:  "couldn't reach the update server",
		})
		return
	}
	handlers.WriteJSON(w, r, 0, s.updateChecker.Current())
}

// kickUpdateCheck runs a single scheduled-style check in the background (used
// when the mode flips off→on). It respects the gate — which is now on — and is
// a no-op in test mode.
func (s *Server) kickUpdateCheck() {
	if s.updateChecker == nil || s.testMode {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.updateChecker.CheckOnce(ctx); err != nil {
			jlog.Info("updatecheck: kick after mode change failed: %v", err)
		}
	}()
}
