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
	// ThinkingLevels lists the canonical thinking levels this model supports
	// ("off","low","medium","high","max"); empty/omitted ⇒ the UI hides the
	// thinking control for this model.
	ThinkingLevels []string `json:"thinkingLevels,omitempty"`
	// DefaultThinkingLevel is the level the provider uses when a turn carries
	// none — presentation only, lets the UI label "Default (medium)".
	DefaultThinkingLevel string `json:"defaultThinkingLevel,omitempty"`
}

// ProviderStatus is one provider's published state.
type ProviderStatus struct {
	Name              string             `json:"name"`
	DisplayName       string             `json:"displayName"`
	Description       string             `json:"description"`
	AuthType          provider.AuthType  `json:"authType"`
	AuthSource        string             `json:"authSource,omitempty"`
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
			ID:            id,
			ContextWindow: pInfo.ModelContextWindows[id],
			FromAPI:       false,
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
			available := err == nil
			authHint := cred.AuthHint

			var modelsWithContext []ModelWithContext
			if available {
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
						})
					}
				} else {
					available = false
					jlog.Error("computeProviders: list models from %s failed: %v", pInfo.Name, err)
					authHint = humanizeModelListError(pInfo.DisplayName, err)
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

// resolveDefaultModel returns the concrete {provider, model} a new conversation
// should be seeded with, plus whether it came from an explicit user default.
func (s *Server) resolveDefaultModel(ctx context.Context) (core.ModelRef, bool) {
	if stored, err := s.defaultModelStore.Load(); err == nil && stored.Provider != "" && stored.Model != "" {
		return core.ModelRef{Provider: stored.Provider, Model: stored.Model}, true
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

// handleDefaultModel returns the concrete {provider, model} a new conversation
// should be seeded with. When the user has set a default it is returned as-is
// (explicit:true); otherwise the server computes the preferred available
// provider's first model from the live provider list (explicit:false). The
// result is captured onto the conversation at creation time, so a later change
// to the default never retargets an existing conversation.
func (s *Server) handleDefaultModel(w http.ResponseWriter, r *http.Request) {
	ref, explicit := s.resolveDefaultModel(r.Context())
	handlers.WriteJSON(w, r, 0, map[string]any{
		"provider": ref.Provider,
		"model":    ref.Model,
		"explicit": explicit,
	})
}

// handleSetDefaultModel persists the model new conversations are seeded with.
// Body: {"provider": "...", "model": "..."}. An empty provider/model clears the
// stored value, reverting to automatic selection.
func (s *Server) handleSetDefaultModel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid request body"})
		return
	}
	if err := s.defaultModelStore.Save(core.ModelRef{Provider: req.Provider, Model: req.Model}); err != nil {
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]any{"success": false, "error": fmt.Sprintf("Failed to save default model: %v", err)})
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"success": true})
}

// handleRecentModels handles the user's recently-selected concrete models.
//
//	GET  /api/recent-models           → {"models": [{provider, model}, ...]} (most-recent first)
//	POST /api/recent-models {provider, model} → records a pick, returns {success}
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
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid request body"})
		return
	}
	if err := s.recentModelsStore.Add(core.ModelRef{Provider: req.Provider, Model: req.Model}); err != nil {
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
// known but no output limit resolved from any source.
func normalizeOutputLimit(capabilities provider.ModelCapabilities) provider.ModelCapabilities {
	if capabilities.MaxOutputTokens <= 0 && capabilities.ContextWindowTokens > 0 {
		capabilities.MaxOutputTokens = provider.ContextSafetyReserve(capabilities.ContextWindowTokens)
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

// handleProviderUsageStats returns best-effort account/plan usage stats for all
// currently credentialed providers that support them. Unsupported or unavailable
// providers are omitted; per-provider fetch errors are returned in `errors` so a
// single flaky upstream doesn't hide the rest of the snapshot.
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

	providerInfos := provider.ListProviderInfos()
	stats := make([]provider.UsageStats, 0, len(providerInfos))
	errorsByProvider := map[string]string{}

	for _, info := range providerInfos {
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
