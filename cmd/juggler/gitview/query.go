//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"

	"juggler/cmd/juggler/msg"
)

// Query is one read of the git client: which of its places it is for, and the
// repository within the tree it reads ("" for the tree's own). Every read the
// client makes is a Query, so a Workspace answers all of them through one
// method and a new place is a new kind rather than a new method.
type Query struct {
	Kind string `json:"kind"`
	Repo string `json:"repo"`

	// Log is what a log read asks for (QueryLog), Commit the commit a commit
	// read names (QueryCommit), a revision as git spells one, and Blame the
	// file a blame read is of (QueryBlame), Attribution what an attribution
	// read scores (QueryAttribution), and CommitContext the commit a
	// commit-context read describes (QueryCommitContext), and Ref the full
	// ref name a stranded read asks about (QueryStranded).
	Log           LogQuery           `json:"log"`
	Commit        string             `json:"commit,omitempty"`
	Ref           string             `json:"ref,omitempty"`
	Blame         BlameQuery         `json:"blame"`
	Attribution   AttributionQuery   `json:"attribution"`
	CommitContext CommitContextQuery `json:"commitContext"`
}

// AttributionQuery is what an attribution read scores: the files staged for a
// commit made now, or for an amend of HEAD when Amend is set. Conv is the
// conversation the asker is looking at, which only breaks ties between
// conversations that account for as much as each other.
type AttributionQuery struct {
	Amend bool   `json:"amend,omitempty"`
	Conv  string `json:"conv,omitempty"`
}

// The kinds of Query.
const (
	QueryChanges    = "changes"    // the Changes place: answered with a Changes
	QueryRefs       = "refs"       // the Refs place's branches, remotes, tags and stashes: a Refs
	QueryWorktrees  = "worktrees"  // every working tree of the repository: a Worktrees
	QueryRepository = "repository" // where the repository keeps its state: a Repository
	QueryLog        = "log"        // one page of the History place's commits: a LogPage, answered by Graphs
	QueryCommit     = "commit"     // one commit as History's detail shows it: a Commit
	QuerySubmodules = "submodules" // the repository's submodules and where each is checked out: a Submodules
	QueryBlame      = "blame"      // which commit last changed each line of one file: a Blame
	QueryStranded   = "stranded"   // the commits only one ref reaches, which deleting it leaves unreachable: a Stranded

	// QueryAttribution is which of the project's conversations made the staged
	// changes, best match first: a gitattr.Attribution, answered by the tree
	// from the project's attribution index (staged files: ReadStaged).
	QueryAttribution = "attribution"

	// QueryCommitContext is what a commit message for the staged changes is
	// written from — their diff cut to a budget, recent subjects, the
	// repository's commit rules: a CommitContext.
	QueryCommitContext = "commit-context"
)

// Repository is where a repository keeps its state, as GitDirs names it. Its
// CommonDir is what every tree of the repository shares, and so what tells two
// trees of one repository from trees of two.
type Repository struct {
	GitDir    string `json:"gitDir"`
	CommonDir string `json:"commonDir"`
}

// ReadRepository names the directories of the repository repo under root.
func ReadRepository(ctx context.Context, root, repo string) (Repository, error) {
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return Repository{}, err
	}
	gitDir, common, err := GitDirs(ctx, dir)
	if err != nil {
		return Repository{}, err
	}
	return Repository{GitDir: gitDir, CommonDir: common}, nil
}

// Read answers a query about the tree at root. A kind it does not know is a
// *RequestError, as is any refusal of the repository it names.
func Read(ctx context.Context, root string, q Query) (any, error) {
	switch q.Kind {
	case QueryChanges:
		return ReadChanges(ctx, root, q.Repo)
	case QueryRefs:
		return ReadRefs(ctx, root, q.Repo)
	case QueryWorktrees:
		return ReadWorktrees(ctx, root, q.Repo)
	case QueryRepository:
		return ReadRepository(ctx, root, q.Repo)
	case QueryCommit:
		return ReadCommit(ctx, root, q.Repo, q.Commit)
	case QuerySubmodules:
		return ReadSubmodules(ctx, root, q.Repo)
	case QueryBlame:
		return ReadBlame(ctx, root, q.Repo, q.Blame)
	case QueryStranded:
		return ReadStranded(ctx, root, q.Repo, q.Ref)
	case QueryCommitContext:
		return ReadCommitContext(ctx, root, q.Repo, q.CommitContext)
	}
	return nil, &RequestError{msg.NewError("Unknown git read: {kind}", "kind", q.Kind)}
}
