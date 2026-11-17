//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitview"
)

// A turn snapshot takes the working tree as it is — a tracked file's edit and
// an untracked file, never an ignored one — into a ref, and leaves the user's
// index exactly as it was: the same bytes, the same staged changes.
func TestSnapshotTurnCapturesTheWorkingTreeAndLeavesTheIndex(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}
	write := func(rel, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q")
	write(".gitignore", "*.log\n")
	write("tracked.txt", "one\n")
	write("staged.txt", "s\n")
	git("add", "-A")
	git("commit", "-qm", "Initial")
	write("staged.txt", "s, staged\n")
	git("add", "staged.txt")
	write("tracked.txt", "one, edited\n")
	write("untracked.txt", "new\n")
	write("noise.log", "ignored\n")

	indexPath := filepath.Join(dir, ".git", "index")
	indexBefore, err := os.ReadFile(indexPath) //nolint:gosec // the test's own repository
	if err != nil {
		t.Fatal(err)
	}
	cachedBefore := git("diff", "--cached", "--name-status")

	q := NewQueue()
	defer q.Close()
	tree, ok, err := SnapshotTurn(t.Context(), q, dir, "conv-1")
	if err != nil || !ok {
		t.Fatalf("SnapshotTurn = %q, %v, %v", tree, ok, err)
	}

	if got := strings.TrimSpace(git("rev-parse", "refs/juggler/turns/conv-1")); got != tree {
		t.Errorf("refs/juggler/turns/conv-1 = %q, want the snapshot tree %q", got, tree)
	}
	listed := git("ls-tree", "-r", "--name-only", tree)
	for _, want := range []string{"tracked.txt", "staged.txt", "untracked.txt", ".gitignore"} {
		if !strings.Contains(listed, want+"\n") {
			t.Errorf("snapshot lacks %s:\n%s", want, listed)
		}
	}
	if strings.Contains(listed, "noise.log") {
		t.Errorf("snapshot holds the ignored noise.log:\n%s", listed)
	}
	if got := git("cat-file", "-p", tree+":tracked.txt"); got != "one, edited\n" {
		t.Errorf("tracked.txt in the snapshot = %q, want the edit on disk", got)
	}

	indexAfter, err := os.ReadFile(indexPath) //nolint:gosec // the test's own repository
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(indexBefore, indexAfter) {
		t.Error("the index changed under the snapshot")
	}
	if got := git("diff", "--cached", "--name-status"); got != cachedBefore {
		t.Errorf("staged changes after the snapshot = %q, want %q", got, cachedBefore)
	}

	if err := gitview.DropTurnSnapshot(t.Context(), dir, "conv-1"); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "-C", dir, "rev-parse", "--verify", "-q", "refs/juggler/turns/conv-1").Output(); err == nil {
		t.Errorf("the ref survived its drop: %s", out)
	}
}

// A tree that is no repository has nothing to snapshot, and says so without
// failing.
func TestSnapshotTurnOutsideARepositoryIsNoSnapshot(t *testing.T) {
	q := NewQueue()
	defer q.Close()
	if _, ok, err := SnapshotTurn(t.Context(), q, t.TempDir(), "conv-1"); ok || err != nil {
		t.Errorf("SnapshotTurn outside a repository = %v, %v; want no snapshot and no error", ok, err)
	}
}
