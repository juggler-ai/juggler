//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
)

// TestSwitchProjectLoadsHeldConversations: switching into a project loads the
// conversations its held-send index lists, as starting the server in it does,
// so their sends fire with nobody opening them. The index here lists a
// conversation that does not exist; the load is what discards that entry, and
// with it the index's only entry, the file.
func TestSwitchProjectLoadsHeldConversations(t *testing.T) {
	s := newTestServerState(t)
	s.switchToken = make(chan struct{}, 1)
	s.switchToken <- struct{}{}
	s.workerManager = worker.NewManager()
	s.workerManager.SetPathProvider(func(string) (string, bool) { return "", false })
	t.Cleanup(s.workerManager.Shutdown)

	project := t.TempDir()
	index := filepath.Join(project, ".juggler", "held-sends.json")
	if err := os.MkdirAll(filepath.Dir(index), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, []byte(`{"conv-gone":{"due":true}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	// As in TestSwitchProjectInvalidatesConversationCache: switch away and wait
	// for the temp project's teardown before t.TempDir removes it.
	t.Cleanup(func() {
		previous := s.projectState.Load()
		if err := s.SwitchProject(""); err != nil {
			return
		}
		select {
		case <-previous.teardownDone:
		case <-time.After(30 * time.Second):
			t.Error("the temp project's teardown never finished, so its files are still held open")
		}
	})
	if err := s.SwitchProject(project); err != nil {
		t.Fatalf("SwitchProject: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(index); os.IsNotExist(err) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("switching into the project never loaded its held-send index: the entry for a missing conversation is still there")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
