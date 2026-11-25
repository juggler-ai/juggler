//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
)

// The pages that carry the API token are never stored. A browser restoring a
// tab or going back takes a stored page without revalidating it even under
// "no-cache", and a stored page holds the token of whichever server process
// served it — after a restart, a page whose every /api call is refused.
func TestTokenPagesAreNotStored(t *testing.T) {
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

	for name, serve := range map[string]func(http.ResponseWriter, *http.Request){
		"/":       s.serveIndex,
		"/engine": s.serveEngine,
	} {
		req := httptest.NewRequest(http.MethodGet, name, nil)
		req.RemoteAddr = localViewerAddr
		rec := httptest.NewRecorder()
		serve(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: got %d, want 200", name, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s: Cache-Control = %q, want no-store", name, cc)
		}
	}
}
