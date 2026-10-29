//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/worker"
)

// TestStartupLoadsHeldConversations: starting the server's background
// services loads the conversations the project's held-send index lists, so
// their sends fire with nobody opening them. The index here lists a
// conversation that does not exist; the load is what discards that entry, and
// with it the index's only entry, the file.
func TestStartupLoadsHeldConversations(t *testing.T) {
	s := newTestServerStateWithProject(t)
	s.workerManager = worker.NewManager()
	s.workerManager.SetPathProvider(func(string) (string, bool) { return "", false })
	t.Cleanup(s.workerManager.Shutdown)

	index := filepath.Join(s.ProjectPath(), ".juggler", "held-sends.json")
	if err := os.MkdirAll(filepath.Dir(index), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, []byte(`{"conv-gone":{"due":true}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	s.loadHeldConversations()
	if _, err := os.Stat(index); !os.IsNotExist(err) {
		t.Fatal("loading the project's held conversations left the entry for a missing conversation in its index")
	}
}
