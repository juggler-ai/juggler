//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package basepath

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestFromRequest pins which forwarded prefixes a page may be served under:
// nothing for a direct request, a well-formed path of plain segments from a
// proxy, and nothing for anything else — so a forged header can at worst
// mis-address the forger's own page, never inject into it. The machine
// server's prefix to a child follows the same rule.
func TestFromRequest(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"", ""},
		{"/p/myapp-81fb48e2", "/p/myapp-81fb48e2"},
		{"/a/b_c-d", "/a/b_c-d"},
		{"p/myapp-81fb48e2", ""},   // not rooted
		{"/p/myapp-81fb48e2/", ""}, // trailing slash
		{"//evil.example", ""},     // protocol-relative
		{"/s/../x", ""},
		{"/s/a b", ""},
		{"/s/x'", ""},
		{"/s/<script>", ""},
		{"/" + strings.Repeat("a", MaxLen-1), "/" + strings.Repeat("a", MaxLen-1)},
		{"/" + strings.Repeat("a", MaxLen), ""},
	}
	for _, c := range cases {
		for name, h := range map[string]struct {
			header string
			read   func(*http.Request) string
		}{"Header": {Header, FromRequest}, "MachineHeader": {MachineHeader, MachineFromRequest}} {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if c.header != "" {
				req.Header.Set(h.header, c.header)
			}
			if got := h.read(req); got != c.want {
				t.Errorf("%s %q read as %q, want %q", name, c.header, got, c.want)
			}
		}
	}
}
