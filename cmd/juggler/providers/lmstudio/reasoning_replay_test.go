//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lmstudio

import (
	"testing"

	"juggler/cmd/juggler/providers/openaibase"
)

// TestReasoningReplay pins how each model takes its earlier reasoning back.
// LM Studio accepts reasoning_content on input messages, matching the field it streams.
func TestReasoningReplay(t *testing.T) {
	for _, tc := range []struct {
		model string
		want  openaibase.ReasoningReplay
	}{
		{"qwen/qwen3-8b", openaibase.ReasoningReplay{Field: "reasoning_content", Required: false, Placeholder: ""}},
	} {
		if got := reasoningReplay(tc.model); got != tc.want {
			t.Errorf("reasoningReplay(%q) = %+v, want %+v", tc.model, got, tc.want)
		}
	}
}
