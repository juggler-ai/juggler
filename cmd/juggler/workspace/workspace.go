//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package workspace is the one way the server reaches the tree a conversation
// works in: the project itself, or a workspace registered against it.
//
// Every caller that acts on a conversation's tree — the agent's tool
// operations, its streaming shell, "@" completion, the git views, the directory
// a CLI provider is spawned in, the sandbox's module imports — resolves the
// conversation's workspace id to a Workspace and asks it, rather than resolving
// a root and treating that as a path on this machine. A Workspace's Root is a
// name in its own terms; the one thing that may be done with it as a local
// directory is what LocalDir hands out, and LocalDir is allowed to have nothing
// to hand out.
//
// The methods come in two layers. The bulk operations — Operations,
// StreamShell, SearchFiles, CompletePath and the three git views — are the
// ones whose cost is in touching many files, so a Workspace performs them
// beside the files rather than having them assembled out of single reads by the
// caller. The primitives, Stat and Open, are the single-file reads a caller
// makes itself.
package workspace

import (
	"context"
	"io"
	"io/fs"

	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/ops"
)

// Workspace is the tree a conversation works in, and everything the server
// does there.
type Workspace interface {
	// ID is the workspace's id: "" for the project itself.
	ID() string

	// Root is the tree's root in the workspace's own terms — what an answer
	// about the tree says it describes, and what a path the model or a URL
	// wrote is matched against. It is "" for the project when no project is
	// open.
	Root() string

	// Name is what to call the tree in an answer about it: the workspace's
	// label when it is a tree of its own, and "" when it is the project's
	// tree — the project itself, or a workspace that works in the project.
	Name() string

	// LocalDir is the directory on this machine where a process may be
	// started to work in this tree, and false when there is none. A CLI
	// provider is spawned there, so false is also the answer to whether this
	// workspace can host one (see Row.HostsLocalProviders).
	LocalDir() (string, bool)

	// Operations builds the handler for one of the agent's tools, confined to
	// this tree and widened by the caller's standing allowed-paths grant.
	Operations(toolID string, allowedPaths []string) (ops.Operations, error)

	// StreamShell runs one streaming shell command here, sending its output to
	// out and closing out when the command is over, refusal included.
	StreamShell(ctx context.Context, req ShellRequest, out chan<- ops.ShellStreamChunk)

	// SearchFiles answers "@" completion: entries anywhere in the tree whose
	// names match query, root-relative.
	SearchFiles(ctx context.Context, query string, limit int) ([]ops.FileMatch, error)

	// CompletePath completes a typed path: an absolute one, a "~" one, or a
	// "./" one anchored at Root.
	CompletePath(ctx context.Context, query string, limit int) ([]ops.FileMatch, error)

	// GitStatus is the status card's view of every repository in the tree.
	GitStatus(ctx context.Context) ([]gitview.RepoStatus, error)

	// GitReview is the review's complete manifest of the tree's changes within
	// a scope (see gitview.ParseScope; the zero Scope is the working tree
	// against HEAD).
	GitReview(ctx context.Context, scope gitview.Scope) (gitview.Manifest, error)

	// GitDiff is one file's diff. A refusal of the request itself is a
	// *gitview.RequestError.
	GitDiff(ctx context.Context, req gitview.DiffRequest) (gitview.FileDiff, error)

	// Stat describes one path: relative to Root, absolute, or under "~".
	Stat(path string) (fs.FileInfo, error)

	// Open opens one regular file for reading, by a path relative to Root. A
	// path that leaves the tree is refused.
	Open(rel string) (File, error)
}

// ShellRequest is one streaming shell command: the shell the engine is waiting
// on, the conversation that owns it, and what to run where and for how long.
// Cwd is validated against the workspace's root.
type ShellRequest struct {
	ShellID   string
	ConvID    string
	Command   string
	Cwd       string
	TimeoutMs int
}

// File is an open file a caller can stream, seek in and describe — what
// http.ServeContent needs.
type File interface {
	io.ReadSeekCloser
	Stat() (fs.FileInfo, error)
}

// ResolveFunc resolves a workspace id to the workspace it names, or says why it
// cannot be worked in. Handlers are given one rather than a Resolver, so a test
// can hand them any Workspace at all.
type ResolveFunc func(id string) (Workspace, error)
