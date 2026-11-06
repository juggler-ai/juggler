//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/worker"
	"juggler/internal/attention"
)

// The attention report names each conversation that is not idle — here one
// the session has not loaded, known from the project's saved summary — and
// leaves out one whose folder has gone. /api/health/active carries the
// report's revision, so a poller fetches the report only when it moves.
func TestHealthAttentionReport(t *testing.T) {
	project := t.TempDir()
	const known, gone = "conv_known1", "conv_gone1"
	if err := os.MkdirAll(filepath.Join(project, ".juggler", core.BuildDirName("Fix the build", known)), 0o755); err != nil {
		t.Fatal(err)
	}
	since := time.Date(2026, 11, 6, 9, 30, 0, 0, time.UTC)
	waiting := attention.Entry{State: attention.Waiting, Wait: attention.Question, Since: since, Excerpt: "Which database should I use?"}
	if err := attention.Write(project, map[string]attention.Entry{
		known: waiting,
		gone:  {State: attention.Failed, Since: since, Excerpt: "boom"},
	}); err != nil {
		t.Fatal(err)
	}
	mgr, err := core.NewSessionManagerForPath(project)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)
	m := worker.NewManager()
	defer m.Shutdown()
	s := &Server{workerManager: m}
	s.projectState.Store(&projectState{projectPath: project, sessionManager: mgr})

	rec := httptest.NewRecorder()
	s.handleHealthAttention(rec, httptest.NewRequest("GET", "/api/health/attention", nil))
	var report attention.Report
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil || rec.Code != 200 {
		t.Fatalf("attention = %d %s (%v)", rec.Code, rec.Body.String(), err)
	}
	want := []attention.Conversation{{ID: known, Name: "Fix the build", Entry: waiting}}
	if !reflect.DeepEqual(report.Conversations, want) {
		t.Fatalf("conversations = %+v, want %+v", report.Conversations, want)
	}

	rec = httptest.NewRecorder()
	s.handleHealthActive(rec, httptest.NewRequest("GET", "/api/health/active", nil))
	var active struct {
		AttentionRev *uint64 `json:"attentionRev"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &active); err != nil {
		t.Fatal(err)
	}
	if active.AttentionRev == nil || *active.AttentionRev != report.Rev {
		t.Fatalf("active = %s; want attentionRev %d", rec.Body.String(), report.Rev)
	}
}

// /api/health/active counts the project's conversations, which the machine
// server's poll records for the switcher's status line.
func TestHealthActiveCountsConversations(t *testing.T) {
	project := t.TempDir()
	for i, name := range []string{"One", "Two", "Three"} {
		if err := os.MkdirAll(filepath.Join(project, ".juggler", core.BuildDirName(name, "conv_count"+string(rune('a'+i)))), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mgr, err := core.NewSessionManagerForPath(project)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)
	m := worker.NewManager()
	defer m.Shutdown()
	s := &Server{workerManager: m}
	s.projectState.Store(&projectState{projectPath: project, sessionManager: mgr})

	rec := httptest.NewRecorder()
	s.handleHealthActive(rec, httptest.NewRequest("GET", "/api/health/active", nil))
	var active struct {
		Conversations *int `json:"conversations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &active); err != nil {
		t.Fatal(err)
	}
	if active.Conversations == nil || *active.Conversations != 3 {
		t.Fatalf("active = %s; want conversations 3", rec.Body.String())
	}
}
