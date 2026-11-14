//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

// TestPrepareSettingsKeepsAnEndpointAndNothingElse: what the add form and the
// card post is put in the one form accounts.json stores — base URL, protocol
// and headers, nothing else — and one that could never serve is refused.
func TestPrepareSettingsKeepsAnEndpointAndNothingElse(t *testing.T) {
	got, err := prepareSettings(map[string]any{
		"baseURL": "  https://gateway.acme.test/v1 ",
		"headers": map[string]any{"X-Tenant": "acme"},
		"stray":   "dropped",
	})
	if err != nil {
		t.Fatalf("prepareSettings: %v", err)
	}
	inst := instanceFromEntry(core.AccountEntry{Settings: got})
	if inst.BaseURL != "https://gateway.acme.test/v1" || inst.Headers["X-Tenant"] != "acme" {
		t.Fatalf("prepared as %+v", inst)
	}
	if _, stray := got["stray"]; stray {
		t.Fatalf("prepared settings kept a field an endpoint does not have: %v", got)
	}
	if inst.EffectiveProtocol() != ProtocolOpenAI {
		t.Fatalf("blank protocol resolved to %q", inst.EffectiveProtocol())
	}
	if _, err := prepareSettings(map[string]any{"baseURL": "not a url at all"}); err == nil {
		t.Fatal("prepareSettings accepted an endpoint with no usable base URL")
	}
}

// TestKeySlotKeepsTheLegacyEndpointsKey: the endpoint carried over from the
// single custom provider keeps the credential and variable it always had, so
// its key is found without being moved; every other endpoint has its own.
func TestKeySlotKeepsTheLegacyEndpointsKey(t *testing.T) {
	for id, want := range map[string][2]string{
		LegacyID:         {legacyAPIKeyCredKey, legacyEnvVarName},
		"custom-acme-eu": {"custom_acme-eu_api_key", "CUSTOM_ACME_EU_API_KEY"},
	} {
		if key, envVar := keySlot(id); key != want[0] || envVar != want[1] {
			t.Errorf("keySlot(%q) = %q, %q; want %q, %q", id, key, envVar, want[0], want[1])
		}
	}
}

// TestRegisteredNameIsSelectorSafe guards the reason the prefix is a hyphen: the
// settings UI builds DOM ids from a provider id and finds them again with
// querySelector("#<id>-key"), where a colon would parse as a pseudo-class.
func TestRegisteredNameIsSelectorSafe(t *testing.T) {
	got := RegisteredName("acme-eu")
	if strings.ContainsAny(got, ":/ .#[]") {
		t.Fatalf("RegisteredName = %q, which is not safe in a CSS id selector", got)
	}
	if got != "custom-acme-eu" {
		t.Fatalf("RegisteredName = %q, want custom-acme-eu", got)
	}
}

func TestValidateInstanceRejections(t *testing.T) {
	for _, tc := range []struct {
		name string
		inst Instance
	}{
		{"no base URL", Instance{}},
		{"blank base URL", Instance{BaseURL: "   "}},
		{"no scheme", Instance{BaseURL: "gateway.test/v1"}},
		{"wrong scheme", Instance{BaseURL: "ftp://gateway.test/v1"}},
		{"no host", Instance{BaseURL: "https:///v1"}},
		{"unknown protocol", Instance{Protocol: "anthropic", BaseURL: "https://gateway.test"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateInstance(tc.inst); err == nil {
				t.Fatalf("ValidateInstance(%+v) accepted it", tc.inst)
			}
		})
	}
}
