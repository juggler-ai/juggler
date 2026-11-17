//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"errors"
	"strconv"
	"strings"

	"juggler/cmd/juggler/msg"
)

// The History place's rewrites: the verbs of an interactive rebase, each
// without its editor.
//
// A reword or a squash changes no commit's tree, so it is made in plumbing:
// the commit is made again with its new message (or the run as one commit,
// with the last one's tree), every commit descended from it on the way to HEAD
// is made again over its new parents with its own tree, message and author,
// and the branch is moved over the old tip. Nothing can conflict, and the
// index and working tree are left alone — local changes included. A merge
// after it is made again as a merge.
//
// A drop or a fixup changes the trees after it, so it is a rebase, which can
// stop on conflicts into the Operation place like any other. A plain rebase
// would flatten a merge after the commit, so one with a merge after it is
// refused.
//
// Each rewrites the current branch from where the client saw it (ExpectHead),
// and only a commit on it. One a remote-tracking branch already holds is a
// PublishedError unless Force: the branch could only be pushed by force after.
// Result.Sha is the old tip, which a reset back to undoes.

// rewriteBranch is the branch a rewrite moves: the current one, at the HEAD
// the client saw, with every commit in revs (resolved, in order) on it, none of
// them published unless the op is forced.
func (r *runner) rewriteBranch(op Op, revs ...string) (string, []string, error) {
	branch, ok, err := r.ask("symbolic-ref", "-q", "--short", "HEAD")
	if err != nil {
		return "", nil, err
	}
	if !ok || branch == "" {
		return "", nil, refused(msg.NewError("HEAD is detached: there is no branch to rewrite."))
	}
	if err := r.expect("HEAD", branch, op.ExpectHead); err != nil {
		return "", nil, err
	}
	shas := make([]string, 0, len(revs))
	for _, rev := range revs {
		sha, err := r.rev(rev)
		if err != nil {
			return "", nil, err
		}
		if _, ok, err := r.ask("merge-base", "--is-ancestor", sha, "HEAD"); err != nil || !ok {
			if err != nil {
				return "", nil, err
			}
			return "", nil, refused(msg.NewError("{sha} is not on {branch}.", "sha", short(sha), "branch", branch))
		}
		shas = append(shas, sha)
	}
	if !op.Force {
		for _, sha := range shas {
			remote, _, err := r.ask("for-each-ref", "--contains", sha, "--count=1", "--format=%(refname:short)", "refs/remotes")
			if err != nil {
				return "", nil, err
			}
			if remote != "" {
				return "", nil, &PublishedError{Err: msg.NewError(
					"{sha} is already on {remote}: rewriting it means the branch can only be pushed by force.",
					"sha", short(sha), "remote", remote)}
			}
		}
	}
	return branch, shas, nil
}

func short(sha string) string { return sha[:min(len(sha), 7)] }

// rawCommit is one commit as plumbing remakes it.
type rawCommit struct {
	tree    string
	parents []string
	author  []string // GIT_AUTHOR_* assignments
	message string
}

// readCommit reads a commit's tree, parents, author and message as stored.
func (r *runner) readCommit(sha string) (rawCommit, error) {
	out, err := r.run(call{args: []string{"cat-file", "commit", sha}, quiet: true})
	if err != nil {
		return rawCommit{}, err
	}
	text := string(out)
	head, message, _ := strings.Cut(text, "\n\n")
	var c rawCommit
	c.message = message
	for _, line := range strings.Split(head, "\n") {
		key, value, _ := strings.Cut(line, " ")
		switch key {
		case "tree":
			c.tree = value
		case "parent":
			c.parents = append(c.parents, value)
		case "author":
			lt, gt := strings.LastIndex(value, "<"), strings.LastIndex(value, ">")
			if lt < 0 || gt < lt {
				continue
			}
			c.author = []string{
				"GIT_AUTHOR_NAME=" + strings.TrimSpace(value[:lt]),
				"GIT_AUTHOR_EMAIL=" + value[lt+1:gt],
				"GIT_AUTHOR_DATE=" + strings.TrimSpace(value[gt+1:]),
			}
		}
	}
	return c, nil
}

// makeCommit writes a commit object and answers its sha.
func (r *runner) makeCommit(c rawCommit) (string, error) {
	args := []string{"commit-tree", c.tree}
	for _, p := range c.parents {
		args = append(args, "-p", p)
	}
	args = append(args, "-F", "-")
	out, err := r.run(call{args: args, stdin: []byte(c.message), env: c.author})
	return strings.TrimSpace(string(out)), err
}

// remake makes again every commit descended from from on the way to HEAD, over
// the parents made already (made maps an old commit to its new one, and holds
// from's), and moves branch over tip to the new HEAD.
func (r *runner) remake(branch, tip, from string, made map[string]string, why string) (Result, error) {
	out, err := r.run(call{args: []string{"rev-list", "--reverse", "--topo-order", "--ancestry-path", from + "..HEAD"}, quiet: true})
	if err != nil {
		return Result{}, err
	}
	for _, sha := range strings.Fields(string(out)) {
		c, err := r.readCommit(sha)
		if err != nil {
			return Result{}, err
		}
		for i, p := range c.parents {
			if now, ok := made[p]; ok {
				c.parents[i] = now
			}
		}
		if made[sha], err = r.makeCommit(c); err != nil {
			return Result{}, err
		}
	}
	head := made[tip]
	if _, err := r.git("update-ref", "-m", "Juggler: "+why, "refs/heads/"+branch, head, tip); err != nil {
		return Result{}, err
	}
	return Result{Head: head, Sha: tip}, nil
}

func reword(r *runner, op Op) (Result, error) {
	message := strings.TrimSpace(op.Message)
	if message == "" {
		return Result{}, refused(msg.NewError("A commit needs a message."))
	}
	branch, shas, err := r.rewriteBranch(op, op.Rev)
	if err != nil {
		return Result{}, err
	}
	at := shas[0]
	c, err := r.readCommit(at)
	if err != nil {
		return Result{}, err
	}
	c.message = message + "\n"
	now, err := r.makeCommit(c)
	if err != nil {
		return Result{}, err
	}
	return r.remake(branch, op.ExpectHead, at, map[string]string{at: now}, "reword "+short(at))
}

// squash makes the run from Rev to Sha one commit: the newer end's tree, the
// older end's parent and author, and their messages joined, oldest first. The
// run is the line of first parents between them, with no merge on it.
func squash(r *runner, op Op) (Result, error) {
	branch, shas, err := r.rewriteBranch(op, op.Rev, op.Sha)
	if err != nil {
		return Result{}, err
	}
	oldest, newest := shas[0], shas[1]
	if _, older, err := r.ask("merge-base", "--is-ancestor", newest, oldest); err != nil {
		return Result{}, err
	} else if older {
		oldest, newest = newest, oldest
	}
	var run []rawCommit
	for at := newest; ; {
		c, err := r.readCommit(at)
		if err != nil {
			return Result{}, err
		}
		if len(c.parents) != 1 {
			return Result{}, refused(msg.NewError("Only a run of commits with no merge in it can be squashed."))
		}
		run = append(run, c)
		if at == oldest {
			break
		}
		at = c.parents[0]
	}
	if len(run) < 2 {
		return Result{}, refused(msg.NewError("Choose two commits or more to squash."))
	}
	messages := make([]string, 0, len(run))
	for i := len(run) - 1; i >= 0; i-- {
		if m := strings.TrimSpace(run[i].message); m != "" {
			messages = append(messages, m)
		}
	}
	one := run[len(run)-1]
	one.tree = run[0].tree
	one.message = strings.Join(messages, "\n\n") + "\n"
	now, err := r.makeCommit(one)
	if err != nil {
		return Result{}, err
	}
	why := "squash " + strconv.Itoa(len(run)) + " commits into " + short(now)
	return r.remake(branch, op.ExpectHead, newest, map[string]string{newest: now}, why)
}

// refuseMerges refuses a rebase from c, the commit sha, that would flatten a
// merge: c itself or one after it.
func (r *runner) refuseMerges(sha string, c rawCommit) error {
	n, _, err := r.ask("rev-list", "--count", "--merges", sha+"..HEAD")
	if err != nil {
		return err
	}
	if len(c.parents) > 1 || (n != "0" && n != "") {
		return refused(msg.NewError("There is a merge after {sha}: only history with no merges in it can be rewritten here.", "sha", short(sha)))
	}
	return nil
}

// drop rebases what follows Rev onto Rev's parent.
func drop(r *runner, op Op) (Result, error) {
	_, shas, err := r.rewriteBranch(op, op.Rev)
	if err != nil {
		return Result{}, err
	}
	at := shas[0]
	c, err := r.readCommit(at)
	if err != nil {
		return Result{}, err
	}
	if len(c.parents) == 0 {
		return Result{}, refused(msg.NewError("The first commit can't be dropped."))
	}
	if err := r.refuseMerges(at, c); err != nil {
		return Result{}, err
	}
	if err := r.refuseTrackedChanges(op); err != nil {
		return Result{}, err
	}
	res, err := r.intoCurrent(op, "Juggler: set aside to drop "+short(at), nil, "rebase", "--onto", c.parents[0], at)
	res.Sha = op.ExpectHead
	return res, err
}

// fixup commits what is staged as a fixup of Rev and has an autosquashing
// rebase fold it in, with git's own todo taken as it stands. A rebase that is
// refused takes the fixup commit back out again, leaving it staged; one that
// stops on conflicts leaves it to the Operation place.
func fixup(r *runner, op Op) (Result, error) {
	_, shas, err := r.rewriteBranch(op, op.Rev)
	if err != nil {
		return Result{}, err
	}
	at := shas[0]
	c, err := r.readCommit(at)
	if err != nil {
		return Result{}, err
	}
	if err := r.refuseMerges(at, c); err != nil {
		return Result{}, err
	}
	if _, clean, err := r.ask("diff", "--cached", "--quiet"); err != nil {
		return Result{}, err
	} else if clean {
		return Result{}, refused(msg.NewError("Nothing is staged to fold into {sha}.", "sha", short(at)))
	}
	if op.Dirty != DirtyStash {
		if _, clean, err := r.ask("diff", "--quiet"); err != nil {
			return Result{}, err
		} else if !clean {
			return Result{}, dirtyError()
		}
	}
	if _, err := r.git("commit", "-q", "--no-verify", "-m", "fixup! "+at); err != nil {
		return Result{}, err
	}
	made := r.headSha()
	onto := "--root"
	if len(c.parents) > 0 {
		onto = c.parents[0]
	}
	res, err := r.intoCurrent(op, "Juggler: set aside to fix up "+short(at), nil,
		"-c", "sequence.editor=:", "rebase", "-i", "--autosquash", onto)
	var stopped *ConflictsError
	if err != nil && !errors.As(err, &stopped) && r.headSha() == made {
		_, _ = r.git("reset", "-q", "--soft", "HEAD~1")
	}
	res.Sha = op.ExpectHead
	return res, err
}
