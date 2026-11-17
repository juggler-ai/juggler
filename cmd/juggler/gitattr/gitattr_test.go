//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitattr

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// convs is the conversations of records, in order.
func convs(rs []Record) string {
	var out []string
	for _, r := range rs {
		out = append(out, r.Conv)
	}
	return strings.Join(out, ",")
}

// A file is found by its path and by the version written; each conversation
// keeps only its newest version of a file, and the newest record comes first.
func TestGitAttrRecordAndLookup(t *testing.T) {
	x := Open(filepath.Join(t.TempDir(), FileName))
	x.Add(Record{Path: "a.go", Blob: "b1", Conv: "c1", Item: "t1"})
	x.Add(Record{Path: "a.go", Blob: "b2", Conv: "c2", Item: "t2", Strength: Weak})
	x.Add(Record{Path: "b.go", Blob: "b3", Conv: "c1"})
	x.Add(Record{Workspace: "ws", Path: "a.go", Blob: "b1", Conv: "c3"})
	x.Add(Record{Repo: "sub", Path: "a.go", Blob: "b1", Conv: "c4"})

	if got := convs(x.ForPaths("", "", []string{"a.go"})); got != "c2,c1" {
		t.Errorf("records of a.go = %q, want c2,c1 (newest first, this tree and repo only)", got)
	}
	if got := convs(x.ForPaths("", "", nil)); got != "c1,c2,c1" {
		t.Errorf("every record of the tree's repo = %q, want c1,c2,c1", got)
	}
	if got := x.Lookup("", "", "a.go", "b1"); len(got) != 1 || got[0].Conv != "c1" || got[0].Item != "t1" || got[0].Strength != Strong || got[0].Time == 0 {
		t.Errorf("lookup of a.go at b1 = %+v, want c1's strong, stamped record", got)
	}
	if got := x.Lookup("", "", "a.go", "b2"); len(got) != 1 || got[0].Strength != Weak {
		t.Errorf("lookup of a.go at b2 = %+v, want c2's weak record", got)
	}

	// c1 writes a.go again: its record moves to the new version.
	x.Add(Record{Path: "a.go", Blob: "b9", Conv: "c1"})
	if got := x.Lookup("", "", "a.go", "b1"); len(got) != 0 {
		t.Errorf("c1's earlier version is still recorded: %+v", got)
	}
	if got := convs(x.ForPaths("", "", []string{"a.go"})); got != "c1,c2" {
		t.Errorf("records of a.go after c1 wrote it again = %q, want c1,c2", got)
	}
}

// What an index records is there for the next one opened over the same file.
func TestGitAttrPersists(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state", FileName)
	Open(file).Add(Record{Path: "a.go", Blob: "b1", Conv: "c1", Thread: "th", Item: "t1"})
	got := Open(file).Lookup("", "", "a.go", "b1")
	if len(got) != 1 || got[0].Thread != "th" || got[0].Item != "t1" {
		t.Fatalf("reopened index has %+v, want c1's record", got)
	}
}

// A conversation pruned leaves nothing of itself, on disk as well; the last
// record going takes the file with it.
func TestGitAttrPruneConversation(t *testing.T) {
	file := filepath.Join(t.TempDir(), FileName)
	x := Open(file)
	x.Add(Record{Path: "a.go", Blob: "b1", Conv: "c1"})
	x.Add(Record{Path: "b.go", Blob: "b2", Conv: "c1"})
	x.Add(Record{Path: "a.go", Blob: "b3", Conv: "c2"})
	x.PruneConversation("c1")
	if got := convs(x.ForPaths("", "", nil)); got != "c2" {
		t.Errorf("after pruning c1 = %q, want c2", got)
	}
	if got := convs(Open(file).ForPaths("", "", nil)); got != "c2" {
		t.Errorf("after pruning c1, the file holds %q, want c2", got)
	}
	x.PruneConversation("c2")
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Errorf("an empty index left its file behind: %v", err)
	}
}

// A record past MaxAge is dropped: from a file read, and from an index that
// grew old while open.
func TestGitAttrAgeCap(t *testing.T) {
	file := filepath.Join(t.TempDir(), FileName)
	now := time.Now()
	old := now.Add(-MaxAge - time.Hour).UnixMilli()
	data, _ := json.Marshal(fileShape{Records: []Record{
		{Path: "old.go", Blob: "b0", Conv: "c0", Time: old, Strength: Strong},
		{Path: "new.go", Blob: "b1", Conv: "c1", Time: now.UnixMilli(), Strength: Strong},
	}})
	if err := os.WriteFile(file, data, 0o644); err != nil {
		t.Fatal(err)
	}
	x := Open(file)
	if got := convs(x.ForPaths("", "", nil)); got != "c1" {
		t.Errorf("a file with an old record reads as %q, want c1 only", got)
	}
	if raw, _ := os.ReadFile(file); strings.Contains(string(raw), "old.go") {
		t.Errorf("the old record is still on disk: %s", raw)
	}

	x.now = func() time.Time { return now.Add(MaxAge + time.Hour) }
	if got := x.ForPaths("", "", nil); len(got) != 0 {
		t.Errorf("records past their age are still answered: %+v", got)
	}
}

// Writers recording at once lose none of each other's records, in memory or
// on disk.
func TestGitAttrConcurrentRecords(t *testing.T) {
	file := filepath.Join(t.TempDir(), FileName)
	x := Open(file)
	var wg sync.WaitGroup
	for i := range 40 {
		wg.Go(func() {
			x.Add(Record{Path: fmt.Sprintf("f%d.go", i), Blob: "b", Conv: fmt.Sprintf("c%d", i%4)})
			x.ForPaths("", "", nil)
		})
	}
	wg.Wait()
	if got := len(x.ForPaths("", "", nil)); got != 40 {
		t.Errorf("%d records after 40 concurrent writes, want 40", got)
	}
	if got := len(Open(file).ForPaths("", "", nil)); got != 40 {
		t.Errorf("the file holds %d records after 40 concurrent writes, want 40", got)
	}
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// Locate names a file as the git views do — its repository relative to the
// tree, its path relative to the repository — and its blob id is the one git
// stages for it. A file in no repository is not located.
func TestGitAttrLocate(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	root := t.TempDir()
	gitIn(t, root, "init", "-q")
	sub := filepath.Join(root, "libs", "inner")
	if err := os.MkdirAll(filepath.Join(sub, "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	gitIn(t, sub, "init", "-q")
	write := func(path, content string) string {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}

	top := write(filepath.Join(root, "dir", "a.txt"), "hello\n")
	gitIn(t, root, "add", "dir/a.txt")
	staged := strings.Fields(gitIn(t, root, "ls-files", "-s", "--", "dir/a.txt"))[1]
	got, ok, err := Locate(t.Context(), root, top)
	if err != nil || !ok || got != (Located{Repo: "", Path: "dir/a.txt", Blob: staged}) {
		t.Errorf("Locate(dir/a.txt) = %+v, %v, %v; want the root repo, dir/a.txt, %s", got, ok, err, staged)
	}

	inner := write(filepath.Join(sub, "pkg", "b.txt"), "inner\n")
	want := gitIn(t, sub, "hash-object", "pkg/b.txt")
	got, ok, err = Locate(t.Context(), root, inner)
	if err != nil || !ok || got != (Located{Repo: "libs/inner", Path: "pkg/b.txt", Blob: want}) {
		t.Errorf("Locate(libs/inner/pkg/b.txt) = %+v, %v, %v; want libs/inner, pkg/b.txt, %s", got, ok, err, want)
	}

	// A tree rooted inside a repository: the repository is the tree's own,
	// and the path is from its top level.
	got, ok, err = Locate(t.Context(), filepath.Join(root, "dir"), top)
	if err != nil || !ok || got.Repo != "" || got.Path != "dir/a.txt" {
		t.Errorf("Locate from a tree inside the repo = %+v, %v, %v; want dir/a.txt of the enclosing repo", got, ok, err)
	}

	loose := t.TempDir()
	if got, ok, err := Locate(t.Context(), loose, write(filepath.Join(loose, "c.txt"), "x")); ok || err != nil {
		t.Errorf("Locate outside any repository = %+v, %v, %v; want not located", got, ok, err)
	}
	if _, ok, _ := Locate(t.Context(), root, filepath.Join(root, ".git", "config")); ok {
		t.Error("a file inside .git was located")
	}
}
