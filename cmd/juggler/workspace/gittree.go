//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package workspace

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/ops"
)

// The git client's trees.
//
// The git client shows any working tree of a repository it serves, wherever it
// is on disk — a worktree made with the CLI in /tmp included — because it acts
// for the user, who can reach all of them. The agent cannot, and nothing here
// may change that: a tree reached this way is reached only through GitTrees,
// which only the git API uses, and it refuses every one of the agent's tools.
//
// Such a tree is named by an id the worktree read mints (see Annotate): "wt:"
// and the base64url of the workspace it was found from, the repository there,
// and its path. Resolving the id asks git again whether the path is one of that
// repository's worktrees, so an id forged or kept past the tree's removal names
// nothing. Everywhere else the id is just a workspace id — the git watch, the
// job routes and a pin's config carry it unchanged.

const gitTreePrefix = "wt:"

// gitTreeClock bounds the git command that checks a tree id: resolving has no
// context of its own to inherit one from.
const gitTreeClock = 10 * time.Second

// gitTreeRef is what a git-only tree id holds.
type gitTreeRef struct {
	Anchor string `json:"w"` // the workspace the tree was found from; "" is the project
	Repo   string `json:"r"` // the repository there, as the API names it
	Path   string `json:"p"` // the tree, absolute
}

// WorktreeID is the id that views the worktree at path of the repository repo
// of the workspace anchor. The path is stored with its symbolic links
// resolved, so that one tree has one id however it was spelt.
func WorktreeID(anchor, repo, path string) string {
	b, _ := json.Marshal(gitTreeRef{Anchor: anchor, Repo: repo, Path: gitview.RealPath(path)})
	return gitTreePrefix + base64.RawURLEncoding.EncodeToString(b)
}

// IsWorktreeID reports whether id is a git-only tree id rather than a
// workspace's.
func IsWorktreeID(id string) bool {
	return strings.HasPrefix(id, gitTreePrefix)
}

func parseWorktreeID(id string) (gitTreeRef, error) {
	var ref gitTreeRef
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(id, gitTreePrefix))
	if err != nil || json.Unmarshal(raw, &ref) != nil || ref.Path == "" || IsWorktreeID(ref.Anchor) {
		return gitTreeRef{}, msg.NewError("Not a worktree this project can show.")
	}
	return ref, nil
}

// GitTrees is the git surface's resolver: Resolve for every id it is given, and
// the git-only trees besides. Rows is the session's workspace table, read when
// the worktree read is annotated; nil for none.
type GitTrees struct {
	Resolve ResolveFunc
	Rows    func() []core.Workspace
}

// ResolveGit returns the tree an id names for the git surface: a git-only tree
// for a worktree id, and what Resolve says for any other.
func (g GitTrees) ResolveGit(id string) (Workspace, error) {
	if !IsWorktreeID(id) {
		return g.Resolve(id)
	}
	ref, err := parseWorktreeID(id)
	if err != nil {
		return nil, err
	}
	anchor, err := g.anchor(ref.Anchor)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitTreeClock)
	defer cancel()
	list, err := gitview.ListWorktrees(ctx, anchor.root, ref.Repo)
	if err != nil {
		return nil, err
	}
	want := gitview.RealPath(ref.Path)
	for _, t := range list.Trees {
		if t.Path == want && !t.Prunable && !t.Bare {
			return &gitTree{local: &local{id: id, name: filepath.Base(t.Path), root: t.Path, projectRoot: anchor.project(), git: anchor.git, queue: anchor.queue, graphs: anchor.graphs, convs: anchor.convs}}, nil
		}
	}
	return nil, msg.NewError("{path} is no longer a worktree of this repository.", "path", ref.Path)
}

// anchor resolves the workspace a git-only tree was found from, which has to
// be a tree on this machine.
func (g GitTrees) anchor(id string) (*local, error) {
	ws, err := g.Resolve(id)
	if err != nil {
		return nil, err
	}
	l, ok := ws.(*local)
	if !ok || l.root == "" {
		return nil, msg.NewError("Not a worktree this project can show.")
	}
	return l, nil
}

// Annotate names each tree of a worktree read by the id that views it, and the
// open workspace rows rooted there. read is the id of the tree the read was
// made in.
//
// The anchor's own tree is named by the anchor's id, so that viewing it is the
// same as viewing the workspace — at the nested repository the read was made
// in, when it was made in one, which is TreeRepo; any other is a git-only tree
// id anchored where the anchor is, viewed at its root. A tree that cannot be
// viewed — prunable, bare, or found through a repository nested in a git-only
// tree, which no id can name — has no Tree.
func (g GitTrees) Annotate(read string, w *gitview.Worktrees) {
	anchorID, repo := read, w.Repo
	if IsWorktreeID(read) {
		ref, err := parseWorktreeID(read)
		if err != nil || w.Repo != "" {
			anchorID = ""
			repo = "\x00" // nothing can be named
		} else {
			anchorID, repo = ref.Anchor, ref.Repo
		}
	}
	anchorDir := ""
	if repo != "\x00" {
		if anchor, err := g.anchor(anchorID); err == nil {
			anchorDir = gitview.RealPath(filepath.Join(anchor.root, filepath.FromSlash(repo)))
		}
	}
	var rows []core.Workspace
	if g.Rows != nil {
		rows = g.Rows()
	}
	for i := range w.Trees {
		t := &w.Trees[i]
		for _, row := range rows {
			if row.State != core.WorkspaceStateClosed && row.Root != "" && gitview.RealPath(row.Root) == t.Path {
				t.Rows = append(t.Rows, row.ID)
			}
		}
		if anchorDir == "" || t.Prunable || t.Bare {
			continue
		}
		id := anchorID
		if t.Path != anchorDir {
			id = WorktreeID(anchorID, repo, t.Path)
		} else {
			t.TreeRepo = repo
		}
		t.Tree = &id
	}
}

// gitTree is a working tree only the git client reaches: everything local does
// for git, and nothing for the agent.
type gitTree struct{ *local }

func (g *gitTree) refusal() error {
	return msg.NewError("Only the git client works in {path}: it is not a workspace.", "path", g.root)
}

// LocalDir is none: no provider is spawned in a tree no conversation is in.
func (g *gitTree) LocalDir() (string, bool) { return "", false }

// Operations refuses every tool.
func (g *gitTree) Operations(string, []string) (ops.Operations, error) { return nil, g.refusal() }

// StreamShell refuses the command and closes the stream.
func (g *gitTree) StreamShell(_ context.Context, req ShellRequest, out chan<- ops.ShellStreamChunk) {
	out <- ops.ShellStreamChunk{ShellID: req.ShellID, Done: true, Blocked: true, ExitCode: -1, Error: g.refusal().Error()}
	close(out)
}

// SearchFiles refuses.
func (g *gitTree) SearchFiles(context.Context, string, int) ([]ops.FileMatch, error) {
	return nil, g.refusal()
}

// CompletePath refuses.
func (g *gitTree) CompletePath(context.Context, string, int) ([]ops.FileMatch, error) {
	return nil, g.refusal()
}

// Stat refuses.
func (g *gitTree) Stat(path string) (fs.FileInfo, error) {
	return nil, &fs.PathError{Op: "stat", Path: path, Err: errors.Join(fs.ErrPermission, g.refusal())}
}

// Open refuses.
func (g *gitTree) Open(rel string) (File, error) {
	return nil, &fs.PathError{Op: "open", Path: rel, Err: errors.Join(fs.ErrPermission, g.refusal())}
}
