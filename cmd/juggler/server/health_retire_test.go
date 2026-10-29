//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/worker"
)

func TestHealthRetireAuthAndIdle(t *testing.T) {
	for _, managed := range []bool{false, true} {
		s, _ := newAuthTestServer(t)
		s.shutdownChan = make(chan struct{})
		if managed {
			s.workerManager = worker.NewManager()
			defer s.workerManager.Shutdown()
			s.workerManager.GetOrCreate("idle", "user:test")
		}
		s.router.HandleFunc("/api/health/retire", s.handleHealthRetire).Methods(http.MethodPost)
		for _, token := range []string{"", "wrong", testAPIToken} {
			r := httptest.NewRequest(http.MethodPost, "http://localhost/api/health/retire", nil)
			r.Header.Set("X-Juggler-Token", token)
			w := httptest.NewRecorder()
			s.router.ServeHTTP(w, r)
			want := http.StatusUnauthorized
			if token == testAPIToken {
				want = http.StatusAccepted
			}
			if w.Code != want {
				t.Errorf("managed=%v token=%q: status %d, want %d", managed, token, w.Code, want)
			}
			select {
			case <-s.shutdownChan:
				if want != http.StatusAccepted {
					t.Fatal("unauthorized request initiated shutdown")
				}
			default:
				if w.Code == http.StatusAccepted {
					t.Fatal("202 without signalling shutdown")
				}
			}
		}
	}
}

// A held session refuses without shutting down. A caller that has gone changes
// nothing: the decision runs to its end, and an idle child commits regardless.
func TestHealthRetireBusyAndCallerGone(t *testing.T) {
	for _, held := range []bool{true, false} {
		s := &Server{workerManager: worker.NewManager(), shutdownChan: make(chan struct{})}
		conv := s.workerManager.GetOrCreate("conv", "user:test")
		if held {
			doc := conv.Document()
			doc.InsertMessage(0, worker.ConversationItem{Type: worker.ItemTypeToolAction, ItemID: "approval", ToolUseID: "use", ToolName: "bash", State: worker.StatePending})
			doc.SetMetadata("processingState", map[string]any{"activity": worker.ActivityAwaitingLLM})
		}
		r := httptest.NewRequest(http.MethodPost, "/api/health/retire", nil)
		ctx, cancel := context.WithCancel(r.Context())
		cancel()
		w := httptest.NewRecorder()
		s.handleHealthRetire(w, r.WithContext(ctx))
		shut := false
		select {
		case <-s.shutdownChan:
			shut = true
		default:
		}
		if held && (w.Code != http.StatusConflict || shut) {
			t.Errorf("held: status %d shutdown=%v; want 409 and no shutdown", w.Code, shut)
		}
		if !held && (w.Code != http.StatusAccepted || !shut) {
			t.Errorf("idle, caller gone: status %d shutdown=%v; want 202 and shutdown", w.Code, shut)
		}
		s.workerManager.Shutdown()
	}
}
