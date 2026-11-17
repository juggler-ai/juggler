//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitattr"
)

// shellsWatcher is a manual watcher whose running shell commands are calls,
// watching r's tree as workspace ws of a project of its own. It returns the
// watcher, the tree's channel and the project's index.
func shellsWatcher(t *testing.T, r *repo, ws string, calls ...ShellCall) (*Watcher, <-chan []Change, *gitattr.Index) {
	t.Helper()
	project := t.TempDir()
	w := manualWatcher(t)
	w.AttributeShells(func(p string) []ShellCall {
		if p != project {
			return nil
		}
		return calls
	})
	ch, err := w.Watch(t.Context(), r.dir, Attribution{Project: project, Workspace: ws})
	if err != nil {
		t.Fatal(err)
	}
	return w, ch, gitattr.ForProject(project)
}

// recorded is every record of the tree's root repository, as
// "path conv/item strength", in path then conversation order.
func recorded(x *gitattr.Index, ws string) string {
	var out []string
	for _, rec := range x.ForPaths(ws, "", nil) {
		out = append(out, fmt.Sprintf("%s %s/%s %s", rec.Path, rec.Conv, rec.Item, rec.Strength))
	}
	slices.Sort(out)
	return strings.Join(out, "; ")
}

// A file written in a tree while exactly one shell command runs there is that
// command's, strongly, at the version written — unless that version is already
// someone's. The command is found by its working directory or its workspace.
func TestWatch_ShellWritesAreAttributed(t *testing.T) {
	r := newRepo(t)
	one := ShellCall{Conv: "c1", Thread: "th1", Item: "tu1", Cwd: filepath.Join(r.dir, "sub")}
	elsewhere := ShellCall{Conv: "c9", Item: "tu9", Cwd: t.TempDir(), Workspace: "ws_other"}
	w, ch, x := shellsWatcher(t, r, "ws1", one, elsewhere)

	r.write("a.txt", "from the shell\n")
	r.write("claimed.txt", "an edit tool's\n")
	x.Add(gitattr.Record{Workspace: "ws1", Path: "claimed.txt", Blob: strings.TrimSpace(r.git("hash-object", "claimed.txt")), Conv: "c_edit", Item: "tu_edit"})
	treeEvent(w, filepath.Join(r.dir, "a.txt"), "write")
	treeEvent(w, filepath.Join(r.dir, "claimed.txt"), "write")
	treeEvent(w, filepath.Join(r.dir, ".git", "index"), "write")
	flushed(t, w, r.dir, ch)

	if got, want := recorded(x, "ws1"), "a.txt c1/tu1 strong; claimed.txt c_edit/tu_edit strong"; got != want {
		t.Errorf("records = %q, want %q", got, want)
	}
	blob := strings.TrimSpace(r.git("hash-object", "a.txt"))
	if got := x.Lookup("ws1", "", "a.txt", blob); len(got) != 1 || got[0].Thread != "th1" {
		t.Errorf("a.txt at %s = %+v, want c1's record from th1", blob, got)
	}
}

// Two shell commands running in the tree: each is recorded for what changed,
// weakly.
func TestWatch_ConcurrentShellsAreWeak(t *testing.T) {
	r := newRepo(t)
	byCwd := ShellCall{Conv: "c1", Item: "tu1", Cwd: r.dir}
	byWorkspace := ShellCall{Conv: "c2", Item: "tu2", Cwd: t.TempDir(), Workspace: "ws1"}
	w, ch, x := shellsWatcher(t, r, "ws1", byCwd, byWorkspace)

	r.write("a.txt", "one of them\n")
	treeEvent(w, filepath.Join(r.dir, "a.txt"), "create")
	flushed(t, w, r.dir, ch)

	if got, want := recorded(x, "ws1"), "a.txt c1/tu1 weak; a.txt c2/tu2 weak"; got != want {
		t.Errorf("records = %q, want %q", got, want)
	}
}

// No shell command running in the tree: nothing is recorded, and a file
// deleted records nothing either.
func TestWatch_NoShellRecordsNothing(t *testing.T) {
	r := newRepo(t)
	w, ch, x := shellsWatcher(t, r, "ws1", ShellCall{Conv: "c9", Item: "tu9", Cwd: t.TempDir(), Workspace: "ws_other"})
	r.write("a.txt", "the user's\n")
	treeEvent(w, filepath.Join(r.dir, "a.txt"), "write")
	flushed(t, w, r.dir, ch)
	if got := recorded(x, "ws1"); got != "" {
		t.Errorf("records = %q, want none", got)
	}

	w2, ch2, x2 := shellsWatcher(t, r, "ws1", ShellCall{Conv: "c1", Item: "tu1", Cwd: r.dir})
	treeEvent(w2, filepath.Join(r.dir, "gone.txt"), "write")
	flushed(t, w2, r.dir, ch2)
	if got := recorded(x2, "ws1"); got != "" {
		t.Errorf("records for a file that is not there = %q, want none", got)
	}
}
