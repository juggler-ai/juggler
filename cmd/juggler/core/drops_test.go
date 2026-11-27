//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"strings"
	"testing"
)

// TestSanitizeDropName pins the names a drop may be stored under: one path
// element, safe on every platform.
func TestSanitizeDropName(t *testing.T) {
	long := strings.Repeat("é", 150) + ".csv"
	for _, c := range []struct{ in, want string }{
		{"notes.txt", "notes.txt"},
		{"../../etc/passwd", "passwd"},
		{`C:\Users\x\report.pdf`, "report.pdf"},
		{"a/b", "b"},
		{"..", dropNameFallback},
		{"", dropNameFallback},
		{"CON.txt", "_CON.txt"},
		{"lpt1", "_lpt1"},
		{"what?.txt", "what_.txt"},
		{"tab\there.txt", "tabhere.txt"},
		{"trailing. . ", "trailing"},
		{".env", ".env"},
	} {
		if got := sanitizeDropName(c.in); got != c.want {
			t.Errorf("sanitizeDropName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	got := sanitizeDropName(long)
	if len(got) > maxDropNameBytes || !strings.HasSuffix(got, ".csv") || !strings.HasPrefix(got, "é") {
		t.Errorf("long name sanitised to %d bytes %q, want ≤%d keeping .csv", len(got), got, maxDropNameBytes)
	}
}
