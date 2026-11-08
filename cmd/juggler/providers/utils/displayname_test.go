//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import "testing"

func TestModelDisplayName(t *testing.T) {
	cases := []struct {
		id   string
		want string
	}{
		{"opus", "Opus"},
		{"claude-sonnet-4-5", "Claude Sonnet 4.5"},
		{"gpt-5-codex", "GPT-5 Codex"},
		{"gpt-4o", "GPT-4o"},
		{"glm-4.6", "GLM-4.6"},
		{"o3-mini", "o3 Mini"},
		{"gpt-oss-120b", "GPT OSS 120b"},
		{"models/gemini-2.5-pro", "Gemini 2.5 Pro"},
		{"deepseek-chat", "Deepseek Chat"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := ModelDisplayName(tc.id); got != tc.want {
			t.Errorf("ModelDisplayName(%q) = %q, want %q", tc.id, got, tc.want)
		}
	}
}
