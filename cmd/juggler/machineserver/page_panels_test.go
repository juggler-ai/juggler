//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"testing/fstest"

	"juggler/web"
)

// layeredFS is top over base, as an asset overlay is (web.SetOverlay),
// without installing one for the whole test binary.
type layeredFS struct {
	top  fstest.MapFS
	base fs.FS
}

func (l layeredFS) Open(name string) (fs.File, error) {
	if f, err := l.top.Open(name); err == nil {
		return f, nil
	}
	return l.base.Open(name)
}

// TestSessionsPageLoadsPanels proves the page-panel seam on the server's side:
// the page is handed every module in machine/panels/ of the asset tree, in
// name order, at a URL it is served from; nothing else there; and a tree with
// no such folder hands it none.
func TestSessionsPageLoadsPanels(t *testing.T) {
	tree := layeredFS{base: web.Files, top: fstest.MapFS{
		"machine/panels/b-second.js":     {Data: []byte("export {};\n")},
		"machine/panels/a-first.js":      {Data: []byte("export {};\n")},
		"machine/panels/notes.txt":       {Data: []byte("not a module\n")},
		"machine/panels/nested/inner.js": {Data: []byte("export {};\n")},
	}}
	panels := func(assets fs.FS) (*httptest.Server, []any) {
		s := &Server{reg: newRegistry(), assets: assets, token: testToken, uiLocale: func() string { return "" }}
		front := httptest.NewServer(s.routes())
		t.Cleanup(front.Close)
		status, _, body := fetch(t, front.URL+"/")
		if status != http.StatusOK {
			t.Fatalf("page: status %d", status)
		}
		list, _ := decodePageConfig(t, body)["panels"].([]any)
		return front, list
	}

	front, got := panels(tree)
	want := regexp.MustCompile(`^/v[0-9a-f]+/machine/panels/(a-first|b-second)\.js$`)
	if len(got) != 2 {
		t.Fatalf("the page's panels = %q; want a-first.js and b-second.js", got)
	}
	for i, name := range []string{"a-first", "b-second"} {
		u, _ := got[i].(string)
		if m := want.FindStringSubmatch(u); m == nil || m[1] != name {
			t.Fatalf("panel %d = %q; want %s.js under the asset root", i, u, name)
		}
		if status, _, _ := fetch(t, front.URL+u); status != http.StatusOK {
			t.Fatalf("GET %s: status %d", u, status)
		}
	}

	if _, got := panels(web.Files); len(got) != 0 {
		t.Fatalf("with no panels folder, the page's panels = %q; want none", got)
	}
}
