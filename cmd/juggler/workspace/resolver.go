//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package workspace

import (
	"fmt"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
)

// Resolver turns a conversation's workspace id into the Workspace it names.
//
// Every caller asks through one, so the answer cannot differ between them: an
// operation from the engine, the git card, "@" completion and the directory a
// provider's CLI is spawned in all see the same tree, or the same refusal. A
// turn that refuses to run is far better than one that runs somewhere else.
//
// Resolution never involves the extension that created a workspace. Everything
// it needs is on the server's own row, so a disabled or broken extension cannot
// strand the conversations bound to the workspaces it made.
type Resolver struct {
	project func() string
	lookup  core.WorkspaceLookup
	index   func() ops.PathSearcher
}

// NewResolver builds a Resolver over the live project path, the session's
// workspace table and the project's path index. Each is read on every Resolve,
// so a project switch or a workspace registered a moment ago is seen without
// rebuilding anything. lookup may be nil in a server with no session, in which
// case only the project resolves; index may be nil, in which case the project's
// "@" search is a prefix scan only.
func NewResolver(project func() string, lookup core.WorkspaceLookup, index func() ops.PathSearcher) *Resolver {
	return &Resolver{project: project, lookup: lookup, index: index}
}

// Resolve returns the workspace an id names, or the reason it cannot be worked
// in.
//
// No id at all is the project; with no
// project open it is a project rooted nowhere (Root ""), which every caller that
// needs a tree already checks for. Any other id is put to
// core.WorkspaceLookup.Usable, which owns the refusals — still provisioning,
// closed, root gone, never registered — and is never answered with the
// project: a stale binding that silently ran in the project root would edit the
// wrong tree, and look exactly like working. A usable row is then opened by
// openRow, which refuses one it cannot open. Whatever opens as the project's
// tree is handed the project's index.
func (r *Resolver) Resolve(id string) (Workspace, error) {
	project := r.project()
	if id == core.DefaultWorkspaceID {
		return r.withIndex(&local{root: project, isProject: true}), nil
	}
	if r.lookup == nil {
		return nil, fmt.Errorf("no session is loaded, so workspace %s cannot be resolved", id)
	}
	row, err := r.lookup.Usable(id)
	if err != nil {
		return nil, err
	}
	ws, err := openRow(row, project)
	if err != nil {
		return nil, err
	}
	if w, ok := ws.(*local); ok {
		r.withIndex(w)
	}
	return ws, nil
}

// withIndex gives the project's tree the project's path index.
func (r *Resolver) withIndex(w *local) *local {
	if w.isProject && r.index != nil {
		w.index = r.index()
	}
	return w
}

// Row is a workspace table row as the browser is handed it: the stored row, and
// what the workspace it opens to can do, which the stored row does not say.
type Row struct {
	core.Workspace

	// HostsLocalProviders is whether a provider Juggler spawns as a subprocess —
	// a CLI agent — can run in this workspace: whether it has a LocalDir. It is
	// what lets the model picker refuse the pairing rather than let a user
	// discover it through a turn that ran on the wrong machine. False for a row
	// that opens to no workspace at all.
	HostsLocalProviders bool `json:"hostsLocalProviders"`
}

// Describe answers each row with what its workspace can do, keeping the table's
// order. It asks the workspace the row opens to rather than its state, so a row
// still being provisioned is described as it will be once ready.
func Describe(rows []core.Workspace) []Row {
	described := make([]Row, 0, len(rows))
	for _, row := range rows {
		d := Row{Workspace: row}
		if ws, err := openRow(row, ""); err == nil {
			_, d.HostsLocalProviders = ws.LocalDir()
		}
		described = append(described, d)
	}
	return described
}
