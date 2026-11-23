//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package gitops is the git client's side of a working tree that is not a read:
// for now, watching. A Watcher tells whoever is watching a tree which of its
// repositories changed and in what part of their git state, so that a surface
// re-reads on a change instead of polling for one.
//
// It knows nothing of workspaces, projects' conversations or HTTP: it is handed
// a directory on this machine and reports on every repository under it, as
// gitview's status card names them.
package gitops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitview"
	"juggler/internal/jlog"

	"github.com/fsnotify/fsnotify"
)

const (
	// debounceQuiet is how long a tree's changes must pause before they are
	// sent: a commit is a dozen file events, and one change is what a reader
	// wants to hear of it.
	debounceQuiet = 100 * time.Millisecond

	// debounceMax bounds how long a burst that never pauses — a long checkout,
	// a build writing as it goes — can hold its changes back.
	debounceMax = time.Second

	// cappedTick is how often a tree too big to watch whole is told its working
	// tree may have changed, since changes in the part left unwatched are never
	// heard (core.FileWatcher.WatchCapped). Lazy on purpose: what it covers is
	// ambient information nobody waits on, and every other tree has no clock.
	cappedTick = 20 * time.Second

	// discoveryBudget bounds the search for a tree's repositories and the
	// rev-parse of each.
	discoveryBudget = 10 * time.Second

	// maxCommonDirs caps the directories watched for one repository's shared
	// state, most of them loose ref directories. On macOS each watched directory
	// holds a descriptor per file in it, so a repository of ten thousand loose
	// refs must not be allowed to take ten thousand.
	maxCommonDirs = 256
)

// errClosed is the answer to a watch asked of a watcher that has been closed.
var errClosed = errors.New("the git watcher has stopped")

// Change is one repository's news: what changed in it since the last Change.
// Repo is relative to the watched tree's root, forward-slashed, "" for the root
// repository — gitview.RepoPath's spelling, which is the status card's.
type Change struct {
	Repo  string
	Kinds Kinds
}

// Watcher watches the git state of any number of trees on this machine through
// one fsnotify watcher of git's directories. Two trees of one repository share
// its common directory, which is watched once for both of them and for as long
// as either is watched.
//
// All of its state belongs to one goroutine (run), which every other goroutine
// reaches through do. Nothing slow happens there: git runs, and changes are
// sent, on each tree's own goroutine.
type Watcher struct {
	project   string            // the project root, symbolic links resolved; "" for none
	projectFW *core.FileWatcher // the project's watcher, with its raw feed; nil for none
	fsw       *fsnotify.Watcher

	// manual makes a tree flush only when a test calls flush, and a flush send
	// even when it has nothing to say. Set before the first Watch.
	manual bool

	cmds      chan func()
	quit      chan struct{}
	done      chan struct{}
	closeOnce sync.Once

	// Owned by run.
	trees    map[*tree]struct{}
	treeDirs map[string]*treeDirEntry // by a tree's own git directory
	commons  map[string]*commonEntry  // by a repository's common directory
	dirRefs  map[string]int           // how many entries hold each watched directory
}

// sub is one repository of one watched tree.
type sub struct {
	t    *tree
	repo string
}

// treeDirEntry is one tree's own git directory and everything watching it.
// Usually one sub; more when two watched trees overlap.
type treeDirEntry struct {
	common string
	subs   map[sub]struct{}
	dirs   []string
}

// commonEntry is one repository's common directory and every tree of it that
// is watched.
type commonEntry struct {
	subs map[sub]struct{}
	dirs map[string]bool
}

// repoInfo is one repository in a watched tree: its working directory, its name
// in the tree, and its two git directories (gitview.GitDirs).
type repoInfo struct {
	dir, rel, own, common string
}

// tree is one Watch. Its fields after out are owned by the Watcher's goroutine.
type tree struct {
	w    *Watcher
	root string
	out  chan []Change
	kick chan struct{}

	// fw watches the working tree of a tree that is not the project's; nil for
	// the project's, which the project's watcher already covers. Set before the
	// tree's goroutines start.
	fw *core.FileWatcher

	repos      []repoInfo
	pending    map[string]Kinds
	rediscover bool
}

// NewWatcher makes a watcher. project is the project root, whose tree is told
// of its working tree by ProjectChanged, from projectFW's raw feed, rather than
// by a watcher of its own; both may be empty, and then every tree gets its own.
func NewWatcher(project string, projectFW *core.FileWatcher) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{
		projectFW: projectFW,
		fsw:       fsw,
		cmds:      make(chan func()),
		quit:      make(chan struct{}),
		done:      make(chan struct{}),
		trees:     map[*tree]struct{}{},
		treeDirs:  map[string]*treeDirEntry{},
		commons:   map[string]*commonEntry{},
		dirRefs:   map[string]int{},
	}
	if project != "" && projectFW != nil {
		w.project = realPath(project)
	}
	go w.run()
	return w, nil
}

// Close stops the watcher. Every watch ends with it. Safe to call twice.
func (w *Watcher) Close() {
	w.closeOnce.Do(func() {
		close(w.quit)
		<-w.done
		_ = w.fsw.Close()
	})
}

// run is the goroutine that owns the watcher's state.
func (w *Watcher) run() {
	defer close(w.done)
	for {
		select {
		case fn := <-w.cmds:
			fn()
		case ev, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			w.handleGitEvent(ev)
		case err, ok := <-w.fsw.Errors:
			if !ok {
				return
			}
			if errors.Is(err, fsnotify.ErrEventOverflow) {
				w.noteEverything()
				continue
			}
			jlog.Error("[GitWatcher] %v", err)
		case <-w.quit:
			return
		}
	}
}

// ProjectChanged is one change from the project's watcher's raw feed
// (core.FileWatcherOptions.RawFeed), by absolute path. Whoever reads that feed
// hands each change on here; after Close it does nothing.
func (w *Watcher) ProjectChanged(path, event string) {
	w.do(func() { w.workingTreeChanged(path, event) })
}

// do runs fn on the watcher's goroutine and waits for it, or reports false if
// the watcher has stopped.
func (w *Watcher) do(fn func()) bool {
	ran := make(chan struct{})
	select {
	case w.cmds <- func() { fn(); close(ran) }:
		<-ran
		return true
	case <-w.done:
		return false
	}
}

// Watch reports changes to the git state of every repository under root until
// ctx ends, when the channel is closed. Each send is one tree's news since the
// last, one Change per repository, never empty. Repositories created under root
// later are found when the directory holding them appears.
func (w *Watcher) Watch(ctx context.Context, root string) (<-chan []Change, error) {
	root = filepath.Clean(root)
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", root)
	}

	t := &tree{w: w, root: root, out: make(chan []Change, 16), kick: make(chan struct{}, 1), pending: map[string]Kinds{}}
	repos := discover(ctx, root)
	if w.project == "" || realPath(root) != w.project {
		fw, err := core.NewFileWatcherWith(root, core.FileWatcherOptions{RawFeed: true, NoIndex: true})
		if err != nil {
			return nil, err
		}
		t.fw = fw
	}

	if !w.do(func() {
		for _, r := range repos {
			w.register(t, r)
		}
		t.repos = repos
		w.trees[t] = struct{}{}
	}) {
		if t.fw != nil {
			t.fw.Stop()
		}
		return nil, errClosed
	}

	if t.fw != nil {
		t.fw.Start()
		go t.feed()
	}
	go t.run(ctx)
	return t.out, nil
}

// discover finds root's repositories and their git directories. One git cannot
// read is left out, as the status card leaves it out.
func discover(ctx context.Context, root string) []repoInfo {
	ctx, cancel := context.WithTimeout(ctx, discoveryBudget)
	defer cancel()
	repos := []repoInfo{}
	for _, dir := range gitview.Repos(ctx, root) {
		own, common, err := gitview.GitDirs(ctx, dir)
		if err != nil {
			continue
		}
		repos = append(repos, repoInfo{dir: dir, rel: gitview.RepoPath(root, dir), own: own, common: common})
	}
	return repos
}

// register starts telling t about r, watching r's git directories if nothing
// watched them yet. On the watcher's goroutine.
func (w *Watcher) register(t *tree, r repoInfo) {
	s := sub{t: t, repo: r.rel}
	e := w.treeDirs[r.own]
	if e == nil {
		e = &treeDirEntry{common: r.common, subs: map[sub]struct{}{}}
		for _, dir := range []string{r.own, filepath.Join(r.own, "logs")} {
			if w.addDir(dir) {
				e.dirs = append(e.dirs, dir)
			}
		}
		w.treeDirs[r.own] = e
	}
	e.subs[s] = struct{}{}

	c := w.commons[r.common]
	if c == nil {
		c = &commonEntry{subs: map[sub]struct{}{}, dirs: map[string]bool{}}
		for _, rel := range []string{"", "logs", "logs/refs", "worktrees"} {
			w.addCommonDir(c, filepath.Join(r.common, filepath.FromSlash(rel)))
		}
		w.addRefDirs(c, filepath.Join(r.common, "refs"))
		w.commons[r.common] = c
	}
	c.subs[s] = struct{}{}
}

// unregister stops telling t about r, and stops watching what nothing else
// needs. On the watcher's goroutine.
func (w *Watcher) unregister(t *tree, r repoInfo) {
	s := sub{t: t, repo: r.rel}
	if e := w.treeDirs[r.own]; e != nil {
		delete(e.subs, s)
		if len(e.subs) == 0 {
			for _, dir := range e.dirs {
				w.removeDir(dir)
			}
			delete(w.treeDirs, r.own)
		}
	}
	if c := w.commons[r.common]; c != nil {
		delete(c.subs, s)
		if len(c.subs) == 0 {
			for dir := range c.dirs {
				w.removeDir(dir)
			}
			delete(w.commons, r.common)
		}
	}
}

// addDir watches a directory on behalf of one more holder, reporting whether
// there is a directory there to watch.
func (w *Watcher) addDir(dir string) bool {
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return false
	}
	// Added whatever the count says: fsnotify forgets a directory that was
	// deleted, and one made again in its place has to be watched afresh.
	if err := w.fsw.Add(dir); err != nil {
		jlog.Debug("[GitWatcher] Couldn't watch %s: %v", dir, err)
		return false
	}
	w.dirRefs[dir]++
	return true
}

// removeDir lets go of a directory for one holder, unwatching it after the last.
func (w *Watcher) removeDir(dir string) {
	w.dirRefs[dir]--
	if w.dirRefs[dir] > 0 {
		return
	}
	delete(w.dirRefs, dir)
	_ = w.fsw.Remove(dir) // already gone if the directory was deleted
}

// addCommonDir watches one directory of a repository's shared state, once, up
// to the cap.
func (w *Watcher) addCommonDir(c *commonEntry, dir string) {
	if c.dirs[dir] || len(c.dirs) >= maxCommonDirs {
		return
	}
	if w.addDir(dir) {
		c.dirs[dir] = true
	}
}

// addRefDirs watches a ref directory and every one under it: loose refs live in
// directories as deep as their names have slashes.
func (w *Watcher) addRefDirs(c *commonEntry, dir string) {
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil //nolint:nilerr // an unreadable entry is one fewer to watch
		}
		if len(c.dirs) >= maxCommonDirs {
			return filepath.SkipAll
		}
		w.addCommonDir(c, p)
		return nil
	})
}

// relWithin is path relative to dir, forward-slashed, when path lies inside dir.
func relWithin(dir, path string) (string, bool) {
	rest, ok := strings.CutPrefix(path, dir+string(filepath.Separator))
	if !ok || rest == "" {
		return "", false
	}
	return filepath.ToSlash(rest), true
}

// handleGitEvent tells every tree an event in git's directories concerns what
// it means for it. On the watcher's goroutine.
func (w *Watcher) handleGitEvent(ev fsnotify.Event) {
	if ev.Op == fsnotify.Chmod {
		return
	}
	created := ev.Op&fsnotify.Create != 0

	for own, e := range w.treeDirs {
		if ev.Name == own {
			// The tree's git directory itself went: a linked worktree removed.
			if ev.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
				w.noteSubs(e.subs, AllKinds)
			}
			continue
		}
		rel, ok := relWithin(own, ev.Name)
		if !ok {
			continue
		}
		k := classifyTreeDir(rel)
		if k&KindRefs != 0 {
			if c := w.commons[e.common]; c != nil {
				w.noteSubs(c.subs, KindRefs)
			}
		}
		if rest := k &^ KindRefs; rest != 0 {
			w.noteSubs(e.subs, rest)
		}
		// A repository's first commit makes its logs directory.
		if created && rel == "logs" && w.addDir(ev.Name) {
			e.dirs = append(e.dirs, ev.Name)
		}
	}

	for common, c := range w.commons {
		rel, ok := relWithin(common, ev.Name)
		if !ok {
			continue
		}
		if k := classifyCommonDir(rel); k != 0 {
			w.noteSubs(c.subs, k)
		}
		if !created {
			continue
		}
		switch {
		case rel == "refs" || strings.HasPrefix(rel, "refs/"):
			w.addRefDirs(c, ev.Name)
		case rel == "logs" || rel == "logs/refs" || rel == "worktrees":
			w.addCommonDir(c, ev.Name)
		}
	}
}

// noteSubs tells each sub that kinds changed.
func (w *Watcher) noteSubs(subs map[sub]struct{}, kinds Kinds) {
	for s := range subs {
		s.t.note(s.repo, kinds)
	}
}

// noteEverything tells every tree that anything may have changed: events were
// lost, and nobody can say which.
func (w *Watcher) noteEverything() {
	jlog.Info("[GitWatcher] Events were lost; every watched tree re-reads")
	for t := range w.trees {
		t.noteAll(AllKinds)
	}
}

// workingTreeChanged tells every tree holding path that a file in its working
// tree changed. On the watcher's goroutine.
func (w *Watcher) workingTreeChanged(path, event string) {
	for t := range w.trees {
		if path == t.root {
			t.workingTreeChanged(path, event)
			continue
		}
		if _, ok := relWithin(t.root, path); ok {
			t.workingTreeChanged(path, event)
		}
	}
}

// note records that kinds changed in one repository and wakes the tree's
// goroutine. On the watcher's goroutine.
func (t *tree) note(repo string, kinds Kinds) {
	t.pending[repo] |= kinds
	t.wake()
}

// noteAll records that kinds changed in every repository of the tree.
func (t *tree) noteAll(kinds Kinds) {
	for _, r := range t.repos {
		t.note(r.rel, kinds)
	}
	t.wake()
}

// wake asks the tree's goroutine to flush soon, without waiting.
func (t *tree) wake() {
	select {
	case t.kick <- struct{}{}:
	default:
	}
}

// workingTreeChanged records a change to a file of the working tree: news to
// the repository holding it and to every repository enclosing that one, since a
// superproject reports its submodules' changes. A directory appearing, or one
// holding a repository going, sends the tree looking for repositories again. On
// the watcher's goroutine.
func (t *tree) workingTreeChanged(path, event string) {
	if path == t.root && (event == "remove" || event == "rename") {
		t.noteAll(AllKinds)
		return
	}
	for _, r := range t.repos {
		if path == r.dir {
			t.note(r.rel, KindWorktree)
		} else if _, ok := relWithin(r.dir, path); ok {
			t.note(r.rel, KindWorktree)
		}
	}
	switch event {
	case "create":
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			t.rediscover = true
			t.wake()
		}
	case "remove", "rename":
		for _, r := range t.repos {
			if _, inside := relWithin(path, r.dir); inside || r.dir == path {
				t.rediscover = true
				t.wake()
				break
			}
		}
	}
}

// feed hands the tree's own working-tree watcher's raw feed to the watcher,
// until that watcher stops. The viewers' stream of the same watcher is drained
// unread: nobody completes paths in, or shows file events from, a tree watched
// for git alone.
func (t *tree) feed() {
	go func() {
		for range t.fw.Changes() { //nolint:revive // drained so the watcher never blocks on it
		}
	}()
	for c := range t.fw.RawChanges() {
		t.w.do(func() { t.workingTreeChanged(c.Path, c.Event) })
	}
}

// capped reports whether part of the tree's working tree goes unwatched.
func (t *tree) capped() bool {
	if t.fw != nil {
		return t.fw.WatchCapped()
	}
	return t.w.projectFW != nil && t.w.projectFW.WatchCapped()
}

// run is the tree's goroutine: it waits for a change, lets the burst settle,
// and flushes, until the watch ends.
func (t *tree) run(ctx context.Context) {
	defer t.end()
	tick := time.NewTicker(cappedTick)
	defer tick.Stop()

	var quiet, longest *time.Timer
	var quietC, longestC <-chan time.Time
	settle := func() {
		quiet.Stop()
		longest.Stop()
		quiet, longest, quietC, longestC = nil, nil, nil, nil
		t.flush(ctx)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.w.done:
			return
		case <-t.kick:
			if t.w.manual {
				continue
			}
			if quiet == nil {
				quiet, longest = time.NewTimer(debounceQuiet), time.NewTimer(debounceMax)
				quietC, longestC = quiet.C, longest.C
			} else {
				quiet.Reset(debounceQuiet)
			}
		case <-quietC:
			settle()
		case <-longestC:
			settle()
		case <-tick.C:
			if t.capped() {
				t.w.do(func() { t.noteAll(KindWorktree) })
			}
		}
	}
}

// flush looks for repositories again if the tree asked to, then sends
// everything recorded since the last flush as one batch.
func (t *tree) flush(ctx context.Context) {
	var rediscover bool
	t.w.do(func() {
		rediscover = t.rediscover
		t.rediscover = false
	})
	if rediscover {
		t.refreshRepos(ctx)
	}

	var batch []Change
	t.w.do(func() {
		for repo, kinds := range t.pending {
			batch = append(batch, Change{Repo: repo, Kinds: kinds})
		}
		t.pending = map[string]Kinds{}
	})
	if len(batch) > 0 || t.w.manual {
		sort.Slice(batch, func(i, j int) bool { return batch[i].Repo < batch[j].Repo })
		select {
		case t.out <- batch:
		case <-ctx.Done():
			return
		}
	}
}

// refreshRepos looks for the tree's repositories again, watching the new and
// letting go of the gone. Each of them is news in every part.
func (t *tree) refreshRepos(ctx context.Context) {
	repos := discover(ctx, t.root)
	t.w.do(func() {
		now := map[string]repoInfo{}
		for _, r := range repos {
			now[r.dir] = r
		}
		before := map[string]repoInfo{}
		for _, r := range t.repos {
			before[r.dir] = r
			if _, still := now[r.dir]; !still {
				t.w.unregister(t, r)
				t.note(r.rel, AllKinds)
			}
		}
		for _, r := range repos {
			if _, had := before[r.dir]; !had {
				t.w.register(t, r)
				t.note(r.rel, AllKinds)
			}
		}
		t.repos = repos
	})
}

// end lets go of everything the tree held and closes its channel.
func (t *tree) end() {
	t.w.do(func() {
		for _, r := range t.repos {
			t.w.unregister(t, r)
		}
		t.repos = nil
		delete(t.w.trees, t)
	})
	if t.fw != nil {
		t.fw.Stop()
	}
	close(t.out)
}

// realPath is a path with every symbolic link resolved, or the path cleaned
// when it cannot be.
func realPath(p string) string {
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return resolved
	}
	return filepath.Clean(p)
}
