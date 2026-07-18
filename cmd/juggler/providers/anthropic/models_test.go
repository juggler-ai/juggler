//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestGetMaxOutputTokens pins the per-model output ceiling. The provider used to
// hardcode 8192 for every model, which (a) silently truncated Sonnet/Opus 4.x
// responses (32k–64k) at 8192 and (b) exceeded the 4096 ceiling of the Claude 3
// (non-3.5) models, producing a hard 400 on every request. The detection must be
// robust to the dated model ids the Models API actually returns.
func TestGetMaxOutputTokens(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		// Claude 3 (non-3.5): 4096 — the ids that 400'd on max_tokens=8192.
		{"claude-3-opus-20240229", 4096},
		{"claude-3-opus", 4096},
		{"claude-3-haiku-20240307", 4096},
		{"claude-3-sonnet-20240229", 4096},
		// Claude 3.5 / 3.7 Sonnet & Haiku.
		{"claude-3-5-sonnet-20241022", 8192},
		{"claude-3-5-sonnet-20240620", 8192},
		{"claude-3-5-haiku-20241022", 8192},
		{"claude-3-7-sonnet-20250219", 64000},
		// Claude 4.x — dated API ids AND short aliases (both naming orders) resolve.
		{"claude-sonnet-4-20250514", 64000},
		{"claude-sonnet-4-5-20250929", 64000},
		{"claude-sonnet-4.5", 64000},
		{"claude-4.5-sonnet", 64000},
		{"claude-haiku-4-5-20251001", 64000},
		{"claude-opus-4-20250514", 32000},
		{"claude-opus-4-1-20250805", 32000},
		// Unknown / empty → conservative default (never below a known model's min).
		{"some-future-model", defaultMaxOutputTokens},
		{"", defaultMaxOutputTokens},
	}
	for _, tc := range cases {
		if got := GetMaxOutputTokens(tc.model); got != tc.want {
			t.Errorf("GetMaxOutputTokens(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

func TestBuildMessageParamsUsesAdmissionCapability(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929", maxOutputTokens: 12345}
	params := c.buildMessageParams(provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	})
	if params.MaxTokens != 12345 {
		t.Fatalf("MaxTokens = %d, want admission capability 12345", params.MaxTokens)
	}
}

// derived from the model, not a fixed 8192 — in particular that a Claude 3 Opus
// request stays at its 4096 ceiling (the value the API rejected before) and a
// Sonnet 4.5 request is allowed its full 64000.
func TestBuildMessageParamsMaxTokensPerModel(t *testing.T) {
	cases := []struct {
		model string
		want  int64
	}{
		{"claude-3-opus-20240229", 4096},
		{"claude-sonnet-4-5-20250929", 64000},
	}
	for _, tc := range cases {
		c := &Client{model: tc.model}
		params := c.buildMessageParams(provider.MessageRequest{
			Messages: []provider.Message{{Type: "user", Content: "hi"}},
		})
		if params.MaxTokens != tc.want {
			t.Errorf("model %q: MaxTokens = %d, want %d", tc.model, params.MaxTokens, tc.want)
		}
	}
}
