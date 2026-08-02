//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package deepseek

import "testing"

// TestDeepSeekOutputCapHasReasoningHeadroom guards that deepseek-reasoner (R1)
// gets enough output budget for chain-of-thought. R1 spends output tokens
// thinking before it answers; the original flat 8192 cap throttled the
// reasoning itself, producing empty `finish=length` turns the worker silently
// retried. The reasoner must sit well above 8192; chat models also clear the
// old floor; unknown ids fall back to the (raised) default.
func TestDeepSeekOutputCapHasReasoningHeadroom(t *testing.T) {
	cases := []struct {
		model   string
		atLeast int
	}{
		{"deepseek-reasoner", 65536},
		{"deepseek-chat", 32768},
		{"deepseek-coder", 32768},
		{"deepseek-vNext", 32768}, // unknown/newer → raised default
	}
	for _, tc := range cases {
		if got := maxOutputCaps.Lookup(tc.model); got < tc.atLeast {
			t.Errorf("GetMaxOutputTokens(%q) = %d, want >= %d (reasoning needs headroom)", tc.model, got, tc.atLeast)
		}
	}
}

// TestDeepSeekContextWindow pins the known windows and the unknown-model default.
func TestDeepSeekContextWindow(t *testing.T) {
	if got := contextWindowCaps.Lookup("deepseek-reasoner"); got != 128000 {
		t.Errorf("context window(deepseek-reasoner) = %d, want 128000", got)
	}
	// The v4 API models advertise a 1M-token window (DeepSeek API docs,
	// Models & Pricing) — without these entries they'd fall to the 128k
	// default and conversations would be compacted ~8x too early.
	for _, model := range []string{"deepseek-v4-flash", "deepseek-v4-pro"} {
		if got := contextWindowCaps.Lookup(model); got != 1000000 {
			t.Errorf("context window(%s) = %d, want 1000000", model, got)
		}
	}
	if got := contextWindowCaps.Lookup("deepseek-vNext"); got != DefaultContextWindow {
		t.Errorf("context window(unknown) = %d, want default %d", got, DefaultContextWindow)
	}
}
