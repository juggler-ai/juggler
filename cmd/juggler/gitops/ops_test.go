//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitview"
)

// op runs one write against root's own repository through a queue of its own.
func op(t *testing.T, root string, o Op) (Result, error) {
	t.Helper()
	q := NewQueue()
	defer q.Close()
	var out strings.Builder
	res, err := Run(t.Context(), q, root, o, Hooks{Output: func(b []byte) { out.Write(b) }})
	if err != nil {
		t.Logf("output of the failed %s:\n%s", o.Kind, out.String())
	}
	return res, err
}

func mustOp(t *testing.T, root string, o Op) Result {
	t.Helper()
	res, err := op(t, root, o)
	if err != nil {
		t.Fatalf("%s: %v", o.Kind, err)
	}
	return res
}

// patchOf is a file's diff as the client saw it before choosing lines.
func patchOf(t *testing.T, root, path, scope string) gitview.Patch {
	t.Helper()
	p, err := gitview.ReadPatch(t.Context(), root, gitview.DiffRequest{Path: path, Scope: scope})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func (r *repo) read(rel string) string {
	r.t.Helper()
	b, err := os.ReadFile(filepath.Join(r.dir, filepath.FromSlash(rel))) //nolint:gosec // the test's own repository
	if err != nil {
		r.t.Fatal(err)
	}
	return string(b)
}

func (r *repo) exists(rel string) bool {
	_, err := os.Lstat(filepath.Join(r.dir, filepath.FromSlash(rel)))
	return err == nil
}

func (r *repo) staged() string { return strings.TrimSpace(r.git("diff", "--cached", "--name-status")) }

func (r *repo) hook(name, script string) {
	r.t.Helper()
	if runtime.GOOS == "windows" {
		r.t.Skip("hooks here are sh scripts")
	}
	path := filepath.Join(r.dir, ".git", "hooks", name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o700); err != nil { //nolint:gosec // a hook must be executable
		r.t.Fatal(err)
	}
}

// committed is a repository with a.txt "a b c d" and gone.txt committed.
func committed(t *testing.T) *repo {
	t.Helper()
	r := newRepo(t)
	r.write("a.txt", "a\nb\nc\nd\n")
	r.write("gone.txt", "bye\n")
	r.commit("init")
	return r
}

func TestStageAndUnstageFiles(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "a\nB\nc\nd\n")
	r.write("new.txt", "new\n")
	if err := os.Remove(filepath.Join(r.dir, "gone.txt")); err != nil {
		t.Fatal(err)
	}

	mustOp(t, r.dir, Op{Kind: OpStage, Paths: []string{"a.txt", "new.txt", "gone.txt"}})
	if got := r.staged(); got != "M\ta.txt\nD\tgone.txt\nA\tnew.txt" {
		t.Fatalf("staged after stage = %q", got)
	}
	mustOp(t, r.dir, Op{Kind: OpUnstage, Paths: []string{"a.txt", "new.txt", "gone.txt"}})
	if got := r.staged(); got != "" {
		t.Fatalf("staged after unstage = %q", got)
	}

	mustOp(t, r.dir, Op{Kind: OpStageAll})
	if got := r.staged(); got != "M\ta.txt\nD\tgone.txt" {
		t.Fatalf("stage-all stages tracked changes only: %q", got)
	}
	mustOp(t, r.dir, Op{Kind: OpUnstageAll})
	if got := r.staged(); got != "" {
		t.Fatalf("staged after unstage-all = %q", got)
	}
}

func TestUnstageBeforeTheFirstCommit(t *testing.T) {
	t.Parallel()
	r := newRepo(t)
	r.write("a.txt", "a\n")
	r.git("add", "a.txt")
	mustOp(t, r.dir, Op{Kind: OpUnstage, Paths: []string{"a.txt"}})
	if got := strings.TrimSpace(r.git("status", "--porcelain")); got != "?? a.txt" {
		t.Errorf("status after unstaging with no HEAD = %q", got)
	}
}

func TestRefusesPathsOutsideTheRepository(t *testing.T) {
	t.Parallel()
	r := committed(t)
	var refused *RefusedError
	if _, err := op(t, r.dir, Op{Kind: OpStage, Paths: []string{"../escape.txt"}}); !errors.As(err, &refused) {
		t.Errorf("a path out of the repository: %v", err)
	}
	if _, err := op(t, r.dir, Op{Kind: "rm-rf"}); !errors.As(err, &refused) {
		t.Errorf("an unknown kind: %v", err)
	}
}

func TestStageAndUnstageLines(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "a\nB\nc\nD\n")

	p := patchOf(t, r.dir, "a.txt", "@unstaged")
	mustOp(t, r.dir, Op{Kind: OpStageLines, Path: "a.txt", Revision: p.Revision, Lines: []LineRef{{Old: 2}, {New: 2}}})
	if got := r.git("show", ":a.txt"); got != "a\nB\nc\nd\n" {
		t.Fatalf("index after staging one change = %q", got)
	}

	s := patchOf(t, r.dir, "a.txt", "@staged")
	mustOp(t, r.dir, Op{Kind: OpUnstageLines, Path: "a.txt", Revision: s.Revision, Lines: []LineRef{{Old: 2}, {New: 2}}})
	if got := r.git("show", ":a.txt"); got != "a\nb\nc\nd\n" {
		t.Fatalf("index after unstaging it = %q", got)
	}
}

// A selection made on a diff that has since changed is refused, untouched.
func TestStageLinesOfAStaleDiff(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "a\nB\nc\nd\n")
	p := patchOf(t, r.dir, "a.txt", "@unstaged")
	r.write("a.txt", "a\nB\nc\nD\n")

	var stale *StaleError
	if _, err := op(t, r.dir, Op{Kind: OpStageLines, Path: "a.txt", Revision: p.Revision, Lines: []LineRef{{Old: 2}, {New: 2}}}); !errors.As(err, &stale) {
		t.Fatalf("err = %v, want *StaleError", err)
	}
	if got := r.staged(); got != "" {
		t.Errorf("a stale selection staged %q", got)
	}
}

func TestStageLinesOfAnUntrackedFile(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("new.txt", "a\nb\nc\n")
	p := patchOf(t, r.dir, "new.txt", "@unstaged")
	mustOp(t, r.dir, Op{Kind: OpStageLines, Path: "new.txt", Revision: p.Revision, Lines: []LineRef{{New: 1}, {New: 3}}})
	if got := r.git("show", ":new.txt"); got != "a\nc\n" {
		t.Errorf("index of a partly staged new file = %q", got)
	}
}

func TestDiscardFileAndUndo(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "a\nB\nc\nd\n")
	r.write("new.txt", "precious\n")

	res := mustOp(t, r.dir, Op{Kind: OpDiscard, Paths: []string{"a.txt", "new.txt"}})
	if got := r.read("a.txt"); got != "a\nb\nc\nd\n" {
		t.Fatalf("a.txt after discard = %q", got)
	}
	if r.exists("new.txt") {
		t.Fatal("an untracked file survived its discard")
	}
	if res.Discard == "" || strings.TrimSpace(r.git("rev-parse", DiscardRef)) != res.Discard {
		t.Fatalf("the discard %q is not the tip of %s", res.Discard, DiscardRef)
	}

	mustOp(t, r.dir, Op{Kind: OpUndoDiscard, Discard: res.Discard})
	if got := r.read("a.txt"); got != "a\nB\nc\nd\n" {
		t.Errorf("a.txt after undo = %q", got)
	}
	if got := r.read("new.txt"); got != "precious\n" {
		t.Errorf("new.txt after undo = %q", got)
	}
}

// Undo never overwrites work done after the discard; the discarded version
// stays in the ref.
func TestUndoDiscardRefusesAChangedFile(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "a\nB\nc\nd\n")
	res := mustOp(t, r.dir, Op{Kind: OpDiscard, Paths: []string{"a.txt"}})
	r.write("a.txt", "later work\n")

	var refused *RefusedError
	if _, err := op(t, r.dir, Op{Kind: OpUndoDiscard, Discard: res.Discard}); !errors.As(err, &refused) {
		t.Fatalf("err = %v, want *RefusedError", err)
	}
	if got := r.read("a.txt"); got != "later work\n" {
		t.Errorf("the refused undo wrote %q", got)
	}
	if got := r.git("show", res.Discard+":a.txt"); got != "a\nB\nc\nd\n" {
		t.Errorf("the discarded version in the ref = %q", got)
	}
}

func TestDiscardDeletionAndUndo(t *testing.T) {
	t.Parallel()
	r := committed(t)
	if err := os.Remove(filepath.Join(r.dir, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	res := mustOp(t, r.dir, Op{Kind: OpDiscard, Paths: []string{"gone.txt"}})
	if got := r.read("gone.txt"); got != "bye\n" {
		t.Fatalf("a discarded deletion restores the file: %q", got)
	}
	mustOp(t, r.dir, Op{Kind: OpUndoDiscard, Discard: res.Discard})
	if r.exists("gone.txt") {
		t.Error("undoing the discard of a deletion deletes it again")
	}
}

func TestDiscardLinesAndUndo(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "a\nB\nc\nD\n")
	p := patchOf(t, r.dir, "a.txt", "@unstaged")
	res := mustOp(t, r.dir, Op{Kind: OpDiscardLines, Path: "a.txt", Revision: p.Revision, Lines: []LineRef{{Old: 4}, {New: 4}}})
	if got := r.read("a.txt"); got != "a\nB\nc\nd\n" {
		t.Fatalf("a.txt after discarding one change = %q", got)
	}
	mustOp(t, r.dir, Op{Kind: OpUndoDiscard, Discard: res.Discard})
	if got := r.read("a.txt"); got != "a\nB\nc\nD\n" {
		t.Errorf("a.txt after undo = %q", got)
	}
}

// Discards chain onto one ref, so the refs list never grows with them.
func TestDiscardsChain(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "one\n")
	first := mustOp(t, r.dir, Op{Kind: OpDiscard, Paths: []string{"a.txt"}})
	r.write("a.txt", "two\n")
	second := mustOp(t, r.dir, Op{Kind: OpDiscard, Paths: []string{"a.txt"}})
	if parent := strings.TrimSpace(r.git("rev-parse", second.Discard+"^")); parent != first.Discard {
		t.Errorf("second discard's parent = %s, want the first %s", parent, first.Discard)
	}
	if refs := strings.TrimSpace(r.git("for-each-ref", "refs/juggler/")); strings.Count(refs, "\n") != 0 {
		t.Errorf("more than one discard ref: %q", refs)
	}
}

func TestIgnore(t *testing.T) {
	t.Parallel()
	r := committed(t)
	// Every glob character a name may hold must be escaped; Windows forbids `*`
	// in a file name, leaving it the brackets.
	name, escaped := "logs/a [1]*.log", "/logs/a \\[1\\]\\*.log"
	if runtime.GOOS == "windows" {
		name, escaped = "logs/a [1].log", "/logs/a \\[1\\].log"
	}
	r.write(name, "x\n")
	r.write("#notes.txt", "x\n")

	mustOp(t, r.dir, Op{Kind: OpIgnore, Paths: []string{name}, Pattern: IgnoreFile})
	mustOp(t, r.dir, Op{Kind: OpIgnore, Paths: []string{"#notes.txt"}, Pattern: IgnoreExtension})
	mustOp(t, r.dir, Op{Kind: OpIgnore, Paths: []string{name}, Pattern: IgnoreFolder})
	if got := r.read(".gitignore"); got != escaped+"\n*.txt\n/logs/\n" {
		t.Errorf(".gitignore = %q", got)
	}
	r.git("check-ignore", "-q", name)

	var refused *RefusedError
	if _, err := op(t, r.dir, Op{Kind: OpIgnore, Paths: []string{"a.txt"}, Pattern: IgnoreFile}); !errors.As(err, &refused) {
		t.Errorf("ignoring a tracked file: %v", err)
	}
}

func TestCommitAndAmend(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "x\n")
	r.git("add", "a.txt")

	res := mustOp(t, r.dir, Op{Kind: OpCommit, Message: "Changed a\n\n#123 is the issue\n"})
	if got := r.git("log", "-1", "--format=%B"); got != "Changed a\n\n#123 is the issue\n\n" {
		t.Errorf("message = %q", got)
	}
	if head := strings.TrimSpace(r.git("rev-parse", "HEAD")); res.Head != head {
		t.Errorf("Result.Head = %q, HEAD = %q", res.Head, head)
	}

	mustOp(t, r.dir, Op{Kind: OpCommit, Message: "Changed a, reworded", Amend: true})
	if got := strings.TrimSpace(r.git("log", "--format=%s", "-2")); got != "Changed a, reworded\ninit" {
		t.Errorf("history after amend = %q", got)
	}

	var refused *RefusedError
	if _, err := op(t, r.dir, Op{Kind: OpCommit, Message: "nothing"}); !errors.As(err, &refused) {
		t.Errorf("a commit of nothing: %v", err)
	}
}

func TestCommitHooks(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.hook("commit-msg", "printf '\\nChecked-by: hook\\n' >> \"$1\"\n")
	r.write("a.txt", "x\n")
	r.git("add", "a.txt")
	mustOp(t, r.dir, Op{Kind: OpCommit, Message: "With trailer"})
	if got := r.git("log", "-1", "--format=%B"); !strings.Contains(got, "Checked-by: hook") {
		t.Errorf("commit-msg hook did not run: %q", got)
	}

	r.hook("pre-commit", "echo 'lint: a.txt is bad'\nexit 1\n")
	r.write("a.txt", "y\n")
	r.git("add", "a.txt")
	before := r.git("rev-parse", "HEAD")
	_, err := op(t, r.dir, Op{Kind: OpCommit, Message: "Blocked"})
	if err == nil || !strings.Contains(err.Error(), "lint: a.txt is bad") {
		t.Fatalf("err = %v, want the hook's complaint", err)
	}
	if r.git("rev-parse", "HEAD") != before {
		t.Error("a commit its hook refused landed")
	}
	if got := r.staged(); got != "M\ta.txt" {
		t.Errorf("staged after the refused commit = %q", got)
	}

	// NoVerify goes past both: the refusing pre-commit, and the commit-msg trailer.
	mustOp(t, r.dir, Op{Kind: OpCommit, Message: "Past the hooks", NoVerify: true})
	if got := r.git("log", "-1", "--format=%B"); !strings.HasPrefix(got, "Past the hooks") || strings.Contains(got, "Checked-by") {
		t.Errorf("a commit with NoVerify ran its hooks, or did not land: %q", got)
	}
}

func TestCommitRefusesADetachedHead(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.git("switch", "-q", "--detach")
	r.write("a.txt", "x\n")
	r.git("add", "a.txt")
	var refused *RefusedError
	if _, err := op(t, r.dir, Op{Kind: OpCommit, Message: "Detached"}); !errors.As(err, &refused) {
		t.Errorf("err = %v, want *RefusedError", err)
	}
}

func TestUndoCommit(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "x\n")
	r.git("add", "a.txt")
	res := mustOp(t, r.dir, Op{Kind: OpCommit, Message: "Second"})

	var refused *RefusedError
	if _, err := op(t, r.dir, Op{Kind: OpUndoCommit, ExpectHead: "0000000000000000000000000000000000000000"}); !errors.As(err, &refused) {
		t.Errorf("undo of a commit that is not HEAD: %v", err)
	}
	r.git("update-ref", "refs/remotes/origin/main", "HEAD")
	if _, err := op(t, r.dir, Op{Kind: OpUndoCommit, ExpectHead: res.Head}); !errors.As(err, &refused) {
		t.Errorf("undo of a pushed commit: %v", err)
	}
	r.git("update-ref", "-d", "refs/remotes/origin/main")

	mustOp(t, r.dir, Op{Kind: OpUndoCommit, ExpectHead: res.Head})
	if got := strings.TrimSpace(r.git("log", "-1", "--format=%s")); got != "init" {
		t.Errorf("HEAD after undo = %q", got)
	}
	if got := r.staged(); got != "M\ta.txt" {
		t.Errorf("the undone commit's changes are not staged: %q", got)
	}
}

func TestUndoTheFirstCommit(t *testing.T) {
	t.Parallel()
	r := newRepo(t)
	r.write("a.txt", "a\n")
	r.git("add", "a.txt")
	res := mustOp(t, r.dir, Op{Kind: OpCommit, Message: "First"})
	mustOp(t, r.dir, Op{Kind: OpUndoCommit, ExpectHead: res.Head})
	cmd := r.git("status", "--porcelain")
	if strings.TrimSpace(cmd) != "A  a.txt" {
		t.Errorf("status after undoing the first commit = %q", cmd)
	}
}

// An index.lock is somebody else's git at work; it is reported, never removed.
func TestLockedIndex(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "x\n")
	lock := filepath.Join(r.dir, ".git", "index.lock")
	if err := os.WriteFile(lock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var locked *LockedError
	if _, err := op(t, r.dir, Op{Kind: OpStage, Paths: []string{"a.txt"}}); !errors.As(err, &locked) {
		t.Fatalf("err = %v, want *LockedError", err)
	}
	if resolved, _ := filepath.EvalSymlinks(lock); locked.Path != resolved {
		t.Errorf("LockedError names %q, want %q", locked.Path, resolved)
	}
	if _, err := os.Stat(lock); err != nil {
		t.Errorf("the lock is gone: %v", err)
	}
}

// A linked worktree is written to as itself: its own index and HEAD move, the
// main tree's do not, and what is shared — the discard ref — is shared.
func TestLinkedWorktreeWrites(t *testing.T) {
	t.Parallel()
	main, linked := withLinkedWorktree(t)
	tree := &repo{t: t, dir: linked}
	mainHead := main.git("rev-parse", "HEAD")

	tree.write("a.txt", "one\ntwo\n")
	p := patchOf(t, linked, "a.txt", "@unstaged")
	mustOp(t, linked, Op{Kind: OpStageLines, Path: "a.txt", Revision: p.Revision, Lines: []LineRef{{New: 2}}})
	res := mustOp(t, linked, Op{Kind: OpCommit, Message: "In the linked tree"})

	if got := strings.TrimSpace(tree.git("log", "-1", "--format=%s")); got != "In the linked tree" {
		t.Errorf("linked HEAD = %q", got)
	}
	if main.git("rev-parse", "HEAD") != mainHead {
		t.Error("committing in the linked tree moved the main tree's HEAD")
	}
	if got := strings.TrimSpace(main.git("rev-parse", "side")); got != res.Head {
		t.Errorf("branch side = %s, want the linked tree's commit %s", got, res.Head)
	}

	tree.write("a.txt", "changed\n")
	discard := mustOp(t, linked, Op{Kind: OpDiscard, Paths: []string{"a.txt"}})
	if got := strings.TrimSpace(main.git("rev-parse", DiscardRef)); got != discard.Discard {
		t.Errorf("the main tree sees %s at %s, want %s", got, DiscardRef, discard.Discard)
	}
}
