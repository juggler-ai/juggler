//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"juggler/cmd/juggler/gitattr"
	"juggler/cmd/juggler/gitops"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/jobs"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/server/handlers"
)

// The git tool: the git client's reads and writes, as operations of the tool
// "git" in the server's ops table (Server.opsTable).
//
// It is ClientOnly — the git client acts for the user, so the agent's tool
// calls never reach it (handlers.OpsAPI) — and AnyTree, so it also runs in the
// worktrees no workspace names that the git client shows
// (workspace.GitTrees). Its operations, each in the workspace the call names:
//
//   - status {}: the status card's view, gitStatusAnswer.
//
// The dispatcher refuses every call when no project is open, and so does the
// tool when a tree has no root.
//   - review {scope, conv}: the review's manifest (gitview.Review), with the
//     tree it describes.
//   - diff {repo, path, context, scope, conv}: one file's diff (gitview.Diff).
//   - read {kind, repo, …}: one of the client's reads (gitReadParams).
//   - run {op}: starts one write (a gitops.Op) as a job (git_jobs.go) and
//     answers with the job at once.
//   - fetchOnShow {repo}: the fetch the pin asks for the first time it shows a
//     repository, gitFetchOnShowAnswer.
//   - digest {conv, repo, paths}: what a conversation says about why some
//     files changed (git_digest.go).
//
// A refusal of the request itself is an error like any other failure; the
// message says which.

// gitToolID is the git tool's id on the wire.
const gitToolID = "git"

// gitStatusAnswer is the git tool's status: the tree it describes, its name
// (see workspace.Workspace.Name) and its repositories.
type gitStatusAnswer struct {
	Root      string               `json:"root"`
	Workspace string               `json:"workspace,omitempty"`
	Repos     []gitview.RepoStatus `json:"repos"`
}

// gitReviewAnswer is the git tool's review: the tree it describes, then the
// manifest itself.
type gitReviewAnswer struct {
	Root      string `json:"root"`
	Workspace string `json:"workspace,omitempty"`
	gitview.Manifest
}

// gitReadParams are a read's parameters: Kind picks the read (see
// gitview.Read), and the rest are each read's own — a log's the rest of a
// gitview.LogQuery, a commit's Commit, a blame's Path and Rev, an
// attribution's Amend and Conv, a stranded read's Ref, a commit-context's
// Amend.
type gitReadParams struct {
	Kind     string `json:"kind"`
	Repo     string `json:"repo"`
	Commit   string `json:"commit"`
	Path     string `json:"path"`
	Rev      string `json:"rev"`
	Amend    bool   `json:"amend"`
	Conv     string `json:"conv"`
	Ref      string `json:"ref"`
	Graph    string `json:"graph"`
	Scope    string `json:"scope"`
	Message  string `json:"message"`
	Author   string `json:"author"`
	Refresh  bool   `json:"refresh"`
	Find     string `json:"find"`
	Worktree bool   `json:"worktree"`
	Offset   int    `json:"offset"`
	Limit    int    `json:"limit"`
}

// query is the gitview.Query the parameters ask.
func (p gitReadParams) query() gitview.Query {
	q := gitview.Query{Kind: p.Kind, Repo: p.Repo, Commit: p.Commit}
	switch p.Kind {
	case gitview.QueryBlame:
		q.Blame = gitview.BlameQuery{Path: p.Path, Rev: p.Rev}
	case gitview.QueryAttribution:
		q.Attribution = gitview.AttributionQuery{Amend: p.Amend, Conv: p.Conv}
	case gitview.QueryStranded:
		q.Ref = p.Ref
	case gitview.QueryCommitContext:
		q.CommitContext = gitview.CommitContextQuery{Amend: p.Amend}
	case gitview.QueryLog:
		q.Log = gitview.LogQuery{
			Graph: p.Graph, Scope: p.Scope, Ref: p.Ref, Message: p.Message, Author: p.Author, Path: p.Path,
			Refresh: p.Refresh, Find: p.Find, Worktree: p.Worktree, Offset: p.Offset, Limit: p.Limit,
		}
	}
	return q
}

// newOpsAPI is the server's ops dispatcher: the workspaces for every tool, the
// server's own tools over the process-wide ones, and the git surface's wider
// resolver for an AnyTree tool the client calls (see handlers.OpsAPI).
func (s *Server) newOpsAPI() *handlers.OpsAPI {
	return handlers.NewOpsAPI(s.Workspaces().Resolve).WithTable(s.opsTable()).WithClientTrees(s.gitResolve)
}

// opsTable is the server's own tools, over the process-wide ones: those whose
// handlers close over this server — the git tool.
func (s *Server) opsTable() *ops.Table {
	table := ops.NewTable()
	s.registerGitTool(table)
	return table
}

// registerGitTool adds the git tool to the server's ops table.
func (s *Server) registerGitTool(table *ops.Table) {
	table.Register(gitToolID, ops.Registration{
		Factory:    func(scope ops.PathScope) ops.Operations { return gitTool{s: s, scope: scope} },
		ClientOnly: true,
		AnyTree:    true,
	})
}

// gitTool is the git tool in one tree.
type gitTool struct {
	s     *Server
	scope ops.PathScope
}

// id is the workspace id the call named; root the tree.
func (g gitTool) id() string   { return g.scope.Workspace() }
func (g gitTool) root() string { return g.scope.Root() }

// Execute runs one of the git tool's operations.
func (g gitTool) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	if g.root() == "" {
		return nil, msg.NewError("No project is open")
	}
	switch operation {
	case "status":
		return gitStatusAnswer{Root: g.root(), Workspace: g.name(), Repos: gitview.Status(ctx, g.root())}, nil
	case "review":
		p, err := paramsAs[struct{ Scope, Conv string }](params)
		if err != nil {
			return nil, err
		}
		scope, err := gitview.ParseScope(p.Scope)
		if err != nil {
			return nil, err
		}
		manifest := gitview.Review(ctx, g.root(), scope.WithConversation(p.Conv))
		return gitReviewAnswer{Root: g.root(), Workspace: g.name(), Manifest: manifest}, nil
	case "diff":
		p, err := paramsAs[gitview.DiffRequest](params)
		if err != nil {
			return nil, err
		}
		diff, err := gitview.Diff(ctx, g.root(), p)
		return diff, failed(err, func(detail string) error {
			return msg.NewError("Couldn't read the diff. {detail}", "detail", detail)
		})
	case "read":
		p, err := paramsAs[gitReadParams](params)
		if err != nil {
			return nil, err
		}
		return g.read(ctx, p.query())
	case "run":
		p, err := paramsAs[struct {
			Op gitops.Op `json:"op"`
		}](params)
		if err != nil {
			return nil, err
		}
		job, err := g.s.jobHub().Start(g.s.gitJobSpec(g.id(), g.root(), p.Op, ""))
		if err != nil {
			return nil, msg.NewError("The server is shutting down.")
		}
		return job, nil
	case "fetchOnShow":
		p, err := paramsAs[struct{ Repo string }](params)
		if err != nil {
			return nil, err
		}
		return g.fetchOnShow(ctx, p.Repo)
	case "digest":
		p, err := paramsAs[struct {
			Conv, Repo string
			Paths      []string
		}](params)
		if err != nil {
			return nil, err
		}
		return g.s.gitDigest(g.id(), g.root(), p.Conv, p.Repo, p.Paths)
	}
	return nil, fmt.Errorf("unknown git operation: %s", operation)
}

// name is what to call the tree in an answer: see workspace.Workspace.Name.
func (g gitTool) name() string { return g.scope.Name() }

// read is one of the client's reads: a log, the server's graph store's; an
// attribution, the project's attribution index scored against the project's
// conversations; a worktree read, with its trees named by the ids that view
// them; anything else, gitview's.
func (g gitTool) read(ctx context.Context, q gitview.Query) (any, error) {
	var answer any
	var err error
	switch q.Kind {
	case gitview.QueryAttribution:
		answer, err = gitattr.Read(ctx, gitattr.ForProject(g.scope.ProjectRoot()), g.root(), gitattr.Request{
			Workspace: g.id(), Repo: q.Repo, Amend: q.Attribution.Amend, Visible: q.Attribution.Conv,
		}, conversationDirectory{g.s})
	case gitview.QueryLog:
		graphs := g.s.GitGraphs()
		if graphs == nil {
			return nil, msg.NewError("This server reads no history.")
		}
		answer, err = graphs.Read(ctx, g.root(), q.Repo, q.Log)
	default:
		answer, err = gitview.Read(ctx, g.root(), q)
	}
	if err != nil {
		return nil, failed(err, func(detail string) error {
			return msg.NewError("Couldn't read the repository. {detail}", "detail", detail)
		})
	}
	if trees, ok := answer.(gitview.Worktrees); ok {
		g.s.GitTrees().Annotate(g.id(), &trees)
		answer = trees
	}
	return answer, nil
}

// fetchOnShow starts the fetch the pin asks for the first time it shows a
// repository. The repository is told by its common directory, so every tree of
// it shares the one fetch; the first ask starts it, as an auto job, and every
// later one in this server's life answers skipped.
func (g gitTool) fetchOnShow(ctx context.Context, repoPath string) (gitFetchOnShowAnswer, error) {
	read, err := gitview.Read(ctx, g.root(), gitview.Query{Kind: gitview.QueryRepository, Repo: repoPath})
	if err != nil {
		return gitFetchOnShowAnswer{}, err
	}
	repo, ok := read.(gitview.Repository)
	if !ok || repo.CommonDir == "" {
		return gitFetchOnShowAnswer{}, msg.NewError("The workspace did not say where its repository is.")
	}
	op := gitops.Op{Kind: gitops.OpFetch, Repo: repoPath, Auto: true}
	job, err := g.s.jobHub().Start(g.s.gitJobSpec(g.id(), g.root(), op, "git-fetch-on-show:"+repo.CommonDir))
	switch {
	case errors.Is(err, jobs.ErrStartedBefore):
		return gitFetchOnShowAnswer{Skipped: true}, nil
	case err != nil:
		return gitFetchOnShowAnswer{}, msg.NewError("The server is shutting down.")
	}
	return gitFetchOnShowAnswer{Job: &job}, nil
}

// failed is err as the git tool reports it: a refusal of the request itself
// as it is, any other failure in the words say gives it, with err as its
// detail.
func failed(err error, say func(detail string) error) error {
	var refused *gitview.RequestError
	if err == nil || errors.As(err, &refused) {
		return err
	}
	return say(err.Error())
}

// paramsAs is an operation's parameters as the type that names them, by their
// JSON names (a field with no tag matches its name in any case).
func paramsAs[T any](params map[string]any) (T, error) {
	var out T
	raw, err := json.Marshal(params)
	if err == nil {
		err = json.Unmarshal(raw, &out)
	}
	if err != nil {
		return out, msg.NewError("Invalid request: {detail}", "detail", err.Error())
	}
	return out, nil
}
