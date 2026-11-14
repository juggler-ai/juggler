//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// findProviderStatus returns the named entry of a computeProviders result.
func findProviderStatus(t *testing.T, list []ProviderStatus, name string) ProviderStatus {
	t.Helper()
	for _, p := range list {
		if p.Name == name {
			return p
		}
	}
	t.Fatalf("provider %s missing from computeProviders result", name)
	return ProviderStatus{}
}

// TestComputeProvidersOAuthSwitch: an OAuth provider (the Codex plan, Copilot)
// is on whenever its external login is present, until the user switches it
// off. Switched off, it must leave the model menu entirely — no greyed-out
// fallbacks, which are for a login that has lapsed, not one the user declined —
// and say that it is off rather than signed out.
func TestComputeProvidersOAuthSwitch(t *testing.T) {
	const name = "oauthswitch"
	const source = "oauthswitch_src"
	core.RegisterOAuthSource(source, core.OAuthSource{Resolve: func() (core.ProviderCredential, error) {
		return core.ProviderCredential{BearerToken: "tok", AuthHint: "Signed in"}, nil
	}})
	provider.RegisterProvider(provider.ProviderInfo{
		Name:       name,
		AuthType:   provider.AuthTypeOAuthBearer,
		AuthSource: source,
	}, func(provider.Config) (provider.Provider, error) {
		return fakeModelProvider{name: name}, nil
	})
	userpathstest.Isolate(t)

	on := findProviderStatus(t, (&Server{}).computeProviders(context.Background()), name)
	if !on.Available || !on.Credentialed || on.Disabled {
		t.Fatalf("with no choice recorded a signed-in OAuth provider must be on: %+v", on)
	}
	if len(on.ModelsWithContext) == 0 {
		t.Fatalf("an enabled provider must list its models")
	}

	credStore, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatalf("new credentials store: %v", err)
	}
	if err := credStore.SetProviderEnabled(name, false); err != nil {
		t.Fatalf("switch off: %v", err)
	}

	off := findProviderStatus(t, (&Server{}).computeProviders(context.Background()), name)
	if off.Available || off.Credentialed {
		t.Fatalf("a switched-off provider must not serve: %+v", off)
	}
	if !off.Disabled {
		t.Fatalf("a switched-off provider must report Disabled so the UI draws its switch off")
	}
	if len(off.ModelsWithContext) != 0 {
		t.Fatalf("a switched-off provider must publish no models, got %d", len(off.ModelsWithContext))
	}

	if err := credStore.SetProviderEnabled(name, true); err != nil {
		t.Fatalf("switch on: %v", err)
	}
	back := findProviderStatus(t, (&Server{}).computeProviders(context.Background()), name)
	if !back.Available || back.Disabled {
		t.Fatalf("switching back on must restore the provider: %+v", back)
	}
}
