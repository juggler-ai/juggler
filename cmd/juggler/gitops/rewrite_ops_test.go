//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"strings"
	"testing"
)

// chain is a committed repository with three more commits on its branch, b, c
// and d, each adding its own file; b is written by Ann at a fixed date. It
// returns their shas, oldest first.
func chain(t *testing.T) (*repo, []string) {
	t.Helper()
	r := committed(t)
	r.write("b.txt", "b\n")
	r.git("add", "-A")
	r.git("commit", "-qm", "adds b\n\nwith a body", "--author=Ann <ann@example.com>", "--date=2001-02-03T04:05:06+00:00")
	shas := []string{r.sha("HEAD")}
	for _, name := range []string{"c", "d"} {
		r.write(name+".txt", name+"\n")
		r.commit("adds " + name)
		shas = append(shas, r.sha("HEAD"))
	}
	return r, shas
}

// subjects is the branch's subjects, newest first.
func (r *repo) subjects() string { return r.out("log", "--format=%s") }

func TestRewriteReword(t *testing.T) {
	t.Parallel()
	r, shas := chain(t)
	tip := r.sha("HEAD")
	trees := r.out("log", "--format=%T")
	r.write("a.txt", "dirty\n")
	r.write("staged.txt", "s\n")
	r.git("add", "staged.txt")

	res := mustOp(t, r.dir, Op{Kind: OpReword, Rev: shas[0], Message: "brings b\n\nnew body", ExpectHead: tip})
	if res.Sha != tip || res.Head != r.sha("HEAD") || res.Head == tip {
		t.Fatalf("result %+v, head %s", res, r.sha("HEAD"))
	}
	if got := r.subjects(); got != "adds d\nadds c\nbrings b\ninit" {
		t.Fatalf("subjects %q", got)
	}
	if got := r.out("log", "-1", "--format=%B", "HEAD~2"); got != "brings b\n\nnew body" {
		t.Fatalf("message %q", got)
	}
	if got := r.out("log", "--format=%T"); got != trees {
		t.Fatalf("trees changed:\n%s\nwant\n%s", got, trees)
	}
	if got := r.out("log", "-1", "--format=%an <%ae> %at", "HEAD~2"); got != "Ann <ann@example.com> 981173106" {
		t.Fatalf("author %q", got)
	}
	if r.read("a.txt") != "dirty\n" || r.staged() != "A\tstaged.txt" {
		t.Fatalf("the tree was touched: a.txt %q, staged %q", r.read("a.txt"), r.staged())
	}
	if !strings.Contains(r.out("reflog", "-1", "--format=%gs"), "reword") {
		t.Fatalf("reflog %q", r.out("reflog", "-1", "--format=%gs"))
	}

	// HEAD must be where the client saw it, and the commit on the branch.
	_, err := op(t, r.dir, Op{Kind: OpReword, Rev: "HEAD", Message: "x", ExpectHead: tip})
	mustFailAs[*StaleError](t, err, "a reword from a HEAD that moved")
	head := r.sha("HEAD")
	_, err = op(t, r.dir, Op{Kind: OpReword, Rev: shas[0], Message: "x", ExpectHead: head})
	mustFailAs[*RefusedError](t, err, "a reword of a commit no longer on the branch")
	_, err = op(t, r.dir, Op{Kind: OpReword, Rev: "HEAD", Message: "  ", ExpectHead: head})
	mustFailAs[*RefusedError](t, err, "a reword to an empty message")
}

func TestRewriteSquash(t *testing.T) {
	t.Parallel()
	r, shas := chain(t)
	tip := r.sha("HEAD")
	final := r.out("rev-parse", "HEAD^{tree}")

	res := mustOp(t, r.dir, Op{Kind: OpSquash, Rev: shas[0], Sha: shas[1], ExpectHead: tip})
	if res.Sha != tip || res.Head != r.sha("HEAD") {
		t.Fatalf("result %+v", res)
	}
	if got := r.subjects(); got != "adds d\nadds b\ninit" {
		t.Fatalf("subjects %q", got)
	}
	if got := r.out("log", "-1", "--format=%B", "HEAD~1"); got != "adds b\n\nwith a body\n\nadds c" {
		t.Fatalf("squashed message %q", got)
	}
	if r.out("rev-parse", "HEAD^{tree}") != final || r.out("ls-tree", "--name-only", "HEAD~1") != "a.txt\nb.txt\nc.txt\ngone.txt" {
		t.Fatal("the squash changed what the commits hold")
	}

	// Named newest first, it is the same run.
	head := r.sha("HEAD")
	res = mustOp(t, r.dir, Op{Kind: OpSquash, Rev: head, Sha: r.sha("HEAD~1"), ExpectHead: head})
	if got := r.subjects(); got != "adds b\ninit" || res.Sha != head {
		t.Fatalf("subjects %q", got)
	}

	// A run is two commits or more, one on the line of first parents.
	head = r.sha("HEAD")
	_, err := op(t, r.dir, Op{Kind: OpSquash, Rev: head, Sha: head, ExpectHead: head})
	mustFailAs[*RefusedError](t, err, "a squash of one commit")
}

func TestRewriteSquashRefusesAMerge(t *testing.T) {
	t.Parallel()
	r := committed(t)
	merge := r.mergeCommit()
	r.git("merge", "-q", "--ff-only", "merged")
	head := r.sha("HEAD")
	_, err := op(t, r.dir, Op{Kind: OpSquash, Rev: r.sha(merge + "^1"), Sha: merge, ExpectHead: head})
	mustFailAs[*RefusedError](t, err, "a squash of a run holding a merge")
	_, err = op(t, r.dir, Op{Kind: OpDrop, Rev: r.sha(merge + "^1"), ExpectHead: head})
	mustFailAs[*RefusedError](t, err, "a drop with a merge after it")
	if r.sha("HEAD") != head {
		t.Fatal("a refused rewrite moved HEAD")
	}
}

func TestRewriteDrop(t *testing.T) {
	t.Parallel()
	r, shas := chain(t)
	tip := r.sha("HEAD")

	res := mustOp(t, r.dir, Op{Kind: OpDrop, Rev: shas[1], ExpectHead: tip})
	if res.Sha != tip || res.Head != r.sha("HEAD") || r.subjects() != "adds d\nadds b\ninit" || r.exists("c.txt") {
		t.Fatalf("drop: %+v, subjects %q, c.txt %v", res, r.subjects(), r.exists("c.txt"))
	}

	// Local changes are in the way until set aside.
	head := r.sha("HEAD")
	r.write("a.txt", "dirty\n")
	_, err := op(t, r.dir, Op{Kind: OpDrop, Rev: shas[0], ExpectHead: head})
	mustFailAs[*DirtyError](t, err, "a drop over local changes")
	mustOp(t, r.dir, Op{Kind: OpDrop, Rev: r.sha("HEAD~1"), ExpectHead: head, Dirty: DirtyStash})
	if r.subjects() != "adds d\ninit" || r.read("a.txt") != "dirty\n" || r.out("stash", "list") != "" {
		t.Fatalf("drop with stash: subjects %q, a.txt %q", r.subjects(), r.read("a.txt"))
	}
	r.git("checkout", "--", "a.txt")

	// One the commits after it depend on stops on conflicts.
	r.write("d.txt", "d, changed\n")
	r.commit("changes d")
	head = r.sha("HEAD")
	_, err = op(t, r.dir, Op{Kind: OpDrop, Rev: r.sha("HEAD~1"), ExpectHead: head})
	mustFailAs[*ConflictsError](t, err, "a drop the next commit depends on")
	if r.inProgress() != "rebase" {
		t.Fatalf("in progress: %q", r.inProgress())
	}

	// The first commit has nothing to drop it onto.
	r.git("rebase", "--abort")
	_, err = op(t, r.dir, Op{Kind: OpDrop, Rev: r.out("rev-list", "--max-parents=0", "HEAD"), ExpectHead: head})
	mustFailAs[*RefusedError](t, err, "a drop of the first commit")
}

func TestRewriteFixup(t *testing.T) {
	t.Parallel()
	r, shas := chain(t)
	tip := r.sha("HEAD")

	_, err := op(t, r.dir, Op{Kind: OpFixup, Rev: shas[0], ExpectHead: tip})
	mustFailAs[*RefusedError](t, err, "a fixup with nothing staged")

	r.write("b.txt", "b, fixed\n")
	r.git("add", "b.txt")
	r.write("a.txt", "unstaged\n")
	_, err = op(t, r.dir, Op{Kind: OpFixup, Rev: shas[0], ExpectHead: tip})
	mustFailAs[*DirtyError](t, err, "a fixup with unstaged changes about")
	if r.sha("HEAD") != tip || r.staged() != "M\tb.txt" {
		t.Fatalf("a refused fixup left HEAD %s, staged %q", r.sha("HEAD"), r.staged())
	}

	res := mustOp(t, r.dir, Op{Kind: OpFixup, Rev: shas[0], ExpectHead: tip, Dirty: DirtyStash})
	if res.Sha != tip || res.Head != r.sha("HEAD") || r.subjects() != "adds d\nadds c\nadds b\ninit" {
		t.Fatalf("fixup: %+v, subjects %q", res, r.subjects())
	}
	if got := r.out("show", "HEAD~2:b.txt"); got != "b, fixed" {
		t.Fatalf("b.txt in the fixed commit %q", got)
	}
	if r.read("a.txt") != "unstaged\n" || r.staged() != "" || r.out("stash", "list") != "" {
		t.Fatalf("after: a.txt %q staged %q", r.read("a.txt"), r.staged())
	}
	if got := r.out("log", "-1", "--format=%an %at", "HEAD~2"); got != "Ann 981173106" {
		t.Fatalf("author %q", got)
	}
}

func TestRewritePublished(t *testing.T) {
	t.Parallel()
	r, shas := chain(t)
	r.withRemote()
	r.write("e.txt", "e\n")
	r.commit("adds e")
	tip := r.sha("HEAD")

	// The unpushed commit is the user's alone.
	res := mustOp(t, r.dir, Op{Kind: OpReword, Rev: tip, Message: "brings e", ExpectHead: tip})
	head := res.Head

	for _, o := range []Op{
		{Kind: OpReword, Rev: shas[2], Message: "x"},
		{Kind: OpSquash, Rev: shas[1], Sha: shas[2]},
		{Kind: OpDrop, Rev: shas[1]},
		{Kind: OpFixup, Rev: shas[1]},
	} {
		o.ExpectHead = head
		_, err := op(t, r.dir, o)
		mustFailAs[*PublishedError](t, err, string(o.Kind)+" of a pushed commit")
	}
	if r.sha("HEAD") != head {
		t.Fatal("a refused rewrite moved HEAD")
	}
	mustOp(t, r.dir, Op{Kind: OpReword, Rev: shas[2], Message: "brings d", ExpectHead: head, Force: true})
	if r.subjects() != "brings e\nbrings d\nadds c\nadds b\ninit" {
		t.Fatalf("forced reword: %q", r.subjects())
	}
}
