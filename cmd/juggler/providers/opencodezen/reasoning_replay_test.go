//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package opencodezen

import (
	"testing"

	"juggler/cmd/juggler/providers/openaibase"
)

// TestReasoningReplay pins how each model takes its earlier reasoning back.
// Zen's DeepSeek route relays DeepSeek's own 400 without reasoning_content, so it gets DeepSeek's contract; no other route is known to pass the field through, and its GLM route has rejected unknown request fields, so they get none.
func TestReasoningReplay(t *testing.T) {
	for _, tc := range []struct {
		model string
		want  openaibase.ReasoningReplay
	}{
		{"deepseek-v4-pro", openaibase.ReasoningReplay{Field: "reasoning_content", Required: true, Placeholder: ""}},
		{"glm-5.3", openaibase.ReasoningReplay{Field: "", Required: false, Placeholder: ""}},
		{"kimi-k3", openaibase.ReasoningReplay{Field: "", Required: false, Placeholder: ""}},
		{"qwen3.8-max", openaibase.ReasoningReplay{Field: "", Required: false, Placeholder: ""}},
	} {
		if got := reasoningReplay(tc.model); got != tc.want {
			t.Errorf("reasoningReplay(%q) = %+v, want %+v", tc.model, got, tc.want)
		}
	}
}
