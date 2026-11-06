//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// engineBootServer is a server with three user-extension modules for an engine
// boot to fetch through /worker-module.
func engineBootServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"a", "b", "c"} {
		full := filepath.Join(dir, "ext", name+".js")
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("export default {};\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s := serverWithUserExt(dir)
	s.apiToken, s.staticVersion = testAPIToken, "test-static-version"
	return s
}

// best is the most distinct fetches any boot has reached.
func (b *engineBootProgress) best() int {
	if st := b.state.Load(); st != nil {
		return st.best
	}
	return 0
}

// bootFetch makes one of the engine's boot requests: "" for the page itself,
// otherwise a module by name.
func bootFetch(t *testing.T, s *Server, module string) {
	t.Helper()
	rec := httptest.NewRecorder()
	if module == "" {
		s.serveEngine(rec, httptest.NewRequest(http.MethodGet, "/engine", nil))
	} else {
		target := "/worker-module?url=" + url.QueryEscape("/user-extensions/ext/"+module+".js")
		s.serveWorkerModule(rec, httptest.NewRequest(http.MethodGet, target, nil))
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("boot fetch %q: got %d", module, rec.Code)
	}
}

// An engine that is still loading is getting somewhere: each page load and
// module it fetches for the first time is progress its startup is judged by.
func TestAnEngineBootFetchingNewModulesIsProgress(t *testing.T) {
	s := engineBootServer(t)
	if !s.EngineBootProgressAt().IsZero() {
		t.Fatal("progress recorded before the engine asked for anything")
	}
	bootFetch(t, s, "")
	if s.EngineBootProgressAt().IsZero() || s.engineBoot.best() != 1 {
		t.Fatalf("loading the engine page was not progress (best %d)", s.engineBoot.best())
	}
	bootFetch(t, s, "a")
	bootFetch(t, s, "b")
	if s.engineBoot.best() != 3 {
		t.Fatalf("a page and two modules reached %d, want 3", s.engineBoot.best())
	}
}

// An engine that reloads and dies at the same place every time — a renderer
// crash WebKit reloads by itself — is making traffic, not progress. Only
// getting further than any boot before it counts.
func TestAnEngineBootThatOnlyGetsAsFarAsBeforeIsNotProgress(t *testing.T) {
	s := engineBootServer(t)
	for _, m := range []string{"", "a", "b"} {
		bootFetch(t, s, m)
	}
	at := s.EngineBootProgressAt()

	for range 3 {
		for _, m := range []string{"", "a", "b"} {
			bootFetch(t, s, m)
		}
	}
	if got := s.EngineBootProgressAt(); !got.Equal(at) || s.engineBoot.best() != 3 {
		t.Fatalf("reloading to the same point moved progress (best %d)", s.engineBoot.best())
	}

	bootFetch(t, s, "c")
	if s.engineBoot.best() != 4 {
		t.Fatalf("getting one module further reached %d, want 4", s.engineBoot.best())
	}
}
