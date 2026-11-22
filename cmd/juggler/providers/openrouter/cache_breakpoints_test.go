//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import "testing"

// TestCacheBreakpoints pins which models are sent explicit cache breakpoints:
// Anthropic's, which cache nothing without them, including OpenRouter's "~"
// latest-version aliases. Every other vendor caches on its own.
func TestCacheBreakpoints(t *testing.T) {
	for _, tc := range []struct {
		model string
		want  bool
	}{
		{"anthropic/claude-haiku-4.5", true},
		{"Anthropic/Claude-Sonnet-4.5", true},
		{"~anthropic/claude-sonnet-latest", true},
		{"z-ai/glm-5.3", false},
		{"openai/gpt-5.5", false},
		{"google/gemini-3-pro", false},
	} {
		if got := cacheBreakpoints(tc.model); got != tc.want {
			t.Errorf("cacheBreakpoints(%q) = %v, want %v", tc.model, got, tc.want)
		}
	}
}
