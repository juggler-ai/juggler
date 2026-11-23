//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package shellattr records which shell command changed a tree's files, in the
// project's attribution index (gitattr), so the git client can say which
// conversation made changes that no edit or write tool reported.
//
// A file of a tree that is created or written while shell commands are running
// in that tree is put down to them. The commands are read when the change is
// heard, since a short command has often exited by the time the burst settles.
// The file is hashed when the burst settles. If exactly one command was
// running, the record is Strong for it; if several were, each gets a Weak
// record. Nothing is recorded while no command runs: the user's own edits
// belong to no conversation.
//
// A version some record already holds is left alone. That is usually the
// record of the edit or write tool that made it (it reports the file itself),
// and a shell running beside that tool must not share its file.
//
// It records whether or not anything is watching the tree's git state, at no
// cost to a project nobody is working in:
//
//   - The project's tree is told of its changes by the project's file watcher
//     (ProjectChanged), which runs for as long as the project is open anyway.
//     A change costs one look at the process inventory.
//   - Any other tree — a worktree workspace — is watched only while shell
//     commands run in it, and for a short linger after the last one ends, so a
//     run of commands walks it once rather than once each. The watch starts when
//     the inventory says a command has started there (ProcessesChanged), and
//     what the command writes before the walk has reached a directory is not
//     heard: a fast command in a big tree can finish unattributed. Attribution
//     is a hint for a commit message, so that is a loss of detail, not of data.
package shellattr

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitattr"
	"juggler/internal/jlog"
)

const (
	// settleQuiet is how long a tree's changes must pause before they are
	// hashed: a command writing a file is often several events.
	settleQuiet = 100 * time.Millisecond

	// settleMax bounds how long a burst that never pauses holds its changes.
	settleMax = time.Second

	// linger is how long a workspace tree stays watched after its last shell
	// command ends. Only a cost: a command starting within it is not walked for.
	linger = 30 * time.Second

	// maxPerFlush bounds how many files one flush hashes: a checkout or a
	// generator can write thousands, and each costs a git process. The rest of
	// such a burst goes unattributed, which only means the git client cannot say
	// who made them.
	maxPerFlush = 256

	// noteQueue absorbs the changes a tree hears while it hashes a flush, as
	// the file watcher's own feed absorbs a checkout.
	noteQueue = 512
)

// ShellCall is one shell command running, as the recorder attributes changes
// to it: the conversation, thread and tool use that started it, the directory
// it runs in, and the workspace it runs in ("" for the project).
type ShellCall struct {
	Conv, Thread, Item string
	Cwd                string
	Workspace          string
}

// RunningShells lists the shell commands running under a project right now. It
// is called for each change heard while a tree is recorded, so it must answer
// promptly.
type RunningShells func(project string) []ShellCall

// Roots resolves a workspace to its tree on this machine; false for one that
// cannot be resolved or is not on this machine.
type Roots func(workspace string) (root string, ok bool)

// Recorder records a project's shell changes. Make one with New; Close it.
type Recorder struct {
	project     string
	realProject string
	running     RunningShells
	roots       Roots

	// manual makes trees flush only when a test calls flush. Set before use.
	manual bool

	ctx    context.Context
	cancel context.CancelFunc

	projectTree *tree

	// trees are the workspace trees being recorded, by workspace id. Owned by
	// the supervisor.
	trees map[string]*tree

	changed chan struct{}
	done    chan struct{}
}

// tree is one tree whose shell changes are recorded.
type tree struct {
	r         *Recorder
	workspace string
	root      string
	realRoot  string
	fw        *core.FileWatcher // nil for the project's, which ProjectChanged feeds

	// idleSince is when the last shell command running in a workspace tree was
	// seen to end; zero while one runs. Owned by the supervisor.
	idleSince time.Time

	// notes carries what the tree heard to its goroutine, in order, with
	// requests to flush among them. paths is what it has heard since the last
	// flush: each file changed while shell commands ran, and the commands.
	// Owned by the tree's goroutine.
	notes chan note
	paths map[string][]ShellCall

	stop chan struct{}
	done chan struct{}
}

// note is one file changed while calls ran, or, with flushed set, a request
// to flush now and close flushed when done.
type note struct {
	path    string
	calls   []ShellCall
	flushed chan struct{}
}

// New starts recording the shell changes of project's trees. running lists the
// commands running under it, and roots finds a workspace's tree.
func New(project string, running RunningShells, roots Roots) *Recorder {
	return newRecorder(project, running, roots, false)
}

func newRecorder(project string, running RunningShells, roots Roots, manual bool) *Recorder {
	ctx, cancel := context.WithCancel(context.Background())
	r := &Recorder{
		project:     project,
		realProject: realPath(project),
		running:     running,
		roots:       roots,
		manual:      manual,
		ctx:         ctx,
		cancel:      cancel,
		trees:       map[string]*tree{},
		changed:     make(chan struct{}, 1),
		done:        make(chan struct{}),
	}
	r.projectTree = r.newTree("", project, nil)
	go r.supervise()
	return r
}

// ProjectChanged is one change from the project's file watcher (its raw feed:
// core.FileWatcherOptions.RawFeed). By absolute path.
func (r *Recorder) ProjectChanged(path, event string) {
	r.projectTree.changed(path, event)
}

// ProcessesChanged says a process started or ended. It never blocks, so it is
// safe to call from ops.OnProcessesChanged.
func (r *Recorder) ProcessesChanged() {
	select {
	case r.changed <- struct{}{}:
	default:
	}
}

// Close stops recording. What a tree had heard and not yet hashed is
// abandoned. Safe to call twice.
func (r *Recorder) Close() {
	if r.ctx.Err() == nil {
		r.cancel()
	}
	<-r.done
}

// newTree starts recording one tree.
func (r *Recorder) newTree(workspace, root string, fw *core.FileWatcher) *tree {
	t := &tree{
		r: r, workspace: workspace, root: filepath.Clean(root), realRoot: realPath(root), fw: fw,
		notes: make(chan note, noteQueue), stop: make(chan struct{}), done: make(chan struct{}),
	}
	go t.run()
	if fw != nil {
		go func() {
			for range fw.Changes() { //nolint:revive // drained so the watcher never blocks on it
			}
		}()
		go func() {
			for c := range fw.RawChanges() {
				t.changed(c.Path, c.Event)
			}
		}()
	}
	return t
}

// supervise keeps a watched tree for each workspace shell commands run in,
// until the recorder closes, and then stops every tree.
func (r *Recorder) supervise() {
	defer close(r.done)
	defer func() {
		for _, t := range r.trees {
			t.end()
		}
		r.trees = map[string]*tree{}
		r.projectTree.end()
	}()
	var reap *time.Timer
	var reapC <-chan time.Time
	for {
		select {
		case <-r.ctx.Done():
			if reap != nil {
				reap.Stop()
			}
			return
		case <-r.changed:
		case <-reapC:
		}
		next := r.reconcile(time.Now())
		if reap != nil {
			reap.Stop()
			reap, reapC = nil, nil
		}
		if !next.IsZero() {
			reap = time.NewTimer(time.Until(next))
			reapC = reap.C
		}
	}
}

// reconcile starts recording the workspace trees shell commands run in, marks
// the rest idle, and stops those idle for the linger. It returns when the next
// idle tree is due to stop, zero for none.
func (r *Recorder) reconcile(now time.Time) time.Time {
	busy := map[string]bool{}
	for _, c := range r.running(r.project) {
		if c.Workspace != "" {
			busy[c.Workspace] = true
		}
	}
	for id := range busy {
		if t := r.trees[id]; t != nil {
			t.idleSince = time.Time{}
			continue
		}
		root, ok := r.roots(id)
		if !ok || root == "" || realPath(root) == r.realProject {
			continue // not on this machine, or the project's tree, which is always heard
		}
		fw, err := core.NewFileWatcherWith(root, core.FileWatcherOptions{RawFeed: true, NoIndex: true})
		if err != nil {
			jlog.Debug("[ShellAttr] Couldn't watch %s: %v", root, err)
			continue
		}
		fw.Start()
		r.trees[id] = r.newTree(id, root, fw)
	}
	var next time.Time
	for id, t := range r.trees {
		if busy[id] {
			continue
		}
		if t.idleSince.IsZero() {
			t.idleSince = now
		}
		due := t.idleSince.Add(linger)
		if !now.Before(due) {
			delete(r.trees, id)
			go t.end()
			continue
		}
		if next.IsZero() || due.Before(next) {
			next = due
		}
	}
	return next
}

// changed notes which running shell commands could have changed path. On
// whichever goroutine heard the change.
func (t *tree) changed(path, event string) {
	if event != "create" && event != "write" {
		return
	}
	rel, ok := relWithin(t.root, path)
	if !ok || slices.Contains(strings.Split(rel, "/"), ".git") {
		return
	}
	var calls []ShellCall
	for _, c := range t.r.running(t.r.project) {
		if t.runsHere(c) {
			calls = append(calls, c)
		}
	}
	if len(calls) == 0 {
		return
	}
	select {
	case t.notes <- note{path: path, calls: calls}:
	case <-t.done:
	default:
		jlog.Error("[ShellAttr] Dropped a change (queue full): %s", path)
	}
}

// add records one note. On the tree's goroutine.
func (t *tree) add(n note) {
	if t.paths == nil {
		t.paths = map[string][]ShellCall{}
	}
	for _, c := range n.calls {
		if !slices.Contains(t.paths[n.path], c) {
			t.paths[n.path] = append(t.paths[n.path], c)
		}
	}
}

// runsHere says whether a command runs in the tree: it runs in the tree's
// workspace, or its directory is inside the tree.
func (t *tree) runsHere(c ShellCall) bool {
	if c.Workspace != "" && c.Workspace == t.workspace {
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

// run is the tree's goroutine: it waits for a change, lets the burst settle,
// and flushes, until the tree ends, when it flushes what is left — unless the
// recorder is closing, which abandons it rather than hold shutdown on git.
func (t *tree) run() {
	defer close(t.done)
	var quiet, longest *time.Timer
	var quietC, longestC <-chan time.Time
	settle := func() {
		if quiet != nil {
			quiet.Stop()
			longest.Stop()
		}
		quiet, longest, quietC, longestC = nil, nil, nil, nil
		t.flush(t.r.ctx)
	}
	for {
		select {
		case <-t.stop:
			settle()
			return
		case n := <-t.notes:
			if n.flushed != nil {
				settle()
				close(n.flushed)
				continue
			}
			t.add(n)
			if t.r.manual {
				continue
			}
			if quiet == nil {
				quiet, longest = time.NewTimer(settleQuiet), time.NewTimer(settleMax)
				quietC, longestC = quiet.C, longest.C
			} else {
				quiet.Reset(settleQuiet)
			}
		case <-quietC:
			settle()
		case <-longestC:
			settle()
		}
	}
}

// end stops the tree: its watcher, if it has one, and then its goroutine,
// which flushes what it had heard.
func (t *tree) end() {
	if t.fw != nil {
		t.fw.Stop()
	}
	close(t.stop)
	<-t.done
}

// flush hashes the files shell commands changed since the last flush and
// records them. On the tree's goroutine.
func (t *tree) flush(ctx context.Context) {
	changed := t.paths
	t.paths = nil
	if len(changed) == 0 {
		return
	}
	paths := make([]string, 0, len(changed))
	for p := range changed {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	if len(paths) > maxPerFlush {
		jlog.Info("[ShellAttr] %d files changed by shell commands in %s; attributing the first %d", len(paths), t.root, maxPerFlush)
		paths = paths[:maxPerFlush]
	}
	index := gitattr.ForProject(t.r.project)
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
		if len(index.Lookup(t.workspace, at.Repo, at.Path, at.Blob)) > 0 {
			continue
		}
		calls := changed[p]
		strength := gitattr.Strong
		if len(calls) > 1 {
			strength = gitattr.Weak
		}
		for _, c := range calls {
			index.Add(gitattr.Record{
				Workspace: t.workspace, Repo: at.Repo, Path: at.Path, Blob: at.Blob,
				Conv: c.Conv, Thread: c.Thread, Item: c.Item, Strength: strength,
			})
		}
	}
}

// relWithin is path relative to dir, forward-slashed, when path lies inside dir.
func relWithin(dir, path string) (string, bool) {
	rest, ok := strings.CutPrefix(path, dir+string(filepath.Separator))
	if !ok || rest == "" {
		return "", false
	}
	return filepath.ToSlash(rest), true
}

// realPath is a path with every symbolic link resolved, or the path cleaned
// when it cannot be.
func realPath(p string) string {
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return resolved
	}
	return filepath.Clean(p)
}
