//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"runtime"
	"slices"
	"testing"
	"time"

	"juggler/cmd/juggler/ops"
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

// A background task (bash run_in_background, Monitor) holds the session like a
// running turn: retiring it stops the task, and nobody is asked — the session
// retires because nobody is looking. Once the task has ended, the same request
// commits.
func TestHealthRetireRefusedWhileABackgroundTaskRuns(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("starts a POSIX sleep")
	}
	project := t.TempDir()
	s := &Server{workerManager: worker.NewManager(), shutdownChan: make(chan struct{})}
	defer s.workerManager.Shutdown()
	s.workerManager.GetOrCreate("idle", "user:test")
	s.projectState.Store(&projectState{projectPath: project})

	res, err := ops.NewShellOperations(ops.NewPathScope(project, nil)).Execute(context.Background(), "startBackground", map[string]any{"command": "sleep 30"})
	if err != nil {
		t.Fatalf("startBackground: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	t.Cleanup(func() { ops.KillTask(id) })
	listed := func() bool {
		for _, p := range ops.ListProcesses(project) {
			if p.ID == id {
				return true
			}
		}
		return false
	}
	waitUntil := func(want bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for listed() != want {
			if time.Now().After(deadline) {
				t.Fatalf("task %s listed = %v, want %v", id, !want, want)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

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
	waitUntil(true)
	if code, shut := retire(); code != http.StatusConflict || shut {
		t.Fatalf("background task running: status %d shutdown=%v; want 409 and no shutdown", code, shut)
	}
	ops.KillTask(id)
	waitUntil(false)
	if code, shut := retire(); code != http.StatusAccepted || !shut {
		t.Fatalf("background task ended: status %d shutdown=%v; want 202 and shutdown", code, shut)
	}
}

// A viewed background task — a pin's server — holds nothing up: an unviewed
// session running only that retires, and its shutdown stops the task.
func TestHealthRetireAllowedWithOnlyAViewedTask(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("starts a POSIX sleep")
	}
	project := t.TempDir()
	s := &Server{workerManager: worker.NewManager(), shutdownChan: make(chan struct{})}
	defer s.workerManager.Shutdown()
	s.workerManager.GetOrCreate("idle", "user:test")
	s.projectState.Store(&projectState{projectPath: project})

	res, err := ops.NewShellOperations(ops.NewPathScope(project, nil)).Execute(context.Background(), "startBackground",
		map[string]any{"command": "sleep 30", "lifetime": ops.LifetimeViewed})
	if err != nil {
		t.Fatalf("startBackground: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	t.Cleanup(func() { ops.KillTask(id) })
	deadline := time.Now().Add(5 * time.Second)
	for !slices.ContainsFunc(ops.ListProcesses(project), func(p ops.ProcessInfo) bool { return p.ID == id }) {
		if time.Now().After(deadline) {
			t.Fatalf("task %s never listed", id)
		}
		time.Sleep(10 * time.Millisecond)
	}

	w := httptest.NewRecorder()
	s.handleHealthRetire(w, httptest.NewRequest(http.MethodPost, "/api/health/retire", nil))
	select {
	case <-s.shutdownChan:
	default:
		t.Fatalf("only a viewed task running: status %d and no shutdown; want 202 and shutdown", w.Code)
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
