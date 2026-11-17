//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"juggler/cmd/juggler/gitattr"
	"juggler/internal/jlog"
)

// A watched tree also records which shell command changed its files, in the
// project's attribution index (gitattr), so the git client can say which
// conversation made changes that no edit tool reported. A file of the working
// tree that is created or written while shell commands are running in the tree
// is put down to them. The commands are read when the event arrives, since a
// short command has often exited by the time the burst settles. The file is
// hashed when the tree flushes. If exactly one command was running, the record
// is Strong for it. If several were, each gets a Weak record. Nothing is
// recorded while no command runs: the user's own edits belong to no
// conversation.
//
// A version some record already holds is left alone. That is usually the
// record of the edit or write tool that made it (it records the file itself),
// and a shell running beside that tool must not share its file.
//
// A tree records only while it is watched, which means while a git surface is
// showing it.

// maxAttributedPerFlush bounds how many files one flush hashes: a checkout or
// a generator can write thousands, and each costs a git process. The rest of
// such a burst goes unattributed, which only means the git client cannot say
// who made them.
const maxAttributedPerFlush = 256

// ShellCall is one shell command running, as the watcher attributes changes to
// it: the conversation, thread and tool use that started it, the directory it
// runs in, and the workspace it runs in ("" for the project).
type ShellCall struct {
	Conv, Thread, Item string
	Cwd                string
	Workspace          string
}

// RunningShells lists the shell commands running under a project right now. It
// is called on the watcher's goroutine for each working-tree change of a tree
// that records, so it must answer promptly.
type RunningShells func(project string) []ShellCall

// Attribution is what a watched tree records shell changes under: the project
// whose index they go in and the tree's workspace id ("" for the project's).
// No Project records nothing.
type Attribution struct {
	Project   string
	Workspace string
}

// AttributeShells says how the watcher finds the shell commands running in a
// tree. Without it, no tree records anything.
func (w *Watcher) AttributeShells(running RunningShells) {
	w.do(func() { w.running = running })
}

// noteShells records which running shell commands could have changed path. On
// the watcher's goroutine.
func (t *tree) noteShells(path string) {
	if t.attr.Project == "" || t.w.running == nil {
		return
	}
	rel, ok := relWithin(t.root, path)
	if !ok || slices.Contains(strings.Split(rel, "/"), ".git") {
		return
	}
	var calls []ShellCall
	for _, c := range t.w.running(t.attr.Project) {
		if t.runsHere(c) {
			calls = append(calls, c)
		}
	}
	if len(calls) == 0 {
		return
	}
	if t.shellPaths == nil {
		t.shellPaths = map[string][]ShellCall{}
	}
	for _, c := range calls {
		if !slices.Contains(t.shellPaths[path], c) {
			t.shellPaths[path] = append(t.shellPaths[path], c)
		}
	}
}

// runsHere says whether a command runs in the tree: its directory is inside
// the tree, or it runs in the tree's workspace.
func (t *tree) runsHere(c ShellCall) bool {
	if c.Workspace != "" && c.Workspace == t.attr.Workspace {
		return true
	}
	if c.Cwd == "" {
		return false
	}
	cwd := filepath.Clean(c.Cwd)
	for _, root := range []string{t.root, t.realRoot} {
		if cwd == root {
			return true
		}
		if _, ok := relWithin(root, cwd); ok {
			return true
		}
	}
	return false
}

// attributeShells hashes the files shell commands changed since the last
// flush and records them. On the tree's goroutine.
func (t *tree) attributeShells(ctx context.Context) {
	var changed map[string][]ShellCall
	t.w.do(func() {
		changed = t.shellPaths
		t.shellPaths = nil
	})
	if len(changed) == 0 {
		return
	}
	paths := make([]string, 0, len(changed))
	for p := range changed {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	if len(paths) > maxAttributedPerFlush {
		jlog.Info("[GitWatcher] %d files changed by shell commands in %s; attributing the first %d", len(paths), t.root, maxAttributedPerFlush)
		paths = paths[:maxAttributedPerFlush]
	}
	index := gitattr.ForProject(t.attr.Project)
	for _, p := range paths {
		if ctx.Err() != nil {
			return
		}
		if info, err := os.Lstat(p); err != nil || !info.Mode().IsRegular() {
			continue
		}
		at, ok, err := gitattr.Locate(ctx, t.root, p)
		if err != nil || !ok {
			continue
		}
		if len(index.Lookup(t.attr.Workspace, at.Repo, at.Path, at.Blob)) > 0 {
			continue
		}
		calls := changed[p]
		strength := gitattr.Strong
		if len(calls) > 1 {
			strength = gitattr.Weak
		}
		for _, c := range calls {
			index.Add(gitattr.Record{
				Workspace: t.attr.Workspace, Repo: at.Repo, Path: at.Path, Blob: at.Blob,
				Conv: c.Conv, Thread: c.Thread, Item: c.Item, Strength: strength,
			})
		}
	}
}
