//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"juggler/cmd/juggler/core"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"
)

// ModelWithContext is one model entry in a provider's listing.
type ModelWithContext struct {
	ID              string   `json:"id"`
	DisplayName     string   `json:"displayName,omitempty"` // Provider-supplied label; empty ⇒ UI derives one from the ID
	ContextWindow   int      `json:"contextWindow"`
	MaxOutputTokens int      `json:"maxOutputTokens"`
	FromAPI         bool     `json:"fromAPI"`                   // True if from API, false if hardcoded fallback
	InputModalities []string `json:"inputModalities,omitempty"` // e.g. ["text","image"]; empty/omitted means text-only
	// ThinkingLevels lists the reasoning-effort tiers this model supports, in
	// display order, each named in the provider's own native vocabulary (e.g.
	// "low"/"medium"/"high", "none"/"low"/"high"/"xhigh"). The string is the
	// identity: shown verbatim and sent back as the chosen level. Empty/omitted
	// ⇒ the UI hides the thinking control for this model.
	ThinkingLevels []string `json:"thinkingLevels,omitempty"`
	// DefaultThinkingLevel is the level the provider uses when a turn carries
	// none — presentation only, lets the UI label "Default (medium)".
	DefaultThinkingLevel string `json:"defaultThinkingLevel,omitempty"`
	// StreamsLiveUsage is true when this model's provider reports authoritative
	// per-step input usage mid-turn (see provider.ProviderInfo.StreamsLiveUsage).
	// The footer meter grows against the live count only for models that set it;
	// others keep the end-of-turn blob anchor. Provider-declared, surfaced per
	// model so the client reads it off the model config.
	StreamsLiveUsage bool `json:"streamsLiveUsage,omitempty"`
}

// ProviderStatus is one provider's published state.
type ProviderStatus struct {
	Name              string             `json:"name"`
	DisplayName       string             `json:"displayName"`
	Description       string             `json:"description"`
	AuthType          provider.AuthType  `json:"authType"`
	AuthSource        string             `json:"authSource,omitempty"`
	SignInMethod      string             `json:"signInMethod,omitempty"`
	AuthHint          string             `json:"authHint,omitempty"`
	ConfigKeyName     string             `json:"configKeyName"`
	EnvVarName        string             `json:"envVarName"`
	APIKeyURL         string             `json:"apiKeyURL"`
	KeySource         core.KeySource     `json:"keySource"`
	Available         bool               `json:"available"`
	ModelsWithContext []ModelWithContext `json:"modelsWithContext"`
}

func modelContextFallbacks(pInfo provider.ProviderInfo) []ModelWithContext {
	if len(pInfo.ModelContextWindows) == 0 {
		return nil
	}
	ids := make([]string, 0, len(pInfo.ModelContextWindows))
	for id := range pInfo.ModelContextWindows {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	models := make([]ModelWithContext, 0, len(ids))
	for _, id := range ids {
		models = append(models, ModelWithContext{
			ID:               id,
			ContextWindow:    pInfo.ModelContextWindows[id],
			FromAPI:          false,
			StreamsLiveUsage: pInfo.StreamsLiveUsage,
		})
	}
	return models
}

// humanizeModelListError maps a raw model-list failure to a short, human hint
// safe to render in a model-menu row. The raw error is logged separately for
// diagnosis; it must never reach the UI (it leaks wrapped transport internals).
func humanizeModelListError(providerDisplayName string, err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "401") || strings.Contains(msg, "403") ||
		strings.Contains(msg, "unauthorized") || strings.Contains(msg, "forbidden") ||
		strings.Contains(msg, "invalid api key") || strings.Contains(msg, "authentication"):
		return "Key rejected — check it in Provider Settings"
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded") ||
		strings.Contains(msg, "no such host") || strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "dial tcp") || strings.Contains(msg, "network is unreachable"):
		return "Couldn't reach " + providerDisplayName + " — check your connection"
	default:
		return "Couldn't load models — see Provider Settings"
	}
}

// computeProviders fans out one model-list call per available provider and
// returns the assembled status slice. Network-heavy; call sparingly. The
// result is cached on the server and pushed to clients via `providers-update`.
func (s *Server) computeProviders(ctx context.Context) []ProviderStatus {
	credStore, err := core.NewCredentialsStore()
	if err != nil {
		jlog.Error("computeProviders: %v", err)
		return nil
	}

	providerInfos := provider.ListProviderInfos()
	providers := make([]ProviderStatus, len(providerInfos))
	var wg sync.WaitGroup

	for i, info := range providerInfos {
		wg.Add(1)
		go func(idx int, pInfo provider.ProviderInfo) {
			defer wg.Done()

			authType := pInfo.EffectiveAuthType()

			// Toggle providers with auto-detection: run detection on first use
			if authType == provider.AuthTypeToggle && pInfo.AutoDetect != nil && !credStore.HasProviderFlag(pInfo.Name) {
				if provider.CheckAutoDetect(pInfo.Name) {
					_ = credStore.SetProviderEnabled(pInfo.Name, true)
				}
			}

			cred, err := credStore.GetProviderCredential(pInfo.Name)
			credentialed := err == nil
			available := credentialed
			authHint := cred.AuthHint

			// Non-interactive readiness probe: a provider can be credentialed yet
			// unable to serve a turn right now (e.g. a CLI whose OAuth login is
			// missing). Mark it unavailable with the probe's hint, but still list
			// its (local) models below so the menu shows them disabled rather than
			// hiding the provider — the ReadinessCheck contract requires local
			// model listing precisely so this stays safe.
			readyGated := false
			if credentialed && pInfo.ReadinessCheck != nil {
				if ready, hint := pInfo.ReadinessCheck(); !ready {
					available = false
					readyGated = true
					if hint != "" {
						authHint = hint
					}
				}
			}

			var modelsWithContext []ModelWithContext
			if available || readyGated {
				modelInfos, err := s.fetchModels(ctx, pInfo.Name, cred)
				if err == nil {
					for _, modelInfo := range modelInfos {
						modelsWithContext = append(modelsWithContext, ModelWithContext{
							ID:                   modelInfo.ID,
							DisplayName:          modelInfo.DisplayName,
							ContextWindow:        modelInfo.ContextWindow,
							MaxOutputTokens:      modelInfo.MaxOutputTokens,
							FromAPI:              modelInfo.FromAPI,
							InputModalities:      modelInfo.InputModalities,
							ThinkingLevels:       modelInfo.ThinkingLevels,
							DefaultThinkingLevel: modelInfo.DefaultThinkingLevel,
							StreamsLiveUsage:     pInfo.StreamsLiveUsage,
						})
					}
				} else {
					available = false
					jlog.Error("computeProviders: list models from %s failed: %v", pInfo.Name, err)
					// Keep the readiness hint (e.g. "sign in") when the provider was
					// already gated unready — it's more actionable than a generic
					// model-list error, and readiness is the real reason it's down.
					if !readyGated {
						authHint = humanizeModelListError(pInfo.DisplayName, err)
					}
					modelsWithContext = modelContextFallbacks(pInfo)
				}
			} else if authType == provider.AuthTypeOAuthBearer {
				// OAuth providers can be discoverable in the UI even while their
				// external CLI login has expired. Publish built-in model fallbacks so
				// the menu can show disabled choices with the authHint.
				modelsWithContext = modelContextFallbacks(pInfo)
			}

			providers[idx] = ProviderStatus{
				Name:              pInfo.Name,
				DisplayName:       pInfo.DisplayName,
				Description:       pInfo.Description,
				AuthType:          authType,
				AuthSource:        pInfo.AuthSource,
				SignInMethod:      pInfo.SignInMethod,
				AuthHint:          authHint,
				ConfigKeyName:     pInfo.ConfigKeyName,
				EnvVarName:        pInfo.EnvVarName,
				APIKeyURL:         pInfo.APIKeyURL,
				KeySource:         cred.KeySource,
				Available:         available,
				ModelsWithContext: modelsWithContext,
			}
		}(i, info)
	}

	wg.Wait()
	return providers
}

// fetchModels initialises a provider client just long enough to list its
// models. No caching — callers (i.e. computeProviders) own coalescing.
func (s *Server) fetchModels(ctx context.Context, providerName string, cred core.ProviderCredential) ([]provider.ModelInfo, error) {
	client, err := provider.InitializeProvider(providerName, provider.Config{
		APIKey:      cred.APIKey,
		BearerToken: cred.BearerToken,
		Headers:     cred.Headers,
		Model:       "placeholder-for-listing-models",
	})
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, ProviderInitTimeout)
	defer cancel()
	return client.ListModelsWithInfo(callCtx)
}

// fetchUsageStats initialises a provider client just long enough to fetch its
// optional account/plan usage stats. Providers that don't implement
// UsageStatsProvider simply report no stats.
func (s *Server) fetchUsageStats(ctx context.Context, providerName string, cred core.ProviderCredential) (*provider.UsageStats, error) {
	client, err := provider.InitializeProvider(providerName, provider.Config{
		APIKey:      cred.APIKey,
		BearerToken: cred.BearerToken,
		Headers:     cred.Headers,
		Model:       "placeholder-for-usage-stats",
	})
	if err != nil {
		return nil, err
	}
	statsProvider, ok := client.(provider.UsageStatsProvider)
	if !ok {
		return nil, nil
	}
	callCtx, cancel := context.WithTimeout(ctx, ProviderInitTimeout)
	defer cancel()
	stats, err := statsProvider.UsageStats(callCtx)
	if err != nil {
		return nil, err
	}
	return &stats, nil
}

// RefreshProviders queues a provider-list recomputation. Safe to call from any
// goroutine. refreshRequests is a dirty latch: bursts coalesce to one queued
// request, including while a computation is in flight. A request accepted during
// a computation remains queued for the actor's next pass.
func (s *Server) RefreshProviders() {
	if s.testMode {
		// Tests mock the provider list; nothing will ever populate the cache, so
		// open the readiness gate immediately to keep default-model lookups from
		// waiting out the full timeout.
		s.markProvidersReady()
		return
	}
	select {
	case s.refreshRequests <- struct{}{}:
	default:
	}
}

func (s *Server) runProviderRefreshActor() {
	for {
		select {
		case <-s.shutdownChan:
			return
		case <-s.refreshRequests:
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			compute := s.computeProvidersFunc
			if compute == nil {
				compute = s.computeProviders
			}
			list := compute(ctx)
			cancel()
			s.providersList.Store(&list)
			s.markProvidersReady()
			s.broadcastToAll(map[string]any{
				"type":      "providers-update",
				"providers": list,
				// This snapshot is the settled, post-compute list — clients that gate
				// startup decisions on real provider availability should trust it.
				"ready": true,
			})
		}
	}
}

// markProvidersReady opens the providers-ready gate exactly once. Called when
// the first provider refresh completes (and immediately in test mode).
func (s *Server) markProvidersReady() {
	s.providersReadyOnce.Do(func() { close(s.providersReady) })
}

// providersReadyNow reports whether the first provider refresh has completed,
// without blocking. Used to stamp the connect-time seed push so clients can tell
// a pre-compute snapshot from the settled list.
func (s *Server) providersReadyNow() bool {
	select {
	case <-s.providersReady:
		return true
	default:
		return false
	}
}

// awaitProvidersReady blocks until the first provider refresh has populated the
// cache, the request context is cancelled, the server shuts down, or
// ProvidersReadyTimeout elapses — whichever comes first. In steady state the
// gate is already open and this returns immediately; it only ever waits during
// the startup discovery window (or a watchdog re-exec restart).
func (s *Server) awaitProvidersReady(ctx context.Context) {
	select {
	case <-s.providersReady:
	case <-ctx.Done():
	case <-s.shutdownChan:
	case <-time.After(ProvidersReadyTimeout):
	}
}

// defaultProviderPreference ranks providers for the implicit `default` alias
// when the user hasn't configured one. Listed providers win in this order; any
// other available provider follows, ordered by name for determinism. (Provider
// registration order is non-deterministic — ListProviderInfos iterates a map —
// so the preference must impose its own stable ordering.)
var defaultProviderPreference = []string{"claudecode", "openaicodex"}

// preferredAvailableModel returns the (provider, first model) for the
// highest-ranked available provider that exposes at least one model, or
// ok=false when no provider is usable.
func preferredAvailableModel(providers []ProviderStatus) (core.ModelRef, bool) {
	rank := func(name string) int {
		for i, p := range defaultProviderPreference {
			if p == name {
				return i
			}
		}
		return len(defaultProviderPreference)
	}

	candidates := make([]ProviderStatus, 0, len(providers))
	for _, p := range providers {
		if p.Available && len(p.ModelsWithContext) > 0 {
			candidates = append(candidates, p)
		}
	}
	if len(candidates) == 0 {
		return core.ModelRef{}, false
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		ri, rj := rank(candidates[i].Name), rank(candidates[j].Name)
		if ri != rj {
			return ri < rj
		}
		return candidates[i].Name < candidates[j].Name
	})
	best := candidates[0]
	return core.ModelRef{Provider: best.Name, Model: best.ModelsWithContext[0].ID}, true
}

// resolveDefaultModel returns the concrete {provider, model, thinking?} a new
// conversation should be seeded with, plus whether it came from an explicit
// user default. An empty Thinking means the model's default level.
func (s *Server) resolveDefaultModel(ctx context.Context) (core.ModelRef, bool) {
	if stored, err := s.defaultModelStore.Load(); err == nil && stored.Provider != "" && stored.Model != "" {
		return stored, true
	}

	// No explicit default: the answer is derived from the live provider list,
	// which is computed asynchronously at startup (model discovery spawns the
	// claudecode CLI and lists remote models). A tab created in that first
	// moment would otherwise see an empty cache and be seeded with no model,
	// which nothing retargets later. Wait out the discovery window first.
	s.awaitProvidersReady(ctx)
	ref, _ := preferredAvailableModel(s.cachedProviders())
	return ref, false
}

// providerAvailable reports whether the named provider is present and available
// in the most recent provider snapshot.
func (s *Server) providerAvailable(providerName string) bool {
	for _, p := range s.cachedProviders() {
		if p.Name == providerName {
			return p.Available
		}
	}
	return false
}

// liveModelMatch resolves a provider's cheap-model hint against its live model
// list, returning the concrete model id to send. It matches an exact id first,
// then falls back to a prefix match so a family hint ("claude-haiku-4-5") lands
// on the dated id the API actually publishes ("claude-haiku-4-5-20251001").
// ok=false when the provider is unavailable or exposes no matching model.
func (s *Server) liveModelMatch(providerName, wantID string) (string, bool) {
	if wantID == "" {
		return "", false
	}
	for _, p := range s.cachedProviders() {
		if p.Name != providerName {
			continue
		}
		if !p.Available {
			return "", false
		}
		for _, m := range p.ModelsWithContext {
			if m.ID == wantID {
				return m.ID, true
			}
		}
		for _, m := range p.ModelsWithContext {
			if strings.HasPrefix(m.ID, wantID) {
				return m.ID, true
			}
		}
		return "", false
	}
	return "", false
}

// resolveCheapModel returns the concrete {provider, model, thinking?} to use for
// out-of-band micro-tasks (auto-naming a tab, plugin generateText), plus whether
// one was resolved at all. Resolution order:
//
//  1. Explicit — the user pinned a cheap model (cheapModelStore) and its
//     provider is currently available: used as-is.
//  2. Auto-derive — the caller's primary model's provider advertises a
//     ProviderInfo.CheapModel that appears in its live list: used with the
//     matched concrete id.
//  3. Neither → ok=false. Callers that need a model do not run (no heuristic).
//
// The primary ref lets the namer derive a cheap sibling of the conversation's
// own model; the HTTP endpoint passes the resolved default as primary.
func (s *Server) resolveCheapModel(ctx context.Context, primary core.ModelRef) (core.ModelRef, bool) {
	// The live provider list drives both the availability check and the
	// auto-derive validation, so wait out startup discovery once here (a no-op in
	// steady state), exactly as resolveDefaultModel does.
	s.awaitProvidersReady(ctx)

	if s.cheapModelStore != nil {
		if stored, err := s.cheapModelStore.Load(); err == nil && stored.Provider != "" && stored.Model != "" {
			if s.providerAvailable(stored.Provider) {
				return stored, true
			}
			// Pinned but unavailable: fall through to auto-derive rather than
			// returning a model that cannot run.
		}
	}

	if primary.Provider == "" {
		return core.ModelRef{}, false
	}
	info, ok := provider.GetProviderInfo(primary.Provider)
	if !ok || info.CheapModel == "" {
		return core.ModelRef{}, false
	}
	if concrete, ok := s.liveModelMatch(primary.Provider, info.CheapModel); ok {
		return core.ModelRef{Provider: primary.Provider, Model: concrete}, true
	}
	return core.ModelRef{}, false
}

// handleCheapModel returns the cheap model used for out-of-band micro-tasks.
// When the user has pinned one it is returned as-is (explicit:true). Otherwise
// the server reports the auto-derived cheap sibling of the current default model
// (explicit:false) under `autoResolved`, or omits it when none is available so
// the UI can show a plain "Auto".
func (s *Server) handleCheapModel(w http.ResponseWriter, r *http.Request) {
	var stored core.ModelRef
	if s.cheapModelStore != nil {
		stored, _ = s.cheapModelStore.Load()
	}
	explicit := stored.Provider != "" && stored.Model != ""

	body := map[string]any{"explicit": explicit}
	if explicit {
		body["provider"] = stored.Provider
		body["model"] = stored.Model
		if stored.Thinking != "" {
			body["thinking"] = stored.Thinking
		}
	} else {
		primary, _ := s.resolveDefaultModel(r.Context())
		if ref, ok := s.resolveCheapModel(r.Context(), primary); ok {
			body["autoResolved"] = map[string]any{"provider": ref.Provider, "model": ref.Model}
		}
	}
	handlers.WriteJSON(w, r, 0, body)
}

// handleSetCheapModel persists the cheap model used for out-of-band micro-tasks.
// Body: {"provider": "...", "model": "...", "thinking": "..."} — thinking is
// optional. An empty provider/model clears the stored value, reverting to Auto.
func (s *Server) handleSetCheapModel(w http.ResponseWriter, r *http.Request) {
	if s.cheapModelStore == nil {
		handlers.WriteJSON(w, r, http.StatusServiceUnavailable, map[string]any{"success": false, "error": "Cheap model is not available"})
		return
	}
	var req struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Thinking string `json:"thinking"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid request body"})
		return
	}
	if err := s.cheapModelStore.Save(core.ModelRef{Provider: req.Provider, Model: req.Model, Thinking: req.Thinking}); err != nil {
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]any{"success": false, "error": fmt.Sprintf("Failed to save cheap model: %v", err)})
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"success": true})
}

// handleDefaultModel returns the concrete {provider, model, thinking?} a new
// conversation should be seeded with. When the user has set a default it is
// returned as-is (explicit:true); otherwise the server computes the preferred
// available provider's first model from the live provider list
// (explicit:false). The result is captured onto the conversation at creation
// time, so a later change to the default never retargets an existing
// conversation. `thinking` is included only when non-empty (absent = the
// model's default level).
func (s *Server) handleDefaultModel(w http.ResponseWriter, r *http.Request) {
	ref, explicit := s.resolveDefaultModel(r.Context())
	body := map[string]any{
		"provider": ref.Provider,
		"model":    ref.Model,
		"explicit": explicit,
	}
	if ref.Thinking != "" {
		body["thinking"] = ref.Thinking
	}
	handlers.WriteJSON(w, r, 0, body)
}

// handleSetDefaultModel persists the model new conversations are seeded with.
// Body: {"provider": "...", "model": "...", "thinking": "..."} — thinking is
// optional; absent/empty means the model's default level. An empty
// provider/model clears the stored value, reverting to automatic selection.
func (s *Server) handleSetDefaultModel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Thinking string `json:"thinking"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid request body"})
		return
	}
	if err := s.defaultModelStore.Save(core.ModelRef{Provider: req.Provider, Model: req.Model, Thinking: req.Thinking}); err != nil {
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]any{"success": false, "error": fmt.Sprintf("Failed to save default model: %v", err)})
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"success": true})
}

// handleRecentModels handles the user's recently-used concrete models.
//
//	GET  /api/recent-models           → {"models": [{provider, model, thinking?}, ...]} (most-recent first)
//	POST /api/recent-models {provider, model, thinking?} → records usage, returns {success}
//
// `thinking` is optional on both sides — absent/empty means the model's
// default level, and entries dedupe by the full triple.
//
// The list is server-side (not browser localStorage) so it survives app
// relaunch / a spawned server binding to a different port. Whether a model is
// currently available never affects it — recording a pick is decoupled from
// availability, and the list is returned verbatim.
func (s *Server) handleRecentModels(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		s.handleRecentModelsPost(w, r)
		return
	}
	s.handleRecentModelsGet(w, r)
}

func (s *Server) handleRecentModelsGet(w http.ResponseWriter, r *http.Request) {
	if s.recentModelsStore == nil {
		handlers.WriteJSON(w, r, 0, map[string]any{"models": []core.ModelRef{}})
		return
	}

	models, err := s.recentModelsStore.Load()
	if err != nil {
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]any{"error": fmt.Sprintf("Failed to load recent models: %v", err)})
		return
	}
	if models == nil {
		models = []core.ModelRef{}
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"models": models})
}

func (s *Server) handleRecentModelsPost(w http.ResponseWriter, r *http.Request) {
	if s.recentModelsStore == nil {
		handlers.WriteJSON(w, r, http.StatusServiceUnavailable, map[string]any{"success": false, "error": "Recent models are not available"})
		return
	}

	var req struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Thinking string `json:"thinking"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid request body"})
		return
	}
	if err := s.recentModelsStore.Add(core.ModelRef{Provider: req.Provider, Model: req.Model, Thinking: req.Thinking}); err != nil {
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]any{"success": false, "error": fmt.Sprintf("Failed to record recent model: %v", err)})
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"success": true})
}

// cachedProviders returns the most recent provider list, or an empty slice
// if no refresh has completed yet.
func (s *Server) cachedProviders() []ProviderStatus {
	if p := s.providersList.Load(); p != nil {
		return *p
	}
	return []ProviderStatus{}
}

// resolveModelCapabilities returns one immutable capability snapshot for an
// exact provider/model pair. Published positive live values win. A provider's
// static capability resolver can fill values that are still unknown before
// runtime discovery; the context-only map remains the final fallback.
//
// The snapshot always carries one effective output limit when the context
// window is known: model-reported or catalogued limits win, otherwise the
// shared derived safety reserve is filled in here. Admission charges a
// reserve from the same snapshot fields, so the reserve and the value placed
// on the wire can never diverge.
func (s *Server) resolveModelCapabilities(providerName, model string) provider.ModelCapabilities {
	info, hasInfo := provider.GetProviderInfo(providerName)
	capabilities := provider.ModelCapabilities{}
	if hasInfo {
		if info.ResolveModelCapabilities != nil {
			if resolved, found := info.ResolveModelCapabilities(model); found {
				capabilities = resolved
			}
		}
		if capabilities.ContextWindowTokens <= 0 {
			if contextWindow, found := info.ModelContextWindows[model]; found && contextWindow > 0 {
				capabilities.ContextWindowTokens = int64(contextWindow)
			}
		}
	}

	for _, status := range s.cachedProviders() {
		if status.Name != providerName {
			continue
		}
		for _, candidate := range status.ModelsWithContext {
			if candidate.ID == model {
				if candidate.ContextWindow > 0 {
					capabilities.ContextWindowTokens = int64(candidate.ContextWindow)
				}
				if candidate.MaxOutputTokens > 0 {
					capabilities.MaxOutputTokens = int64(candidate.MaxOutputTokens)
				}
				return normalizeOutputLimit(capabilities)
			}
		}
		break
	}
	return normalizeOutputLimit(capabilities)
}

// normalizeOutputLimit fills the derived safety reserve when the window is
// known but no output limit resolved from any source, and clamps a reported
// output cap that is at or above the window down to the derived reserve.
//
// A reported output cap equal to (or above) the context window leaves zero
// input room, so admission would reject every request with
// InvalidOutputReserveError and the model would be permanently unusable. Such a
// value is a catalog artifact (some OpenRouter entries report
// max_completion_tokens == context_length), not a usable limit; the derived
// reserve is the conservative interpretation. This is the universal safety net
// for any provider that misreports; sources may also clamp at their own layer.
func normalizeOutputLimit(capabilities provider.ModelCapabilities) provider.ModelCapabilities {
	if capabilities.ContextWindowTokens > 0 {
		if capabilities.MaxOutputTokens <= 0 || capabilities.MaxOutputTokens >= capabilities.ContextWindowTokens {
			capabilities.MaxOutputTokens = provider.ContextSafetyReserve(capabilities.ContextWindowTokens)
		}
	}
	return capabilities
}

// handleProviders returns the cached provider/model list. The list is
// populated at startup and on every credential change via RefreshProviders;
// this handler never makes upstream calls of its own.
func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, map[string]any{
		"providers": s.cachedProviders(),
	})
}

// handleRefreshProviders queues a provider/model refresh and returns the current
// cached list immediately. Clients receive the refreshed list via providers-update
// once model discovery completes.
func (s *Server) handleRefreshProviders(w http.ResponseWriter, r *http.Request) {
	s.RefreshProviders()
	handlers.WriteJSON(w, r, 0, map[string]any{
		"success":   true,
		"providers": s.cachedProviders(),
	})
}

// handleProviderUsageStats returns best-effort account/plan usage stats for
// credentialed providers that support them. Unsupported or unavailable providers
// are omitted; per-provider fetch errors are returned in `errors` so a single
// flaky upstream doesn't hide the rest of the snapshot.
//
// The optional `provider` query param scopes the fetch to one provider — the UI
// only ever shows the active conversation's usage, so it asks for just that one.
// Fetching a provider's usage can be expensive and, for CLI-backed providers,
// even provoke a login, so we never fan out across providers the user isn't
// looking at. With no param the endpoint fetches every credentialed provider
// (kept for callers that want the whole snapshot).
func (s *Server) handleProviderUsageStats(w http.ResponseWriter, r *http.Request) {
	// In test mode, fetching usage would make real upstream HTTPS calls per
	// credentialed provider — the same flake vector that bit /api/providers.
	// The model-selector menu requests this on open, so short-circuit here.
	if s.testMode {
		handlers.WriteJSON(w, r, 0, map[string]any{
			"usage":  []provider.UsageStats{},
			"errors": map[string]string{},
		})
		return
	}

	credStore, err := core.NewCredentialsStore()
	if err != nil {
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
			"error": fmt.Sprintf("Failed to initialize credentials store: %v", err),
		})
		return
	}

	scope := strings.TrimSpace(r.URL.Query().Get("provider"))

	providerInfos := provider.ListProviderInfos()
	stats := make([]provider.UsageStats, 0, len(providerInfos))
	errorsByProvider := map[string]string{}

	for _, info := range providerInfos {
		if scope != "" && info.Name != scope {
			continue
		}
		cred, credErr := credStore.GetProviderCredential(info.Name)
		if credErr != nil {
			continue
		}
		usage, fetchErr := s.fetchUsageStats(r.Context(), info.Name, cred)
		if fetchErr != nil {
			errorsByProvider[info.Name] = fetchErr.Error()
			continue
		}
		if usage != nil && len(usage.Stats) > 0 {
			stats = append(stats, *usage)
		}
	}

	handlers.WriteJSON(w, r, 0, map[string]any{
		"usage":  stats,
		"errors": errorsByProvider,
	})
}

// handleVersion returns the server version and the rendezvous protocol version
// the binary speaks (the juggler.studio bootstrap compares the latter against its
// own constant and refuses to boot on a mismatch).
func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, map[string]any{
		"version":         core.Version,
		"protocolVersion": RendezvousProtocolVersion,
	})
}
