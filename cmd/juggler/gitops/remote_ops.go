//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"errors"
	"slices"
	"strings"

	"juggler/cmd/juggler/gitcmd"
	"juggler/cmd/juggler/msg"
)

// The writes that talk to a remote: fetch, pull, push.
//
// Each runs on the repository's network lane (see Run) with --progress, its
// meter read off stderr into Hooks.Progress. They run with LC_ALL=C, which
// fixes the meter's words and the refusals read here to git's English; the
// client translates the phases it knows. A push is run with --porcelain, whose
// per-ref lines on stdout are what tells a rejection from any other failure.
//
// Nothing here forces a push blind: Force is only ever --force-with-lease on
// the remote sha the client saw, so a push that would overwrite something the
// user has not seen is refused by the remote (StaleError).

// netGit runs one command that talks to a remote, with Hooks.Env — the way its
// questions reach the user — and a failure to sign in reported as one.
func (r *runner) netGit(auto bool, args ...string) ([]byte, error) {
	env := append([]string{"LC_ALL=C"}, r.hooks.Env...)
	if auto {
		// A write the user did not ask for raises no prompt: Git Credential
		// Manager's own windows included.
		env = append(env, "GCM_INTERACTIVE=never")
	}
	out, err := r.run(call{args: args, env: env, net: true})
	return out, authFailure(err)
}

// authSigns are what git and ssh print, under LC_ALL=C, when a remote was not
// signed in to: a question unanswered (git falls back to a terminal prompt it
// is not allowed, and says so), credentials refused, no ssh key accepted, a
// host key not trusted.
var authSigns = []string{
	"could not read Username for ",
	"could not read Password for ",
	"Authentication failed for ",
	"Permission denied (publickey",
	"Host key verification failed.",
}

// authFailure is err as an AuthError when git's words say signing in failed,
// and err itself otherwise — a cancel included, whatever it printed.
func authFailure(err error) error {
	var failed *gitcmd.Error
	if !errors.As(err, &failed) || failed.Cancelled {
		return err
	}
	for _, sign := range authSigns {
		if strings.Contains(failed.Stderr, sign) {
			return &AuthError{Err: msg.NewError("The remote turned the sign-in down, or none was given.")}
		}
	}
	return err
}

// config is one setting's value, or "" when it is not set.
func (r *runner) config(key string) string {
	v, _, _ := r.ask("config", "--get", key)
	return v
}

// remotes are the repository's remotes, by name, sorted.
func (r *runner) remotes() ([]string, error) {
	out, _, err := r.ask("remote")
	if err != nil {
		return nil, err
	}
	names := strings.Fields(out)
	slices.Sort(names)
	return names, nil
}

// currentBranch is the branch HEAD is on; a detached HEAD is refused.
func (r *runner) currentBranch() (string, error) {
	name, ok, err := r.ask("symbolic-ref", "-q", "--short", "HEAD")
	if err != nil {
		return "", err
	}
	if !ok || name == "" {
		return "", refused(msg.NewError("HEAD is detached: there is no branch to pull into or push."))
	}
	return name, nil
}

// isSha reports whether s is a whole object id.
func isSha(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	return strings.Trim(s, "0123456789abcdef") == ""
}

func fetch(r *runner, op Op) (Result, error) {
	_, err := r.netGit(op.Auto, "fetch", "--all", "--prune", "--progress")
	return Result{}, err
}

// pull brings the current branch up to its upstream: fetches that remote, then,
// holding the write lane as well, fast-forwards — or, when the branch has
// commits of its own, refuses with a DivergedError unless Mode says to merge or
// rebase. Local changes in the way are handled as a merge's are (Dirty).
func pull(r *runner, op Op) (Result, error) {
	branch, err := r.currentBranch()
	if err != nil {
		return Result{}, err
	}
	remote := r.config("branch." + branch + ".remote")
	if remote == "" || r.config("branch."+branch+".merge") == "" {
		return Result{}, refused(msg.NewError("{branch} has no upstream to pull from. Publish it first.", "branch", branch))
	}
	if strings.HasPrefix(remote, "-") {
		return Result{}, refused(msg.NewError("{remote} is not a remote of this repository.", "remote", remote))
	}
	if remote != "." {
		if _, err := r.netGit(false, "fetch", "--prune", "--progress", remote); err != nil {
			return Result{}, err
		}
	}

	turn, err := r.q.Wait(r.ctx, r.common)
	if err != nil {
		return Result{}, err
	}
	defer turn.Done()

	upstream, ok, err := r.ask("rev-parse", "--abbrev-ref", branch+"@{upstream}")
	if err != nil {
		return Result{}, err
	}
	if !ok {
		return Result{}, refused(msg.NewError("{branch}'s upstream is gone from its remote.", "branch", branch))
	}
	switch op.Mode {
	case PullMerge:
		return r.intoCurrent(op, "Juggler: set aside to pull "+upstream, nil, "merge", "--no-edit", upstream)
	case PullRebase:
		if err := r.refuseTrackedChanges(op); err != nil {
			return Result{}, err
		}
		return r.intoCurrent(op, "Juggler: set aside to pull "+upstream, nil, "rebase", upstream)
	case "":
	default:
		return Result{}, refused(msg.NewError("Unknown way to pull: {mode}", "mode", op.Mode))
	}

	head := r.headSha()
	to, err := r.rev(upstream)
	if err != nil {
		return Result{}, err
	}
	if _, ahead, err := r.ask("merge-base", "--is-ancestor", to, head); err != nil || ahead {
		// Up to date, or only ahead: nothing to bring in.
		return Result{Head: head}, err
	}
	if _, behind, err := r.ask("merge-base", "--is-ancestor", head, to); err != nil || !behind {
		if err != nil {
			return Result{}, err
		}
		return Result{}, &DivergedError{Prefer: r.pullPrefers(branch), Err: msg.NewError(
			"{branch} and {upstream} have both moved on: it can't be fast-forwarded. Merge or rebase instead.",
			"branch", branch, "upstream", upstream)}
	}
	return r.intoCurrent(op, "Juggler: set aside to pull "+upstream, nil, "merge", "--ff-only", upstream)
}

// pullPrefers is how the repository says a pull should integrate: "rebase"
// when branch.<name>.rebase, or failing that pull.rebase, says to rebase in any
// of its ways, else "merge".
func (r *runner) pullPrefers(branch string) string {
	v, ok, _ := r.ask("config", "--get", "branch."+branch+".rebase")
	if !ok {
		v, _, _ = r.ask("config", "--get", "pull.rebase")
	}
	switch strings.ToLower(v) {
	case "", "false", "no", "off", "0":
		return PullMerge
	}
	return PullRebase
}

// pushRemote is the remote a push goes to: the one the client named, which must
// be one; then the branch's pushRemote, remote.pushDefault, and — for a branch
// already tracking one — its upstream's remote; then the only remote, or
// origin. With several and none of those, the client is asked
// (RemoteNeededError). Branch "" is a push of no branch: a tag.
func (r *runner) pushRemote(branch, named string, publish bool) (string, error) {
	all, err := r.remotes()
	if err != nil {
		return "", err
	}
	if named != "" {
		if !slices.Contains(all, named) {
			return "", refused(msg.NewError("{remote} is not a remote of this repository.", "remote", named))
		}
		return named, nil
	}
	candidates := []string{}
	if branch != "" {
		candidates = append(candidates, r.config("branch."+branch+".pushRemote"))
	}
	candidates = append(candidates, r.config("remote.pushDefault"))
	if branch != "" && !publish {
		candidates = append(candidates, r.config("branch."+branch+".remote"))
	}
	for _, c := range candidates {
		if c != "" && slices.Contains(all, c) {
			return c, nil
		}
	}
	switch {
	case len(all) == 0:
		return "", refused(msg.NewError("This repository has no remote to push to."))
	case len(all) == 1:
		return all[0], nil
	case slices.Contains(all, "origin"):
		return "origin", nil
	}
	return "", &RemoteNeededError{Remotes: all, Err: msg.NewError("Which remote should this go to?")}
}

// push sends a branch to its upstream, or publishes one that has none: to the
// remote pushRemote finds, setting it as the upstream. Force replaces what the
// remote has, and only if that is still ExpectSha.
func push(r *runner, op Op) (Result, error) {
	branch := op.Branch
	if branch == "" {
		var err error
		if branch, err = r.currentBranch(); err != nil {
			return Result{}, err
		}
	} else if err := r.branchName(branch); err != nil {
		return Result{}, err
	}
	if _, err := r.rev("refs/heads/" + branch); err != nil {
		return Result{}, err
	}
	tracking := r.config("branch." + branch + ".remote")
	merge := r.config("branch." + branch + ".merge")
	if tracking == "." {
		return Result{}, refused(msg.NewError("{branch} tracks a local branch: there is nothing to push it to.", "branch", branch))
	}
	publish := tracking == "" || merge == ""
	remote, err := r.pushRemote(branch, op.Remote, publish)
	if err != nil {
		return Result{}, err
	}
	dest := "refs/heads/" + branch
	if !publish && remote == tracking {
		dest = merge
	}
	args := []string{"push", "--porcelain", "--progress"}
	if publish {
		args = append(args, "-u")
	}
	if op.Force {
		if !isSha(op.ExpectSha) {
			return Result{}, refused(msg.NewError("A forced push needs the sha the remote was seen at."))
		}
		args = append(args, "--force-with-lease="+dest+":"+op.ExpectSha)
	}
	args = append(args, remote, "refs/heads/"+branch+":"+dest)
	return Result{}, r.pushRefs(remote, args...)
}

func pushTag(r *runner, op Op) (Result, error) {
	if err := r.tagName(op.Name); err != nil {
		return Result{}, err
	}
	ref := "refs/tags/" + op.Name
	if _, ok, err := r.ask("rev-parse", "-q", "--verify", ref); err != nil || !ok {
		if err != nil {
			return Result{}, err
		}
		return Result{}, refused(msg.NewError("There is no tag {name}.", "name", op.Name))
	}
	remote, err := r.pushRemote("", op.Remote, true)
	if err != nil {
		return Result{}, err
	}
	return Result{}, r.pushRefs(remote, "push", "--porcelain", "--progress", remote, ref+":"+ref)
}

// remoteBranchDelete deletes a branch from its remote, named by its
// remote-tracking ref, and only while the remote still has it at ExpectSha.
func remoteBranchDelete(r *runner, op Op) (Result, error) {
	all, err := r.remotes()
	if err != nil {
		return Result{}, err
	}
	remote, branch := "", ""
	for _, name := range all {
		if rest, ok := strings.CutPrefix(op.Ref, name+"/"); ok && len(name) > len(remote) {
			remote, branch = name, rest
		}
	}
	if remote == "" {
		return Result{}, refused(msg.NewError("{ref} is not a branch of any remote.", "ref", op.Ref))
	}
	if err := r.branchName(branch); err != nil {
		return Result{}, err
	}
	if !isSha(op.ExpectSha) {
		return Result{}, refused(msg.NewError("No expected value was given for {name}.", "name", op.Ref))
	}
	dest := "refs/heads/" + branch
	err = r.pushRefs(remote, "push", "--porcelain", "--progress", "--force-with-lease="+dest+":"+op.ExpectSha, remote, ":"+dest)
	if err != nil {
		return Result{}, err
	}
	return Result{Sha: op.ExpectSha}, nil
}

// pushRefs runs a push and tells its refusals apart by the lines --porcelain
// prints for each ref: `!<tab>src:dst<tab>[rejected] (reason)`. A lease the
// remote has moved past is "stale info", and the client must look again; any
// other is a RejectedError.
func (r *runner) pushRefs(remote string, args ...string) error {
	out, err := r.netGit(false, args...)
	if err == nil {
		return nil
	}
	var refs []string
	reason, stale := "", false
	for line := range strings.Lines(string(out)) {
		fields := strings.SplitN(strings.TrimRight(line, "\r\n"), "\t", 3)
		if len(fields) < 3 || fields[0] != "!" {
			continue
		}
		_, dst, _ := strings.Cut(fields[1], ":")
		why := fields[2]
		if open := strings.Index(why, "("); open >= 0 && strings.HasSuffix(why, ")") {
			why = why[open+1 : len(why)-1]
		}
		if why == "stale info" {
			stale = true
		}
		if reason == "" {
			reason = why
		}
		refs = append(refs, dst)
	}
	switch {
	case stale:
		return &StaleError{Err: msg.NewError("{ref} on {remote} has moved since it was shown. Fetch and look again.",
			"ref", strings.TrimPrefix(refs[0], "refs/heads/"), "remote", remote)}
	case len(refs) > 0:
		return &RejectedError{Refs: refs, Reason: reason, Err: msg.NewError(
			"{remote} turned the push down ({reason}). Pull first, or force it with a lease.",
			"remote", remote, "reason", reason)}
	}
	return err
}

// refuseTrackedChanges refuses a rebase with tracked changes about, which git
// would refuse anyway, unless they are to be set aside.
func (r *runner) refuseTrackedChanges(op Op) error {
	if op.Dirty == DirtyStash {
		return nil
	}
	changes, _, err := r.ask("status", "--porcelain", "-uno")
	if err != nil {
		return err
	}
	if changes != "" {
		return dirtyError()
	}
	return nil
}
