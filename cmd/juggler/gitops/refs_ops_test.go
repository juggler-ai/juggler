//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitview"
)

// mainBranch is the name of the branch a fresh repository starts on, which
// depends on this machine's git.
func (r *repo) mainBranch() string { return r.out("symbolic-ref", "--short", "HEAD") }

// out is git's answer, trimmed.
func (r *repo) out(args ...string) string { return strings.TrimSpace(r.git(args...)) }

// sha is what rev names.
func (r *repo) sha(rev string) string { return r.out("rev-parse", rev) }

// hasRef reports whether ref exists.
func (r *repo) hasRef(ref string) bool {
	cmd := exec.Command("git", "rev-parse", "-q", "--verify", ref)
	cmd.Dir = r.dir
	return cmd.Run() == nil
}

// linked adds a worktree on a new branch, in a directory of its own outside the
// repository, and returns its path as git lists it.
func (r *repo) linked(branch string) string {
	r.t.Helper()
	path := filepath.Join(r.t.TempDir(), "tree-"+strings.ReplaceAll(branch, "/", "-"))
	r.git("worktree", "add", "-q", "-b", branch, path)
	return gitview.RealPath(path)
}

// withRemote gives the repository a bare remote, origin, holding its current
// branch, which then tracks it.
func (r *repo) withRemote() string {
	r.t.Helper()
	bare := filepath.Join(r.t.TempDir(), "origin.git")
	r.git("init", "-q", "--bare", bare)
	r.git("remote", "add", "origin", bare)
	r.git("push", "-q", "-u", "origin", r.mainBranch())
	return bare
}

// mustFailAs fails the test unless err is an E.
func mustFailAs[E error](t *testing.T, err error, what string) {
	t.Helper()
	_ = wantErr[E](t, err, what)
}

func wantErr[E error](t *testing.T, err error, what string) E {
	t.Helper()
	var e E
	if !errors.As(err, &e) {
		t.Fatalf("%s: got %v (%T), want a %T", what, err, err, e)
	}
	return e
}

func TestBranchCreateSwitchRenameAndUpstream(t *testing.T) {
	t.Parallel()
	r := committed(t)
	main := r.mainBranch()
	r.withRemote()

	mustOp(t, r.dir, Op{Kind: OpBranchCreate, Name: "feat"})
	if !r.hasRef("refs/heads/feat") || r.mainBranch() != main {
		t.Fatalf("branch-create made feat and stayed on %s: on %s", main, r.mainBranch())
	}
	mustOp(t, r.dir, Op{Kind: OpBranchCreate, Name: "feat2", Rev: "HEAD", Switch: true})
	if r.mainBranch() != "feat2" {
		t.Fatalf("branch-create with switch left HEAD on %s", r.mainBranch())
	}
	mustOp(t, r.dir, Op{Kind: OpSwitch, Branch: main})
	if r.mainBranch() != main {
		t.Fatalf("switch left HEAD on %s", r.mainBranch())
	}

	mustOp(t, r.dir, Op{Kind: OpBranchRename, Branch: "feat", Name: "feature"})
	if r.hasRef("refs/heads/feat") || !r.hasRef("refs/heads/feature") {
		t.Fatal("rename did not move feat to feature")
	}

	mustOp(t, r.dir, Op{Kind: OpBranchUpstream, Branch: "feature", Upstream: "origin/" + main})
	if got := r.out("rev-parse", "--abbrev-ref", "feature@{upstream}"); got != "origin/"+main {
		t.Fatalf("upstream = %q", got)
	}
	mustOp(t, r.dir, Op{Kind: OpBranchUpstream, Branch: "feature"})
	if r.hasRef("feature@{upstream}") {
		t.Fatal("an empty upstream did not unset it")
	}

	_, err := op(t, r.dir, Op{Kind: OpBranchCreate, Name: "a..b"})
	mustFailAs[*RefusedError](t, err, "a name git would not take")

	// A remote branch is switched to as a new local branch that tracks it, and
	// any commit can be looked at detached.
	r.git("push", "-q", "origin", "HEAD:refs/heads/remote-only")
	r.git("fetch", "-q", "origin")
	mustOp(t, r.dir, Op{Kind: OpSwitch, Branch: "remote-only", Rev: "origin/remote-only", Track: true})
	if r.mainBranch() != "remote-only" || r.out("rev-parse", "--abbrev-ref", "@{upstream}") != "origin/remote-only" {
		t.Fatal("switching to a remote branch did not make a tracking branch of it")
	}
	mustOp(t, r.dir, Op{Kind: OpSwitch, Rev: "HEAD~0", Detach: true})
	if _, err := exec.Command("git", "-C", r.dir, "symbolic-ref", "-q", "HEAD").Output(); err == nil {
		t.Fatal("switch with detach left HEAD on a branch")
	}
}

// Local changes in the way of a switch are never lost: carrying them is git's
// plain switch, which refuses rather than overwrite; setting them aside is a
// stash, kept for the user and named in the result; and a switch that then
// fails puts them back.
func TestSwitchWithADirtyTree(t *testing.T) {
	t.Parallel()
	r := committed(t)
	main := r.mainBranch()
	r.git("switch", "-q", "-c", "other")
	r.write("a.txt", "other\n")
	r.commit("other")
	r.git("switch", "-q", main)

	r.write("a.txt", "mine\n")
	_, err := op(t, r.dir, Op{Kind: OpSwitch, Branch: "other", Dirty: DirtyCarry})
	mustFailAs[*DirtyError](t, err, "carrying changes the switch would overwrite")
	if r.mainBranch() != main || r.read("a.txt") != "mine\n" {
		t.Fatal("a refused switch moved HEAD or touched the change")
	}

	_, err = op(t, r.dir, Op{Kind: OpSwitch, Branch: "nosuch", Dirty: DirtyStash})
	if err == nil {
		t.Fatal("switched to a branch that does not exist")
	}
	if r.read("a.txt") != "mine\n" || r.out("stash", "list") != "" {
		t.Fatalf("a switch that failed after stashing did not put the change back: a.txt %q, stashes %q", r.read("a.txt"), r.out("stash", "list"))
	}

	res := mustOp(t, r.dir, Op{Kind: OpSwitch, Branch: "other", Dirty: DirtyStash})
	if r.mainBranch() != "other" || r.read("a.txt") != "other\n" {
		t.Fatalf("switch with stash: on %s, a.txt %q", r.mainBranch(), r.read("a.txt"))
	}
	if res.Stash == "" || res.Stash != r.sha("stash@{0}") || !strings.Contains(r.out("stash", "list"), "other") {
		t.Fatalf("the stash is not named in the result: %+v, list %q", res, r.out("stash", "list"))
	}

	// An untracked file in nobody's way is simply carried.
	r.write("loose.txt", "loose\n")
	mustOp(t, r.dir, Op{Kind: OpSwitch, Branch: main})
	if r.read("loose.txt") != "loose\n" {
		t.Fatal("an untracked file was not carried")
	}
}

// A branch another worktree has out cannot be switched to, deleted or
// fast-forwarded here, and the refusal names the tree — wherever it is — so
// the client can offer to go there instead. Renaming it renames it there too.
func TestBranchCheckedOutInAnotherWorktree(t *testing.T) {
	t.Parallel()
	r := committed(t)
	tree := r.linked("side")

	_, err := op(t, r.dir, Op{Kind: OpSwitch, Branch: "side"})
	if out := wantErr[*CheckedOutError](t, err, "switching to it"); out.Branch != "side" || out.Worktree != tree {
		t.Errorf("refusal = %+v, want side in %s", out, tree)
	}
	_, err = op(t, r.dir, Op{Kind: OpBranchDelete, Branch: "side", ExpectSha: r.sha("side")})
	if out := wantErr[*CheckedOutError](t, err, "deleting it"); out.Worktree != tree {
		t.Errorf("refusal = %+v, want %s", out, tree)
	}
	_, err = op(t, r.dir, Op{Kind: OpFastForward, Branch: "side", Rev: "HEAD", ExpectSha: r.sha("side")})
	mustFailAs[*CheckedOutError](t, err, "fast-forwarding it")
	_, err = op(t, r.dir, Op{Kind: OpBranchDelete, Branch: r.mainBranch(), ExpectSha: r.sha("HEAD")})
	if out := wantErr[*CheckedOutError](t, err, "deleting the branch out here"); out.Worktree != gitview.RealPath(r.dir) {
		t.Errorf("refusal = %+v, want this tree", out)
	}

	mustOp(t, r.dir, Op{Kind: OpBranchRename, Branch: "side", Name: "side2"})
	cmd := exec.Command("git", "symbolic-ref", "--short", "HEAD")
	cmd.Dir = tree
	if got, _ := cmd.Output(); strings.TrimSpace(string(got)) != "side2" {
		t.Errorf("the other tree's HEAD after the rename = %q", got)
	}
}

// Deleting is safe by default and undoable: an unmerged branch is refused
// until forced, a branch that moved since the client looked is stale, and the
// result names the tip that ref-restore puts back.
func TestDeleteAndRestoreABranch(t *testing.T) {
	t.Parallel()
	r := committed(t)
	main := r.mainBranch()
	r.git("branch", "done")
	r.git("switch", "-q", "-c", "wip")
	r.write("w.txt", "w\n")
	r.commit("wip")
	r.git("switch", "-q", main)

	_, err := op(t, r.dir, Op{Kind: OpBranchDelete, Branch: "done", ExpectSha: r.sha("wip")})
	mustFailAs[*StaleError](t, err, "deleting a branch that is not where the client saw it")

	tip := r.sha("done")
	res := mustOp(t, r.dir, Op{Kind: OpBranchDelete, Branch: "done", ExpectSha: tip})
	if r.hasRef("refs/heads/done") || res.Sha != tip {
		t.Fatalf("delete: %+v", res)
	}
	mustOp(t, r.dir, Op{Kind: OpRefRestore, Ref: "refs/heads/done", Sha: tip})
	if r.sha("done") != tip {
		t.Fatal("ref-restore did not put the branch back")
	}
	if _, err := op(t, r.dir, Op{Kind: OpRefRestore, Ref: "refs/heads/done", Sha: r.sha("wip")}); err == nil {
		t.Fatal("ref-restore overwrote a ref that exists")
	}
	if _, err := op(t, r.dir, Op{Kind: OpRefRestore, Ref: "HEAD", Sha: tip}); err == nil {
		t.Fatal("ref-restore wrote something other than a branch or a tag")
	}

	_, err = op(t, r.dir, Op{Kind: OpBranchDelete, Branch: "wip", ExpectSha: r.sha("wip")})
	mustFailAs[*UnmergedError](t, err, "deleting an unmerged branch")
	if !r.hasRef("refs/heads/wip") {
		t.Fatal("an unmerged branch was deleted without being forced")
	}
	mustOp(t, r.dir, Op{Kind: OpBranchDelete, Branch: "wip", ExpectSha: r.sha("wip"), Force: true})
	if r.hasRef("refs/heads/wip") {
		t.Fatal("a forced delete left the branch")
	}
}

func TestMergeAndRebaseIntoCurrent(t *testing.T) {
	t.Parallel()
	r := committed(t)
	main := r.mainBranch()
	r.git("switch", "-q", "-c", "topic")
	r.write("t.txt", "t\n")
	r.commit("topic")
	r.git("switch", "-q", main)
	r.write("m.txt", "m\n")
	r.commit("main moves on")

	res := mustOp(t, r.dir, Op{Kind: OpMerge, Rev: "topic"})
	if !r.exists("t.txt") || res.Head != r.sha("HEAD") || r.out("rev-list", "--count", "--merges", "HEAD") != "1" {
		t.Fatalf("merge: %+v", res)
	}

	r.git("switch", "-q", "-c", "later", "topic")
	r.write("l.txt", "l\n")
	r.commit("later")
	mustOp(t, r.dir, Op{Kind: OpRebase, Rev: main})
	if r.out("merge-base", "HEAD", main) != r.sha(main) || !r.exists("m.txt") {
		t.Fatal("rebase did not put later on top of main")
	}

	// A merge the working tree is in the way of is a DirtyError until the
	// changes are set aside; set aside, they are put back afterwards.
	r.git("switch", "-q", main)
	r.git("switch", "-q", "-c", "edits-a", "HEAD~1")
	r.write("a.txt", "theirs\n")
	r.commit("edits a")
	r.git("switch", "-q", main)
	r.write("a.txt", "a\nb\nc\nd\nmine\n")
	_, err := op(t, r.dir, Op{Kind: OpMerge, Rev: "edits-a"})
	mustFailAs[*DirtyError](t, err, "merging over a change to the same file")
	r.git("checkout", "--", "a.txt")
	r.write("other.txt", "set aside\n")
	r.git("add", "other.txt")
	mustOp(t, r.dir, Op{Kind: OpMerge, Rev: "edits-a", Dirty: DirtyStash})
	if r.read("a.txt") != "theirs\n" || r.read("other.txt") != "set aside\n" || r.out("stash", "list") != "" {
		t.Fatalf("merge with stash: a.txt %q other.txt present %v stashes %q", r.read("a.txt"), r.exists("other.txt"), r.out("stash", "list"))
	}

	// One that stops on conflicts says so and leaves the merge for the user.
	r.git("switch", "-q", "-c", "clash", "HEAD~1")
	r.write("a.txt", "clash\n")
	r.commit("clash")
	r.git("switch", "-q", main)
	_, err = op(t, r.dir, Op{Kind: OpMerge, Rev: "clash"})
	mustFailAs[*ConflictsError](t, err, "a merge that conflicts")
	if !r.exists(".git/MERGE_HEAD") {
		t.Fatal("the conflicted merge was not left in progress")
	}
}

func TestFastForwardWithoutCheckout(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.git("branch", "behind")
	r.git("branch", "apart")
	r.write("n.txt", "n\n")
	r.commit("next")

	_, err := op(t, r.dir, Op{Kind: OpFastForward, Branch: "behind", Rev: "HEAD", ExpectSha: r.sha("HEAD")})
	mustFailAs[*StaleError](t, err, "a branch that is not where the client saw it")
	mustOp(t, r.dir, Op{Kind: OpFastForward, Branch: "behind", Rev: "HEAD", ExpectSha: r.sha("behind")})
	if r.sha("behind") != r.sha("HEAD") {
		t.Fatal("fast-forward did not move the branch")
	}
	if r.mainBranch() == "behind" {
		t.Fatal("fast-forward checked the branch out")
	}

	r.git("switch", "-q", "apart")
	r.write("x.txt", "x\n")
	r.commit("apart")
	r.git("switch", "-q", "-")
	_, err = op(t, r.dir, Op{Kind: OpFastForward, Branch: "apart", Rev: "HEAD", ExpectSha: r.sha("apart")})
	mustFailAs[*DivergedError](t, err, "a branch that has commits of its own")
}

func TestStashes(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "one\n")
	first := mustOp(t, r.dir, Op{Kind: OpStashSave, Message: "first"})
	r.write("a.txt", "two\n")
	r.write("u.txt", "untracked\n")
	second := mustOp(t, r.dir, Op{Kind: OpStashSave, Message: "second", Untracked: true})
	if first.Stash == "" || second.Stash != r.sha("stash@{0}") || r.exists("u.txt") {
		t.Fatalf("stash-save: %+v %+v, u.txt still there %v", first, second, r.exists("u.txt"))
	}

	// Named by what it is, not where it is: the first stash is now stash@{1}.
	mustOp(t, r.dir, Op{Kind: OpStashApply, Stash: first.Stash})
	if r.read("a.txt") != "one\n" || r.out("stash", "list", "--format=%H") != second.Stash+"\n"+first.Stash {
		t.Fatalf("apply: a.txt %q, list %q", r.read("a.txt"), r.out("stash", "list", "--format=%H"))
	}
	r.git("checkout", "--", "a.txt")

	dropped := mustOp(t, r.dir, Op{Kind: OpStashDrop, Stash: first.Stash})
	if strings.Contains(r.out("stash", "list", "--format=%H"), first.Stash) || dropped.Stash != first.Stash || !strings.Contains(dropped.Message, "first") {
		t.Fatalf("drop: %+v", dropped)
	}
	_, err := op(t, r.dir, Op{Kind: OpStashApply, Stash: first.Stash})
	mustFailAs[*StaleError](t, err, "applying a stash that is gone")
	mustOp(t, r.dir, Op{Kind: OpStashStore, Stash: dropped.Stash, Message: dropped.Message})
	if !strings.Contains(r.out("stash", "list", "--format=%H %gs"), first.Stash+" "+dropped.Message) {
		t.Fatalf("stash-store did not put it back: %q", r.out("stash", "list"))
	}

	mustOp(t, r.dir, Op{Kind: OpStashPop, Stash: second.Stash})
	if r.read("a.txt") != "two\n" || r.read("u.txt") != "untracked\n" || strings.Contains(r.out("stash", "list", "--format=%H"), second.Stash) {
		t.Fatal("pop did not apply and drop the stash")
	}

	// A pop that conflicts keeps the stash.
	r.write("a.txt", "clash\n")
	r.commit("clash")
	_, err = op(t, r.dir, Op{Kind: OpStashPop, Stash: first.Stash})
	mustFailAs[*ConflictsError](t, err, "popping onto a conflicting change")
	if !strings.Contains(r.out("stash", "list", "--format=%H"), first.Stash) {
		t.Fatal("a conflicted pop dropped the stash")
	}
	r.git("reset", "-q", "--hard")

	res := mustOp(t, r.dir, Op{Kind: OpStashBranch, Stash: first.Stash, Name: "from-stash"})
	if r.mainBranch() != "from-stash" || r.read("a.txt") != "one\n" || res.Head == "" {
		t.Fatalf("stash-branch: on %s, a.txt %q", r.mainBranch(), r.read("a.txt"))
	}
}

func TestTags(t *testing.T) {
	t.Parallel()
	r := committed(t)
	mustOp(t, r.dir, Op{Kind: OpTagCreate, Name: "v1"})
	mustOp(t, r.dir, Op{Kind: OpTagCreate, Name: "v2", Rev: "HEAD", Message: "Two"})
	if r.out("cat-file", "-t", "v1") != "commit" || r.out("cat-file", "-t", "v2") != "tag" {
		t.Fatal("tag-create made the wrong kinds of tag")
	}
	object := r.sha("refs/tags/v2")
	res := mustOp(t, r.dir, Op{Kind: OpTagDelete, Name: "v2", ExpectSha: object})
	if r.hasRef("refs/tags/v2") || res.Sha != object {
		t.Fatalf("tag-delete: %+v", res)
	}
	mustOp(t, r.dir, Op{Kind: OpRefRestore, Ref: "refs/tags/v2", Sha: res.Sha})
	if r.sha("refs/tags/v2") != object || r.out("cat-file", "-t", "v2") != "tag" {
		t.Fatal("restoring an annotated tag did not bring back the same tag object")
	}
}

// The plain worktree ops act on any tree of the repository, wherever it is,
// and refuse the trees they must not touch: the main one, the one the client
// is standing in, and anything git does not list.
func TestWorktreeOps(t *testing.T) {
	t.Parallel()
	r := committed(t)
	keep := r.linked("keep")
	dirty := r.linked("dirty")
	gone := r.linked("gone")

	mustOp(t, r.dir, Op{Kind: OpWorktreeLock, Worktree: keep, Reason: "on a stick"})
	if !strings.Contains(r.git("worktree", "list", "--porcelain"), "locked on a stick") {
		t.Fatal("worktree-lock did not lock it")
	}
	mustOp(t, r.dir, Op{Kind: OpWorktreeUnlock, Worktree: keep})
	if strings.Contains(r.git("worktree", "list", "--porcelain"), "locked") {
		t.Fatal("worktree-unlock did not unlock it")
	}
	mustOp(t, r.dir, Op{Kind: OpWorktreeRemove, Worktree: keep})
	if _, err := os.Stat(keep); err == nil {
		t.Fatal("worktree-remove left a clean tree")
	}

	if err := os.WriteFile(filepath.Join(dirty, "a.txt"), []byte("unsaved\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dirty, "new.txt"), []byte("new\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r.git("worktree", "lock", dirty)
	_, err := op(t, r.dir, Op{Kind: OpWorktreeRemove, Worktree: dirty})
	mustFailAs[*RefusedError](t, err, "removing a dirty, locked tree without forcing")
	res := mustOp(t, r.dir, Op{Kind: OpWorktreeRemove, Worktree: dirty, Force: true})
	if _, err := os.Stat(dirty); err == nil {
		t.Fatal("a forced remove left the tree")
	}
	if res.Saved == "" || r.out("cat-file", "-t", res.Saved) != "commit" {
		t.Fatalf("the removed tree's changes were not saved first: %+v", res)
	}
	if got := r.out("show", res.Saved+":new.txt"); got != "new" {
		t.Errorf("saved new.txt = %q", got)
	}

	for name, target := range map[string]string{
		"the main tree":     r.dir,
		"a directory":       r.t.TempDir(),
		"a tree it removed": keep,
	} {
		_, err := op(t, r.dir, Op{Kind: OpWorktreeRemove, Worktree: target, Force: true})
		mustFailAs[*RefusedError](t, err, "removing "+name)
	}
	other := r.linked("other")
	_, err = op(t, other, Op{Kind: OpWorktreeRemove, Worktree: other, Force: true})
	mustFailAs[*RefusedError](t, err, "removing the tree the op runs in")

	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	mustOp(t, r.dir, Op{Kind: OpWorktreePrune})
	if strings.Contains(r.git("worktree", "list", "--porcelain"), "tree-gone") {
		t.Fatal("prune left the tree whose directory is gone")
	}
}
