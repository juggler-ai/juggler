//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"testing"

	"juggler/cmd/juggler/providers/openaibase"
)

// TestReasoningReplay pins how each model takes its earlier reasoning back.
// OpenRouter takes plain reasoning back under "reasoning" and relays it to the upstream; only the vendors whose reasoning is plain text and documented to come back get it, with their own Required rule. Claude, Gemini and GPT reasoning needs signed reasoning_details, which this does not carry.
func TestReasoningReplay(t *testing.T) {
	for _, tc := range []struct {
		model string
		want  openaibase.ReasoningReplay
	}{
		{"z-ai/glm-5.3", openaibase.ReasoningReplay{Field: "reasoning", Required: false, Placeholder: ""}},
		{"moonshotai/kimi-k3", openaibase.ReasoningReplay{Field: "reasoning", Required: true, Placeholder: " "}},
		{"deepseek/deepseek-v4-pro", openaibase.ReasoningReplay{Field: "reasoning", Required: true, Placeholder: ""}},
		{"anthropic/claude-sonnet-4.5", openaibase.ReasoningReplay{Field: "", Required: false, Placeholder: ""}},
		{"google/gemini-3-pro", openaibase.ReasoningReplay{Field: "", Required: false, Placeholder: ""}},
		{"openai/gpt-5", openaibase.ReasoningReplay{Field: "", Required: false, Placeholder: ""}},
	} {
		if got := reasoningReplay(tc.model); got != tc.want {
			t.Errorf("reasoningReplay(%q) = %+v, want %+v", tc.model, got, tc.want)
		}
	}
}
