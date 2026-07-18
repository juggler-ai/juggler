//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestConservativeAliasCapabilities(t *testing.T) {
	cases := map[string]int64{
		"opus": 32000, "sonnet": 64000, "haiku": 32000, "fable": 64000,
	}
	for alias, maxOutput := range cases {
		got, ok := conservativeAliasCapabilities(alias)
		want := provider.ModelCapabilities{
			ContextWindowTokens:    200000,
			MaxOutputTokens:        maxOutput,
			ProviderOverheadTokens: 40000,
		}
		if !ok || got != want {
			t.Errorf("%s capabilities = %+v, %v; want %+v, true", alias, got, ok, want)
		}
	}
	if got, ok := conservativeAliasCapabilities("custom-claude"); ok || got != (provider.ModelCapabilities{}) {
		t.Fatalf("unknown alias capabilities = %+v, %v; want zero, false", got, ok)
	}
}

// TestInfoAllowsUnknownLimitsForLearnOnFirstTurn pins the escape hatch: a
// verbatim custom model id can only discover its real limits by running the
// CLI once, which fail-closed admission would otherwise prevent.
func TestInfoAllowsUnknownLimitsForLearnOnFirstTurn(t *testing.T) {
	if !Info().AllowUnknownLimits {
		t.Fatal("claudecode Info must allow unknown limits (learn-on-first-turn for custom aliases)")
	}
}
