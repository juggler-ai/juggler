//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	provider "juggler/cmd/juggler/providers/registry"
)

type capabilityCacheProvider struct {
	opened *[]*capabilityCacheConversation
}

func (p *capabilityCacheProvider) Name() string { return "test_capability_cache" }
func (p *capabilityCacheProvider) ListModelsWithInfo(context.Context) ([]provider.ModelInfo, error) {
	return nil, nil
}
func (p *capabilityCacheProvider) OpenConversation(context.Context, string) (provider.Conversation, error) {
	conv := &capabilityCacheConversation{}
	*p.opened = append(*p.opened, conv)
	return conv, nil
}

type capabilityCacheConversation struct {
	closed  bool
	submits int
}

func (c *capabilityCacheConversation) Submit(context.Context, provider.MessageRequest, provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	c.submits++
	return &provider.StreamResult{}, nil
}
func (c *capabilityCacheConversation) Subscribe(provider.TurnSink) {}
func (c *capabilityCacheConversation) CacheTTL() time.Duration     { return 0 }
func (c *capabilityCacheConversation) Cancel()                     {}
func (c *capabilityCacheConversation) Close() error {
	c.closed = true
	return nil
}

func TestConversationCacheCapabilitiesArePartOfIdentity(t *testing.T) {
	const providerName = "test_capability_cache"
	var configs []provider.Config
	var opened []*capabilityCacheConversation
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(cfg provider.Config) (provider.Provider, error) {
		configs = append(configs, cfg)
		return &capabilityCacheProvider{opened: &opened}, nil
	})

	cache := newConversationCache()
	t.Cleanup(cache.Shutdown)
	credential := core.ProviderCredential{APIKey: "test-key"}
	firstCapabilities := provider.ModelCapabilities{ContextWindowTokens: 1000, MaxOutputTokens: 100}
	first, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", credential, firstCapabilities)
	if err != nil {
		t.Fatalf("first GetOrOpen: %v", err)
	}
	reused, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", credential, firstCapabilities)
	if err != nil {
		t.Fatalf("reused GetOrOpen: %v", err)
	}
	if reused != first {
		t.Fatal("unchanged capabilities did not reuse cached conversation")
	}
	if len(configs) != 1 || configs[0].ModelCapabilities != firstCapabilities {
		t.Fatalf("initial configs = %+v, want one config with capabilities %+v", configs, firstCapabilities)
	}

	secondCapabilities := provider.ModelCapabilities{ContextWindowTokens: 2000, MaxOutputTokens: 200}
	second, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", credential, secondCapabilities)
	if err != nil {
		t.Fatalf("changed GetOrOpen: %v", err)
	}
	if second == first {
		t.Fatal("changed capabilities reused incompatible cached conversation")
	}
	if len(configs) != 2 || configs[1].ModelCapabilities != secondCapabilities {
		t.Fatalf("changed configs = %+v, want second config with capabilities %+v", configs, secondCapabilities)
	}
	if len(opened) != 2 || !opened[0].closed {
		t.Fatalf("opened conversations = %+v, want old handle closed before replacement", opened)
	}
}

func TestConversationCacheAllowUnknownLimitsFlowsToAdmission(t *testing.T) {
	credential := core.ProviderCredential{APIKey: "test-key"}
	newCache := func() *conversationCache {
		cache := newConversationCache()
		t.Cleanup(cache.Shutdown)
		return cache
	}
	register := func(name string, allowUnknown bool) *[]*capabilityCacheConversation {
		opened := &[]*capabilityCacheConversation{}
		provider.RegisterProvider(provider.ProviderInfo{Name: name, AllowUnknownLimits: allowUnknown}, func(provider.Config) (provider.Provider, error) {
			return &capabilityCacheProvider{opened: opened}, nil
		})
		return opened
	}

	// Unknown limits (zero capabilities) against a provider that did not opt
	// out must keep failing closed.
	closedName := "test_unknown_limits_closed_" + t.Name()
	register(closedName, false)
	closedConv, err := newCache().GetOrOpen(context.Background(), "conv", closedName, "model", credential, provider.ModelCapabilities{})
	if err != nil {
		t.Fatalf("closed GetOrOpen: %v", err)
	}
	if _, err := closedConv.Submit(context.Background(), provider.MessageRequest{}, nil); err == nil {
		t.Fatal("closed provider admitted request with unknown limits")
	} else {
		var unknown *provider.UnknownContextLimitError
		if !errors.As(err, &unknown) {
			t.Fatalf("closed Submit error = %T %v, want UnknownContextLimitError", err, err)
		}
	}

	// A provider that declares AllowUnknownLimits (e.g. acp) must dispatch
	// unchecked, or every one of its turns would die at admission.
	openName := "test_unknown_limits_open_" + t.Name()
	opened := register(openName, true)
	openConv, err := newCache().GetOrOpen(context.Background(), "conv", openName, "model", credential, provider.ModelCapabilities{})
	if err != nil {
		t.Fatalf("open GetOrOpen: %v", err)
	}
	if _, err := openConv.Submit(context.Background(), provider.MessageRequest{}, nil); err != nil {
		t.Fatalf("open provider rejected request despite AllowUnknownLimits: %v", err)
	}
	if len(*opened) != 1 || (*opened)[0].submits != 1 {
		t.Fatalf("opened = %+v, want exactly one passthrough submit", *opened)
	}
}
