//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitview"
)

// clash is committed(t) with a topic branch whose two commits each rewrite
// a.txt, and a main branch that rewrites it once, so that bringing either into
// the other stops on a conflict. HEAD is on main; it returns main's name.
func (r *repo) clash() string {
	r.t.Helper()
	main := r.mainBranch()
	r.git("switch", "-q", "-c", "topic")
	r.write("a.txt", "topic 1\n")
	r.commit("topic one")
	r.write("a.txt", "topic 2\n")
	r.commit("topic two")
	r.git("switch", "-q", main)
	r.write("a.txt", "main\n")
	r.commit("main moves on")
	return main
}

// take resolves a.txt with git's own version of one side.
func (r *repo) take(side string) {
	r.t.Helper()
	r.git("checkout", "--"+side, "--", "a.txt")
	r.git("add", "--", "a.txt")
}

func (r *repo) inProgress() string { return gitview.OperationIn(filepath.Join(r.dir, ".git")) }

func TestInProgressNothing(t *testing.T) {
	t.Parallel()
	r := committed(t)
	for _, kind := range []OpKind{OpContinue, OpSkip, OpAbort} {
		_, err := op(t, r.dir, Op{Kind: kind, Operation: "merge"})
		mustFailAs[*RefusedError](t, err, string(kind)+" with nothing in progress")
	}
}

func TestInProgressMerge(t *testing.T) {
	t.Parallel()

	t.Run("continue", func(t *testing.T) {
		t.Parallel()
		r := committed(t)
		r.clash()
		_, err := op(t, r.dir, Op{Kind: OpMerge, Rev: "topic"})
		mustFailAs[*ConflictsError](t, err, "the merge")

		_, err = op(t, r.dir, Op{Kind: OpContinue, Operation: "merge"})
		mustFailAs[*ConflictsError](t, err, "continuing with a.txt unresolved")
		_, err = op(t, r.dir, Op{Kind: OpContinue, Operation: "rebase"})
		mustFailAs[*StaleError](t, err, "continuing a rebase when a merge is in progress")
		_, err = op(t, r.dir, Op{Kind: OpSkip, Operation: "merge"})
		mustFailAs[*RefusedError](t, err, "skipping in a merge")
		if r.inProgress() != "merge" {
			t.Fatal("a refused continue ended the merge")
		}

		r.write("a.txt", "both\n")
		r.git("add", "a.txt")
		res := mustOp(t, r.dir, Op{Kind: OpContinue, Operation: "merge"})
		if r.inProgress() != "" || res.Head != r.sha("HEAD") || r.sha("HEAD^2") != r.sha("topic") || r.read("a.txt") != "both\n" {
			t.Fatalf("continue: %+v, in progress %q", res, r.inProgress())
		}
		if got := r.out("log", "-1", "--format=%s"); got != "Merge branch 'topic'" {
			t.Errorf("the merge commit's message is %q, not git's own", got)
		}
	})

	t.Run("abort", func(t *testing.T) {
		t.Parallel()
		r := committed(t)
		r.clash()
		before := r.sha("HEAD")
		_, err := op(t, r.dir, Op{Kind: OpMerge, Rev: "topic"})
		mustFailAs[*ConflictsError](t, err, "the merge")
		res := mustOp(t, r.dir, Op{Kind: OpAbort, Operation: "merge"})
		if r.inProgress() != "" || r.sha("HEAD") != before || res.Head != before || r.read("a.txt") != "main\n" {
			t.Fatalf("abort: %+v, in progress %q, a.txt %q", res, r.inProgress(), r.read("a.txt"))
		}
	})
}

// A rebase stops on each commit that conflicts: continuing past one can stop
// on the next, and skipping drops the commit it stopped on.
func TestInProgressRebase(t *testing.T) {
	t.Parallel()

	t.Run("continue and skip", func(t *testing.T) {
		t.Parallel()
		r := committed(t)
		main := r.clash()
		r.git("switch", "-q", "topic")
		_, err := op(t, r.dir, Op{Kind: OpRebase, Rev: main})
		mustFailAs[*ConflictsError](t, err, "the rebase")

		_, err = op(t, r.dir, Op{Kind: OpContinue, Operation: "rebase"})
		mustFailAs[*ConflictsError](t, err, "continuing with a.txt unresolved")
		if got := r.read(".git/rebase-merge/msgnum"); got != "1\n" {
			t.Fatalf("a refused continue moved the rebase on to step %q", got)
		}

		// Keeping main's version empties the first commit, so the second no
		// longer applies cleanly either.
		r.take("ours")
		_, err = op(t, r.dir, Op{Kind: OpContinue, Operation: "rebase"})
		mustFailAs[*ConflictsError](t, err, "continuing onto the second conflict")
		if r.inProgress() != "rebase" || r.read(".git/rebase-merge/msgnum") != "2\n" {
			t.Fatalf("the rebase did not stop on its second commit: %q", r.inProgress())
		}

		res := mustOp(t, r.dir, Op{Kind: OpSkip, Operation: "rebase"})
		if r.inProgress() != "" || r.out("symbolic-ref", "--short", "HEAD") != "topic" || r.sha("topic") != r.sha(main) || res.Head != r.sha("HEAD") {
			t.Fatalf("skip: %+v, in progress %q", res, r.inProgress())
		}
	})

	t.Run("abort", func(t *testing.T) {
		t.Parallel()
		r := committed(t)
		main := r.clash()
		r.git("switch", "-q", "topic")
		tip := r.sha("HEAD")
		_, err := op(t, r.dir, Op{Kind: OpRebase, Rev: main})
		mustFailAs[*ConflictsError](t, err, "the rebase")
		mustOp(t, r.dir, Op{Kind: OpAbort, Operation: "rebase"})
		if r.inProgress() != "" || r.sha("topic") != tip || r.out("symbolic-ref", "--short", "HEAD") != "topic" || r.read("a.txt") != "topic 2\n" {
			t.Fatalf("abort left %q in progress, topic at %s", r.inProgress(), r.sha("topic"))
		}
	})
}

func TestInProgressPickAndRevert(t *testing.T) {
	t.Parallel()

	t.Run("pick", func(t *testing.T) {
		t.Parallel()
		r := committed(t)
		r.clash()
		before := r.sha("HEAD")
		_, err := op(t, r.dir, Op{Kind: OpCherryPick, Rev: "topic"})
		mustFailAs[*ConflictsError](t, err, "the pick")

		// Resolved to what is already there, the pick has nothing left to commit:
		// refused, and still in progress for a skip.
		r.take("ours")
		_, err = op(t, r.dir, Op{Kind: OpContinue, Operation: "cherry-pick"})
		mustFailAs[*RefusedError](t, err, "continuing a pick resolved to nothing")
		if r.inProgress() != "cherry-pick" {
			t.Fatal("the emptied pick was not left in progress")
		}
		mustOp(t, r.dir, Op{Kind: OpSkip, Operation: "cherry-pick"})
		if r.inProgress() != "" || r.sha("HEAD") != before {
			t.Fatalf("skip left %q in progress, HEAD moved %v", r.inProgress(), r.sha("HEAD") != before)
		}

		_, err = op(t, r.dir, Op{Kind: OpCherryPick, Rev: "topic"})
		mustFailAs[*ConflictsError](t, err, "the pick again")
		r.take("theirs")
		res := mustOp(t, r.dir, Op{Kind: OpContinue, Operation: "cherry-pick"})
		if r.inProgress() != "" || r.sha("HEAD^") != before || res.Head != r.sha("HEAD") || r.out("log", "-1", "--format=%s") != "topic two" {
			t.Fatalf("continue: %+v, in progress %q", res, r.inProgress())
		}
	})

	t.Run("revert", func(t *testing.T) {
		t.Parallel()
		r := committed(t)
		r.clash()
		r.git("switch", "-q", "topic")
		before := r.sha("HEAD")
		_, err := op(t, r.dir, Op{Kind: OpRevert, Rev: "topic~1"})
		mustFailAs[*ConflictsError](t, err, "the revert")
		mustOp(t, r.dir, Op{Kind: OpAbort, Operation: "revert"})
		if r.inProgress() != "" || r.sha("HEAD") != before || r.read("a.txt") != "topic 2\n" {
			t.Fatalf("abort left %q in progress", r.inProgress())
		}

		_, err = op(t, r.dir, Op{Kind: OpRevert, Rev: "topic~1"})
		mustFailAs[*ConflictsError](t, err, "the revert again")
		r.write("a.txt", "neither\n")
		r.git("add", "a.txt")
		mustOp(t, r.dir, Op{Kind: OpContinue, Operation: "revert"})
		if r.inProgress() != "" || r.sha("HEAD^") != before || r.read("a.txt") != "neither\n" {
			t.Fatalf("continue left %q in progress", r.inProgress())
		}
	})
}

// A pick of several commits whose first was committed by hand is still in
// progress between commits, and git will not switch branch until it ends.
// Quitting ends it and changes nothing else.
func TestInProgressQuitPickBetweenCommits(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.clash()
	if err := exec.Command("git", "-C", r.dir, "cherry-pick", "topic~1", "topic").Run(); err == nil {
		t.Fatal("the pick did not stop on its conflict")
	}
	r.take("theirs")
	r.git("commit", "-q", "--no-edit")
	if r.inProgress() != "cherry-pick" {
		t.Fatalf("between commits, %q is in progress", r.inProgress())
	}
	_, err := op(t, r.dir, Op{Kind: OpBranchCreate, Name: "side", Switch: true})
	if err == nil {
		t.Fatal("git switched branch with a pick in progress; the premise of quitting is gone")
	}

	_, err = op(t, r.dir, Op{Kind: OpQuit, Operation: "merge"})
	mustFailAs[*StaleError](t, err, "quitting a merge when a pick is in progress")
	head := r.sha("HEAD")
	res := mustOp(t, r.dir, Op{Kind: OpQuit, Operation: "cherry-pick"})
	if r.inProgress() != "" || res.Head != head || r.sha("HEAD") != head || r.read("a.txt") != "topic 1\n" || r.staged() != "" {
		t.Fatalf("quit: %+v, in progress %q, a.txt %q, staged %q", res, r.inProgress(), r.read("a.txt"), r.staged())
	}
	mustOp(t, r.dir, Op{Kind: OpBranchCreate, Name: "side", Switch: true})
}

// Only a pick or revert is quit; a merge or rebase is continued or aborted.
func TestInProgressQuitRefusedForAMerge(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.clash()
	_, err := op(t, r.dir, Op{Kind: OpMerge, Rev: "topic"})
	mustFailAs[*ConflictsError](t, err, "the merge")
	_, err = op(t, r.dir, Op{Kind: OpQuit, Operation: "merge"})
	mustFailAs[*RefusedError](t, err, "quitting a merge")
	if r.inProgress() != "merge" {
		t.Fatal("a refused quit ended the merge")
	}
}

// Changes set aside before a write that stopped on conflicts come back when
// the operation is finished, or abandoned.
func TestInProgressPutsBackWhatWasSetAside(t *testing.T) {
	t.Parallel()
	for _, finish := range []OpKind{OpContinue, OpAbort} {
		t.Run(string(finish), func(t *testing.T) {
			t.Parallel()
			r := committed(t)
			r.clash()
			r.write("gone.txt", "edited\n")
			res, err := op(t, r.dir, Op{Kind: OpMerge, Rev: "topic", Dirty: DirtyStash})
			mustFailAs[*ConflictsError](t, err, "the merge")
			if res.Stash == "" || !r.exists(".git/"+gitview.SetAsideFile) {
				t.Fatalf("the stash the merge stopped with is not recorded: %+v", res)
			}
			if finish == OpContinue {
				r.take("theirs")
			}
			res = mustOp(t, r.dir, Op{Kind: finish, Operation: "merge"})
			if r.read("gone.txt") != "edited\n" || r.out("stash", "list") != "" || res.Stash != "" {
				t.Fatalf("after %s: gone.txt %q, stashes %q, %+v", finish, r.read("gone.txt"), r.out("stash", "list"), res)
			}
			if r.exists(".git/" + gitview.SetAsideFile) {
				t.Error("the record of the stash outlived it")
			}
		})
	}
}

// unmergedStages is the stages of path the index holds, as "1 2 3" (or "0"
// once resolved, "" once removed).
func (r *repo) unmergedStages(path string) string {
	r.t.Helper()
	var stages []string
	for _, line := range strings.Split(r.out("ls-files", "-s", "--", path), "\n") {
		if meta, _, ok := strings.Cut(line, "\t"); ok {
			fields := strings.Fields(meta)
			stages = append(stages, fields[len(fields)-1])
		}
	}
	return strings.Join(stages, " ")
}

// TestResolveBothModified takes each side of a file both branches changed,
// and undoes it.
func TestResolveBothModified(t *testing.T) {
	t.Parallel()
	for side, want := range map[string]string{"ours": "main\n", "theirs": "topic 2\n"} {
		t.Run(side, func(t *testing.T) {
			t.Parallel()
			r := committed(t)
			r.clash()
			_, err := op(t, r.dir, Op{Kind: OpMerge, Rev: "topic"})
			mustFailAs[*ConflictsError](t, err, "the merge")
			r.write("a.txt", "hand edits\n")

			res := mustOp(t, r.dir, Op{Kind: OpResolve, Path: "a.txt", Mode: side})
			if r.read("a.txt") != want || r.unmergedStages("a.txt") != "0" || res.Discard == "" {
				t.Fatalf("%s: a.txt %q, stages %q, %+v", side, r.read("a.txt"), r.unmergedStages("a.txt"), res)
			}

			mustOp(t, r.dir, Op{Kind: OpUnresolve, Path: "a.txt", Discard: res.Discard})
			if r.unmergedStages("a.txt") != "1 2 3" || r.read("a.txt") != "hand edits\n" {
				t.Fatalf("unresolve: stages %q, a.txt %q", r.unmergedStages("a.txt"), r.read("a.txt"))
			}
		})
	}
}

// TestResolveModifyDelete takes each side of a file one branch changed and
// the other deleted: the deleting side's version is no file at all.
func TestResolveModifyDelete(t *testing.T) {
	t.Parallel()
	for side, kept := range map[string]bool{"ours": true, "theirs": false} {
		t.Run(side, func(t *testing.T) {
			t.Parallel()
			r := committed(t)
			main := r.mainBranch()
			r.git("switch", "-q", "-c", "topic")
			r.git("rm", "-q", "a.txt")
			r.commit("topic deletes a.txt")
			r.git("switch", "-q", main)
			r.write("a.txt", "main\n")
			r.commit("main changes a.txt")
			_, err := op(t, r.dir, Op{Kind: OpMerge, Rev: "topic"})
			mustFailAs[*ConflictsError](t, err, "the merge")

			res := mustOp(t, r.dir, Op{Kind: OpResolve, Path: "a.txt", Mode: side})
			if r.exists("a.txt") != kept || r.out("ls-files", "-u") != "" {
				t.Fatalf("%s: a.txt exists %v, unmerged %q", side, r.exists("a.txt"), r.out("ls-files", "-u"))
			}
			if kept && (r.read("a.txt") != "main\n" || r.unmergedStages("a.txt") != "0") {
				t.Fatalf("ours: a.txt %q, stages %q", r.read("a.txt"), r.unmergedStages("a.txt"))
			}
			if !kept && r.unmergedStages("a.txt") != "" {
				t.Fatalf("theirs left a.txt in the index: %q", r.unmergedStages("a.txt"))
			}

			mustOp(t, r.dir, Op{Kind: OpUnresolve, Path: "a.txt", Discard: res.Discard})
			if r.unmergedStages("a.txt") != "1 2" || r.read("a.txt") != "main\n" {
				t.Fatalf("unresolve: stages %q", r.unmergedStages("a.txt"))
			}
		})
	}
}

// TestResolveMarkedResolved stages the file as it is, refusing one that still
// has conflict markers unless forced.
func TestResolveMarkedResolved(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.clash()
	_, err := op(t, r.dir, Op{Kind: OpMerge, Rev: "topic"})
	mustFailAs[*ConflictsError](t, err, "the merge")

	_, err = op(t, r.dir, Op{Kind: OpResolve, Path: "a.txt", Mode: ResolveMarked})
	mustFailAs[*MarkersError](t, err, "marking a file with markers resolved")
	if r.unmergedStages("a.txt") != "1 2 3" {
		t.Fatal("the refused resolve staged a.txt")
	}
	mustOp(t, r.dir, Op{Kind: OpResolve, Path: "a.txt", Mode: ResolveMarked, Force: true})
	if r.unmergedStages("a.txt") != "0" || !strings.Contains(r.out("show", ":a.txt"), "<<<<<<< ") {
		t.Fatalf("forced: stages %q", r.unmergedStages("a.txt"))
	}

	r.write("a.txt", "both\n")
	_, err = op(t, r.dir, Op{Kind: OpResolve, Path: "a.txt", Mode: ResolveMarked})
	mustFailAs[*StaleError](t, err, "resolving a file with no conflict")
	r.git("update-index", "--unresolve", "--", "a.txt")
	mustOp(t, r.dir, Op{Kind: OpResolve, Path: "a.txt", Mode: ResolveMarked})
	if r.unmergedStages("a.txt") != "0" || r.out("show", ":a.txt") != "both" {
		t.Fatalf("resolved: stages %q", r.unmergedStages("a.txt"))
	}
}

// TestResolveUndoRefused leaves alone a file changed since it was resolved,
// and a resolve once the operation has ended.
func TestResolveUndoRefused(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.clash()
	_, err := op(t, r.dir, Op{Kind: OpMerge, Rev: "topic"})
	mustFailAs[*ConflictsError](t, err, "the merge")
	res := mustOp(t, r.dir, Op{Kind: OpResolve, Path: "a.txt", Mode: "theirs"})

	r.write("a.txt", "later\n")
	_, err = op(t, r.dir, Op{Kind: OpUnresolve, Path: "a.txt", Discard: res.Discard})
	mustFailAs[*StaleError](t, err, "undoing a resolve of a file changed since")
	if r.read("a.txt") != "later\n" || r.unmergedStages("a.txt") != "0" {
		t.Fatal("the refused undo touched a.txt")
	}

	r.write("a.txt", "topic 2\n")
	mustOp(t, r.dir, Op{Kind: OpContinue, Operation: "merge"})
	_, err = op(t, r.dir, Op{Kind: OpUnresolve, Path: "a.txt", Discard: res.Discard})
	mustFailAs[*RefusedError](t, err, "undoing a resolve once the merge is committed")
}
