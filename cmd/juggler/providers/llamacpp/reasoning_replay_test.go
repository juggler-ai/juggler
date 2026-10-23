//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package llamacpp

import (
	"testing"

	"juggler/cmd/juggler/providers/openaibase"
)

// TestReasoningReplay pins how each model takes its earlier reasoning back.
// llama-server passes reasoning_content to templates that support it; gpt-oss's template answers 500 to content, reasoning and tool_calls together, so it gets none.
func TestReasoningReplay(t *testing.T) {
	for _, tc := range []struct {
		model string
		want  openaibase.ReasoningReplay
	}{
		{"GLM-4.7-Q4_K_M", openaibase.ReasoningReplay{Field: "reasoning_content", Required: false, Placeholder: ""}},
		{"gpt-oss-20b", openaibase.ReasoningReplay{Field: "", Required: false, Placeholder: ""}},
	} {
		if got := reasoningReplay(tc.model); got != tc.want {
			t.Errorf("reasoningReplay(%q) = %+v, want %+v", tc.model, got, tc.want)
		}
	}
}
