//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/worker"
)

// flakyCatalogProvider lists one model with a live 872k window until down is
// set, then fails the way an unreachable catalog does.
type flakyCatalogProvider struct {
	name string
	down *atomic.Bool
}

func (p flakyCatalogProvider) Name() string { return p.name }
func (p flakyCatalogProvider) ListModelsWithInfo(context.Context) ([]provider.ModelInfo, error) {
	if p.down.Load() {
		return nil, errors.New("request failed: context deadline exceeded")
	}
	return []provider.ModelInfo{{ID: "astra", ContextWindow: 872000, MaxOutputTokens: 128000, FromAPI: true}}, nil
}
func (p flakyCatalogProvider) OpenConversation(context.Context, string) (provider.Conversation, error) {
	return nil, nil
}

// registerFlakyCatalog registers an OAuth provider (the Codex plan's shape)
// whose static windows are 272k stand-ins for a catalog that reports 872k.
func registerFlakyCatalog(t *testing.T, name string) *atomic.Bool {
	t.Helper()
	source := name + "_src"
	core.RegisterOAuthSource(source, core.OAuthSource{Resolve: func() (core.ProviderCredential, error) {
		return core.ProviderCredential{BearerToken: "tok"}, nil
	}})
	down := new(atomic.Bool)
	provider.RegisterProvider(provider.ProviderInfo{
		Name:                   name,
		AuthType:               provider.AuthTypeOAuthBearer,
		AuthSource:             source,
		ModelContextWindows:    map[string]int{"astra": 272000},
		StaticWindowsAssumed:   true,
		RejectsContextOverflow: true,
	}, func(provider.Config) (provider.Provider, error) {
		return flakyCatalogProvider{name: name, down: down}, nil
	})
	return down
}

// publishedModel returns the named model's published entry.
func publishedModel(t *testing.T, status ProviderStatus, id string) ModelWithContext {
	t.Helper()
	for _, m := range status.ModelsWithContext {
		if m.ID == id {
			return m
		}
	}
	t.Fatalf("model %s not published by %s: %+v", id, status.Name, status.ModelsWithContext)
	return ModelWithContext{}
}

// TestFailedCatalogRefreshKeepsLastReportedWindows is the incident: one timed-out
// refresh of the Codex catalog replaced gpt-6-astra's reported 872k window with
// the 272k stand-in, and the next turn compacted ~300k tokens of history it had
// room for. A refresh that fails says nothing new about a model's window, so the
// last one the provider reported stands.
func TestFailedCatalogRefreshKeepsLastReportedWindows(t *testing.T) {
	const name = "flakycatalog"
	down := registerFlakyCatalog(t, name)
	writeEnabledProviders(t)
	s := &Server{}

	first := findProviderStatus(t, s.computeProviders(context.Background()), name)
	if got := publishedModel(t, first, "astra").ContextWindow; got != 872000 {
		t.Fatalf("live window = %d, want 872000", got)
	}
	list := []ProviderStatus{first}
	s.providersList.Store(&list)

	down.Store(true)
	failed := findProviderStatus(t, s.computeProviders(context.Background()), name)
	if failed.Available {
		t.Fatalf("a provider whose catalog is unreachable must not read as available: %+v", failed)
	}
	astra := publishedModel(t, failed, "astra")
	if astra.ContextWindow != 872000 || astra.WindowAssumed {
		t.Fatalf("after a failed refresh astra = %+v, want the last reported 872000 window, not assumed", astra)
	}
}

// TestStandInWindowsAreAssumed: with no report to fall back on, a provider's
// static stand-in is a guess and is published as one — which is what tells the
// worker (and the user, through the assumed-window notice) that the window
// compaction would run against was never confirmed.
func TestStandInWindowsAreAssumed(t *testing.T) {
	const name = "flakycatalog_cold"
	down := registerFlakyCatalog(t, name)
	writeEnabledProviders(t)
	down.Store(true)
	s := &Server{}

	status := findProviderStatus(t, s.computeProviders(context.Background()), name)
	astra := publishedModel(t, status, "astra")
	if astra.ContextWindow != 272000 || !astra.WindowAssumed {
		t.Fatalf("cold fallback astra = %+v, want the 272000 stand-in marked assumed", astra)
	}

	// Before any refresh has published anything, resolution reads the static
	// map directly; that is the same guess.
	resolve := (&Server{}).createWindowResolver()
	got := resolve(worker.ModelConfig{Provider: name, Model: "astra"})
	if got.WindowTokens != 272000 || !got.Assumed || !got.OverflowRejected {
		t.Fatalf("resolver with nothing published = %+v, want 272000 assumed on a provider that rejects overflow", got)
	}

	list := []ProviderStatus{status}
	s.providersList.Store(&list)
	if got := s.createWindowResolver()(worker.ModelConfig{Provider: name, Model: "astra"}); !got.Assumed || !got.OverflowRejected {
		t.Fatalf("resolver over the published stand-in = %+v, want assumed on a provider that rejects overflow", got)
	}
}
