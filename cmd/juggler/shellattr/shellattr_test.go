//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package shellattr

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/gitattr"
)

// flushNow has the tree flush everything it heard before the call, and waits
// for it. The tests' trees flush only when told.
func (t *tree) flushNow() {
	flushed := make(chan struct{})
	select {
	case t.notes <- note{flushed: flushed}:
		<-flushed
	case <-t.done:
	}
}

// gitRepo makes a repository in a directory of its own and returns it.
func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dir := t.TempDir()
	gitIn(t, dir, "init", "-q")
	return dir
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, dir, rel, content string) string {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// shells is a settable list of running shell commands.
type shells struct {
	calls atomic.Pointer[[]ShellCall]
}

func (s *shells) set(calls ...ShellCall) {
	s.calls.Store(&calls)
}

func (s *shells) running(string) []ShellCall {
	if calls := s.calls.Load(); calls != nil {
		return slices.Clone(*calls)
	}
	return nil
}

// manualRecorder is a recorder of project whose trees flush only when told.
func manualRecorder(t *testing.T, project string, running RunningShells, roots Roots) *Recorder {
	t.Helper()
	if roots == nil {
		roots = func(string) (string, bool) { return "", false }
	}
	r := newRecorder(project, running, roots, true)
	t.Cleanup(r.Close)
	return r
}

// recorded is every record of a workspace's root repository, as
// "path conv/item strength", in path then conversation order.
func recorded(x *gitattr.Index, ws string) string {
	var out []string
	for _, rec := range x.ForPaths(ws, "", nil) {
		out = append(out, fmt.Sprintf("%s %s/%s %s", rec.Path, rec.Conv, rec.Item, rec.Strength))
	}
	slices.Sort(out)
	return strings.Join(out, "; ")
}

// A file written in the project while exactly one shell command runs there is
// that command's, strongly, at the version written — unless that version is
// already someone's. Git's own directory is never anyone's.
func TestRecorder_ShellWritesAreAttributed(t *testing.T) {
	project := gitRepo(t)
	one := ShellCall{Conv: "c1", Thread: "th1", Item: "tu1", Cwd: filepath.Join(project, "sub")}
	elsewhere := ShellCall{Conv: "c9", Item: "tu9", Cwd: t.TempDir(), Workspace: "ws_other"}
	var sh shells
	sh.set(one, elsewhere)
	r := manualRecorder(t, project, sh.running, nil)
	x := gitattr.ForProject(project)

	a := write(t, project, "a.txt", "from the shell\n")
	claimed := write(t, project, "claimed.txt", "an edit tool's\n")
	x.Add(gitattr.Record{Path: "claimed.txt", Blob: gitIn(t, project, "hash-object", "claimed.txt"), Conv: "c_edit", Item: "tu_edit"})
	r.ProjectChanged(a, "write")
	r.ProjectChanged(claimed, "write")
	r.ProjectChanged(filepath.Join(project, ".git", "index"), "write")
	r.ProjectChanged(a, "remove")
	r.projectTree.flushNow()

	if got, want := recorded(x, ""), "a.txt c1/tu1 strong; claimed.txt c_edit/tu_edit strong"; got != want {
		t.Errorf("records = %q, want %q", got, want)
	}
	blob := gitIn(t, project, "hash-object", "a.txt")
	if got := x.Lookup("", "", "a.txt", blob); len(got) != 1 || got[0].Thread != "th1" {
		t.Errorf("a.txt at %s = %+v, want c1's record from th1", blob, got)
	}
}

// Two shell commands running in a tree, one found by its directory and one by
// its workspace: each is recorded for what changed, weakly.
func TestRecorder_ConcurrentShellsAreWeak(t *testing.T) {
	tree := gitRepo(t)
	project := t.TempDir()
	var sh shells
	sh.set(ShellCall{Conv: "c1", Item: "tu1", Cwd: tree}, ShellCall{Conv: "c2", Item: "tu2", Cwd: t.TempDir(), Workspace: "ws1"})
	r := manualRecorder(t, project, sh.running, nil)
	ws := r.newTree("ws1", tree, nil)
	t.Cleanup(ws.end)

	ws.changed(write(t, tree, "a.txt", "one of them\n"), "create")
	ws.flushNow()

	if got, want := recorded(gitattr.ForProject(project), "ws1"), "a.txt c1/tu1 weak; a.txt c2/tu2 weak"; got != want {
		t.Errorf("records = %q, want %q", got, want)
	}
}

// No shell command running in the tree: nothing is recorded, and a file
// that is not there records nothing either.
func TestRecorder_NoShellRecordsNothing(t *testing.T) {
	project := gitRepo(t)
	var sh shells
	sh.set(ShellCall{Conv: "c9", Item: "tu9", Cwd: t.TempDir(), Workspace: "ws_other"})
	r := manualRecorder(t, project, sh.running, nil)
	x := gitattr.ForProject(project)

	r.ProjectChanged(write(t, project, "a.txt", "the user's\n"), "write")
	r.projectTree.flushNow()
	if got := recorded(x, ""); got != "" {
		t.Errorf("records = %q, want none", got)
	}

	sh.set(ShellCall{Conv: "c1", Item: "tu1", Cwd: project})
	r.ProjectChanged(filepath.Join(project, "gone.txt"), "write")
	r.projectTree.flushNow()
	if got := recorded(x, ""); got != "" {
		t.Errorf("records for a file that is not there = %q, want none", got)
	}
}

// A workspace tree is watched while a shell command runs in it and for the
// linger after the last one ends, then let go. The project's own tree, and a
// workspace that is not on this machine, are never watched apart.
func TestRecorder_WorkspaceTreesAreWatchedWhileShellsRun(t *testing.T) {
	project := t.TempDir()
	tree := t.TempDir()
	var sh shells
	roots := map[string]string{"ws1": tree, "ws_project": project}
	r := manualRecorder(t, project, sh.running, func(id string) (string, bool) {
		root, ok := roots[id]
		return root, ok
	})
	watched := func() []string {
		var ids []string
		for id := range r.trees {
			ids = append(ids, id)
		}
		slices.Sort(ids)
		return ids
	}

	now := time.Unix(1_000_000, 0)
	sh.set(ShellCall{Conv: "c1", Item: "tu1", Workspace: "ws1"}, ShellCall{Conv: "c2", Item: "tu2", Workspace: "ws_project"},
		ShellCall{Conv: "c3", Item: "tu3", Workspace: "ws_far"})
	if next := r.reconcile(now); !next.IsZero() {
		t.Errorf("a busy tree is due to stop at %v", next)
	}
	if got := watched(); !slices.Equal(got, []string{"ws1"}) {
		t.Fatalf("watched = %v, want only ws1", got)
	}
	if r.trees["ws1"].fw == nil {
		t.Fatal("ws1's tree has no watcher")
	}

	sh.set()
	if next := r.reconcile(now); !next.Equal(now.Add(linger)) {
		t.Errorf("an idle tree is due to stop at %v, want %v", next, now.Add(linger))
	}
	if next := r.reconcile(now.Add(linger / 2)); !next.Equal(now.Add(linger)) || !slices.Equal(watched(), []string{"ws1"}) {
		t.Errorf("mid-linger: due %v, watched %v; want %v and ws1 kept", next, watched(), now.Add(linger))
	}
	if next := r.reconcile(now.Add(linger)); !next.IsZero() || len(watched()) != 0 {
		t.Errorf("after the linger: due %v, watched %v; want nothing", next, watched())
	}
}
