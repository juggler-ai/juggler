//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/gitcmd"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/msg"
)

// The Refs place's writes to branches and tags, and the merge and rebase into
// the current branch.
//
// Which of git's refusals a failure was — local changes in the way, an
// unmerged branch — is read from what git said, so the commands whose
// refusals are told apart run with git's messages in English whatever the
// user's locale. Conflicts are not read from text at all: they are what the
// repository is left holding.

// englishGit has git speak the untranslated messages its refusals are read
// from. LANGUAGE is the one variable gettext lets choose the language of
// messages alone, leaving the locale — and so what a hook prints — as it was.
var englishGit = []string{"LANGUAGE=en"}

// rawGit runs one git command that may be refused in a way the caller tells
// apart, and hands back git's own error unexplained.
func (r *runner) rawGit(args ...string) ([]byte, error) {
	if r.hooks.Command != nil {
		r.hooks.Command(args)
	}
	// A rebase redraws its "Rebasing (n/m)" line: only what stays on screen is
	// output.
	screen := newProgressSplitter(r.hooks.Output, r.hooks.Progress)
	res, err := gitcmd.Exec(r.ctx, gitcmd.Request{Dir: r.dir, Args: args, Env: englishGit, OnOutput: screen.write})
	screen.flush()
	return res.Stdout, err
}

// said reports whether a failed git command's output holds any of phrases.
func said(err error, phrases ...string) bool {
	var failed *gitcmd.Error
	if !errors.As(err, &failed) {
		return false
	}
	for _, p := range phrases {
		if strings.Contains(failed.Output, p) {
			return true
		}
	}
	return false
}

// dirtyRefusal is how git says local changes are in the way of what it was
// asked.
var dirtyRefusal = []string{"would be overwritten", "Please commit your changes or stash them", "You have unstaged changes", "Your index contains uncommitted changes"}

func dirtyError() *DirtyError {
	return &DirtyError{Err: msg.NewError("Local changes are in the way. Stash them first, or commit them.")}
}

func staleRef(name string) *StaleError {
	return &StaleError{Err: msg.NewError("{name} has moved since it was shown. Look again.", "name", name)}
}

// worktrees lists the repository's working trees, wherever they are.
func (r *runner) worktrees() ([]gitview.Worktree, error) {
	w, err := gitview.ListWorktrees(r.ctx, r.dir, "")
	if err != nil {
		return nil, refusal(err)
	}
	return w.Trees, nil
}

// checkedOut is the tree that has branch out, or nil; skipHere leaves out the
// tree the write runs in.
func (r *runner) checkedOut(branch string, skipHere bool) (*gitview.Worktree, error) {
	trees, err := r.worktrees()
	if err != nil {
		return nil, err
	}
	for i, t := range trees {
		if t.Branch == branch && !t.Prunable && (!skipHere || !t.Current) {
			return &trees[i], nil
		}
	}
	return nil, nil
}

// refuseCheckedOut is a CheckedOutError when branch is out in a tree.
func (r *runner) refuseCheckedOut(branch string, skipHere bool) error {
	t, err := r.checkedOut(branch, skipHere)
	if err != nil || t == nil {
		return err
	}
	return &CheckedOutError{Branch: branch, Worktree: t.Path, Err: msg.NewError(
		"{branch} is checked out in {worktree}.", "branch", branch, "worktree", t.Path)}
}

// branchName refuses a name git would not take for a branch.
func (r *runner) branchName(name string) error {
	if _, ok, err := r.ask("check-ref-format", "--branch", name); err != nil || !ok {
		if err != nil {
			return err
		}
		return refused(msg.NewError("{name} is not a name git allows for a branch.", "name", name))
	}
	if strings.HasPrefix(name, "-") {
		return refused(msg.NewError("{name} is not a name git allows for a branch.", "name", name))
	}
	return nil
}

// tagName refuses a name git would not take for a tag.
func (r *runner) tagName(name string) error {
	if _, ok, err := r.ask("check-ref-format", "refs/tags/"+name); err != nil || !ok || strings.HasPrefix(name, "-") {
		if err != nil {
			return err
		}
		return refused(msg.NewError("{name} is not a name git allows for a tag.", "name", name))
	}
	return nil
}

// rev resolves a revision the client named to the commit it names, refusing
// one that names none or reads as an option.
func (r *runner) rev(rev string) (string, error) {
	if rev == "" || strings.HasPrefix(rev, "-") {
		return "", refused(msg.NewError("{rev} names no commit.", "rev", rev))
	}
	sha, ok, err := r.ask("rev-parse", "-q", "--verify", rev+"^{commit}")
	if err != nil {
		return "", err
	}
	if !ok {
		return "", refused(msg.NewError("{rev} names no commit.", "rev", rev))
	}
	return sha, nil
}

// expect checks ref is still at sha, the object the client saw it at.
func (r *runner) expect(ref, name, sha string) error {
	if sha == "" {
		return refused(msg.NewError("No expected value was given for {name}.", "name", name))
	}
	now, ok, err := r.ask("rev-parse", "-q", "--verify", ref)
	if err != nil {
		return err
	}
	if !ok || now != sha {
		return staleRef(name)
	}
	return nil
}

// headSha is the commit HEAD names now.
func (r *runner) headSha() string {
	sha, _, _ := r.ask("rev-parse", "-q", "--verify", "HEAD")
	return sha
}

// stopped reports whether a failed command left conflicts behind: an operation
// in progress, or unmerged entries in the index.
func (r *runner) stopped() bool {
	for _, name := range []string{"MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"} {
		if _, err := os.Stat(filepath.Join(r.gitDir, name)); err == nil {
			return true
		}
	}
	out, ok, _ := r.ask("ls-files", "-u")
	return ok && out != ""
}

func conflictsError() *ConflictsError {
	return &ConflictsError{Err: msg.NewError("Stopped on conflicts. Resolve them in Changes, or abort.")}
}

func branchCreate(r *runner, op Op) (Result, error) {
	if err := r.branchName(op.Name); err != nil {
		return Result{}, err
	}
	start := op.Rev
	if start == "" {
		start = "HEAD"
	}
	at, err := r.rev(start)
	if err != nil {
		return Result{}, err
	}
	if op.Switch {
		_, err = r.git("switch", "-q", "-c", op.Name, at)
	} else {
		_, err = r.git("branch", "--no-track", op.Name, at)
	}
	return Result{Head: r.headSha()}, err
}

// switchTo moves HEAD: to a branch, to a new branch tracking a remote one, or
// to a commit, detached. Local changes in the way are carried, which git
// refuses when it would overwrite them (DirtyError), or set aside in a stash
// that is left for the user — named in the result — and put back if the switch
// then fails.
func switchTo(r *runner, op Op) (Result, error) {
	var args []string
	switch {
	case op.Detach:
		at, err := r.rev(op.Rev)
		if err != nil {
			return Result{}, err
		}
		args = []string{"switch", "-q", "--detach", at}
	case op.Track:
		if err := r.branchName(op.Branch); err != nil {
			return Result{}, err
		}
		if op.Rev == "" || strings.HasPrefix(op.Rev, "-") {
			return Result{}, refused(msg.NewError("{rev} names no commit.", "rev", op.Rev))
		}
		args = []string{"switch", "-q", "-c", op.Branch, "--track", op.Rev}
	default:
		if err := r.branchName(op.Branch); err != nil {
			return Result{}, err
		}
		if err := r.refuseCheckedOut(op.Branch, true); err != nil {
			return Result{}, err
		}
		args = []string{"switch", "-q", op.Branch}
	}

	var stash string
	if op.Dirty == DirtyStash {
		target := op.Branch
		if target == "" {
			target = op.Rev
		}
		var err error
		if stash, err = r.setAside("Juggler: set aside to switch to " + target); err != nil {
			return Result{}, err
		}
	}
	if _, err := r.rawGit(args...); err != nil {
		if stash != "" {
			r.putBack(stash)
		}
		if said(err, dirtyRefusal...) {
			return Result{}, dirtyError()
		}
		return Result{}, r.explain(err)
	}
	return Result{Head: r.headSha(), Stash: stash}, nil
}

func branchRename(r *runner, op Op) (Result, error) {
	if err := r.branchName(op.Branch); err != nil {
		return Result{}, err
	}
	if err := r.branchName(op.Name); err != nil {
		return Result{}, err
	}
	_, err := r.git("branch", "-m", op.Branch, op.Name)
	return Result{}, err
}

func branchUpstream(r *runner, op Op) (Result, error) {
	if err := r.branchName(op.Branch); err != nil {
		return Result{}, err
	}
	if op.Upstream == "" {
		_, err := r.git("branch", "--unset-upstream", op.Branch)
		return Result{}, err
	}
	if strings.HasPrefix(op.Upstream, "-") {
		return Result{}, refused(msg.NewError("{rev} names no commit.", "rev", op.Upstream))
	}
	_, err := r.git("branch", "--set-upstream-to="+op.Upstream, op.Branch)
	return Result{}, err
}

// branchDelete deletes a branch that is checked out nowhere and still where
// the client saw it, refusing an unmerged one until it is forced. The result
// names its tip, which is what restoring it needs.
func branchDelete(r *runner, op Op) (Result, error) {
	if err := r.branchName(op.Branch); err != nil {
		return Result{}, err
	}
	if err := r.refuseCheckedOut(op.Branch, false); err != nil {
		return Result{}, err
	}
	if err := r.expect("refs/heads/"+op.Branch, op.Branch, op.ExpectSha); err != nil {
		return Result{}, err
	}
	flag := "-d"
	if op.Force {
		flag = "-D"
	}
	if _, err := r.rawGit("branch", flag, op.Branch); err != nil {
		if said(err, "not fully merged") {
			return Result{}, &UnmergedError{Branch: op.Branch, Err: msg.NewError(
				"{branch} has commits no other branch has. Delete it anyway?", "branch", op.Branch)}
		}
		return Result{}, r.explain(err)
	}
	return Result{Sha: op.ExpectSha}, nil
}

// refRestore puts back a branch or tag that was deleted, and only one that does
// not exist: an undo never overwrites what was made since.
func refRestore(r *runner, op Op) (Result, error) {
	if !strings.HasPrefix(op.Ref, "refs/heads/") && !strings.HasPrefix(op.Ref, "refs/tags/") {
		return Result{}, refused(msg.NewError("Only a branch or a tag can be restored."))
	}
	if _, ok, err := r.ask("check-ref-format", op.Ref); err != nil || !ok {
		if err != nil {
			return Result{}, err
		}
		return Result{}, refused(msg.NewError("Only a branch or a tag can be restored."))
	}
	if _, ok, err := r.ask("cat-file", "-e", op.Sha); err != nil || !ok || strings.HasPrefix(op.Sha, "-") {
		if err != nil {
			return Result{}, err
		}
		return Result{}, refused(msg.NewError("What was deleted is no longer in the repository."))
	}
	if _, ok, err := r.ask("rev-parse", "-q", "--verify", op.Ref); err != nil || ok {
		if err != nil {
			return Result{}, err
		}
		return Result{}, refused(msg.NewError("{ref} exists again: it was not restored over.", "ref", op.Ref))
	}
	_, err := r.git("update-ref", "-m", "Juggler: restored", op.Ref, op.Sha, "")
	return Result{}, err
}

// mergeInto merges Rev into the current branch. git is given Rev as the client
// named it, once it is known to name a commit, because git titles the merge
// commit with that name: "Merge branch 'topic'", not a sha.
func mergeInto(r *runner, op Op) (Result, error) {
	if _, err := r.rev(op.Rev); err != nil {
		return Result{}, err
	}
	return r.intoCurrent(op, "Juggler: set aside to merge "+op.Rev, nil, "merge", "--no-edit", op.Rev)
}

// rebaseOnto rebases the current branch onto Rev. git refuses any rebase with
// tracked changes about, so that is refused before it starts unless the
// changes are to be set aside.
func rebaseOnto(r *runner, op Op) (Result, error) {
	at, err := r.rev(op.Rev)
	if err != nil {
		return Result{}, err
	}
	if err := r.refuseTrackedChanges(op); err != nil {
		return Result{}, err
	}
	return r.intoCurrent(op, "Juggler: set aside to rebase onto "+op.Rev, nil, "rebase", at)
}

// intoCurrent runs a merge, rebase, cherry-pick or revert on the current
// branch, setting local changes aside first when asked and putting them back
// once it has finished. One that stops on conflicts leaves them, and any
// changes set aside stay in their stash, named in the result and recorded for
// whatever ends the operation to put back (see operation_ops.go).
//
// refuse, when set, is asked about a failure first, before what the
// repository was left holding is read as conflicts: a failure it answers with
// an error it has cleaned up after, and the changes set aside are put back.
func (r *runner) intoCurrent(op Op, aside string, refuse func(error) error, args ...string) (Result, error) {
	// A record left by an operation that ended without this client names a
	// stash that is the user's now, not this write's.
	r.forgetSetAside()
	var stash string
	if op.Dirty == DirtyStash {
		var err error
		if stash, err = r.setAside(aside); err != nil {
			return Result{}, err
		}
	}
	if _, err := r.rawGit(args...); err != nil {
		if refuse != nil {
			if refusal := refuse(err); refusal != nil {
				if stash != "" {
					r.putBack(stash)
				}
				return Result{}, refusal
			}
		}
		if r.stopped() {
			if stash != "" {
				r.recordSetAside(stash)
			}
			return Result{Stash: stash}, conflictsError()
		}
		if stash != "" {
			r.putBack(stash)
		}
		if said(err, dirtyRefusal...) {
			return Result{}, dirtyError()
		}
		return Result{}, r.explain(err)
	}
	res := Result{Head: r.headSha()}
	if stash != "" {
		if err := r.applyStash(stash, true); err != nil {
			return Result{Head: res.Head, Stash: stash}, err
		}
	}
	return res, nil
}

// fastForward moves a branch nobody has out to Rev (its upstream by default),
// only forward, and only from where the client saw it.
func fastForward(r *runner, op Op) (Result, error) {
	if err := r.branchName(op.Branch); err != nil {
		return Result{}, err
	}
	if err := r.refuseCheckedOut(op.Branch, false); err != nil {
		return Result{}, err
	}
	ref := "refs/heads/" + op.Branch
	if err := r.expect(ref, op.Branch, op.ExpectSha); err != nil {
		return Result{}, err
	}
	target := op.Rev
	if target == "" {
		target = op.Branch + "@{upstream}"
	}
	to, err := r.rev(target)
	if err != nil {
		return Result{}, err
	}
	if to == op.ExpectSha {
		return Result{Sha: to}, nil
	}
	if _, ok, err := r.ask("merge-base", "--is-ancestor", op.ExpectSha, to); err != nil || !ok {
		if err != nil {
			return Result{}, err
		}
		return Result{}, &DivergedError{Err: msg.NewError(
			"{branch} has commits {target} does not: it can't be fast-forwarded. Merge or rebase instead.",
			"branch", op.Branch, "target", target)}
	}
	_, err = r.git("update-ref", "-m", "Juggler: fast-forward to "+target, ref, to, op.ExpectSha)
	return Result{Sha: to}, err
}

func tagCreate(r *runner, op Op) (Result, error) {
	if err := r.tagName(op.Name); err != nil {
		return Result{}, err
	}
	start := op.Rev
	if start == "" {
		start = "HEAD"
	}
	at, err := r.rev(start)
	if err != nil {
		return Result{}, err
	}
	if op.Message != "" {
		_, err = r.git("tag", "-a", "-m", op.Message, "--", op.Name, at)
	} else {
		_, err = r.git("tag", "--", op.Name, at)
	}
	return Result{}, err
}

// tagDelete deletes a tag still where the client saw it. The result names the
// tag's object — the tag object of an annotated tag — which restoring it needs.
func tagDelete(r *runner, op Op) (Result, error) {
	if err := r.tagName(op.Name); err != nil {
		return Result{}, err
	}
	if err := r.expect("refs/tags/"+op.Name, op.Name, op.ExpectSha); err != nil {
		return Result{}, err
	}
	_, err := r.git("update-ref", "-d", "refs/tags/"+op.Name, op.ExpectSha)
	return Result{Sha: op.ExpectSha}, err
}
