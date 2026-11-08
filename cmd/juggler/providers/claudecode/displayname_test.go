//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import "testing"

// TestDisplayName checks this provider's own naming decision: readable model
// name, "Claude" family prefix for the CLI's bare ids, and the route qualifier.
func TestDisplayName(t *testing.T) {
	cases := []struct {
		id   string
		want string
	}{
		{"opus", "Claude Opus (CLI)"},
		// A verbatim full id must not double the "Claude" prefix.
		{"claude-sonnet-4-5", "Claude Sonnet 4.5 (CLI)"},
	}
	for _, tc := range cases {
		if got := displayName(tc.id); got != tc.want {
			t.Errorf("displayName(%q) = %q, want %q", tc.id, got, tc.want)
		}
	}
}
