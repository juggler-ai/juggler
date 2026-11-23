//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitops"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
)

// How the git tests put trees in front of the git tool.
//
// A tree is either real — a workspace rooted at a directory that holds a
// repository, whose writes go to gitops on a queue of the test's own — or a
// script: a fake with a GitRun or GitWatch method of its own, which the test
// drives. A script has no directory, so it is served under the root
// "scripted:<id>", and the server's write and watch seams hand anything at
// such a root back to the script.

// scriptedRoot is the root a scripted tree is served under.
const scriptedRoot = "scripted:"

// runScript is a scripted tree's writes.
type runScript interface {
	GitRun(ctx context.Context, op gitops.Op, hooks gitops.Hooks) (gitops.Result, error)
}

// watchScript is a scripted tree's watch.
type watchScript interface {
	GitWatch(ctx context.Context) (<-chan []gitops.Change, error)
}

// scriptedTree serves a script as a workspace rooted at scripted:<id>.
type scriptedTree struct {
	workspace.Workspace
	id string
}

func (t scriptedTree) ID() string               { return t.id }
func (t scriptedTree) Root() string             { return scriptedRoot + t.id }
func (t scriptedTree) Name() string             { return "" }
func (t scriptedTree) LocalDir() (string, bool) { return "", false }

func (t scriptedTree) Operations(reg ops.Registration, allowed []string) (ops.Operations, error) {
	return reg.Factory(ops.NewPathScope(t.Root(), allowed).WithWorkspace(t.id)), nil
}

// scriptGit has the server's git tool, topic and jobs resolve through resolve,
// serving each script there under its scripted root, and writing to every real
// tree on a queue of the test's own.
func scriptGit(t *testing.T, s *Server, resolve workspace.ResolveFunc) {
	t.Helper()
	queue := gitops.NewQueue()
	t.Cleanup(queue.Close)
	s.gitWatchResolve = func(id string) (workspace.Workspace, error) {
		ws, err := resolve(id)
		if err != nil {
			return nil, err
		}
		_, runs := ws.(runScript)
		_, watches := ws.(watchScript)
		if runs || watches {
			return scriptedTree{Workspace: ws, id: id}, nil
		}
		return ws, nil
	}
	script := func(root string) (workspace.Workspace, bool) {
		id, ok := strings.CutPrefix(root, scriptedRoot)
		if !ok {
			return nil, false
		}
		ws, err := resolve(id)
		return ws, err == nil
	}
	s.gitWriteScript = func(ctx context.Context, root string, op gitops.Op, hooks gitops.Hooks) (gitops.Result, error) {
		if ws, ok := script(root); ok {
			if runs, ok := ws.(runScript); ok {
				return runs.GitRun(ctx, op, hooks)
			}
			return gitops.Result{}, errors.New("the script makes no writes")
		}
		return gitops.Run(ctx, queue, root, op, hooks)
	}
	s.gitWatchScript = func(ctx context.Context, root string) (<-chan []gitops.Change, error) {
		if ws, ok := script(root); ok {
			if watches, ok := ws.(watchScript); ok {
				return watches.GitWatch(ctx)
			}
		}
		return nil, errors.New("this tree is not watched")
	}
}

// localTreeAs is the tree on this machine rooted at root, opened as the
// workspace id names — so what the git tool records and starts there is under
// that id, as it is for a workspace the session registered.
func localTreeAs(t *testing.T, id, root string) workspace.Workspace {
	t.Helper()
	ws, err := workspace.NewResolver(func() string { return root }, func(asked string) (core.Workspace, bool) {
		return core.Workspace{ID: id, Kind: core.WorkspaceKindLocal, Root: root, State: core.WorkspaceStateReady}, asked == id
	}, nil).Resolve(id)
	if err != nil {
		t.Fatal(err)
	}
	return ws
}

// callGitTool runs one of the server's git tool's operations in the tree the
// server's git resolver names by workspaceID, as the ops dispatcher builds it
// for the client (whose gates handlers' own tests and
// TestGitToolIsTheClientsAlone cover).
func callGitTool(s *Server, ctx context.Context, workspaceID, operation string, params map[string]any) (any, error) {
	ws, err := s.gitResolve(workspaceID)
	if err != nil {
		return nil, err
	}
	reg, err := s.opsTable().Lookup(gitToolID)
	if err != nil {
		return nil, err
	}
	handler, err := ws.Operations(reg, nil)
	if err != nil {
		return nil, err
	}
	return handler.Execute(ctx, operation, params)
}
