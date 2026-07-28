//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

func TestRegisterPublishesDescriptorCapabilities(t *testing.T) {
	name := "openaibase-capabilities-" + t.Name()
	Register(Descriptor{
		Name:             name,
		ContextAdmission: provider.ContextAdmissionSilentTruncationGuard,
		ContextWindowFn: func(model string) (int, int) {
			if model != "known" {
				return 0, 0
			}
			return 2000, 200
		},
	})

	info, found := provider.GetProviderInfo(name)
	if !found || info.ResolveModelCapabilities == nil {
		t.Fatal("registered provider has no capability resolver")
	}
	if info.ContextAdmission != provider.ContextAdmissionSilentTruncationGuard {
		t.Fatalf("context admission = %q, want silent-truncation guard", info.ContextAdmission)
	}
	got, found := info.ResolveModelCapabilities("known")
	want := provider.ModelCapabilities{ContextWindowTokens: 2000, MaxOutputTokens: 200}
	if !found || got != want {
		t.Fatalf("known capabilities = (%+v, %v), want (%+v, true)", got, found, want)
	}
	if got, found := info.ResolveModelCapabilities("unknown"); found || got != (provider.ModelCapabilities{}) {
		t.Fatalf("unknown capabilities = (%+v, %v), want zero, false", got, found)
	}
}

func TestRegisterMapsForcedToolChoiceQuirkToCapability(t *testing.T) {
	cases := []struct {
		name            string
		supported       bool
		wantUnsupported bool
	}{
		{name: "supports forced tool choice", supported: true, wantUnsupported: false},
		{name: "does not support forced tool choice", supported: false, wantUnsupported: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			name := "openaibase-forced-tool-" + t.Name()
			Register(Descriptor{
				Name:            name,
				ContextWindowFn: func(string) (int, int) { return 2000, 200 },
				Quirks:          Quirks{ForcedToolChoiceSupported: tc.supported},
			})
			info, found := provider.GetProviderInfo(name)
			if !found {
				t.Fatal("provider not registered")
			}
			if info.ForcedToolChoiceUnsupported != tc.wantUnsupported {
				t.Fatalf("ForcedToolChoiceUnsupported = %v, want %v", info.ForcedToolChoiceUnsupported, tc.wantUnsupported)
			}
		})
	}
}

func TestRegisterCapsResolverVouchesOnlyForCataloguedModels(t *testing.T) {
	name := "openaibase-caps-resolver-" + t.Name()
	Register(Descriptor{
		Name:              name,
		ContextWindowCaps: utils.ModelCaps{Default: 100000, Overrides: map[string]int{"known": 2000}},
		MaxOutputCaps:     utils.ModelCaps{Default: 4000},
	})

	info, found := provider.GetProviderInfo(name)
	if !found || info.ResolveModelCapabilities == nil {
		t.Fatal("registered provider has no capability resolver")
	}
	// A catalogued id resolves, with defaults filling the dimensions that
	// lack an override.
	got, found := info.ResolveModelCapabilities("known")
	want := provider.ModelCapabilities{ContextWindowTokens: 2000, MaxOutputTokens: 4000}
	if !found || got != want {
		t.Fatalf("catalogued capabilities = (%+v, %v), want (%+v, true)", got, found, want)
	}
	// An uncatalogued id (e.g. a user-invented alias) fails closed instead of
	// inheriting the provider defaults as a fabricated limit.
	if got, found := info.ResolveModelCapabilities("user-invented-alias"); found || got != (provider.ModelCapabilities{}) {
		t.Fatalf("uncatalogued capabilities = (%+v, %v), want zero, false", got, found)
	}
}
