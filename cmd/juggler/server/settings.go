//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/hostcheck"
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
//
// The read happens here rather than inside the goroutine so that the store a
// caller is handed has already loaded. Seeding asynchronously left a window in
// which the file could be written after construction but before the load, and the
// store would then seed with the newer document and report no change when asked to
// adopt it — an ordering nobody could see from the outside, since every other
// request blocks until the goroutine is in its loop anyway.
func newSettingsStore() *settingsStore {
	s := &settingsStore{reqs: make(chan func(*core.GlobalSettings) *core.GlobalSettings)}
	cur, err := core.LoadGlobalSettings()
	if err != nil {
		jlog.Info("settings: load failed, using defaults: %v", err)
	}
	go func() {
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
//
// uiPrefs is the UI section's patch rather than its whole value, and is applied
// against the document on disk: these preferences are shared by every project's
// server, so two of them writing different keys at once would otherwise have the
// second replace the first's whole map. A patch the bounds refuse aborts the
// save and returns core.ErrUIPrefsRejected.
func (s *settingsStore) set(next core.GlobalSettings, uiPrefs map[string]json.RawMessage) error {
	resp := make(chan error, 1)
	s.reqs <- func(cur *core.GlobalSettings) *core.GlobalSettings {
		// Merge onto the document as it stands on disk rather than replacing it:
		// another project's server may have written since this one loaded, and
		// the sections below are the whole of what the API owns.
		var mergeErr error
		stored, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
			ui, err := core.MergeUIPrefs(gs.UI, uiPrefs)
			if err != nil {
				mergeErr = err
				return false
			}
			gs.UI = ui
			gs.Updates.Mode = next.Updates.Mode
			// Of connectivity, only the allowed hosts are this API's: what
			// opens at start is the machine server's (PUT /api/server/launch),
			// kept as it stands on disk whatever the request said.
			gs.Connectivity.AllowedHosts = next.Connectivity.AllowedHosts
			gs.Network = next.Network
			gs.Models = next.Models
			gs.UILocale = next.UILocale
			return true
		})
		if mergeErr != nil {
			resp <- mergeErr
			return nil
		}
		if err != nil {
			resp <- err
			return nil // keep the old in-memory state on a failed write
		}
		resp <- nil
		return stored
	}
	return <-resp
}

// reloadFromDisk re-seeds the in-memory document from the file, returning the
// document it replaced, the one it now holds, and whether the two differ.
//
// The read happens inside the owner goroutine, so it cannot interleave with a
// write: a set() landing in the middle would otherwise have this adopt the
// document from before it. Re-seeding matters as much as the comparison — a
// broadcast that left the in-memory copy stale would tell clients the truth and
// then serve them the old document on their next GET. The previous document comes
// back with it because what has to happen next depends on WHICH section moved.
func (s *settingsStore) reloadFromDisk() (core.GlobalSettings, core.GlobalSettings, bool) {
	type reload struct {
		prev    core.GlobalSettings
		next    core.GlobalSettings
		changed bool
	}
	resp := make(chan reload, 1)
	s.reqs <- func(cur *core.GlobalSettings) *core.GlobalSettings {
		next, err := core.LoadGlobalSettings()
		if err != nil {
			// Keep what we have: the file is mid-write or has been hand-edited into
			// something unparseable, and defaults would be a change we then
			// announced as if someone had asked for it.
			jlog.Info("settings: reload failed, keeping the loaded document: %v", err)
			resp <- reload{*cur, *cur, false}
			return nil
		}
		if settingsRevision(*next) == settingsRevision(*cur) {
			resp <- reload{*cur, *cur, false}
			return nil
		}
		resp <- reload{*cur, *next, true}
		return next
	}
	r := <-resp
	return r.prev, r.next, r.changed
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

// cloneModelLimits deep-copies a per-model limits map, so the copy can be
// mutated without touching the settings the store still owns.
func cloneModelLimits(in map[string]map[string]core.ModelLimits) map[string]map[string]core.ModelLimits {
	if in == nil {
		return nil
	}
	out := make(map[string]map[string]core.ModelLimits, len(in))
	for providerName, byModel := range in {
		out[providerName] = maps.Clone(byModel)
	}
	return out
}

// sameModelLimits reports whether two limit maps describe the same overrides.
func sameModelLimits(a, b map[string]map[string]core.ModelLimits) bool {
	if len(a) != len(b) {
		return false
	}
	for providerName, byModel := range a {
		if !maps.Equal(byModel, b[providerName]) {
			return false
		}
	}
	return true
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
		handlers.WriteMessageError(w, r, http.StatusServiceUnavailable, msg.New("settings unavailable"))
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
	//
	// models.limits merges the same way, one level deeper: an omitted provider
	// keeps its overrides, but a provider that IS named has its whole set
	// replaced — decoding an object into a map never merges into the value that
	// was already at a key. So a client changing one model's limits must send
	// that provider's complete set, and clearing the last one is an explicit {}.
	incoming.Models.Hidden = cloneHiddenModels(incoming.Models.Hidden)
	incoming.Models.Limits = cloneModelLimits(incoming.Models.Limits)
	// A slice has the same hazard: decoding an array into one with capacity
	// reuses its backing array, which the stored settings share.
	incoming.Connectivity.AllowedHosts = slices.Clone(incoming.Connectivity.AllowedHosts)
	// The ui section is deliberately NOT seeded: emptied first, it decodes to
	// exactly the keys this request sent, which is the patch the store merges
	// against the document on disk. Seeding it would both have the decode write
	// into the map the store still owns and leave a null value stored as the
	// word null instead of deleting its key.
	incoming.UI = nil
	// Held rather than streamed, because the body is decoded twice: once merged
	// onto the document above, and once on its own below to learn which provider
	// keys this request actually named.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<16))
	if err != nil {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("invalid JSON body"))
		return
	}
	if err := json.Unmarshal(body, &incoming); err != nil {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("invalid JSON body"))
		return
	}
	// posted holds just the provider keys the request sent under the two model
	// sections. The merge above cannot answer that question: incoming was seeded
	// from the stored document, so a key present there may be one this request
	// never mentioned. Unmarshalling cannot fail — the same bytes decoded into
	// the stricter types above.
	var posted struct {
		Connectivity struct {
			AllowedHosts *[]string `json:"allowedHosts"`
		} `json:"connectivity"`
		Models struct {
			Hidden map[string]json.RawMessage `json:"hidden"`
			Limits map[string]json.RawMessage `json:"limits"`
		} `json:"models"`
	}
	_ = json.Unmarshal(body, &posted)
	// A non-empty mode must be one we recognise; empty normalises to automatic.
	if incoming.Updates.Mode != "" && !core.IsKnownUpdateMode(incoming.Updates.Mode) {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("invalid update mode"))
		return
	}
	// Allowed hosts the request sends must each be a name the server would
	// accept at startup, where a bad one is skipped with only a log line. Only
	// the list this request sends: a bad entry already in the file (a hand edit)
	// must not reject every later PUT that never mentions it.
	if posted.Connectivity.AllowedHosts != nil {
		if _, err := hostcheck.NewAllowList(*posted.Connectivity.AllowedHosts); err != nil {
			handlers.WriteErr(w, r, http.StatusBadRequest, err)
			return
		}
	}
	// A non-empty UI language must be a language tag: it is written into every
	// page's markup. "" is the default, English.
	if incoming.UILocale != "" && !core.IsValidUILocale(incoming.UILocale) {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("invalid UI language"))
		return
	}
	incoming.UILocale = core.NormalizeUILocale(incoming.UILocale)
	// A non-empty proxy mode must be recognised; manual mode needs a usable URL.
	if incoming.Network.Proxy.Mode != "" && !core.IsKnownProxyMode(incoming.Network.Proxy.Mode) {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("invalid proxy mode"))
		return
	}
	if incoming.Network.Proxy.Mode == core.ProxyModeManual && !validProxyURL(incoming.Network.Proxy.URL) {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("invalid proxy URL"))
		return
	}
	// Every hidden-model list the request sends must name a provider this build
	// registers, so a typo'd or hand-posted key can't sit in the file hiding
	// nothing. Only the keys it sends: a key inherited from the stored document
	// names a provider this build does not have, which is the ordinary state
	// after a custom provider is deleted or a newer build wrote the file. Judging
	// those here would let one stale entry reject every later PUT, including the
	// ones that touch no model settings at all.
	for providerName := range posted.Models.Hidden {
		if _, ok := provider.GetProviderInfo(providerName); !ok {
			handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("unknown provider in hidden models: {provider}", "provider", providerName))
			return
		}
	}
	// Same for the limit overrides, which additionally must be numbers a model
	// could actually have. A negative one is a typo or a hand-posted body; zero
	// is how "not overridden" is spelled, so it is accepted and normalised away.
	for providerName := range posted.Models.Limits {
		if _, ok := provider.GetProviderInfo(providerName); !ok {
			handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("unknown provider in model limits: {provider}", "provider", providerName))
			return
		}
		// Naming a provider replaces its whole set, so the merged value at this
		// key is exactly what the request posted.
		for modelID, limits := range incoming.Models.Limits[providerName] {
			if limits.ContextWindow < 0 || limits.MaxOutputTokens < 0 {
				handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("negative model limit for {provider} {model}", "provider", providerName, "model", modelID))
				return
			}
		}
	}
	prevMode := s.updateMode()
	prevSettings := s.settings.get()
	prevHidden := prevSettings.Models.Hidden
	prevLimits := prevSettings.Models.Limits
	incoming.Updates.Mode = core.NormalizeUpdateMode(incoming.Updates.Mode)
	incoming.Network.Proxy.Mode = core.NormalizeProxyMode(incoming.Network.Proxy.Mode)
	if err := s.settings.set(incoming, incoming.UI); err != nil {
		// A refused UI patch is the caller's fault, not a storage failure, and
		// nothing was written — so it is answered 400, carrying which bound it
		// crossed.
		if errors.Is(err, core.ErrUIPrefsRejected) {
			handlers.WriteErr(w, r, http.StatusBadRequest, err)
			return
		}
		jlog.Error("settings: save failed: %v", err)
		handlers.WriteMessageError(w, r, http.StatusInternalServerError, msg.New("Couldn't save settings"))
		return
	}
	// Read back the stored document: the save normalises the hidden-model lists
	// (trimming, de-duping, dropping emptied providers), so this is what the
	// client should see and what the comparison below must be made against.
	incoming = s.settings.get()
	// Hidden models change what the model menu offers and what the default and
	// cheap-model resolvers may pick, and a limit override changes the window
	// every one of them displays, so republish the provider list instead of
	// leaving the change invisible until something else triggers a refresh.
	if !sameHiddenModels(prevHidden, incoming.Models.Hidden) ||
		!sameModelLimits(prevLimits, incoming.Models.Limits) {
		s.RefreshProviders()
	}
	// Apply the proxy policy live so a change takes effect without a restart; the
	// atomic resolver makes already-built clients pick it up on their next request.
	httpx.SetConfig(httpx.Config{Mode: incoming.Network.Proxy.Mode, URL: incoming.Network.Proxy.URL})
	// Every window renders these settings, so the change is published rather than
	// left for whatever makes the next GET. The comparison is against the document
	// as it stood: a PUT rewrites the file whether or not it changed anything, and
	// waking every client to re-render a value it already has is worse than saying
	// nothing. The watcher stays quiet about this write for the same reason — the
	// in-memory copy already matches the file it is about to see change.
	if settingsRevision(prevSettings) != settingsRevision(incoming) {
		s.broadcastSettingsChanged(incoming)
	}
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
	if s.test.offlineUpdates {
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
	if s.updateChecker == nil || s.test.offlineUpdates {
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
