//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"slices"

	"juggler/cmd/juggler/gitops"
	"juggler/cmd/juggler/jobs"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/workspace"
)

// The git client's writes, as jobs of kind "git" (jobs.go).
//
// The git tool's run (git_ops.go) starts one write and answers with its job at
// once, whether or not the write will succeed. Everything after — its events, reading
// it back, cancelling it, answering the questions it asks (git_askpass.go) — is
// every job's, through the jobs routes and topic. What is git's is the job's
// detail (gitJobDetail): which write it is, every git command it ran, and what
// a failed one needs for the viewer to offer something instead; and its result,
// a gitops.Result.
//
// The git tool's fetchOnShow is the one write the client makes unasked: the
// first time the pin shows a repository in this server's life, one fetch of it,
// for every tree it has. Its Once key is the repository's common directory, so
// another tree of the same repository, a second pin or a reopened one is told
// it was skipped.

// gitJobKind is the kind of a git write's job.
const gitJobKind = "git"

// gitJobDetail is what a git job says of itself while it runs and once it has
// ended.
type gitJobDetail struct {
	Repo     string        `json:"repo"`
	Op       gitops.OpKind `json:"op"`
	Commands [][]string    `json:"commands"`       // Every git command run so far, as argv after "git"
	Auto     bool          `json:"auto,omitempty"` // Started unasked (fetch-on-show): its failure is quiet

	// What a failed job's error kind needs said with it — which of gitops's
	// refusals it was is the job's Error.Kind ("refused", "stale", "locked",
	// "dirty", "unmerged", "checked-out", "conflicts", "markers", "diverged",
	// "rejected", "remote", "auth" or "published"): LockPath, the lock a
	// "locked" job was stopped by; Branch and Worktree, the branch a refusal
	// was about and, for one checked out elsewhere, the tree that has it out;
	// Prefer, the way into a "diverged" pull the repository puts first
	// ("merge" or "rebase"); Rejected and Reason, the remote refs a "rejected"
	// push was turned down for and git's word for why; Remotes, those a
	// "remote" publish could go to.
	LockPath string   `json:"lockPath,omitempty"`
	Branch   string   `json:"branch,omitempty"`
	Worktree string   `json:"worktree,omitempty"`
	Prefer   string   `json:"prefer,omitempty"`
	Rejected []string `json:"rejected,omitempty"`
	Reason   string   `json:"reason,omitempty"`
	Remotes  []string `json:"remotes,omitempty"`
}

// gitFetchOnShowAnswer is the git tool's fetchOnShow answer: the fetch it
// started, or Skipped when the repository has been fetched on showing before.
type gitFetchOnShowAnswer struct {
	Job     *jobs.Job `json:"job,omitempty"`
	Skipped bool      `json:"skipped,omitempty"`
}

// gitResolve resolves the workspace a git watch or job names.
func (s *Server) gitResolve(id string) (workspace.Workspace, error) {
	if s.gitWatchResolve != nil {
		return s.gitWatchResolve(id)
	}
	return s.GitTrees().ResolveGit(id)
}

// gitJobSpec is the job of one write in the tree at root, started under the
// workspace id wsID; once, when set, is its jobs.Spec.Once.
func (s *Server) gitJobSpec(wsID, root string, op gitops.Op, once string) jobs.Spec {
	return jobs.Spec{
		Kind:      gitJobKind,
		Workspace: wsID,
		Once:      once,
		Detail:    gitJobDetail{Repo: op.Repo, Op: op.Kind, Commands: [][]string{}, Auto: op.Auto},
		Run: func(ctx context.Context, h jobs.Hooks) (any, error) {
			return s.runGitJob(ctx, root, op, h)
		},
	}
}

// gitWrite makes one write to a repository in the tree at root, queued behind
// every other write to the same repository (see gitops.Run, whose typed errors
// it returns) — or a test's script of it, when gitWriteScript is set.
func (s *Server) gitWrite(ctx context.Context, root string, op gitops.Op, hooks gitops.Hooks) (gitops.Result, error) {
	if s.gitWriteScript != nil {
		return s.gitWriteScript(ctx, root, op, hooks)
	}
	queue := s.GitQueue()
	if queue == nil {
		return gitops.Result{}, msg.NewError("This server makes no git writes.")
	}
	if root == "" {
		return gitops.Result{}, msg.NewError("No project is open")
	}
	return gitops.Run(ctx, queue, root, op, hooks)
}

// runGitJob is a git job's work: the write, with everything it reports handed
// to its job.
func (s *Server) runGitJob(ctx context.Context, root string, op gitops.Op, h jobs.Hooks) (gitops.Result, error) {
	var env []string
	if gitops.IsNetwork(op.Kind) {
		var stop func()
		env, stop = s.gitAskpass(op.Auto, h)
		defer stop()
	}
	hooks := gitops.Hooks{
		Command: func(args []string) {
			args = slices.Clone(args)
			updateGitJobDetail(h, func(d *gitJobDetail) {
				d.Commands = append(slices.Clone(d.Commands), args)
			})
		},
		Output: h.Output,
		Progress: func(p gitops.Progress) {
			source := ""
			if p.Remote {
				source = "remote"
			}
			h.Progress(jobs.Progress{
				Phase: p.Phase, Source: source, Percent: p.Percent, Done: p.Done,
				Total: p.Total, Rate: p.Rate, Finished: p.Finished,
			})
		},
		Env: env,
	}
	res, err := s.gitWrite(ctx, root, op, hooks)
	if err == nil || ctx.Err() != nil {
		return res, err
	}
	var said gitJobDetail
	kind := describeGitJobError(&said, err)
	updateGitJobDetail(h, func(d *gitJobDetail) {
		d.LockPath, d.Branch, d.Worktree, d.Prefer = said.LockPath, said.Branch, said.Worktree, said.Prefer
		d.Rejected, d.Reason, d.Remotes = said.Rejected, said.Reason, said.Remotes
	})
	return res, &jobs.Failure{Kind: kind, Message: gitops.FailureText(err), Err: err}
}

// updateGitJobDetail changes a git job's detail through change, on a copy.
func updateGitJobDetail(h jobs.Hooks, change func(*gitJobDetail)) {
	h.Detail(func(old any) any {
		d, _ := old.(gitJobDetail)
		change(&d)
		return d
	})
}

// describeGitJobError says which of gitops's refusals err was, "" for none,
// and fills in what that refusal needs said with it.
func describeGitJobError(d *gitJobDetail, err error) string {
	var refused *gitops.RefusedError
	var stale *gitops.StaleError
	var locked *gitops.LockedError
	var dirty *gitops.DirtyError
	var unmerged *gitops.UnmergedError
	var checkedOut *gitops.CheckedOutError
	var conflicts *gitops.ConflictsError
	var markers *gitops.MarkersError
	var diverged *gitops.DivergedError
	var rejected *gitops.RejectedError
	var remote *gitops.RemoteNeededError
	var auth *gitops.AuthError
	var published *gitops.PublishedError
	switch {
	case errors.As(err, &refused):
		return "refused"
	case errors.As(err, &stale):
		return "stale"
	case errors.As(err, &locked):
		d.LockPath = locked.Path
		return "locked"
	case errors.As(err, &dirty):
		return "dirty"
	case errors.As(err, &unmerged):
		d.Branch = unmerged.Branch
		return "unmerged"
	case errors.As(err, &checkedOut):
		d.Branch, d.Worktree = checkedOut.Branch, checkedOut.Worktree
		return "checked-out"
	case errors.As(err, &conflicts):
		return "conflicts"
	case errors.As(err, &markers):
		return "markers"
	case errors.As(err, &diverged):
		d.Prefer = diverged.Prefer
		return "diverged"
	case errors.As(err, &rejected):
		d.Rejected, d.Reason = slices.Clone(rejected.Refs), rejected.Reason
		return "rejected"
	case errors.As(err, &remote):
		d.Remotes = slices.Clone(remote.Remotes)
		return "remote"
	case errors.As(err, &auth):
		return "auth"
	case errors.As(err, &published):
		return "published"
	}
	return ""
}
