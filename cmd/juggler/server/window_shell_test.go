//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"html"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/internal/basepath"
	"juggler/web"
)

var nonceAttr = regexp.MustCompile(`nonce="([^"]+)"`)

// A session's page wears the desktop window's shell (web/shell/window-shell.html)
// as the sessions page and the stand-ins do: its pre-paint window markers and
// its body block — the Wails runtime, the resize strip, the window's chrome
// modules — are the shell's own blocks, drawn with the page's data, not copies
// of them. Under a proxy's prefix too, and in a browser tab, where the runtime
// is left out.
func TestSessionPageWearsTheWindowShell(t *testing.T) {
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s := &Server{router: mux.NewRouter(), apiToken: testAPIToken, staticVersion: "test-static-version"}
	s.projectState.Store(&projectState{sessionManager: mgr, projectPath: t.TempDir()})
	if err := s.loadIndexTemplate(); err != nil {
		t.Fatalf("loadIndexTemplate: %v", err)
	}

	for _, target := range []string{"/?window=1", "/"} {
		for _, prefix := range []string{"", "/p/myapp-81fb48e2"} {
			req := httptest.NewRequest(http.MethodGet, target, nil)
			req.RemoteAddr = localViewerAddr
			if prefix != "" {
				req.Header.Set(basepath.Header, prefix)
			}
			rec := httptest.NewRecorder()
			s.serveIndex(rec, req)
			page := rec.Body.String()
			m := nonceAttr.FindStringSubmatch(page)
			if m == nil {
				t.Fatalf("%s under %q: the page has no nonce", target, prefix)
			}
			data := map[string]any{
				"AssetBase": prefix + "/v" + s.staticVersion,
				"WailsBase": prefix,
				"IsWindow":  strings.Contains(target, "window=1"),
				// As the page escaped it; the block escapes it again.
				"CSPNonce": html.UnescapeString(m[1]),
			}
			for _, block := range []string{"window-shell-boot", "window-shell-body"} {
				tmpl := s.indexTemplate.Lookup(block)
				if tmpl == nil {
					t.Fatalf("the session page's template has no %s", block)
				}
				var b strings.Builder
				if err := tmpl.Execute(&b, data); err != nil {
					t.Fatalf("%s: %v", block, err)
				}
				if !strings.Contains(page, b.String()) {
					t.Errorf("%s under %q does not wear the shell's %s", target, prefix, block)
				}
			}
		}
	}
}

// The shell's stylesheets are some of a session's page's, in the same order:
// the session page's list is css/manifest.json's (lint-css-arch), and a sheet
// the shell takes out of that order would cascade differently on the
// sessions page and the stand-ins than on the page they share a header with.
func TestWindowShellSheetsFollowTheSessionPage(t *testing.T) {
	index, err := web.Files.ReadFile("index.html")
	if err != nil {
		t.Fatal(err)
	}
	shell, err := web.Files.ReadFile("shell/window-shell.html")
	if err != nil {
		t.Fatal(err)
	}
	sheet := regexp.MustCompile(`<link rel="stylesheet" href="[^"]*?/(css/[^"]+)">`)
	sheets := func(html []byte) []string {
		var out []string
		for _, m := range sheet.FindAllSubmatch(html, -1) {
			out = append(out, string(m[1]))
		}
		return out
	}
	page, shellSheets := sheets(index), sheets(shell)
	if len(shellSheets) == 0 {
		t.Fatal("found no stylesheets in the shell")
	}
	at := 0
	for _, s := range shellSheets {
		for at < len(page) && page[at] != s {
			at++
		}
		if at == len(page) {
			t.Fatalf("the shell links %s, which a session's page does not, or not in this order\nshell:   %v\nsession: %v", s, shellSheets, page)
		}
		at++
	}
}
