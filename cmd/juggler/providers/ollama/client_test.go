//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import "testing"

func TestNormaliseHost(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"whitespace only", "   ", ""},
		{"bare host:port", "192.168.1.70:11434", "http://192.168.1.70:11434"},
		{"full http url", "http://192.168.1.70:11434", "http://192.168.1.70:11434"},
		{"full https url", "https://ollama.lan:11434", "https://ollama.lan:11434"},
		{"trailing slash trimmed", "http://localhost:11434/", "http://localhost:11434"},
		{"surrounding whitespace", "  http://localhost:11434  ", "http://localhost:11434"},
		// Missing-`//` typo repair (the exact input from issue #8).
		{"http missing slashes", "http:192.168.1.70:11434", "http://192.168.1.70:11434"},
		{"https missing slashes", "https:ollama.lan:11434", "https://ollama.lan:11434"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normaliseHost(tc.in); got != tc.want {
				t.Errorf("normaliseHost(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
