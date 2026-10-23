//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package moonshot

import (
	"testing"

	"juggler/cmd/juggler/providers/openaibase"
)

// TestReasoningReplay pins how each model takes its earlier reasoning back.
// Kimi models need reasoning_content on every assistant tool-call message and reject an empty one; the legacy moonshot-v1 models never reason, so get nothing.
func TestReasoningReplay(t *testing.T) {
	for _, tc := range []struct {
		model string
		want  openaibase.ReasoningReplay
	}{
		{"kimi-k3", openaibase.ReasoningReplay{Field: "reasoning_content", Required: true, Placeholder: " "}},
		{"kimi-k2.6", openaibase.ReasoningReplay{Field: "reasoning_content", Required: true, Placeholder: " "}},
		{"moonshot-v1-8k", openaibase.ReasoningReplay{Field: "", Required: false, Placeholder: ""}},
	} {
		if got := reasoningReplay(tc.model); got != tc.want {
			t.Errorf("reasoningReplay(%q) = %+v, want %+v", tc.model, got, tc.want)
		}
	}
}
