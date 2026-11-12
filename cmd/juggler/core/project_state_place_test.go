//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/projectpaths"
)

// placeFixture is a project whose .juggler holds local state, the files meant
// to be committed, and a file this build does not know.
func placeFixture(t *testing.T) (project, outside string) {
	t.Helper()
	t.Setenv(projectpaths.StateDirEnv, t.TempDir())
	project = t.TempDir()
	shared := filepath.Join(project, ".juggler")
	write := func(rel, content string) {
		t.Helper()
		p := filepath.Join(shared, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("session.json", `{"version":4}`)
	write("config.json", `{}`)
	write("MEMORY.md", "remember")
	write("env.local.json", `{"A":"1"}`)
	write("Chat--conv_abc123/txns/t1.json", `{}`)
	write("trash/Old--conv_old999/doc.yjs", "x")
	write("bash-output/conv_abc123/out.txt", "out")
	write("env.json", `{"B":"2"}`)
	write("commands/hello.md", "hi")
	write("skills/s/SKILL.md", "skill")
	write("mcp.json", `{}`)
	write("worktree-setup", "#!/bin/sh")
	write("bookmarks.json", `[]`)
	return project, projectpaths.OutsideDir(project)
}

func mustExist(t *testing.T, paths ...string) {
	t.Helper()
	for _, p := range paths {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("want %s to exist: %v", p, err)
		}
	}
}

func mustNotExist(t *testing.T, paths ...string) {
	t.Helper()
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("want %s gone", p)
		}
	}
}

func place(t *testing.T, project string, outside bool) *InstanceLock {
	t.Helper()
	lock, res, err := PlaceProjectState(project, outside)
	if err != nil || !res.Acquired {
		t.Fatalf("PlaceProjectState(outside=%v): acquired=%v err=%v", outside, res.Acquired, err)
	}
	t.Cleanup(func() { _ = lock.Release() })
	return lock
}

// Local state moves out and back whole; what is meant to be committed, and
// what this build does not know, never leaves the project.
func TestPlaceProjectStateMovesLocalStateBothWays(t *testing.T) {
	project, outside := placeFixture(t)
	shared := filepath.Join(project, ".juggler")
	local := []string{"session.json", "config.json", "MEMORY.md", "env.local.json",
		"Chat--conv_abc123/txns/t1.json", "trash/Old--conv_old999/doc.yjs", "bash-output/conv_abc123/out.txt"}
	kept := []string{"env.json", "commands/hello.md", "skills/s/SKILL.md", "mcp.json", "worktree-setup", "bookmarks.json"}
	in := func(dir string, rels []string) []string {
		var out []string
		for _, r := range rels {
			out = append(out, filepath.Join(dir, r))
		}
		return out
	}

	lock := place(t, project, true)
	if got := projectpaths.StateDir(project); got != outside {
		t.Fatalf("after moving out, state resolves to %s, want %s", got, outside)
	}
	if lock.Path() != filepath.Join(outside, lockFileName) {
		t.Errorf("lock taken at %s, want the outside folder's", lock.Path())
	}
	mustExist(t, in(outside, local)...)
	mustNotExist(t, in(shared, local)...)
	mustExist(t, in(shared, kept)...)
	mustNotExist(t, filepath.Join(shared, lockFileName), filepath.Join(shared, instanceInfoFileName))
	_ = lock.Release()

	lock = place(t, project, false)
	if got := projectpaths.StateDir(project); got != shared {
		t.Fatalf("after moving back, state resolves to %s, want %s", got, shared)
	}
	mustExist(t, in(shared, local)...)
	mustExist(t, in(shared, kept)...)
	mustNotExist(t, outside)
	_ = lock.Release()
}

// A project that has only local state is left with no .juggler at all.
func TestPlaceProjectStateLeavesNoEmptyProjectFolder(t *testing.T) {
	t.Setenv(projectpaths.StateDirEnv, t.TempDir())
	project := t.TempDir()
	shared := filepath.Join(project, ".juggler")
	if err := os.MkdirAll(filepath.Join(shared, "Chat--conv_abc123"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(shared, "session.json"), []byte(`{}`), 0o644)
	_ = os.WriteFile(filepath.Join(shared, ".DS_Store"), nil, 0o644)

	place(t, project, true)
	mustNotExist(t, shared)
}

// A fresh project opened with the setting on never gets a .juggler.
func TestPlaceProjectStateFreshProjectStartsOutside(t *testing.T) {
	t.Setenv(projectpaths.StateDirEnv, t.TempDir())
	project := t.TempDir()
	place(t, project, true)
	mustNotExist(t, filepath.Join(project, ".juggler"))
	if !projectpaths.For(project).Outside() {
		t.Fatal("a fresh project placed outside must resolve outside")
	}
}

// State in use by another process is never moved from under it: the refusal
// names the lock that process holds, and nothing moves.
func TestPlaceProjectStateRefusesWhileTheOldLockIsHeld(t *testing.T) {
	project, outside := placeFixture(t)
	holder := NewInstanceLock(project)
	if res, err := holder.TryAcquire(); err != nil || !res.Acquired {
		t.Fatalf("holder: acquired=%v err=%v", res.Acquired, err)
	}
	t.Cleanup(func() { _ = holder.Release() })

	lock, res, err := PlaceProjectState(project, true)
	if err != nil || res.Acquired {
		t.Fatalf("acquired=%v err=%v, want a refusal", res.Acquired, err)
	}
	if lock.Path() != holder.Path() {
		t.Errorf("refusal names %s, want the held lock %s", lock.Path(), holder.Path())
	}
	mustNotExist(t, outside)
	mustExist(t, filepath.Join(project, ".juggler", "session.json"))
}

// A scratch-copy sandbox is a folder of the state: its row is repointed to
// where it moved, and nothing else in session.json changes.
func TestPlaceProjectStateRepointsSandboxes(t *testing.T) {
	project, outside := placeFixture(t)
	shared := filepath.Join(project, ".juggler")
	work := filepath.Join(shared, "sandboxes", "try", "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "worktree")
	session := map[string]any{
		"version":    4,
		"unknownKey": "kept",
		"workspaces": []any{
			map[string]any{"id": "ws1", "root": work, "meta": map[string]any{
				"baseDir": project, "dir": filepath.Join(shared, "sandboxes", "try"), "work": work,
				"pristine": filepath.Join(shared, "sandboxes", "try", "pristine"), "name": "try"}},
			map[string]any{"id": "ws2", "root": other},
		},
	}
	data, _ := json.Marshal(session)
	if err := os.WriteFile(filepath.Join(shared, "session.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	place(t, project, true)

	data, err := os.ReadFile(filepath.Join(outside, "session.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		UnknownKey string `json:"unknownKey"`
		Workspaces []struct {
			Root string            `json:"root"`
			Meta map[string]string `json:"meta"`
		} `json:"workspaces"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	newWork := filepath.Join(outside, "sandboxes", "try", "work")
	if got.Workspaces[0].Root != newWork || got.Workspaces[0].Meta["work"] != newWork {
		t.Errorf("sandbox row = %+v, want root and meta.work %s", got.Workspaces[0], newWork)
	}
	if got.Workspaces[0].Meta["baseDir"] != project {
		t.Errorf("meta.baseDir = %q, want the project it was copied from", got.Workspaces[0].Meta["baseDir"])
	}
	if got.Workspaces[1].Root != other || got.UnknownKey != "kept" {
		t.Errorf("unrelated content changed: %+v", got)
	}
	mustExist(t, newWork)
}
