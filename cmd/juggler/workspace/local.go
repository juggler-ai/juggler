//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package workspace

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/ops"
)

// local is a tree on the machine the server runs on: the project, or a
// workspace registered against it. Its root is a directory here, so every
// method is the ops package, the filesystem or gitview applied to it.
type local struct {
	id   string
	name string
	root string

	// isProject is set for the project's own tree — the project itself, or a
	// workspace that works in it (a group) — whose tools are bounded by the
	// project alone, whose "@" search is answered by the project's index, and
	// which goes unnamed. It is decided in one place: Resolve for the project,
	// openRow for a row.
	isProject bool

	// projectRoot is the project a workspace belongs to. Its tools may READ
	// there; they are still rooted at the workspace.
	projectRoot string

	// index is the project's path index, or nil when there is none (no file
	// watcher). Only the project's tree has one.
	index ops.PathSearcher
}

// openRow opens a registered row as the tree on this machine it describes.
//
// A row of a kind this server cannot open is refused (core.Workspace.OpenError,
// which owns what a kind means), never served as if it were this machine. It
// does not judge whether the row may be worked in — that is
// core.WorkspaceLookup.Usable's, which Resolve asks first.
//
// A row rooted at the project itself (a group) opens as the project's tree, in
// every respect but its id: see local.isProject. Its root is the project path
// as the project spells it, so the two cannot differ by a trailing separator.
func openRow(row core.Workspace, project string) (Workspace, error) {
	if err := row.OpenError(); err != nil {
		return nil, err
	}
	if project != "" && filepath.Clean(row.Root) == filepath.Clean(project) {
		return &local{id: row.ID, root: project, isProject: true}, nil
	}
	return &local{id: row.ID, name: row.Name(), root: row.Root, projectRoot: project}, nil
}

// ID is "" for the project.
func (w *local) ID() string { return w.id }

// Root is a directory on this machine.
func (w *local) Root() string { return w.root }

// Name is the label of a tree of its own; see Workspace.Name.
func (w *local) Name() string { return w.name }

// LocalDir is the root itself: a local tree can host anything this machine can
// run.
func (w *local) LocalDir() (string, bool) { return w.root, true }

// scope is the path boundary an operation here is confined to.
//
// A workspace roots the scope at the workspace and widens the READ boundary with
// the project. A conversation working in a worktree still needs to read the tree
// it branched from — to diff against it, to read a doc that only exists on the
// main branch — and refusing that would make the feature's first hour
// miserable. Writes are unaffected: they are gated by approval, not by the scope
// (see PathScope.Sanitize). The project joins the allowed roots so reads can
// reach it; the scope is still ROOTED at the workspace, which is what confines a
// shell's cwd (ops.validateCwd consults the root alone).
func (w *local) scope(allowedPaths []string) ops.PathScope {
	if w.isProject {
		return ops.NewPathScope(w.root, allowedPaths)
	}
	allowed := append(append([]string{}, allowedPaths...), w.projectRoot)
	return ops.NewPathScope(w.root, allowed).WithProjectRoot(w.projectRoot)
}

// Operations builds the registered handler for a tool over this tree's scope.
func (w *local) Operations(toolID string, allowedPaths []string) (ops.Operations, error) {
	factory, err := ops.GetGlobal(toolID)
	if err != nil {
		return nil, err
	}
	return factory(w.scope(allowedPaths)), nil
}

// StreamShell runs the command under this tree's scope, with no allowed-paths
// grant: a streaming command's cwd is confined to the root.
func (w *local) StreamShell(ctx context.Context, req ShellRequest, out chan<- ops.ShellStreamChunk) {
	ops.NewShellOperations(w.scope(nil)).ExecuteStreaming(ctx, req.ShellID, req.ConvID, req.Command, req.Cwd, req.TimeoutMs, out)
}

// SearchFiles answers the project's tree from its index, or walks a workspace
// of its own — which has no index — under the rules the index is built by
// (ops.TreeSearcher).
func (w *local) SearchFiles(ctx context.Context, query string, limit int) ([]ops.FileMatch, error) {
	searcher := w.index
	if !w.isProject {
		searcher = ops.NewTreeSearcher(ctx, w.root)
	}
	return ops.CompleteFiles(ctx, w.root, query, limit, searcher)
}

// CompletePath completes a typed path with "./" anchored at the root.
func (w *local) CompletePath(ctx context.Context, query string, limit int) ([]ops.FileMatch, error) {
	return ops.CompletePath(ctx, query, w.root, limit)
}

// GitStatus is gitview's card over the root.
func (w *local) GitStatus(ctx context.Context) ([]gitview.RepoStatus, error) {
	return gitview.Status(ctx, w.root), nil
}

// GitReview is gitview's manifest of the root.
func (w *local) GitReview(ctx context.Context, scope gitview.Scope) (gitview.Manifest, error) {
	return gitview.Review(ctx, w.root, scope), nil
}

// GitDiff is gitview's diff of one file under the root.
func (w *local) GitDiff(ctx context.Context, req gitview.DiffRequest) (gitview.FileDiff, error) {
	return gitview.Diff(ctx, w.root, req)
}

// Stat describes a path the way a typed "@" mention names one.
func (w *local) Stat(path string) (fs.FileInfo, error) {
	abs := resolveMention(path, w.root)
	if abs == "" {
		return nil, &fs.PathError{Op: "stat", Path: path, Err: fs.ErrNotExist}
	}
	return os.Stat(abs)
}

// resolveMention turns a user-supplied path into an absolute one: "~" is the
// user's home, an absolute path is itself, and anything else is relative to
// root. Empty means there is nothing to look at — a relative path with no root
// to read it against, or a home that cannot be found.
func resolveMention(p, root string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		if p == "~" {
			return home
		}
		return filepath.Join(home, p[2:])
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	if root == "" {
		return ""
	}
	return filepath.Join(root, p)
}

// Open opens a regular file named relative to the root. The path is judged
// lexically: one that is
// absolute, empty or climbs out of the root is refused before anything is
// touched, and symbolic links inside the tree are followed as the filesystem
// follows them.
func (w *local) Open(rel string) (File, error) {
	native := filepath.FromSlash(rel)
	if w.root == "" || !filepath.IsLocal(native) {
		return nil, &fs.PathError{Op: "open", Path: rel, Err: fs.ErrInvalid}
	}
	abs := filepath.Join(w.root, native)
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, &fs.PathError{Op: "open", Path: rel, Err: fmt.Errorf("is a directory")}
	}
	return os.Open(abs) //nolint:gosec // contained to the root above
}
