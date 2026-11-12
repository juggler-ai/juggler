//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/fsnotify/fsnotify"
)

// A project keeping its state outside has no .juggler, and the command
// directory is awaited rather than created: the watch steps down as each
// level appears, claims every other event its stepping-stone watches see,
// and hands the directory back once it exists — including when it was made in
// one go, before the watch on the level above could see it.
func TestAwaitedDirStepsDownWithoutCreating(t *testing.T) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	project := t.TempDir()
	target := filepath.Join(project, ".juggler", "commands")

	a, ok := newAwaitedDir(w, target)
	if !ok {
		t.Fatal("newAwaitedDir found nothing to watch")
	}
	if _, err := os.Stat(filepath.Join(project, ".juggler")); err == nil {
		t.Fatal("awaiting the directory created .juggler")
	}

	file := filepath.Join(project, "notes.js")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if ours, arrived := a.handle(w, file); !ours || arrived {
		t.Errorf("a file in the project root: ours=%v arrived=%v, want it claimed and dropped", ours, arrived)
	}
	if ours, _ := a.handle(w, filepath.Join(project, "src", "a.js")); ours {
		t.Error("an event outside the stepping stones was claimed")
	}

	if err := os.Mkdir(filepath.Join(project, ".juggler"), 0o755); err != nil {
		t.Fatal(err)
	}
	if ours, arrived := a.handle(w, filepath.Join(project, ".juggler")); !ours || arrived {
		t.Errorf(".juggler appearing: ours=%v arrived=%v, want a step, not arrival", ours, arrived)
	}
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if ours, arrived := a.handle(w, target); !ours || !arrived {
		t.Errorf("commands appearing: ours=%v arrived=%v, want arrival", ours, arrived)
	}

	// Made in one go: the step above sees only .juggler, which already holds it.
	project2 := t.TempDir()
	target2 := filepath.Join(project2, ".juggler", "commands")
	a2, _ := newAwaitedDir(w, target2)
	if err := os.MkdirAll(target2, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, arrived := a2.handle(w, filepath.Join(project2, ".juggler")); !arrived {
		t.Error("a directory made with MkdirAll was not handed back")
	}
}
