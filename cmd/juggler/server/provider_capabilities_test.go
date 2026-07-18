//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestResolveModelCapabilities(t *testing.T) {
	const providerName = "test_capability_resolution"
	provider.RegisterProvider(provider.ProviderInfo{
		Name: providerName,
		ModelContextWindows: map[string]int{
			"live-model":   111,
			"static-model": 222,
		},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	s := &Server{}
	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{{
			ID:              "live-model",
			ContextWindow:   333,
			MaxOutputTokens: 44,
		}},
	}}
	s.providersList.Store(&providers)

	tests := []struct {
		name  string
		model string
		want  provider.ModelCapabilities
	}{
		{
			name:  "exact live model wins over static metadata",
			model: "live-model",
			want: provider.ModelCapabilities{
				ContextWindowTokens: 333,
				MaxOutputTokens:     44,
			},
		},
		{
			name:  "missing live model uses static context only",
			model: "static-model",
			want:  provider.ModelCapabilities{ContextWindowTokens: 222},
		},
		{
			name:  "unknown model remains unknown",
			model: "unknown-model",
			want:  provider.ModelCapabilities{},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := s.resolveModelCapabilities(providerName, test.model); got != test.want {
				t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, test.want)
			}
		})
	}
}

func TestResolveModelCapabilitiesStaticResolverAndLivePrecedence(t *testing.T) {
	const providerName = "test_capability_static_resolver"
	fallback := provider.ModelCapabilities{
		ContextWindowTokens:    200000,
		MaxOutputTokens:        64000,
		ProviderOverheadTokens: 40000,
	}
	provider.RegisterProvider(provider.ProviderInfo{
		Name: providerName,
		ResolveModelCapabilities: func(model string) (provider.ModelCapabilities, bool) {
			return fallback, model == "sonnet"
		},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	t.Run("fresh alias uses conservative fallback", func(t *testing.T) {
		s := &Server{}
		if got := s.resolveModelCapabilities(providerName, "sonnet"); got != fallback {
			t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, fallback)
		}
		if got := s.resolveModelCapabilities(providerName, "custom"); got != (provider.ModelCapabilities{}) {
			t.Fatalf("unknown alias = %+v, want unknown", got)
		}
	})

	t.Run("positive live limits override fallback and retain overhead", func(t *testing.T) {
		s := &Server{}
		providers := []ProviderStatus{{
			Name: providerName,
			ModelsWithContext: []ModelWithContext{{
				ID: "sonnet", ContextWindow: 1000000, MaxOutputTokens: 32000,
			}},
		}}
		s.providersList.Store(&providers)
		want := provider.ModelCapabilities{
			ContextWindowTokens:    1000000,
			MaxOutputTokens:        32000,
			ProviderOverheadTokens: 40000,
		}
		if got := s.resolveModelCapabilities(providerName, "sonnet"); got != want {
			t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, want)
		}
	})
}

func TestResolveModelCapabilitiesKeepsFallbackForNonPositiveLiveValues(t *testing.T) {
	const providerName = "test_capability_live_unknown"
	provider.RegisterProvider(provider.ProviderInfo{
		Name:                providerName,
		ModelContextWindows: map[string]int{"model": 999},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	s := &Server{}
	providers := []ProviderStatus{{
		Name:              providerName,
		ModelsWithContext: []ModelWithContext{{ID: "model"}},
	}}
	s.providersList.Store(&providers)

	if got := s.resolveModelCapabilities(providerName, "model"); got != (provider.ModelCapabilities{ContextWindowTokens: 999}) {
		t.Fatalf("resolveModelCapabilities() = %+v, want positive static fallback", got)
	}
}
