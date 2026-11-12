//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/fsnotify/fsnotify"

	"juggler/internal/projectpaths"
)

// With the state kept outside the project, the two files of it a user edits by
// hand are still reported — by their absolute path, the only spelling of a file
// outside the project — and everything else Juggler writes there stays silent,
// as it does in <project>/.juggler.
func TestFileWatcher_OutsideStateFiles(t *testing.T) {
	t.Setenv(projectpaths.StateDirEnv, t.TempDir())
	root := t.TempDir()
	state := projectpaths.OutsideDir(root)
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Stop)

	for _, name := range []string{"MEMORY.md", "env.local.json"} {
		abs := filepath.Join(state, name)
		w.handleEvent(fsnotify.Event{Name: abs, Op: fsnotify.Write})
		if got := nextChange(t, w).Path; got != abs {
			t.Errorf("%s reported as %q, want %q", name, got, abs)
		}
	}
	for _, name := range []string{"session.json", "config.json", "juggler.lock"} {
		w.handleEvent(fsnotify.Event{Name: filepath.Join(state, name), Op: fsnotify.Write})
		assertSilent(t, w, name)
	}
}
