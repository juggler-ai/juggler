//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"os"
	"path/filepath"
	"testing"
)

// mergeCommit makes a merge of two branches off HEAD, the first adding
// first.txt and the second second.txt, on a branch named merged, and returns
// it. HEAD is left where it was.
func (r *repo) mergeCommit() string {
	r.t.Helper()
	back := r.mainBranch()
	r.git("switch", "-q", "-c", "second")
	r.write("second.txt", "second\n")
	r.commit("adds second")
	r.git("switch", "-q", "-c", "merged", back)
	r.write("first.txt", "first\n")
	r.commit("adds first")
	r.git("merge", "-q", "--no-ff", "--no-edit", "second")
	sha := r.sha("HEAD")
	r.git("switch", "-q", back)
	return sha
}

func TestHistoryOpsCherryPick(t *testing.T) {
	t.Parallel()
	r := committed(t)
	main := r.mainBranch()
	r.git("switch", "-q", "-c", "topic")
	r.write("t.txt", "t\n")
	r.commit("adds t")
	pick := r.sha("HEAD")
	r.git("switch", "-q", main)
	before := r.sha("HEAD")

	res := mustOp(t, r.dir, Op{Kind: OpCherryPick, Rev: pick})
	if !r.exists("t.txt") || res.Head != r.sha("HEAD") || r.sha("HEAD^") != before || r.out("log", "-1", "--format=%s") != "adds t" {
		t.Fatalf("pick: %+v, t.txt %v", res, r.exists("t.txt"))
	}

	// Picking it again changes nothing: refused, and nothing left in progress.
	tip := r.sha("HEAD")
	_, err := op(t, r.dir, Op{Kind: OpCherryPick, Rev: pick})
	mustFailAs[*RefusedError](t, err, "a pick that is already applied")
	if r.sha("HEAD") != tip || r.exists(".git/CHERRY_PICK_HEAD") || r.out("status", "--porcelain") != "" {
		t.Fatalf("the empty pick was left behind: HEAD moved %v, CHERRY_PICK_HEAD %v, status %q",
			r.sha("HEAD") != tip, r.exists(".git/CHERRY_PICK_HEAD"), r.out("status", "--porcelain"))
	}

	// A merge is picked as its change against its first parent.
	merge := r.mergeCommit()
	mustOp(t, r.dir, Op{Kind: OpCherryPick, Rev: merge})
	if !r.exists("second.txt") || r.exists("first.txt") {
		t.Fatalf("merge pick: second.txt %v first.txt %v", r.exists("second.txt"), r.exists("first.txt"))
	}

	// Local changes git would overwrite are a DirtyError until set aside; set
	// aside, they are put back after the pick.
	r.git("switch", "-q", "-c", "edits", main)
	r.write("a.txt", "A\nb\nc\nd\n")
	r.commit("edits the top of a")
	edit := r.sha("HEAD")
	r.git("switch", "-q", main)
	r.write("a.txt", "a\nb\nc\nD\n")
	_, err = op(t, r.dir, Op{Kind: OpCherryPick, Rev: edit})
	mustFailAs[*DirtyError](t, err, "a pick over a change to the same file")
	mustOp(t, r.dir, Op{Kind: OpCherryPick, Rev: edit, Dirty: DirtyStash})
	if r.read("a.txt") != "A\nb\nc\nD\n" || r.out("stash", "list") != "" || r.out("log", "-1", "--format=%s") != "edits the top of a" {
		t.Fatalf("pick with stash: a.txt %q stashes %q", r.read("a.txt"), r.out("stash", "list"))
	}
	r.git("checkout", "--", "a.txt")

	// One that conflicts says so and leaves the pick for the user.
	r.git("switch", "-q", "-c", "clash", main)
	r.write("a.txt", "clash\n")
	r.commit("clash")
	clash := r.sha("HEAD")
	r.git("switch", "-q", main)
	r.write("a.txt", "mine\n")
	r.commit("mine")
	_, err = op(t, r.dir, Op{Kind: OpCherryPick, Rev: clash})
	mustFailAs[*ConflictsError](t, err, "a pick that conflicts")
	if !r.exists(".git/CHERRY_PICK_HEAD") {
		t.Fatal("the conflicted pick was not left in progress")
	}
}

func TestHistoryOpsRevert(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("a.txt", "a\nB\nc\nd\n")
	r.commit("capital b")
	capital := r.sha("HEAD")

	res := mustOp(t, r.dir, Op{Kind: OpRevert, Rev: capital})
	if r.read("a.txt") != "a\nb\nc\nd\n" || res.Head != r.sha("HEAD") || r.sha("HEAD^") != capital {
		t.Fatalf("revert: %+v, a.txt %q", res, r.read("a.txt"))
	}

	// Reverting it again changes nothing: refused, and nothing left in progress.
	tip := r.sha("HEAD")
	_, err := op(t, r.dir, Op{Kind: OpRevert, Rev: capital})
	mustFailAs[*RefusedError](t, err, "a revert that is already applied")
	if r.sha("HEAD") != tip || r.exists(".git/REVERT_HEAD") || r.out("status", "--porcelain") != "" {
		t.Fatalf("the empty revert was left behind: HEAD moved %v, status %q", r.sha("HEAD") != tip, r.out("status", "--porcelain"))
	}

	// A merge is reverted against its first parent.
	merge := r.mergeCommit()
	r.git("merge", "-q", "--ff-only", "merged")
	mustOp(t, r.dir, Op{Kind: OpRevert, Rev: merge})
	if r.exists("second.txt") || !r.exists("first.txt") {
		t.Fatalf("merge revert: second.txt %v first.txt %v", r.exists("second.txt"), r.exists("first.txt"))
	}

	// Local changes in the way are a DirtyError.
	r.write("a.txt", "a\nb\nc\nd\nmine\n")
	r.commit("adds mine")
	mine := r.sha("HEAD")
	r.write("a.txt", "a\nb\nc\nd\nmine\nmore\n")
	_, err = op(t, r.dir, Op{Kind: OpRevert, Rev: mine})
	mustFailAs[*DirtyError](t, err, "a revert over a change to the same file")
	r.git("checkout", "--", "a.txt")

	// One that conflicts says so and leaves the revert for the user.
	r.write("a.txt", "a\nb\nc\nd\nmine, changed\n")
	r.commit("changes mine")
	_, err = op(t, r.dir, Op{Kind: OpRevert, Rev: mine})
	mustFailAs[*ConflictsError](t, err, "a revert that conflicts")
	if !r.exists(".git/REVERT_HEAD") {
		t.Fatal("the conflicted revert was not left in progress")
	}
}

func TestHistoryOpsReset(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("b.txt", "b\n")
	r.commit("adds b")
	r.write("c.txt", "c\n")
	r.commit("adds c")
	tip := r.sha("HEAD")
	target := r.sha("HEAD~2")

	res := mustOp(t, r.dir, Op{Kind: OpReset, Rev: target, Mode: ResetSoft, ExpectHead: tip})
	if r.sha("HEAD") != target || res.Head != target || res.Sha != tip || r.staged() != "A\tb.txt\nA\tc.txt" {
		t.Fatalf("soft: %+v, staged %q", res, r.staged())
	}
	mustOp(t, r.dir, Op{Kind: OpReset, Rev: tip, Mode: ResetSoft, ExpectHead: target})
	if r.sha("HEAD") != tip || r.out("status", "--porcelain") != "" {
		t.Fatalf("soft back: status %q", r.out("status", "--porcelain"))
	}

	res = mustOp(t, r.dir, Op{Kind: OpReset, Rev: target, Mode: ResetMixed, ExpectHead: tip})
	if r.sha("HEAD") != target || res.Sha != tip || r.staged() != "" || !r.exists("b.txt") || !r.exists("c.txt") {
		t.Fatalf("mixed: %+v, staged %q", res, r.staged())
	}
	mustOp(t, r.dir, Op{Kind: OpReset, Rev: tip, Mode: ResetMixed, ExpectHead: target})
	if r.sha("HEAD") != tip || r.out("status", "--porcelain") != "" {
		t.Fatalf("mixed back: status %q", r.out("status", "--porcelain"))
	}

	res = mustOp(t, r.dir, Op{Kind: OpReset, Rev: target, Mode: ResetHard, ExpectHead: tip})
	if r.sha("HEAD") != target || res.Sha != tip || r.exists("b.txt") || res.Saved != "" {
		t.Fatalf("hard on a clean tree: %+v, b.txt %v", res, r.exists("b.txt"))
	}

	// HEAD must be where the client saw it.
	_, err := op(t, r.dir, Op{Kind: OpReset, Rev: tip, Mode: ResetSoft, ExpectHead: tip})
	mustFailAs[*StaleError](t, err, "a reset from a HEAD that moved")
	_, err = op(t, r.dir, Op{Kind: OpReset, Rev: tip, Mode: "bogus", ExpectHead: target})
	mustFailAs[*RefusedError](t, err, "a reset of an unknown mode")
	_, err = op(t, r.dir, Op{Kind: OpReset, Rev: tip, ExpectHead: target})
	mustFailAs[*RefusedError](t, err, "a reset with no mode")
	r.git("switch", "-q", "--detach")
	_, err = op(t, r.dir, Op{Kind: OpReset, Rev: tip, Mode: ResetSoft, ExpectHead: target})
	mustFailAs[*RefusedError](t, err, "a reset of a detached HEAD")
	if r.sha("HEAD") != target {
		t.Fatal("a refused reset moved HEAD")
	}
}

// A keep reset moves the branch and the files it changes, and leaves local
// changes to other files as they are: what undoing a drop needs. One whose
// files have local changes is refused, and nothing moves.
func TestHistoryOpsResetKeep(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("b.txt", "b\n")
	r.commit("adds b")
	tip := r.sha("HEAD")
	target := r.sha("HEAD~1")
	r.write("a.txt", "a\nmine\n")

	res := mustOp(t, r.dir, Op{Kind: OpReset, Rev: target, Mode: ResetKeep, ExpectHead: tip})
	if r.sha("HEAD") != target || res.Sha != tip || r.exists("b.txt") || r.read("a.txt") != "a\nmine\n" {
		t.Fatalf("keep: %+v, b.txt %v, a.txt %q", res, r.exists("b.txt"), r.read("a.txt"))
	}
	mustOp(t, r.dir, Op{Kind: OpReset, Rev: tip, Mode: ResetKeep, ExpectHead: target})
	if r.sha("HEAD") != tip || r.read("b.txt") != "b\n" || r.read("a.txt") != "a\nmine\n" {
		t.Fatal("keep back did not bring b.txt back with a.txt's change kept")
	}

	r.write("b.txt", "b, changed\n")
	_, err := op(t, r.dir, Op{Kind: OpReset, Rev: target, Mode: ResetKeep, ExpectHead: tip})
	mustFailAs[*DirtyError](t, err, "a keep reset over a changed file it would change")
	if r.sha("HEAD") != tip || r.read("b.txt") != "b, changed\n" {
		t.Fatal("a refused keep reset touched the tree")
	}
}

func TestHistoryOpsHardResetUndo(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("b.txt", "b\n")
	r.commit("adds b")
	tip := r.sha("HEAD")
	target := r.sha("HEAD~1")

	r.write("a.txt", "a\nchanged\n")
	r.write("new.txt", "new\n")
	r.git("add", "new.txt")
	if err := os.Remove(filepath.Join(r.dir, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	r.write("untracked.txt", "u\n")

	res := mustOp(t, r.dir, Op{Kind: OpReset, Rev: target, Mode: ResetHard, ExpectHead: tip})
	if r.sha("HEAD") != target || r.read("a.txt") != "a\nb\nc\nd\n" || r.exists("new.txt") || r.read("gone.txt") != "bye\n" ||
		r.exists("b.txt") || r.read("untracked.txt") != "u\n" {
		t.Fatal("the hard reset did not leave the tree at the target with untracked files alone")
	}
	if res.Saved == "" || res.Sha != tip {
		t.Fatalf("hard reset result: %+v", res)
	}
	if r.out("merge-base", res.Saved, DiscardRef) != res.Saved {
		t.Fatalf("the save %s is not on %s", res.Saved, DiscardRef)
	}

	undo := Op{Kind: OpReset, Rev: tip, Mode: ResetHard, ExpectHead: target, Discard: res.Saved}

	// Changes made since would be lost: refused, nothing moved.
	r.write("a.txt", "since\n")
	_, err := op(t, r.dir, undo)
	mustFailAs[*DirtyError](t, err, "undoing a hard reset over changes made since")
	if r.sha("HEAD") != target || r.read("a.txt") != "since\n" {
		t.Fatal("a refused undo touched the tree")
	}
	r.git("checkout", "--", "a.txt")

	// Only a save Juggler made here is taken.
	_, err = op(t, r.dir, Op{Kind: OpReset, Rev: tip, Mode: ResetHard, ExpectHead: target, Discard: tip})
	mustFailAs[*RefusedError](t, err, "undoing with a commit that is not a save")

	mustOp(t, r.dir, undo)
	if r.sha("HEAD") != tip || !r.exists("b.txt") || r.read("a.txt") != "a\nchanged\n" || r.read("new.txt") != "new\n" ||
		r.exists("gone.txt") || r.read("untracked.txt") != "u\n" {
		t.Fatal("the undo did not put back the tip and the changes")
	}
	if r.staged() != "" {
		t.Fatalf("staged after the undo: %q", r.staged())
	}
	if r.out("ls-files", "new.txt") != "" {
		t.Fatal("the undo restored what was staged: new.txt is in the index")
	}
}
