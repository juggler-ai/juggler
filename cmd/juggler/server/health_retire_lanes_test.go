//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/worker"
)

// A test server whose browser-test lanes hold the session refuses to retire,
// however idle its conversations: a lane queued for a window still loading is
// work, and the machine server's viewer grace is no measure of how long the
// window takes. Once the lanes let go, the same request commits.
func TestHealthRetireRefusedWhileTestLanesHold(t *testing.T) {
	s := &Server{workerManager: worker.NewManager(), shutdownChan: make(chan struct{})}
	defer s.workerManager.Shutdown()
	s.workerManager.GetOrCreate("idle", "user:test")
	lanesHold := true
	hold := func() bool { return lanesHold }
	s.testPool.lanesHold.Store(&hold)

	retire := func() (int, bool) {
		w := httptest.NewRecorder()
		s.handleHealthRetire(w, httptest.NewRequest(http.MethodPost, "/api/health/retire", nil))
		select {
		case <-s.shutdownChan:
			return w.Code, true
		default:
			return w.Code, false
		}
	}
	if code, shut := retire(); code != http.StatusConflict || shut {
		t.Fatalf("lanes holding: status %d shutdown=%v; want 409 and no shutdown", code, shut)
	}
	lanesHold = false
	if code, shut := retire(); code != http.StatusAccepted || !shut {
		t.Fatalf("lanes released: status %d shutdown=%v; want 202 and shutdown", code, shut)
	}
}
