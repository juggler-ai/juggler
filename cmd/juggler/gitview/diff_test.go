//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These are Diff's tests rather than its parser's: each one builds a real
// repository, puts it into the state under test with real git commands, and asks
// Diff what changed. What the diff contract promises is a statement about git's
// behaviour, and only git can be asked whether that is what it does.

// gitProject is a throwaway project directory holding a throwaway repository.
type gitProject struct {
	t    *testing.T
	root string // the root Diff, Review and Status are given
	dir  string // this repository's directory; the root repo's is the root itself
	rel  string // this repository's path relative to the project root
}

// newGitProject creates a project whose root is itself a repository. git reads
// the machine's and the user's own configuration unless it is told not to, and
// either can carry anything from core.autocrlf to a template directory of hooks;
// these tests describe git's behaviour, so they run it with no settings but the
// ones they set themselves.
func newGitProject(t *testing.T) *gitProject {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	unhurried(t)

	root := t.TempDir()
	p := &gitProject{t: t, root: root, dir: root}
	p.init()
	return p
}

// nested returns a second repository inside this one's working tree, which is
// what a submodule or a vendored checkout looks like to the endpoint.
func (p *gitProject) nested(rel string) *gitProject {
	p.t.Helper()
	dir := filepath.Join(p.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		p.t.Fatal(err)
	}
	nested := &gitProject{t: p.t, root: p.root, dir: dir, rel: rel}
	nested.init()
	return nested
}

// The identity a commit needs, and the housekeeping this repository must not
// do — as the text `git config` would have written, appended to the config git
// init just made. A spawn is the expensive unit in this package (on Windows a
// CreateProcess and an image scan apiece) and this harness builds forty-five
// repositories, so the settings are written once rather than run five times.
//
// git does its housekeeping after a commit, in a process it detaches and leaves
// running, and it holds `.git/objects/maintenance.lock` while it works. A test
// that hashes the repository before and after asking the endpoint something
// sees that lock disappear between the two and reports it as a write of ours,
// so this repository keeps no housekeeping of its own. Both maintenance keys:
// the second is what the gits that predate the first read.
const gitProjectConfig = "[user]\n\temail = test@example.com\n\tname = Juggler Test\n" +
	"[commit]\n\tgpgsign = false\n" +
	"[maintenance]\n\tauto = false\n" +
	"[gc]\n\tauto = 0\n"

func (p *gitProject) init() {
	p.t.Helper()
	p.git("init", "-q")
	cfg := filepath.Join(p.dir, ".git", "config")
	existing, err := os.ReadFile(cfg) //nolint:gosec // a repository this test made a line ago
	if err != nil {
		p.t.Fatal(err)
	}
	if err := os.WriteFile(cfg, append(existing, gitProjectConfig...), 0o600); err != nil {
		p.t.Fatal(err)
	}
}

// git runs one git command in this repository and fails the test if it could not.
func (p *gitProject) git(args ...string) string {
	p.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = p.dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		p.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// write creates or replaces a file in the repository's working tree.
func (p *gitProject) write(rel, content string) {
	p.t.Helper()
	abs := filepath.Join(p.dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
		p.t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o600); err != nil {
		p.t.Fatal(err)
	}
}

// backdate moves a working-tree file's timestamps a day into the past, which is
// how a test says "this file was written a while ago" without waiting. git
// distrusts stat information as new as the index it would be cached in, so a
// file's age decides whether git can act on having re-read it.
func (p *gitProject) backdate(rel string) {
	p.t.Helper()
	abs := filepath.Join(p.dir, filepath.FromSlash(rel))
	old := time.Now().Add(-24 * time.Hour)
	if err := os.Chtimes(abs, old, old); err != nil {
		p.t.Fatal(err)
	}
}

// commit stages everything in the working tree and commits it.
func (p *gitProject) commit(message string) {
	p.t.Helper()
	p.git("add", "-A")
	p.git("commit", "-qm", message)
}

// ask asks for one file's diff the way the API does and hands back whatever came
// of it, refusal or failure included.
func (p *gitProject) ask(ctx context.Context, fileRel string) (FileDiff, error) {
	p.t.Helper()
	return Diff(ctx, p.root, DiffRequest{Repo: p.rel, Path: fileRel})
}

// diff is ask for the ordinary case: there was an answer, and the answer is what
// the test is about.
func (p *gitProject) diff(fileRel string) FileDiff {
	p.t.Helper()
	resp, err := p.ask(p.t.Context(), fileRel)
	if err != nil {
		p.t.Fatalf("diff %q: %v", fileRel, err)
	}
	return resp
}

// diffAt is diff with a context width asked for, as the viewer's control sends
// it: the raw query value, so a test can send something that is not a number.
func (p *gitProject) diffAt(fileRel, context string) FileDiff {
	p.t.Helper()
	resp, err := Diff(p.t.Context(), p.root, DiffRequest{Repo: p.rel, Path: fileRel, Context: context})
	if err != nil {
		p.t.Fatalf("diff %q context=%q: %v", fileRel, context, err)
	}
	return resp
}

// refused reports whether a diff was turned down for what it asked for, which
// the API answers with a 400 rather than the 502 of a diff git could not read.
func refused(err error) bool {
	var request *RequestError
	return errors.As(err, &request)
}

// unchangedLines counts the context a response carries — what the width asked
// for is a request for.
func unchangedLines(resp FileDiff) int {
	n := 0
	for _, hunk := range resp.Hunks {
		for _, line := range hunk.Lines {
			if line.Kind != "add" && line.Kind != "remove" {
				n++
			}
		}
	}
	return n
}

// lineText renders a response's lines as "+added"/"-removed"/" context", which is
// how a failure reads as the patch it is.
func lineText(resp FileDiff) string {
	var b strings.Builder
	for _, hunk := range resp.Hunks {
		for _, line := range hunk.Lines {
			switch line.Kind {
			case "add":
				b.WriteString("+" + line.Text + "\n")
			case "remove":
				b.WriteString("-" + line.Text + "\n")
			default:
				b.WriteString(" " + line.Text + "\n")
			}
		}
	}
	return b.String()
}

// Reading one file's diff is as much a read as reading the whole review, and it
// is the one a user does over and over: a click per file, each of them a chance
// to rewrite the index under the git client they have open in another window.
func TestGitDiffChangesNothingOnDisk(t *testing.T) {
	p := newGitProject(t)
	p.write("kept.txt", "one\ntwo\n")
	p.write("edited.txt", "one\n")
	p.commit("init")

	p.write("edited.txt", "one\nEDITED\n")
	// A tracked file rewritten with the content it already has, old enough for git
	// to trust what it just read about it, is what tempts git into refreshing the
	// index — see TestGitReviewChangesNothingOnDisk.
	p.write("kept.txt", "one\ntwo\n")
	p.backdate("kept.txt")

	before := p.snapshot()
	if got := lineText(p.diff("edited.txt")); got == "" {
		t.Fatal("the diff was empty before it could prove anything")
	}
	after := p.snapshot()

	for path, was := range before {
		switch now, present := after[path]; {
		case !present:
			t.Errorf("the diff removed %s", path)
		case now != was:
			t.Errorf("the diff rewrote %s", path)
		}
	}
	for path := range after {
		if _, present := before[path]; !present {
			t.Errorf("the diff created %s", path)
		}
	}
}

// The index is a staging area, not a second answer: what the user has told git
// about and what they have not are one file on disk, and the review is of the
// file. A change half-staged must therefore read as one diff against HEAD,
// whichever half it is.
func TestGitDiffFoldsTheIndexAndWorktreeIntoOneAnswer(t *testing.T) {
	p := newGitProject(t)
	p.write("staged.txt", "one\ntwo\n")
	p.write("unstaged.txt", "one\ntwo\n")
	p.write("both.txt", "one\ntwo\n")
	p.commit("init")

	p.write("staged.txt", "one\nSTAGED\n")
	p.git("add", "staged.txt")

	p.write("unstaged.txt", "one\nUNSTAGED\n")

	p.write("both.txt", "one\nSTAGED\n")
	p.git("add", "both.txt")
	p.write("both.txt", "one\nEDITED AGAIN\n")

	for _, tc := range []struct{ file, want string }{
		{"staged.txt", "+STAGED"},
		{"unstaged.txt", "+UNSTAGED"},
		{"both.txt", "+EDITED AGAIN"},
	} {
		t.Run(tc.file, func(t *testing.T) {
			resp := p.diff(tc.file)
			if resp.Status != "modified" {
				t.Errorf("Status = %q, want %q", resp.Status, "modified")
			}
			if got := lineText(resp); !strings.Contains(got, tc.want+"\n") {
				t.Errorf("diff does not show the final state %q:\n%s", tc.want, got)
			}
			if resp.Added != 1 || resp.Removed != 1 {
				t.Errorf("+%d/-%d, want +1/-1", resp.Added, resp.Removed)
			}
		})
	}
}

// A file git has never been told about has no diff of its own to give, so the
// endpoint makes one: the whole file, added. The variants are the ways that can
// go wrong — nothing to add, bytes nobody can read as lines, and a name that
// points somewhere else entirely.
func TestGitDiffReadsUntrackedFilesItself(t *testing.T) {
	p := newGitProject(t)
	p.write("committed.txt", "x\n")
	p.commit("init")

	p.write("new.txt", "alpha\nbeta\n")
	p.write("empty.txt", "")
	if err := os.WriteFile(filepath.Join(p.dir, "blob.bin"), []byte{0x1, 0x0, 0x2, 0x0}, 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("text", func(t *testing.T) {
		resp := p.diff("new.txt")
		if resp.Status != "untracked" {
			t.Errorf("Status = %q, want %q", resp.Status, "untracked")
		}
		if got := lineText(resp); got != "+alpha\n+beta\n" {
			t.Errorf("lines = %q, want the whole file added", got)
		}
		if resp.Added != 2 {
			t.Errorf("Added = %d, want 2", resp.Added)
		}
	})
	t.Run("empty", func(t *testing.T) {
		resp := p.diff("empty.txt")
		if resp.Status != "untracked" {
			t.Errorf("Status = %q, want %q", resp.Status, "untracked")
		}
		if len(resp.Hunks) != 0 || resp.Added != 0 {
			t.Errorf("an empty file added %d lines in %d hunks, want nothing", resp.Added, len(resp.Hunks))
		}
	})
	t.Run("binary", func(t *testing.T) {
		resp := p.diff("blob.bin")
		if !resp.Binary {
			t.Error("Binary = false for a file holding NUL bytes")
		}
		if len(resp.Hunks) != 0 {
			t.Errorf("len(Hunks) = %d, want no invented text for binary content", len(resp.Hunks))
		}
	})
	// A symlink's own content is the path it holds, and that is what git would
	// store for it. Reading through it would show a file from somewhere else under
	// this file's name; showing nothing at all would leave the user looking at a
	// file the review says exists and cannot describe.
	t.Run("symlink", func(t *testing.T) {
		if err := os.Symlink(filepath.Join(p.dir, "committed.txt"), filepath.Join(p.dir, "link.txt")); err != nil {
			t.Skipf("symlinks unavailable here: %v", err)
		}
		resp := p.diff("link.txt")
		if resp.Status != "untracked" {
			t.Errorf("Status = %q, want %q", resp.Status, "untracked")
		}
		if got := lineText(resp); got != "+"+filepath.Join(p.dir, "committed.txt")+"\n" {
			t.Errorf("lines = %q, want the link's own text added", got)
		}
		if resp.NewMode != gitSymlinkMode {
			t.Errorf("NewMode = %q, want %q — without it a link reads as an ordinary file holding a path", resp.NewMode, gitSymlinkMode)
		}
		if resp.Added != 1 {
			t.Errorf("Added = %d, want 1", resp.Added)
		}
	})
}

// What happened to a file is not always something that happened inside it.
func TestGitDiffReportsWhatHappenedToTheFile(t *testing.T) {
	p := newGitProject(t)
	p.write("kept.txt", "one\ntwo\n")
	p.write("gone.txt", "delete me\n")
	p.write("moved.txt", "move me\nunchanged\n")
	p.commit("init")

	p.write("fresh.txt", "brand new\n")
	p.git("add", "fresh.txt")
	p.git("rm", "-q", "gone.txt")
	p.git("mv", "moved.txt", "arrived.txt")

	t.Run("added", func(t *testing.T) {
		resp := p.diff("fresh.txt")
		if resp.Status != "added" {
			t.Errorf("Status = %q, want %q", resp.Status, "added")
		}
		if resp.Added != 1 {
			t.Errorf("Added = %d, want 1", resp.Added)
		}
	})
	t.Run("deleted", func(t *testing.T) {
		resp := p.diff("gone.txt")
		if resp.Status != "deleted" {
			t.Errorf("Status = %q, want %q", resp.Status, "deleted")
		}
		if got := lineText(resp); got != "-delete me\n" {
			t.Errorf("lines = %q, want the committed side shown as removed", got)
		}
	})
	// Rename detection is a comparison between two paths, and the pathspec for one
	// file holds only one of them: asked about the new path alone git reports a
	// file that appeared out of nowhere. Only metadata generated for the whole
	// repository knows the file arrived from somewhere.
	t.Run("renamed", func(t *testing.T) {
		resp := p.diff("arrived.txt")
		if resp.Status != "renamed" {
			t.Errorf("Status = %q, want %q", resp.Status, "renamed")
		}
		if resp.OldPath != "moved.txt" {
			t.Errorf("OldPath = %q, want %q", resp.OldPath, "moved.txt")
		}
		if resp.Added != 0 || resp.Removed != 0 {
			t.Errorf("+%d/-%d, want a pure rename to change no lines", resp.Added, resp.Removed)
		}
	})
}

// A file that moved and was edited is still one file that moved. Git pairs the
// two paths by how alike they are, so the patch has to be asked for under both
// of them or the pairing it already made cannot be reproduced.
func TestGitDiffReportsARenameThatAlsoChanged(t *testing.T) {
	p := newGitProject(t)
	var before strings.Builder
	for i := range 40 {
		fmt.Fprintf(&before, "line %d\n", i)
	}
	p.write("before.txt", before.String())
	p.commit("init")

	p.git("mv", "before.txt", "after.txt")
	p.write("after.txt", strings.Replace(before.String(), "line 7\n", "line seven\n", 1))

	resp := p.diff("after.txt")
	if resp.Status != "renamed" {
		t.Errorf("Status = %q, want %q", resp.Status, "renamed")
	}
	if resp.OldPath != "before.txt" {
		t.Errorf("OldPath = %q, want %q", resp.OldPath, "before.txt")
	}
	if got := lineText(resp); !strings.Contains(got, "+line seven\n") {
		t.Errorf("the edit is missing from the rename's diff:\n%s", got)
	}
	if resp.Added != 1 || resp.Removed != 1 {
		t.Errorf("+%d/-%d, want +1/-1", resp.Added, resp.Removed)
	}
}

// Git does not write a text patch for bytes that are not text, and neither does
// this: the file is reported as changed, and nothing is invented about how.
func TestGitDiffTrackedBinaryFileSaysItChangedAndNoMore(t *testing.T) {
	p := newGitProject(t)
	if err := os.WriteFile(filepath.Join(p.dir, "image.bin"), []byte{0x0, 0x1, 0x2, 0x0}, 0o600); err != nil {
		t.Fatal(err)
	}
	p.commit("init")
	if err := os.WriteFile(filepath.Join(p.dir, "image.bin"), []byte{0x0, 0x9, 0x9, 0x0}, 0o600); err != nil {
		t.Fatal(err)
	}

	resp := p.diff("image.bin")
	if !resp.Binary {
		t.Error("Binary = false for a tracked binary file")
	}
	if resp.Status != "modified" {
		t.Errorf("Status = %q, want %q", resp.Status, "modified")
	}
	if len(resp.Hunks) != 0 {
		t.Errorf("len(Hunks) = %d, want no invented text for binary content", len(resp.Hunks))
	}
	if resp.Revision == "" {
		t.Error("Revision is empty for a changed binary file")
	}
}

// A read that ran out of time and a caller who went away are different events,
// and the one the reader is told about should be the one that happened.
func TestGitDeadlineErrorNamesTheClockThatRanOut(t *testing.T) {
	request, cancelRequest := context.WithCancel(t.Context())
	command, cancelCommand := context.WithCancel(request)
	defer cancelRequest()
	defer cancelCommand()

	cancelCommand()
	// The budget named is the one the command was actually given, so a reader is
	// not told a diff gave up after the status card's three seconds when it waited
	// far longer than that.
	if got := gitDeadlineError(request, command, gitDiffPerCmd); !strings.Contains(got.Error(), "git took longer than "+gitDiffPerCmd.String()) {
		t.Errorf("one command's clock ran out and the error said %q", got)
	}

	cancelRequest()
	if got := gitDeadlineError(request, command, gitDiffPerCmd); !errors.Is(got, context.Canceled) {
		t.Errorf("the request was cancelled and the error said %q", got)
	}
}

// The card is polled and can give up quickly; a diff is asked for once, by
// somebody waiting for it, and reads a file git may have to hash several times.
// Serving it on the poll's clock is what refuses a large diff that was perfectly
// readable, and the whole-request budget has to hold more than one such command.
func TestGitDiffIsNotHeldToTheStatusCardsClock(t *testing.T) {
	if gitDiffPerCmd <= gitStatusPerCmd {
		t.Errorf("gitDiffPerCmd = %s, want longer than the card's %s", gitDiffPerCmd, gitStatusPerCmd)
	}
	if gitDiffBudget < 2*gitDiffPerCmd {
		t.Errorf("gitDiffBudget = %s, want room for more than one %s command", gitDiffBudget, gitDiffPerCmd)
	}
}

// A file can change without a line of it changing. Left to the patch text alone
// that is an empty diff, which reads as "nothing happened" — so the modes are
// part of the answer.
func TestGitDiffReportsAModeChange(t *testing.T) {
	p := newGitProject(t)
	p.write("script.sh", "#!/bin/sh\necho hello\n")
	p.commit("init")

	abs := filepath.Join(p.dir, "script.sh")
	if err := os.Chmod(abs, 0o750); err != nil {
		t.Skipf("file modes are not settable here: %v", err)
	}
	// Chmod returns success on a filesystem that has no executable bit to set,
	// and git sets core.filemode=false wherever it finds one, so what the call
	// returned says nothing about whether there is now a mode change to report.
	// Only git can answer that, and where its answer is no there is no
	// behaviour here to test.
	if !strings.Contains(p.git("diff", "--summary"), "mode change") {
		t.Skip("git does not track the executable bit on this filesystem")
	}

	resp := p.diff("script.sh")
	if resp.OldMode == resp.NewMode {
		t.Fatalf("OldMode = NewMode = %q; the executable bit was set and the response does not say so", resp.NewMode)
	}
	if resp.OldMode != "100644" || resp.NewMode != "100755" {
		t.Errorf("mode %q -> %q, want 100644 -> 100755", resp.OldMode, resp.NewMode)
	}
	if resp.Status != "modified" {
		t.Errorf("Status = %q, want %q", resp.Status, "modified")
	}
}

// A file replaced by a symlink of the same name is one path with two types, and
// git says so with a deletion and a creation in the same patch. Reading the last
// header and stopping would call the whole thing an addition.
func TestGitDiffReportsATypeChange(t *testing.T) {
	p := newGitProject(t)
	p.write("target.txt", "elsewhere\n")
	p.write("swapped.txt", "was a file\n")
	p.commit("init")

	abs := filepath.Join(p.dir, "swapped.txt")
	if err := os.Remove(abs); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target.txt", abs); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}

	resp := p.diff("swapped.txt")
	if resp.Status != "typechange" {
		t.Errorf("Status = %q, want %q", resp.Status, "typechange")
	}
	if resp.OldMode != "100644" || resp.NewMode != "120000" {
		t.Errorf("mode %q -> %q, want 100644 -> 120000", resp.OldMode, resp.NewMode)
	}
}

// A conflicted file's working tree holds both sides and the markers between
// them. Shown as an ordinary two-way diff it looks like the user wrote those
// markers, so the state is reported rather than implied.
func TestGitDiffReportsAConflictAsItsOwnState(t *testing.T) {
	p := newGitProject(t)
	p.write("shared.txt", "first\nsecond\n")
	p.commit("init")

	p.git("checkout", "-q", "-b", "other")
	p.write("shared.txt", "first\nfrom other\n")
	p.commit("other")
	p.git("checkout", "-q", "-")
	p.write("shared.txt", "first\nfrom main\n")
	p.commit("main")

	merge := exec.Command("git", "merge", "other")
	merge.Dir = p.dir
	if out, err := merge.CombinedOutput(); err == nil {
		t.Fatalf("the merge succeeded; the test needs a conflict\n%s", out)
	}

	resp := p.diff("shared.txt")
	if !resp.Conflicted {
		t.Error("Conflicted = false for a file in a conflicted merge")
	}
	if resp.Status != "conflicted" {
		t.Errorf("Status = %q, want %q", resp.Status, "conflicted")
	}
	if got := lineText(resp); !strings.Contains(got, "<<<<<<<") {
		t.Errorf("the conflicted working tree is not in the diff:\n%s", got)
	}
}

// A repository with no commits has no HEAD to compare against, and the honest
// baseline is the empty tree: everything in it is new. Answering "unchanged"
// because the comparison failed would be the one thing a diff must never say
// wrongly.
func TestGitDiffUnbornRepositoryComparesAgainstTheEmptyTree(t *testing.T) {
	p := newGitProject(t)
	p.write("staged.txt", "one\ntwo\n")
	p.git("add", "staged.txt")
	p.write("loose.txt", "three\n")

	t.Run("staged", func(t *testing.T) {
		resp := p.diff("staged.txt")
		if resp.Status != "added" {
			t.Errorf("Status = %q, want %q", resp.Status, "added")
		}
		if got := lineText(resp); got != "+one\n+two\n" {
			t.Errorf("lines = %q, want the whole file added", got)
		}
	})
	t.Run("untracked", func(t *testing.T) {
		resp := p.diff("loose.txt")
		if resp.Status != "untracked" {
			t.Errorf("Status = %q, want %q", resp.Status, "untracked")
		}
	})
}

// git looks upward for a repository when the directory it is handed is not one,
// so the repository a path belongs to has to be established rather than assumed:
// a file in a nested repository is answered from that repository, not from the
// one that contains it.
func TestGitDiffAnswersFromTheNestedRepository(t *testing.T) {
	p := newGitProject(t)
	p.write("shared.txt", "root version\n")
	p.commit("init")

	nested := p.nested("libs/lib")
	nested.write("shared.txt", "nested version\n")
	nested.commit("init")

	p.write("shared.txt", "root edited\n")
	nested.write("shared.txt", "nested edited\n")

	root := p.diff("shared.txt")
	if got := lineText(root); !strings.Contains(got, "+root edited\n") {
		t.Errorf("the root repo answered with:\n%s", got)
	}
	sub := nested.diff("shared.txt")
	if got := lineText(sub); !strings.Contains(got, "+nested edited\n") {
		t.Errorf("the nested repo answered with:\n%s", got)
	}
}

// Where this endpoint may be pointed is the whole of its security. The unit
// tests cover the shapes of a path; these cover what Diff does with one.
func TestGitDiffRefusesToLeaveTheProject(t *testing.T) {
	p := newGitProject(t)
	p.write("inside.txt", "x\n")
	p.commit("init")
	if err := os.WriteFile(filepath.Join(filepath.Dir(p.root), "secret.txt"), []byte("THE-CONTENTS\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(p.root, "plain"), 0o750); err != nil {
		t.Fatal(err)
	}

	t.Run("path climbing out", func(t *testing.T) {
		if _, err := p.ask(t.Context(), "../secret.txt"); !refused(err) {
			t.Errorf("err = %v, want the request refused", err)
		}
	})
	t.Run("repo that is not a repo", func(t *testing.T) {
		plain := &gitProject{t: t, root: p.root, dir: filepath.Join(p.root, "plain"), rel: "plain"}
		if _, err := plain.ask(t.Context(), "inside.txt"); !refused(err) {
			t.Errorf("err = %v, want the request refused — an ordinary directory is not a repository", err)
		}
	})
	// A directory in the path is a different matter from the file at the end of
	// it: follow a symlinked directory and the file opened is an ordinary file
	// somewhere else entirely, with nothing about it to say so.
	t.Run("symlinked directory in the path", func(t *testing.T) {
		outside := t.TempDir()
		if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("THE-CONTENTS\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(p.dir, "linkdir")); err != nil {
			t.Skipf("symlinks unavailable here: %v", err)
		}
		resp, err := p.ask(t.Context(), "linkdir/secret.txt")
		if !refused(err) {
			t.Errorf("err = %v, want the request refused", err)
		}
		if strings.Contains(lineText(resp), "THE-CONTENTS") {
			t.Errorf("the endpoint read through a linked directory:\n%s", lineText(resp))
		}
	})
	// The link is shown as what it is — a path — and never as what it points at.
	// Naming a file outside the project is the whole of what a link can do here;
	// opening one would be reading that file into a review of this project.
	t.Run("untracked symlink out of the project", func(t *testing.T) {
		if err := os.Symlink(filepath.Join(filepath.Dir(p.root), "secret.txt"), filepath.Join(p.dir, "escape.txt")); err != nil {
			t.Skipf("symlinks unavailable here: %v", err)
		}
		resp, _ := p.ask(t.Context(), "escape.txt")
		if strings.Contains(lineText(resp), "THE-CONTENTS") {
			t.Errorf("the endpoint read through a link out of the project:\n%s", lineText(resp))
		}
		if got := lineText(resp); !strings.Contains(got, "secret.txt") {
			t.Errorf("lines = %q, want the link's own text", got)
		}
	})
}

// Both are ways a repository's own configuration asks git to run a command of
// the repository's choosing while producing a diff. Reading a project is not
// consent to execute it, so neither is ever run — and with each configured to a
// command that does not exist, a diff that came out normally is the proof.
func TestGitDiffRunsNoExternalDiffOrTextconv(t *testing.T) {
	p := newGitProject(t)
	p.write("f.txt", "one\ntwo\n")
	p.write(".gitattributes", "*.txt diff=marked\n")
	p.commit("init")
	p.git("config", "diff.external", "juggler-external-diff-that-does-not-exist")
	p.git("config", "diff.marked.textconv", "juggler-textconv-that-does-not-exist")

	p.write("f.txt", "one\nTWO\n")

	resp := p.diff("f.txt")
	if resp.Status != "modified" {
		t.Fatalf("Status = %q, want %q — git was made to run something and could not", resp.Status, "modified")
	}
	if got := lineText(resp); !strings.Contains(got, "+TWO\n") {
		t.Errorf("lines = %q, want the ordinary text diff", got)
	}
}

// The fingerprint is what a draft comment is anchored to, so it has to answer
// "is this the same file I commented on" — a question HEAD cannot answer, since
// almost every edit under review happens without HEAD moving at all.
func TestGitDiffRevisionFollowsContentNotHead(t *testing.T) {
	p := newGitProject(t)
	p.write("f.txt", "one\ntwo\n")
	p.commit("init")
	head := strings.TrimSpace(p.git("rev-parse", "HEAD"))

	p.write("f.txt", "one\nEDITED\n")
	first := p.diff("f.txt")
	if first.Revision == "" {
		t.Fatal("Revision is empty")
	}

	again := p.diff("f.txt")
	if again.Revision != first.Revision {
		t.Errorf("Revision changed for identical content: %q then %q", first.Revision, again.Revision)
	}

	p.write("f.txt", "one\nEDITED AGAIN\n")
	third := p.diff("f.txt")
	if third.Revision == first.Revision {
		t.Errorf("Revision = %q after the file changed, want a different fingerprint", third.Revision)
	}
	if now := strings.TrimSpace(p.git("rev-parse", "HEAD")); now != head {
		t.Fatalf("HEAD moved during the test (%s -> %s); the test proves nothing", head, now)
	}

	// An untracked file is read by the endpoint rather than by git, and carries a
	// fingerprint over what it read for the same reason.
	p.write("new.txt", "fresh\n")
	untracked := p.diff("new.txt")
	if untracked.Revision == "" || untracked.Revision == first.Revision {
		t.Errorf("untracked Revision = %q, want its own fingerprint", untracked.Revision)
	}
}

// A patch past the byte ceiling stops being returned, but the file's change is
// still the size it is: the counts come from git's own tally rather than from
// the lines that survived, or a truncated diff would understate what it truncated.
func TestGitDiffTruncatesTheTextButNotTheTruth(t *testing.T) {
	// The ceiling is crossed for real, just not at eight megabytes: what is under
	// test is the behaviour either side of it, and that does not know how high it
	// is. Crossing the shipped one means a quarter of a million lines through git
	// and the parser, which on a loaded runner outruns the diff's own 10s
	// per-command clock and fails the test on the clock instead. Every test in
	// this package runs sequentially, so lowering it for one is safe.
	restore := gitDiffMaxBytes
	gitDiffMaxBytes = 64 << 10
	t.Cleanup(func() { gitDiffMaxBytes = restore })

	p := newGitProject(t)
	p.write("big.txt", "")
	p.commit("init")

	var b strings.Builder
	lines := (gitDiffMaxBytes / 32) + 2000
	for i := range lines {
		fmt.Fprintf(&b, "line %d %s\n", i, strings.Repeat("x", 20))
	}
	p.write("big.txt", b.String())

	resp := p.diff("big.txt")
	if !resp.Truncated {
		t.Fatal("Truncated = false for a patch past the ceiling")
	}
	if resp.Added != lines {
		t.Errorf("Added = %d, want every added line %d", resp.Added, lines)
	}
	shown := 0
	for _, hunk := range resp.Hunks {
		shown += len(hunk.Lines)
	}
	if shown > gitDiffMaxLines {
		t.Errorf("returned %d lines, want no more than the ceiling %d", shown, gitDiffMaxLines)
	}
	for _, hunk := range resp.Hunks {
		for _, line := range hunk.Lines {
			if strings.HasPrefix(line.Text, "line ") && !strings.HasSuffix(line.Text, strings.Repeat("x", 20)) {
				t.Fatalf("a line was cut in half: %q", line.Text)
			}
		}
	}
}

// One line longer than everything the endpoint will return leaves nothing that
// can be shown whole. Half of it is a worse answer than none of it, and either
// way the response says it is not the complete patch.
func TestGitDiffGiantSingleLineIsNotReturnedInHalves(t *testing.T) {
	// Lowered for the same reason as in TestGitDiffTruncatesTheTextButNotTheTruth,
	// and doubly so here: a single line past the shipped ceiling is eight megabytes
	// with no newline in it for git or the parser to work with. What is under test
	// is a line longer than the ceiling, whatever the ceiling is. Every test in
	// this package runs sequentially, so lowering it for one is safe.
	restore := gitDiffMaxBytes
	gitDiffMaxBytes = 64 << 10
	t.Cleanup(func() { gitDiffMaxBytes = restore })

	p := newGitProject(t)
	p.write("giant.txt", "small\n")
	p.commit("init")
	p.write("giant.txt", strings.Repeat("y", gitDiffMaxBytes+4096)+"\n")

	resp := p.diff("giant.txt")
	if !resp.Truncated {
		t.Error("Truncated = false for a line past the byte ceiling")
	}
	for _, hunk := range resp.Hunks {
		for _, line := range hunk.Lines {
			if strings.HasPrefix(line.Text, "y") && len(line.Text) != gitDiffMaxBytes+4096 {
				t.Fatalf("returned %d bytes of a %d-byte line", len(line.Text), gitDiffMaxBytes+4096)
			}
		}
	}
}

// Every failed git command produces no output, and so does a file that did not
// change. Reading the first as the second turns a diff that could not be taken
// into the claim that there was nothing to take.
func TestGitDiffReportsCancellationRatherThanAnEmptyDiff(t *testing.T) {
	p := newGitProject(t)
	p.write("f.txt", "one\n")
	p.commit("init")
	p.write("f.txt", "two\n")

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	resp, err := p.ask(ctx, "f.txt")
	if err == nil {
		t.Fatalf("answered with Status %q; a cancelled read is not an answer", resp.Status)
	}
	if refused(err) {
		t.Errorf("err = %v, want a diff that could not be read, not a refused request", err)
	}
}

// How much of the file around a change comes back is the reader's to choose, so
// it is a parameter of the request rather than a constant of the endpoint. The
// answer says which width it was produced at, because a client that narrows a
// patch it already holds has to know whether it holds enough to do it.
func TestGitDiffReturnsTheContextWidthAskedFor(t *testing.T) {
	p := newGitProject(t)
	var before []string
	for i := 1; i <= 40; i++ {
		before = append(before, fmt.Sprintf("line %d", i))
	}
	p.write("f.txt", strings.Join(before, "\n")+"\n")
	p.commit("init")
	after := append([]string(nil), before...)
	after[19] = "CHANGED"
	p.write("f.txt", strings.Join(after, "\n")+"\n")

	wide := p.diffAt("f.txt", "10")
	narrow := p.diffAt("f.txt", "0")
	fallback := p.diff("f.txt")

	if got := unchangedLines(narrow); got != 0 {
		t.Errorf("context=0 returned %d unchanged lines, want none:\n%s", got, lineText(narrow))
	}
	if got := unchangedLines(fallback); got != 6 {
		t.Errorf("no context asked for returned %d unchanged lines, want the default 6:\n%s", got, lineText(fallback))
	}
	if got := unchangedLines(wide); got != 20 {
		t.Errorf("context=10 returned %d unchanged lines, want 20:\n%s", got, lineText(wide))
	}
	if narrow.Context != 0 || wide.Context != 10 || fallback.Context != gitDiffContext {
		t.Errorf("the width each patch was produced at came back as %d/%d/%d, want 0/10/%d",
			narrow.Context, wide.Context, fallback.Context, gitDiffContext)
	}
	// The change itself is the one thing no width may alter.
	for _, resp := range []FileDiff{narrow, wide, fallback} {
		if resp.Added != 1 || resp.Removed != 1 {
			t.Errorf("at context %d the change itself read as +%d -%d, want +1 -1", resp.Context, resp.Added, resp.Removed)
		}
	}
}

// A width that is not a number, or is absurd, is a request we cannot honour as
// asked. Refusing the whole diff over it would lose the reader their patch for a
// query string they never typed, so the shipped default is used instead.
func TestGitDiffIgnoresAContextWidthItCannotUse(t *testing.T) {
	p := newGitProject(t)
	p.write("f.txt", "one\ntwo\nthree\nfour\nfive\n")
	p.commit("init")
	p.write("f.txt", "one\ntwo\nTHREE\nfour\nfive\n")

	for _, asked := range []string{"", "abc", "1e3", "-4", "  "} {
		resp := p.diffAt("f.txt", asked)
		if resp.Context != gitDiffContext {
			t.Errorf("context=%q was produced at %d, want the default %d", asked, resp.Context, gitDiffContext)
		}
	}
}

// "The whole file" has to mean the whole file however long it is, so it travels
// as -1 rather than as a number someone once thought was big enough.
func TestGitDiffWholeFileContextReturnsEveryLine(t *testing.T) {
	p := newGitProject(t)
	var before []string
	for i := 1; i <= 60; i++ {
		before = append(before, fmt.Sprintf("line %d", i))
	}
	p.write("f.txt", strings.Join(before, "\n")+"\n")
	p.commit("init")
	after := append([]string(nil), before...)
	after[29] = "CHANGED"
	p.write("f.txt", strings.Join(after, "\n")+"\n")

	resp := p.diffAt("f.txt", "-1")
	if got := unchangedLines(resp); got != 59 {
		t.Errorf("whole-file context returned %d unchanged lines, want all 59:\n%s", got, lineText(resp))
	}
	if len(resp.Hunks) != 1 {
		t.Errorf("whole-file context returned %d hunks, want one", len(resp.Hunks))
	}
	if resp.Context != gitDiffMaxContext {
		t.Errorf("whole-file context came back as %d, want the ceiling %d", resp.Context, gitDiffMaxContext)
	}
}
