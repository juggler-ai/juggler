//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
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
	// WindowAssumed mirrors provider.ModelInfo.WindowAssumed: the provider's
	// window for this model is a blanket fallback, not a reported or catalogued
	// figure. Like FromAPI it describes the provider's own number, so it stays
	// set under a user override; a UI asking "is the effective window a guess?"
	// checks ProviderContextWindow == nil as well.
	WindowAssumed bool `json:"windowAssumed,omitempty"`
	// ProviderContextWindow and ProviderMaxOutputTokens carry the numbers the
	// provider itself reported, and are set only when a user override
	// (models.limits in the global settings) replaced one in the fields above.
	// Non-nil is therefore exactly "the user overrode this", which a plain int
	// could not express: a provider that reports no limit of its own overrides
	// to a genuine zero. The value is what clearing the override restores.
	//
	// Only the settings UI reads them. Everything that runs a turn wants the
	// effective limits above, which is why the override is applied there rather
	// than left for each consumer to remember to merge.
	ProviderContextWindow   *int `json:"providerContextWindow,omitempty"`
	ProviderMaxOutputTokens *int `json:"providerMaxOutputTokens,omitempty"`
	// DerivedMaxOutputTokens is the output budget Juggler derives from the
	// effective ContextWindow (provider.ContextSafetyReserve) for a model whose
	// provider states no usable output limit: what admission charges and the
	// request sends while the user's Max output is blank. Set whether or not the
	// user overrode Max output, because it is then what clearing the override
	// restores; zero when the provider states a limit of its own, or no window is
	// known. Published so the settings UI can show "auto" as the number it
	// resolves to without re-implementing the formula.
	DerivedMaxOutputTokens int `json:"derivedMaxOutputTokens,omitempty"`
	// ThinkingLevels lists the reasoning-effort tiers this model supports, in
	// display order (least effort first; see lowestThinkingLevel), each named
	// in the provider's own native vocabulary (e.g.
	// "low"/"medium"/"high", "none"/"low"/"high"/"xhigh"). The string is the
	// identity: shown verbatim and sent back as the chosen level. Empty/omitted
	// ⇒ the UI hides the thinking control for this model.
	ThinkingLevels []string `json:"thinkingLevels,omitempty"`
	// DefaultThinkingLevel is the level the provider uses when a turn carries
	// none — presentation only, lets the UI label "Default (medium)".
	DefaultThinkingLevel string `json:"defaultThinkingLevel,omitempty"`
	// ServiceTiers lists the non-standard serving classes this model offers, in
	// display order, each carrying the provider's own id, label and blurb.
	// Standard serving is not a member — it is the absence of a tier.
	// Empty/omitted ⇒ the UI hides the speed control for this model.
	ServiceTiers []provider.ServiceTier `json:"serviceTiers,omitempty"`
	// DefaultServiceTier is the tier the provider bills as this model's default
	// — presentation only, and never applied on the user's behalf.
	DefaultServiceTier string `json:"defaultServiceTier,omitempty"`
	// Hidden is true when the user turned this model off (models.hidden in the
	// global settings). It is published rather than filtered out: the picker
	// still needs to label a hidden model that a conversation is already using,
	// which it can't do if the entry is missing from the list entirely.
	// Everything that CHOOSES a model — the menu, the default resolver, the
	// cheap-model resolver — skips these.
	Hidden bool `json:"hidden,omitempty"`
	// StreamsLiveUsage is true when this model's provider reports authoritative
	// per-step input usage mid-turn (see provider.ProviderInfo.StreamsLiveUsage).
	// The footer meter grows against the live count only for models that set it;
	// others keep the end-of-turn blob anchor. Provider-declared, surfaced per
	// model so the client reads it off the model config.
	StreamsLiveUsage bool `json:"streamsLiveUsage,omitempty"`
}

// ProviderStatus is one provider's published state.
type ProviderStatus struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	// Type is the provider type this account is of; Name for a type's default
	// account.
	Type string `json:"type"`
	// AccountLabel says who is signed in to the account, when known.
	AccountLabel string `json:"accountLabel,omitempty"`
	Description  string `json:"description"`
	// DescriptionMessage is the message Description was rendered from, for the
	// UI to show translated with serverText; nil when there is no description.
	DescriptionMessage *msg.Message      `json:"descriptionMessage,omitempty"`
	AuthType           provider.AuthType `json:"authType"`
	AuthSource         string            `json:"authSource,omitempty"`
	SignInMethod       string            `json:"signInMethod,omitempty"`
	AuthHint           string            `json:"authHint,omitempty"`
	// AuthHintMessage is the message AuthHint was rendered from; nil when the
	// hint is data (an error's text) or there is none.
	AuthHintMessage *msg.Message   `json:"authHintMessage,omitempty"`
	ConfigKeyName   string         `json:"configKeyName"`
	EnvVarName      string         `json:"envVarName"`
	APIKeyURL       string         `json:"apiKeyURL"`
	KeySource       core.KeySource `json:"keySource"`
	Available       bool           `json:"available"`
	// Credentialed reports that the provider has what the user was asked to give
	// it — a key saved, or a keyless provider switched on. Available is narrower:
	// it also requires the provider to be able to serve a turn right now.
	//
	// The two differ exactly when a ReadinessCheck refuses, and the settings UI
	// needs both. A toggle drawn from Available alone would flip itself off when
	// a CLI's sign-in lapsed, telling the user they had disabled something they
	// had not.
	Credentialed bool `json:"credentialed"`
	// Disabled reports that the user switched an OAuth provider off. Those are
	// on by default, so for them a false Credentialed alone can't separate "the
	// login lapsed" (switch still on, models listed greyed out) from "the user
	// declined it" (switch off, no models).
	Disabled bool `json:"disabled,omitempty"`
	// SpawnsLocalProcess mirrors ProviderInfo's: this provider is run as a
	// subprocess in the conversation's directory, so a workspace with no
	// directory on this machine cannot host it. The browser pairs it with the
	// workspace row's HostsLocalProviders (workspace.Row) to say so before the
	// turn.
	SpawnsLocalProcess bool `json:"spawnsLocalProcess,omitempty"`
	// Decisions mirrors ProviderInfo's: this provider's models answer decision
	// requests. A picker that chooses a decision model offers only these.
	Decisions bool `json:"decisions,omitempty"`
	// DecisionOnly mirrors ProviderInfo's: this provider cannot hold a
	// conversation, so no chat picker offers its models and nothing that seeds a
	// conversation may choose one. Omitted for the providers that chat, which is
	// nearly all of them.
	DecisionOnly bool `json:"decisionOnly,omitempty"`
	// SwitchTo names a provider better suited to the server this one is pointed
	// at (ProviderInfo.Successor), for the UI to offer the switch. Nil for
	// nearly every provider, and for any provider that is switched off.
	SwitchTo          *ProviderSwitch    `json:"switchTo,omitempty"`
	ModelsWithContext []ModelWithContext `json:"modelsWithContext"`
}

// applyModelLimits replaces a published model's token limits with the user's
// overrides, keeping the provider's own numbers alongside so the settings UI can
// show what clearing an override would restore. A non-positive override is not
// one, so the two limits can be overridden independently.
//
// Applied wherever the catalogue is published, so every consumer — the model
// menu, the footer meter, admission — reads one effective number and none of
// them has to know an override exists.
func applyModelLimits(model ModelWithContext, limits core.ModelLimits) ModelWithContext {
	if limits.ContextWindow > 0 {
		reported := model.ContextWindow
		model.ProviderContextWindow = &reported
		model.ContextWindow = limits.ContextWindow
	}
	if limits.MaxOutputTokens > 0 {
		reported := model.MaxOutputTokens
		model.ProviderMaxOutputTokens = &reported
		model.MaxOutputTokens = limits.MaxOutputTokens
	}
	return model
}

// withDerivedOutputBudget fills DerivedMaxOutputTokens on a published model
// that applyModelLimits has already resolved. providerDerived is the
// provider's own provider.ModelInfo.MaxOutputDerived: its MaxOutputTokens is a
// reserve it derived, not a limit it was told.
//
// The figure is the one normalizeOutputLimit produces from this same entry
// with no output override in force, so the settings field and admission can
// never disagree about what "auto" means.
func withDerivedOutputBudget(model ModelWithContext, providerDerived bool) ModelWithContext {
	if model.ContextWindow <= 0 {
		return model
	}
	own := model.MaxOutputTokens
	if model.ProviderMaxOutputTokens != nil {
		own = *model.ProviderMaxOutputTokens
	}
	budget, substituted := utils.ResolveOutputCap(model.ContextWindow, own)
	if providerDerived || substituted {
		model.DerivedMaxOutputTokens = budget
	}
	return model
}

// publishedModels turns one provider's model listing into its published
// entries, with the user's limits and hidden models applied.
func publishedModels(pInfo provider.ProviderInfo, modelInfos []provider.ModelInfo, settings core.GlobalSettings) []ModelWithContext {
	var models []ModelWithContext
	for _, modelInfo := range modelInfos {
		models = append(models, withDerivedOutputBudget(applyModelLimits(ModelWithContext{
			ID:                   modelInfo.ID,
			DisplayName:          modelInfo.DisplayName,
			ContextWindow:        modelInfo.ContextWindow,
			MaxOutputTokens:      modelInfo.MaxOutputTokens,
			FromAPI:              modelInfo.FromAPI,
			WindowAssumed:        modelInfo.WindowAssumed,
			InputModalities:      modelInfo.InputModalities,
			ThinkingLevels:       modelInfo.ThinkingLevels,
			DefaultThinkingLevel: modelInfo.DefaultThinkingLevel,
			ServiceTiers:         modelInfo.ServiceTiers,
			DefaultServiceTier:   modelInfo.DefaultServiceTier,
			Hidden:               settings.IsModelHidden(pInfo.Name, modelInfo.ID),
			StreamsLiveUsage:     pInfo.StreamsLiveUsage,
		}, settings.ModelLimitsFor(pInfo.Name, modelInfo.ID)), modelInfo.MaxOutputDerived))
	}
	return models
}

func modelContextFallbacks(pInfo provider.ProviderInfo, settings core.GlobalSettings) []ModelWithContext {
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
		models = append(models, withDerivedOutputBudget(applyModelLimits(ModelWithContext{
			ID:               id,
			ContextWindow:    pInfo.ModelContextWindows[id],
			FromAPI:          false,
			WindowAssumed:    pInfo.StaticWindowsAssumed,
			Hidden:           settings.IsModelHidden(pInfo.Name, id),
			StreamsLiveUsage: pInfo.StreamsLiveUsage,
		}, settings.ModelLimitsFor(pInfo.Name, id)), false))
	}
	return models
}

// humanizeModelListError maps a raw model-list failure to a short, human hint
// safe to render in a model-menu row. The raw error is logged separately for
// diagnosis; it must never reach the UI (it leaks wrapped transport internals).
func humanizeModelListError(providerDisplayName string, err error) msg.Message {
	text := strings.ToLower(err.Error())
	switch {
	case strings.Contains(text, "401") || strings.Contains(text, "403") ||
		strings.Contains(text, "unauthorized") || strings.Contains(text, "forbidden") ||
		strings.Contains(text, "invalid api key") || strings.Contains(text, "authentication"):
		return msg.New("Key rejected — check it in Provider Settings")
	case strings.Contains(text, "timeout") || strings.Contains(text, "deadline exceeded") ||
		strings.Contains(text, "no such host") || strings.Contains(text, "connection refused") ||
		strings.Contains(text, "dial tcp") || strings.Contains(text, "network is unreachable"):
		return msg.New("Couldn't reach {provider} — check your connection", "provider", providerDisplayName)
	default:
		return msg.New("Couldn't load models — see Provider Settings")
	}
}

// messageOrNil returns m for a JSON field that is omitted when there is no
// message.
func messageOrNil(m msg.Message) *msg.Message {
	if m.IsZero() {
		return nil
	}
	return &m
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

	// One settings read for the whole fan-out: the store is a single-writer
	// actor, so calling into it from each goroutine would serialise them all
	// against it for no gain, and a mid-fan-out change would be applied to some
	// providers and not others.
	var settings core.GlobalSettings
	if s.settings != nil {
		settings = s.settings.get()
	}

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

			disabled := authType == provider.AuthTypeOAuthBearer && credStore.IsProviderSwitchedOff(pInfo.Name)

			cred, err := credStore.GetProviderCredential(pInfo.Name)
			credentialed := err == nil
			available := credentialed
			authHint, authHintMessage := cred.AuthHint, cred.AuthHintMessage
			setAuthHint := func(m msg.Message) {
				authHint, authHintMessage = m.English(), &m
			}

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
					if !hint.IsZero() {
						setAuthHint(hint)
					}
				}
			}

			var modelsWithContext []ModelWithContext
			if available || readyGated {
				modelInfos, err := s.fetchModels(ctx, pInfo.Name, cred)
				if err == nil {
					s.lastListedModels.Store(pInfo.Name, modelInfos)
					modelsWithContext = publishedModels(pInfo, modelInfos, settings)
				} else {
					available = false
					jlog.Error("computeProviders: list models from %s failed: %v", pInfo.Name, err)
					// Keep the readiness hint (e.g. "sign in") when the provider was
					// already gated unready — it's more actionable than a generic
					// model-list error, and readiness is the real reason it's down.
					if !readyGated {
						setAuthHint(humanizeModelListError(pInfo.DisplayName, err))
					}
					// The last listing that succeeded still says more about each
					// model than the static map does (see lastListedModels).
					if last, ok := s.lastListedModels.Load(pInfo.Name); ok {
						modelsWithContext = publishedModels(pInfo, last.([]provider.ModelInfo), settings)
					} else {
						modelsWithContext = modelContextFallbacks(pInfo, settings)
					}
				}
			} else if authType == provider.AuthTypeOAuthBearer && !disabled {
				// OAuth providers can be discoverable in the UI even while their
				// external CLI login has expired. Publish built-in model fallbacks so
				// the menu can show disabled choices with the authHint. One the user
				// switched off publishes nothing: it is gone, not waiting on a login.
				modelsWithContext = modelContextFallbacks(pInfo, settings)
			}
			if disabled {
				authHint, authHintMessage = "", nil
			}

			var switchTo *ProviderSwitch
			if credentialed {
				switchTo = providerSwitchFor(ctx, pInfo)
			}

			providers[idx] = ProviderStatus{
				Name:               pInfo.Name,
				DisplayName:        pInfo.DisplayName,
				Type:               pInfo.Type,
				AccountLabel:       pInfo.AccountLabel,
				Description:        pInfo.Description.English(),
				DescriptionMessage: messageOrNil(pInfo.Description),
				AuthType:           authType,
				AuthSource:         pInfo.AuthSource,
				SignInMethod:       pInfo.SignInMethod,
				AuthHint:           authHint,
				AuthHintMessage:    authHintMessage,
				ConfigKeyName:      pInfo.ConfigKeyName,
				EnvVarName:         pInfo.EnvVarName,
				APIKeyURL:          pInfo.APIKeyURL,
				KeySource:          cred.KeySource,
				Available:          available,
				Credentialed:       credentialed,
				Disabled:           disabled,
				SpawnsLocalProcess: pInfo.SpawnsLocalProcess,
				Decisions:          pInfo.Decisions,
				DecisionOnly:       pInfo.DecisionOnly,
				SwitchTo:           switchTo,
				ModelsWithContext:  modelsWithContext,
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
	statsProvider, ok := provider.As[provider.UsageStatsProvider](client)
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
	if s.test.offlineProviders {
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

// RefreshProvidersAndWait recomputes the provider list and answers with it:
// the list of a recomputation that began after the call, so it reflects
// whatever changed before it — a sign-in, a key, a server started. It waits on
// the recomputation itself, however long its probes take, until ctx ends.
//
// Coalescing still holds: a request that joins one already queued is served
// by that one, which has not begun yet and so is fresh enough.
func (s *Server) RefreshProvidersAndWait(ctx context.Context) ([]ProviderStatus, error) {
	if s.test.offlineProviders {
		s.RefreshProviders()
		return s.cachedProviders(), nil
	}
	want := s.passesStarted.Load() + 1
	s.RefreshProviders()
	for {
		// The channel is taken before the count is read: a pass publishes its
		// count before it closes the channel, so none is missed between the two.
		finished := s.passFinishedChan()
		if s.passesFinished.Load() >= want {
			return s.cachedProviders(), nil
		}
		select {
		case <-finished:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-s.shutdownChan:
			return nil, errors.New("server is shutting down")
		}
	}
}

// passFinishedChan is the channel the next published recomputation closes.
func (s *Server) passFinishedChan() chan struct{} {
	for {
		if ch := s.passFinished.Load(); ch != nil {
			return *ch
		}
		ch := make(chan struct{})
		s.passFinished.CompareAndSwap(nil, &ch)
	}
}

// passPublished records that recomputation pass has been published, and wakes
// those waiting on one.
func (s *Server) passPublished(pass int64) {
	s.passesFinished.Store(pass)
	next := make(chan struct{})
	if prev := s.passFinished.Swap(&next); prev != nil {
		close(*prev)
	}
}

func (s *Server) runProviderRefreshActor() {
	for {
		select {
		case <-s.shutdownChan:
			return
		case <-s.refreshRequests:
			pass := s.passesStarted.Add(1)
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			compute := s.computeProvidersFunc
			if compute == nil {
				compute = s.computeProviders
			}
			list := compute(ctx)
			cancel()
			s.providersList.Store(&list)
			s.markProvidersReady()
			// This snapshot is the settled, post-compute list — clients that gate
			// startup decisions on real provider availability should trust it.
			s.broadcastToAll(providersUpdateFrame{Type: frameProvidersUpdate, Providers: list, Ready: true})
			s.passPublished(pass)
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
//
// A test server has nothing to wait for and says so by opening the gate. Its
// provider list is mocked, so no discovery will ever populate the cache, and
// the one thing that would open the gate — RefreshProviders — is called at
// startup only by the background services, which start after the engine
// connects. A test server that never reaches them keeps the gate shut for its
// whole life, and every conversation created on it is then charged the full
// timeout inside its create request, since the handler resolves the default
// model before it seeds the doc.
func (s *Server) awaitProvidersReady(ctx context.Context) {
	if s.test.offlineProviders {
		s.markProvidersReady()
		return
	}
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

// preferredAvailableModel returns the (provider, model) for the highest-ranked
// available provider that exposes at least one model, or ok=false when no
// provider is usable. The model is the provider's preferred default
// (defaultModels, normally ProviderInfo.DefaultModels) when one is listed, and
// otherwise its first visible model.
func preferredAvailableModel(providers []ProviderStatus, defaultModels func(providerName string) []string) (core.ModelRef, bool) {
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
		// A provider qualifies only on models the user can actually choose, so
		// one whose whole catalogue is hidden drops out rather than seeding new
		// conversations with a model the menu refuses to offer. A provider that
		// cannot chat drops out for the same reason: the default is a model to
		// hold a conversation on.
		if p.Available && !p.DecisionOnly && firstVisibleModel(p) != "" {
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
	if defaultModels != nil {
		if id := firstListedModel(best, defaultModels(best.Name)); id != "" {
			return core.ModelRef{Provider: best.Name, Model: id}, true
		}
	}
	return core.ModelRef{Provider: best.Name, Model: firstVisibleModel(best)}, true
}

// firstListedModel returns the first of wanted that p lists and the user has
// not hidden, or "". When p's list came from its live catalog, a built-in
// stand-in (FromAPI false) does not count: it is listed whether or not the
// account can call it, and a default is spent without the user choosing it.
func firstListedModel(p ProviderStatus, wanted []string) string {
	live := false
	for _, m := range p.ModelsWithContext {
		if m.FromAPI {
			live = true
			break
		}
	}
	for _, id := range wanted {
		for _, m := range p.ModelsWithContext {
			if m.ID == id && !m.Hidden && (m.FromAPI || !live) {
				return m.ID
			}
		}
	}
	return ""
}

// providerDefaultModels is the registry's ProviderInfo.DefaultModels for a
// provider, as preferredAvailableModel consumes it.
func providerDefaultModels(providerName string) []string {
	info, found := provider.GetProviderInfo(providerName)
	if !found {
		return nil
	}
	return info.DefaultModels
}

// firstVisibleModel returns the id of the provider's first model the user has
// not hidden, or "" when every one of them is hidden.
func firstVisibleModel(p ProviderStatus) string {
	for _, m := range p.ModelsWithContext {
		if !m.Hidden {
			return m.ID
		}
	}
	return ""
}

// resolveDefaultModel returns the concrete {provider, model, thinking?,
// serviceTier?} a new conversation should be seeded with, plus whether it came
// from an explicit user default. An empty Thinking means the model's default
// level, and an empty ServiceTier means standard serving. A derived default
// (no stored ref) never carries a tier: only an explicit user choice does.
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
	ref, _ := preferredAvailableModel(s.cachedProviders(), providerDefaultModels)
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
		// Hidden models are skipped in both passes: the cheap-model hint is
		// resolved on the user's behalf, so it must never land on a model they
		// turned off.
		for _, m := range p.ModelsWithContext {
			if m.ID == wantID && !m.Hidden {
				return m.ID, true
			}
		}
		for _, m := range p.ModelsWithContext {
			if strings.HasPrefix(m.ID, wantID) && !m.Hidden {
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
//  1. Off — the user recorded that they want no cheap model: ok=false, ahead of
//     everything else. It outranks even a valid pin, because the flag answers
//     "should there be one at all" and a pin left over from before they decided
//     must not overrule the decision.
//  2. Explicit — the user pinned a cheap model (cheapModelStore) and its
//     provider is currently available: used as-is.
//  3. Auto-derive — the primary model's provider advertises a
//     ProviderInfo.CheapModel that appears in its live list: used with the
//     matched concrete id, at its lowest thinking level (providerCheapTier).
//  4. Borrowed — the DEFAULT model's provider advertises one, when that is a
//     different, available provider. A conversation on a plan or an aggregator
//     with no cheap tier then still gets its tabs named, using a provider the
//     user already chose to run their work on. The restriction is the point:
//     the cheap tier of a provider merely sitting configured is never spent, or
//     a tab title would quietly bill an account nobody pointed at this
//     conversation.
//  5. Free to run — the primary model's provider bills nothing per token, so
//     the conversation's own model is re-used for the micro-task, minus its
//     thinking level and serving tier. Local runtimes serve whatever the user
//     loaded, so no cheap id could be named for them in advance; what makes
//     this safe is the price, not the locality.
//  6. None of the above → ok=false. Callers that need a model do not run, and
//     the user is told once (see cheapModelForTask). There is no heuristic
//     guess at a cheap id: an unrecognised model is one nobody can vouch is
//     cheap, and the failure would be a surprise bill, not a bad tab name.
//
// The primary ref lets the namer derive a cheap sibling of the conversation's
// own model; the HTTP endpoint passes the resolved default as primary.
func (s *Server) resolveCheapModel(ctx context.Context, primary core.ModelRef) (core.ModelRef, bool) {
	// The live provider list drives both the availability check and the
	// auto-derive validation, so wait out startup discovery once here (a no-op in
	// steady state), exactly as resolveDefaultModel does.
	s.awaitProvidersReady(ctx)

	if s.cheapModelStore != nil {
		if stored, err := s.cheapModelStore.Load(); err == nil {
			if stored.Disabled {
				return core.ModelRef{}, false
			}
			if stored.Provider != "" && stored.Model != "" && s.providerAvailable(stored.Provider) {
				return stored.ModelRef, true
			}
			// Pinned but unavailable: fall through to auto-derive rather than
			// returning a model that cannot run.
		}
	}

	if primary.Provider == "" {
		return core.ModelRef{}, false
	}

	if ref, ok := s.providerCheapTier(primary.Provider); ok {
		return ref, true
	}

	// The primary's provider has no cheap tier. Borrow the default model's, if
	// the user's default sits somewhere else.
	if fallback, _ := s.resolveDefaultModel(ctx); fallback.Provider != "" && fallback.Provider != primary.Provider {
		if ref, ok := s.providerCheapTier(fallback.Provider); ok {
			return ref, true
		}
	}

	if info, found := provider.GetProviderInfo(primary.Provider); found && info.FreeToRun {
		// Provider and model only: the micro-task inherits the model, never the
		// conversation's reasoning budget or paid serving speed.
		return core.ModelRef{Provider: primary.Provider, Model: primary.Model}, true
	}

	return core.ModelRef{}, false
}

// providerCheapTier resolves a provider's advertised cheap-model hint against
// its live list. ok=false when the provider names no cheap tier, is
// unavailable, or publishes nothing matching the hint.
//
// The tier runs at the model's lowest advertised reasoning level. Sending no
// level leaves the provider's own default in force, and that default can be its
// maximum (GLM's is max) — a micro-task bounded in seconds then spends the
// bound thinking and never answers.
func (s *Server) providerCheapTier(providerName string) (core.ModelRef, bool) {
	info, found := provider.GetProviderInfo(providerName)
	if !found || info.CheapModel == "" {
		return core.ModelRef{}, false
	}
	concrete, ok := s.liveModelMatch(providerName, info.CheapModel)
	if !ok {
		return core.ModelRef{}, false
	}
	return core.ModelRef{Provider: providerName, Model: concrete, Thinking: s.lowestThinkingLevel(providerName, concrete)}, true
}

// lowestThinkingLevel returns the first of a live model's advertised thinking
// levels, which are listed least effort first, or "" when it advertises none.
func (s *Server) lowestThinkingLevel(providerName, modelID string) string {
	for _, p := range s.cachedProviders() {
		if p.Name != providerName {
			continue
		}
		for _, m := range p.ModelsWithContext {
			if m.ID == modelID && len(m.ThinkingLevels) > 0 {
				return m.ThinkingLevels[0]
			}
		}
	}
	return ""
}

// handleCheapModel returns the cheap model used for out-of-band micro-tasks.
// When the user has pinned one it is returned as-is (explicit:true). Otherwise
// the server reports the auto-derived cheap sibling of the current default model
// (explicit:false) under `autoResolved`, or omits it when none is available so
// the UI can show a plain "Auto".
//
// `disabled` is reported separately from both, because it is neither: the user
// wants no cheap model, which the empty pair alone cannot say.
//
// Deliberately calls resolveCheapModel rather than cheapModelForTask: this is
// somebody reading the setting, not a task that failed for want of one, and
// nudging them towards the row they are already looking at would also spend the
// single notice a run gets on the one person who does not need it.
func (s *Server) handleCheapModel(w http.ResponseWriter, r *http.Request) {
	var stored core.CheapModelSetting
	if s.cheapModelStore != nil {
		stored, _ = s.cheapModelStore.Load()
	}
	explicit := stored.Provider != "" && stored.Model != ""

	body := map[string]any{"explicit": explicit}
	if stored.Disabled {
		body["disabled"] = true
	}
	switch {
	case stored.Disabled:
		// Nothing to describe: no pin is in effect, and nothing is derived.
	case explicit:
		body["provider"] = stored.Provider
		body["model"] = stored.Model
		if stored.Thinking != "" {
			body["thinking"] = stored.Thinking
		}
		if stored.ServiceTier != "" {
			body["serviceTier"] = stored.ServiceTier
		}
	default:
		primary, _ := s.resolveDefaultModel(r.Context())
		if ref, ok := s.resolveCheapModel(r.Context(), primary); ok {
			body["autoResolved"] = map[string]any{"provider": ref.Provider, "model": ref.Model}
		}
	}
	handlers.WriteJSON(w, r, 0, body)
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
	capabilities, _ := s.resolveModelLimits(providerName, model)
	return capabilities
}

// modelLimitProvenance says where two of a resolved snapshot's numbers came
// from, for the messages that quote them. It is kept out of
// provider.ModelCapabilities, which is the admission snapshot handed to
// providers, because nothing that admits or sends a request has any use for it.
type modelLimitProvenance struct {
	// windowAssumed is true only when the published entry that supplied the
	// window carries WindowAssumed and no user override replaced it.
	windowAssumed bool
	// outputDerived is true when the output limit is Juggler's reserve derived
	// from the window (provider.ContextSafetyReserve): neither the provider nor
	// the user stated a usable one.
	outputDerived bool
	// raiseCeiling is the most a one-off retry may raise the output limit to:
	// the limit the provider itself states for the model, whatever the user
	// overrode it to, or half the window when it states none. 0 when the
	// provider cannot set a request's output length (FixedOutputCap) or no
	// window is known.
	raiseCeiling int64
}

// resolveModelLimits is resolveModelCapabilities together with the provenance
// of its window and output limit.
func (s *Server) resolveModelLimits(providerName, model string) (provider.ModelCapabilities, modelLimitProvenance) {
	assumed, outputDerived := false, false
	// stated is the output limit the provider itself gives for the model, before
	// any user override; 0 when it gives none.
	var stated int64
	info, hasInfo := provider.GetProviderInfo(providerName)
	capabilities := provider.ModelCapabilities{}
	if hasInfo {
		if info.ResolveModelCapabilities != nil {
			if resolved, found := info.ResolveModelCapabilities(model); found {
				capabilities = resolved
				stated = resolved.MaxOutputTokens
			}
		}
		if capabilities.ContextWindowTokens <= 0 {
			if contextWindow, found := info.ModelContextWindows[model]; found && contextWindow > 0 {
				capabilities.ContextWindowTokens = int64(contextWindow)
				assumed = info.StaticWindowsAssumed
			}
		}
	}

	for _, status := range s.cachedProviders() {
		if status.Name != providerName {
			continue
		}
		for _, candidate := range status.ModelsWithContext {
			if candidate.ID != model {
				continue
			}
			if candidate.ContextWindow > 0 {
				capabilities.ContextWindowTokens = int64(candidate.ContextWindow)
				assumed = candidate.WindowAssumed && candidate.ProviderContextWindow == nil
			}
			if candidate.MaxOutputTokens > 0 {
				capabilities.MaxOutputTokens = int64(candidate.MaxOutputTokens)
			}
			// The provider's own figure sits under an override when there is one;
			// a figure it derived from the window is not a limit it stated.
			own := candidate.MaxOutputTokens
			if candidate.ProviderMaxOutputTokens != nil {
				own = *candidate.ProviderMaxOutputTokens
			}
			switch {
			case candidate.DerivedMaxOutputTokens > 0:
				stated = 0
			case own > 0:
				stated = int64(own)
			}
			// The entry derived its budget unless the user overrode it, and unless a
			// static resolver supplied a stated limit the entry left blank.
			outputDerived = candidate.DerivedMaxOutputTokens > 0 && candidate.ProviderMaxOutputTokens == nil &&
				(candidate.MaxOutputTokens > 0 || capabilities.MaxOutputTokens <= 0)
			break
		}
		break
	}

	// The user's override outranks every source above, including the live list.
	// The published entry already carries it, so this is usually a no-op — but
	// only usually: the catalogue is empty until the first refresh lands, and a
	// model a provider does not list at all (a gateway alias, a model named
	// straight into the config) never appears in it. Admission would then run on
	// the stale number the override was written to correct.
	if s.settings != nil {
		settings := s.settings.get()
		limits := settings.ModelLimitsFor(providerName, model)
		if limits.ContextWindow > 0 {
			capabilities.ContextWindowTokens = int64(limits.ContextWindow)
			assumed = false
		}
		if limits.MaxOutputTokens > 0 {
			capabilities.MaxOutputTokens = int64(limits.MaxOutputTokens)
			outputDerived = false
		}
	}
	normalized := normalizeOutputLimit(capabilities)
	// Whatever the sources said, a limit normalizeOutputLimit had to replace was
	// replaced by the derived reserve.
	if normalized.MaxOutputTokens != capabilities.MaxOutputTokens {
		outputDerived = true
	}
	return normalized, modelLimitProvenance{
		windowAssumed: assumed,
		outputDerived: outputDerived,
		raiseCeiling:  outputRaiseCeiling(info, normalized.ContextWindowTokens, stated),
	}
}

// outputRaiseCeiling is how far a one-off retry may raise a model's output
// limit (modelLimitProvenance.raiseCeiling). A stated limit that the window
// cannot hold is the same catalogue artifact normalizeOutputLimit discards, so
// it is treated as no statement at all.
func outputRaiseCeiling(info provider.ProviderInfo, window, stated int64) int64 {
	if info.FixedOutputCap || window <= 0 {
		return 0
	}
	if stated > 0 && int64(utils.ClampOutputToWindow(int(window), int(stated))) == stated {
		return stated
	}
	return window / 2
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
// for any provider that misreports; sources may also clamp at their own layer,
// through the same shared rule.
func normalizeOutputLimit(capabilities provider.ModelCapabilities) provider.ModelCapabilities {
	capabilities.MaxOutputTokens = int64(utils.ClampOutputToWindow(
		int(capabilities.ContextWindowTokens), int(capabilities.MaxOutputTokens)))
	return capabilities
}

// handleProviders returns the cached provider/model list. The list is
// populated at startup and on every credential change via RefreshProviders;
// this handler never makes upstream calls of its own.
//
// `ready` reports whether that first refresh has completed, exactly as the
// connect-time seed push does (see the providers-update send in
// realtime_loop.go). Until it has, the cache is empty, and an empty list is
// indistinguishable from a genuine "no providers configured" result — a caller
// that renders the list without checking this flag paints a blank page during
// the startup window. Clients that get `false` should wait for the settled
// providers-update rather than trust the array.
func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, map[string]any{
		"providers": s.cachedProviders(),
		"ready":     s.providersReadyNow(),
	})
}

// handleRefreshProviders queues a provider/model refresh and returns the current
// cached list immediately. Clients receive the refreshed list via providers-update
// once model discovery completes.
//
// This is the only refresh that discards memoised auto-detection. It is the one a
// person asked for — the settings re-check button, and first-run setup's "check
// again" after being sent off to install a CLI — so the machine is read afresh
// rather than reported as it was at startup. The refreshes that fire on every
// credential change keep the memo, which is what stops a PATH scan running on
// each pass.
func (s *Server) handleRefreshProviders(w http.ResponseWriter, r *http.Request) {
	provider.InvalidateAutoDetect()
	providers, err := s.RefreshProvidersAndWait(r.Context())
	if err != nil {
		handlers.WriteErr(w, r, http.StatusServiceUnavailable, err)
		return
	}
	handlers.WriteSuccess(w, r, map[string]any{
		"providers": providers,
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
	if s.test.offlineProviders {
		handlers.WriteJSON(w, r, 0, map[string]any{
			"usage":  []provider.UsageStats{},
			"errors": map[string]string{},
		})
		return
	}

	credStore, err := core.NewCredentialsStore()
	if err != nil {
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
			"error": fmt.Sprintf("Couldn't initialize credentials store: %v", err),
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
