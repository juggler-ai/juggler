//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestRegisterPublishesDescriptorCapabilities(t *testing.T) {
	name := "openaibase-capabilities-" + t.Name()
	Register(Descriptor{
		Name: name,
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
	got, found := info.ResolveModelCapabilities("known")
	want := provider.ModelCapabilities{ContextWindowTokens: 2000, MaxOutputTokens: 200}
	if !found || got != want {
		t.Fatalf("known capabilities = (%+v, %v), want (%+v, true)", got, found, want)
	}
	if got, found := info.ResolveModelCapabilities("unknown"); found || got != (provider.ModelCapabilities{}) {
		t.Fatalf("unknown capabilities = (%+v, %v), want zero, false", got, found)
	}
}
