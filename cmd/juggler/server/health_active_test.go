//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"

	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/worker"
)

// A health poll is a read: it asks no conversation's actor anything. A worker
// whose actor has stopped can answer no question, and the poll answers anyway.
func TestHealthActiveAsksNoActor(t *testing.T) {
	m := worker.NewManager()
	defer m.Shutdown()
	m.GetOrCreate("stopped", "user:test").Stop()
	s := &Server{workerManager: m}
	w := httptest.NewRecorder()
	s.handleHealthActive(w, httptest.NewRequest("GET", "/api/health/active", nil))
	if w.Code != 200 {
		t.Fatalf("health poll beside a stopped actor = %d %s; want 200 — the poll must not go through the actors", w.Code, w.Body.String())
	}
}

// A background task (bash run_in_background, Monitor) outlives its turn, so no
// conversation reads as working while it runs — yet letting the server go stops
// it. The poll counts the project's running tasks beside the turns, and not
// another project's, and stops counting one once it has ended. It is not folded
// into active, which also decides whether an unviewed session may retire.
func TestHealthActiveCountsBackgroundTasks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("starts a POSIX sleep")
	}
	project, other := t.TempDir(), t.TempDir()
	m := worker.NewManager()
	defer m.Shutdown()
	s := &Server{workerManager: m}
	s.projectState.Store(&projectState{projectPath: project})

	poll := func() (active bool, tasks int) {
		w := httptest.NewRecorder()
		s.handleHealthActive(w, httptest.NewRequest("GET", "/api/health/active", nil))
		var got struct {
			Active          bool `json:"active"`
			BackgroundTasks int  `json:"backgroundTasks"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Active, got.BackgroundTasks
	}
	start := func(root string) string {
		res, err := ops.NewShellOperations(ops.NewPathScope(root, nil)).Execute(context.Background(), "startBackground", map[string]any{"command": "sleep 30"})
		if err != nil {
			t.Fatalf("startBackground: %v", err)
		}
		id, _ := res.(map[string]any)["task_id"].(string)
		t.Cleanup(func() { ops.KillTask(id) })
		return id
	}
	waitFor := func(want int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			active, tasks := poll()
			if active {
				t.Fatalf("a background task alone made the session read as running a turn")
			}
			if tasks == want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("health poll counted %d background tasks, want %d", tasks, want)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	start(other)
	ours := start(project)
	waitFor(1)
	ops.KillTask(ours)
	waitFor(0)
}

func TestHealthActiveQuitWarning(t *testing.T) {
	m := worker.NewManager()
	defer m.Shutdown()
	s := &Server{workerManager: m}
	for _, withWorker := range []bool{false, true} {
		if withWorker {
			m.GetOrCreate("idle", "user:test")
		}
		r := httptest.NewRequest("GET", "/api/health/active", nil)
		w := httptest.NewRecorder()
		s.handleHealthActive(w, r)
		var got struct {
			Active          bool     `json:"active"`
			SessionHeld     *bool    `json:"sessionHeld"`
			ConversationIDs []string `json:"conversationIds"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || got.SessionHeld != nil || got.Active || len(got.ConversationIDs) != 0 {
			t.Errorf("idle health (worker=%v) = %d %s; want inactive and no session hold", withWorker, w.Code, w.Body.String())
		}
	}

	conv := m.GetOrCreate("held", "user:test")
	doc := conv.Document()
	doc.InsertMessage(0, worker.ConversationItem{
		Type: worker.ItemTypeToolAction, ItemID: "tool", ToolUseID: "use",
		ToolName: "bash", State: worker.StatePending,
	})
	doc.SetMetadata("processingState", map[string]any{
		"activity": worker.ActivityAwaitingLLM,
		"runs": map[string]any{"root": map[string]any{
			"activity": worker.ActivityAwaitingLLM, "threadItemId": "",
		}},
	})
	for _, active := range []bool{false, true} {
		if active {
			if err := doc.UpdateItemByID("tool", "state", worker.StateRunning); err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest("GET", "/api/health/active", nil)
		w := httptest.NewRecorder()
		s.handleHealthActive(w, r)
		var got struct {
			Active          bool     `json:"active"`
			ConversationIDs []string `json:"conversationIds"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Active != active {
			t.Errorf("held health (active=%v) = %s", active, w.Body.String())
		}
		if (active && (len(got.ConversationIDs) != 1 || got.ConversationIDs[0] != "held")) || (!active && len(got.ConversationIDs) != 0) {
			t.Errorf("quit-warning IDs (active=%v) = %v", active, got.ConversationIDs)
		}
	}
}
