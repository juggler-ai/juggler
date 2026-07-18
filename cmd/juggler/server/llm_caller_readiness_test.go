//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/worker"
)

func TestLLMCallerWaitsForStartupCapabilities(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	const providerName = "test_startup_capabilities"
	configs := make(chan provider.Config, 1)
	var opened []*capabilityCacheConversation
	provider.RegisterProvider(provider.ProviderInfo{
		Name:     providerName,
		AuthType: provider.AuthTypeToggle,
	}, func(cfg provider.Config) (provider.Provider, error) {
		configs <- cfg
		return &capabilityCacheProvider{opened: &opened}, nil
	})
	credentials, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := credentials.SetProviderEnabled(providerName, true); err != nil {
		t.Fatal(err)
	}

	s := newTestServerState(t)
	s.providersReady = make(chan struct{})
	s.shutdownChan = make(chan struct{})
	s.conversationCache = newConversationCache()
	t.Cleanup(s.conversationCache.Shutdown)

	request, err := json.Marshal(map[string]any{
		"conversationId": "conv",
		"modelConfig": map[string]string{
			"provider": providerName,
			"model":    "model",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, callErr := s.createLLMCaller()(context.Background(), request, func(worker.StreamChunk) {})
		result <- callErr
	}()

	select {
	case cfg := <-configs:
		t.Fatalf("dispatch captured startup config early: %+v", cfg)
	case <-time.After(50 * time.Millisecond):
	}

	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{{
			ID: "model", ContextWindow: 123456, MaxOutputTokens: 789,
		}},
	}}
	s.providersList.Store(&providers)
	s.markProvidersReady()

	select {
	case cfg := <-configs:
		want := provider.ModelCapabilities{ContextWindowTokens: 123456, MaxOutputTokens: 789}
		if cfg.ModelCapabilities != want {
			t.Fatalf("captured capabilities = %+v, want %+v", cfg.ModelCapabilities, want)
		}
	case <-time.After(time.Second):
		t.Fatal("dispatch did not initialize provider after readiness")
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("LLM call failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("LLM call did not finish")
	}
}

func TestLLMCallerRejectsOversizedRootBeforeProviderSubmit(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	const providerName = "test_root_admission"
	var opened []*capabilityCacheConversation
	provider.RegisterProvider(provider.ProviderInfo{
		Name:     providerName,
		AuthType: provider.AuthTypeToggle,
	}, func(provider.Config) (provider.Provider, error) {
		return &capabilityCacheProvider{opened: &opened}, nil
	})
	credentials, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := credentials.SetProviderEnabled(providerName, true); err != nil {
		t.Fatal(err)
	}

	s := newTestServerState(t)
	s.providersReady = make(chan struct{})
	s.shutdownChan = make(chan struct{})
	s.conversationCache = newConversationCache()
	t.Cleanup(s.conversationCache.Shutdown)
	providers := []ProviderStatus{{Name: providerName, ModelsWithContext: []ModelWithContext{{
		ID: "tiny", ContextWindow: 100, MaxOutputTokens: 20,
	}}}}
	s.providersList.Store(&providers)
	s.markProvidersReady()

	request, err := json.Marshal(map[string]any{
		"conversationId": "root-conv",
		"threadId":       "",
		"messages": []map[string]string{{
			"type": "user", "content": strings.Repeat("oversized ", 1000),
		}},
		"modelConfig": map[string]string{"provider": providerName, "model": "tiny"},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.createLLMCaller()(context.Background(), request, func(worker.StreamChunk) {
		t.Fatal("rejected root request streamed a chunk")
	})
	var exceeded *provider.ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if len(opened) != 1 {
		t.Fatalf("opened conversations = %d, want 1", len(opened))
	}
	if opened[0].submits != 0 {
		t.Fatalf("underlying provider submits = %d, want 0", opened[0].submits)
	}
}

func TestLLMCallerProviderReadinessHonoursContext(t *testing.T) {
	s := newTestServerState(t)
	s.providersReady = make(chan struct{})
	s.shutdownChan = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := s.createLLMCaller()(ctx, json.RawMessage(`{"modelConfig":{"provider":"unused","model":"unused"}}`), func(worker.StreamChunk) {})
	if err != context.Canceled {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}
