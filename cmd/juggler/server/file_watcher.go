//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/extmanifest"
	"juggler/internal/jlog"
	"juggler/internal/projectpaths"

	"github.com/fsnotify/fsnotify"
)

// maxPluginWatchDepth bounds the recursion when registering watches on an
// extension tree, a cheap guard against a pathological symlink cycle that
// EvalSymlinks deduplication didn't already break.
const maxPluginWatchDepth = 12

// pluginReloadDebounce is how long the watcher waits for the filesystem to go
// quiet before broadcasting. An editor save is several events (and a multi-file
// save several more), and each rebuild tears down and re-imports every
// capability, so the burst is collapsed into one reload.
const pluginReloadDebounce = 300 * time.Millisecond

// StartBackgroundServices constructs and starts the filesystem watcher (which
// walks the project tree and registers fsnotify watches), kicks off the
// broadcast goroutine, starts the plugin-directory watcher, and then kicks off
// the remaining background services (provider refresh, update checker), and
// loads the conversations holding queued sends (loadHeldConversations). Call
// this once, after the engine is up and the server is serving — earlier and
// you'd be holding kernel watch handles for events with no audience.
func (s *Server) StartBackgroundServices() {
	st := s.projectState.Load()
	if st != nil && st.fileWatcher == nil {
		fw, err := core.NewFileWatcher(st.projectPath)
		if err != nil {
			jlog.Error("Failed to create file watcher: %v", err)
		} else {
			fw.Start()
			// Install into the live projectState. We rebuild the struct
			// to keep the atomic-pointer write-once semantics clean.
			newSt := *st
			newSt.fileWatcher = fw
			newSt.fileChangesCh = make(chan struct{})
			s.projectState.Store(&newSt)
			go s.forwardFileChanges(&newSt)
		}
	}
	s.startPluginWatcher()
	s.startConfigWatcher()
	s.RefreshProviders()
	s.startUpdateChecker()
	s.startEngineSupervisor()
	// Here rather than when the worker manager is wired: the conversations it
	// loads may fire a send at once, and its turn asks the engine for context.
	go s.loadHeldConversations()
}

// loadHeldConversations loads the project's conversations holding queued sends,
// so they fire with nobody opening them.
func (s *Server) loadHeldConversations() {
	if path := s.ProjectPath(); path != "" && s.workerManager != nil {
		s.workerManager.LoadHeldConversations(path)
	}
}

func (s *Server) flushFileChangeBatch(changes []core.FileChange) {
	// Dedupe by path (keep latest event type per path)
	seen := make(map[string]core.FileChange)
	for _, c := range changes {
		seen[c.Path] = c
	}

	deduped := make([]core.FileChange, 0, len(seen))
	for _, c := range seen {
		deduped = append(deduped, c)
	}

	s.broadcastToAll(fileChangeFrame{Type: frameFileChange, Changes: deduped})
}

// startPluginWatcher watches the extension container directory
// (~/.juggler/extensions) and the user-command and hook directories for changes,
// broadcasting plugin-changed for hot reload. Extension containers hold one
// subdirectory per extension — often a symlink created by `juggler ext link` —
// so each tree is registered recursively with symlinks resolved, and newly
// created subdirectories (a freshly linked or added extension) are picked up on
// the fly.
func (s *Server) startPluginWatcher() {
	dirs := s.pluginWatchDirs()
	if len(dirs) == 0 {
		return
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		jlog.Error("[PluginWatcher] Failed to create watcher: %v", err)
		return
	}

	// Resolved-path set shared across all roots and later Create events, so a dir
	// reachable via two paths (e.g. a symlink) is only watched once. extDirs is
	// the subset belonging to the extension container: an event there carries new
	// capability CODE and so must bust the module cache, while an event in the
	// user-command dirs does not.
	watched := map[string]bool{}
	extDirs := map[string]bool{}
	total := 0
	var awaited []*awaitedDir
	for _, dir := range dirs {
		if dir.await {
			if a, ok := newAwaitedDir(watcher, dir.path); ok {
				awaited = append(awaited, a)
				total++
			}
			continue
		}
		var ext map[string]bool
		if dir.isExtension {
			ext = extDirs
		}
		n := addPluginTree(watcher, dir.path, watched, ext)
		if n > 0 {
			jlog.Info("[PluginWatcher] Watching %d dir(s) under: %s", n, dir.path)
		}
		total += n
	}

	if total == 0 {
		watcher.Close()
		return
	}

	go func() {
		defer watcher.Close()
		// Editors write a file in several steps and a multi-file save fires an
		// event per file, so events are coalesced into one broadcast: pending*
		// accumulates what arrived, and each new event restarts the timer. A fresh
		// timer per event (rather than Reset) keeps the fired-but-undrained case
		// from delivering a stale tick.
		var (
			debounce    <-chan time.Time
			timer       *time.Timer
			pendingPath string
			pendingExt  bool
		)
		schedule := func(path string, isExt bool) {
			pendingPath = path
			pendingExt = pendingExt || isExt
			if timer != nil {
				timer.Stop()
			}
			timer = time.NewTimer(pluginReloadDebounce)
			debounce = timer.C
		}
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				if arrived, ours := handleAwaited(watcher, awaited, event.Name); ours {
					if arrived != "" {
						// The awaited directory appeared, perhaps already holding
						// the file whose write made it: watch it and reload.
						addPluginTree(watcher, arrived, watched, nil)
						schedule(arrived, false)
					}
					continue
				}
				isDir := false
				if fi, err := os.Stat(event.Name); err == nil {
					isDir = fi.IsDir()
				}
				action := classifyPluginEvent(event.Name, event.Op, isDir)
				isExt := isExtensionEvent(event.Name, extDirs)
				// A freshly linked/added extension dir's files already exist, so
				// start watching its subtree for subsequent edits.
				if action.watchTree {
					var ext map[string]bool
					if isExt {
						ext = extDirs
					}
					addPluginTree(watcher, event.Name, watched, ext)
				}
				if action.broadcast {
					schedule(event.Name, isExt)
				}

			case <-debounce:
				debounce, timer = nil, nil
				jlog.Info("[PluginWatcher] Plugin changed: %s", pendingPath)
				s.broadcastPluginChanged(pendingPath, pendingExt)
				pendingPath, pendingExt = "", false

			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				jlog.Error("[PluginWatcher] Error: %v", err)

			case <-s.shutdownChan:
				return
			}
		}
	}()
}

// broadcastPluginChanged tells every connected client to reload its capability
// registries. bustCache advances the extension URL epoch first, so the catalog
// the clients refetch hands out URLs the JS module cache has never seen and the
// edited file is actually re-imported — without it a reload re-runs the stale
// module records and appears to do nothing.
func (s *Server) broadcastPluginChanged(path string, bustCache bool) {
	if bustCache && s.extensionsAPI != nil {
		s.extensionsAPI.BumpEpoch()
	}
	s.broadcastToAll(pluginChangedFrame{Type: framePluginChanged, Path: path})
}

// isExtensionEvent reports whether a filesystem event happened inside the
// extension tree, as opposed to the user-command directories the same watcher
// covers. Membership is by watched directory rather than a path prefix: `juggler
// ext link` puts an extension's real files anywhere on disk, so the container
// path is no guide.
func isExtensionEvent(name string, extDirs map[string]bool) bool {
	return extDirs[name] || extDirs[filepath.Dir(name)]
}

// pluginWatchDirs returns the directory trees the watcher should register: the
// extension container (owned by the ExtensionsAPI) plus the user- and
// project-scope user-command directories and the user hook directory. Each is
// created if absent so a `juggler ext link` or a first command or hook file
// written while the server is already running is caught by the watch on the
// container. An external edit to a command or hook file broadcasts plugin-changed (see isPluginFile), reusing the extension hot-reload
// path with no new client plumbing.
//
// The one exception is the project's command directory when the project keeps
// its state outside it (projectpaths.For): then nothing else puts a .juggler/
// in the project, and creating one just to watch it is the clutter the setting
// exists to avoid. That directory is instead awaited (see awaitedDir).
func (s *Server) pluginWatchDirs() []pluginWatchDir {
	var dirs []pluginWatchDir
	watch := func(dir string, isExtension bool) {
		if dir == "" {
			return
		}
		_ = os.MkdirAll(dir, 0o755)
		dirs = append(dirs, pluginWatchDir{path: dir, isExtension: isExtension})
	}
	watch(s.extensionsAPI.UserExtensionDir(), true)
	watch(s.userCommandsAPI.UserCommandDir(), false)
	if dir := s.userCommandsAPI.ProjectCommandDir(); dir != "" {
		if _, err := os.Stat(dir); err != nil && projectpaths.For(s.ProjectPath()).Outside() {
			dirs = append(dirs, pluginWatchDir{path: dir, await: true})
		} else {
			watch(dir, false)
		}
	}
	watch(core.UserHookDir(), false)
	return dirs
}

// pluginWatchDir is one root the plugin watcher registers, tagged with whether
// it holds extension code (whose reload must bust the module cache) or user
// commands (which are re-read from the server on every reload).
type pluginWatchDir struct {
	path        string
	isExtension bool
	// await marks a directory that does not exist and is not to be created:
	// it is watched for from its nearest existing ancestor (awaitedDir).
	await bool
}

// awaitedDir watches for a directory that does not exist yet, without
// creating it: each missing step from its nearest existing ancestor down is
// watched on its own, non-recursively, until the directory itself appears and
// is handed back to be watched as a plugin tree. Everything else those
// stepping-stone watches see — every other file created in the project root —
// is none of the plugin watcher's business and is dropped.
type awaitedDir struct {
	target string
	// steps holds the ancestors being watched on target's behalf.
	steps map[string]bool
}

// newAwaitedDir watches target's nearest existing ancestor, reporting false
// when there is none to watch.
func newAwaitedDir(watcher *fsnotify.Watcher, target string) (*awaitedDir, bool) {
	a := &awaitedDir{target: target, steps: map[string]bool{}}
	dir := filepath.Dir(target)
	for {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil, false
		}
		dir = parent
	}
	if err := watcher.Add(dir); err != nil {
		return nil, false
	}
	a.steps[dir] = true
	return a, true
}

// handleAwaited offers an event to each awaited directory, returning the one
// that has just appeared ("" if none) and whether any of them claimed it.
func handleAwaited(watcher *fsnotify.Watcher, awaited []*awaitedDir, name string) (arrived string, ours bool) {
	for _, a := range awaited {
		mine, done := a.handle(watcher, name)
		if done {
			return a.target, true
		}
		ours = ours || mine
	}
	return "", ours
}

// handle takes an event from one of the stepping-stone watches, reporting
// whether it was one (so the caller drops it) and whether target has now
// appeared (so the caller watches it and reloads).
func (a *awaitedDir) handle(watcher *fsnotify.Watcher, name string) (ours, arrived bool) {
	if !a.steps[filepath.Dir(name)] {
		return false, false
	}
	info, err := os.Stat(name)
	if err != nil || !info.IsDir() {
		return true, false
	}
	if name == a.target {
		for step := range a.steps {
			_ = watcher.Remove(step)
		}
		a.steps = map[string]bool{}
		return true, true
	}
	rel, err := filepath.Rel(name, a.target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return true, false // a sibling, not on the way to target
	}
	if _, err := os.Stat(a.target); err == nil {
		// Made in one go (MkdirAll) before this watch could see the step.
		for step := range a.steps {
			_ = watcher.Remove(step)
		}
		a.steps = map[string]bool{}
		return true, true
	}
	if watcher.Add(name) == nil {
		a.steps[name] = true
	}
	return true, false
}

// isPluginFile reports whether a changed path is one a hot reload cares about:
// any JS capability file, an extension manifest, a translation catalogue (a
// .json named for a locale, e.g. fr.json), or a user-command markdown
// definition. A stray .md under a watched extension tree (e.g. a README), or a
// .json that merely looks like a catalogue, also triggers a reload, which is
// harmless — reloadRegistries is idempotent.
func isPluginFile(name string) bool {
	base := filepath.Base(name)
	return strings.HasSuffix(name, ".js") ||
		strings.HasSuffix(name, ".md") ||
		base == "juggler.extension.json" ||
		(strings.HasSuffix(base, ".json") && extmanifest.IsLocaleTag(strings.TrimSuffix(base, ".json")))
}

// pluginEventAction is how the plugin watcher reacts to one filesystem event.
type pluginEventAction struct {
	watchTree bool // begin watching name's subtree (a newly appeared extension dir)
	broadcast bool // emit plugin-changed so connected viewers hot-reload
}

// classifyPluginEvent decides the watcher's reaction to a filesystem event. It is
// pure (no IO) so the decision is unit-testable; the caller supplies isDir.
//
// A newly created directory is a freshly linked or added extension (`juggler ext
// link`/`add`). Its capability files already exist on disk, so no per-file Create
// events fire for them — without broadcasting here the extension would not load
// until the next unrelated edit. So a new dir both starts a watch AND broadcasts.
func classifyPluginEvent(name string, op fsnotify.Op, isDir bool) pluginEventAction {
	if op&fsnotify.Create != 0 && isDir {
		return pluginEventAction{watchTree: true, broadcast: true}
	}
	if !isPluginFile(name) {
		return pluginEventAction{}
	}
	if op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0 {
		return pluginEventAction{}
	}
	return pluginEventAction{broadcast: true}
}

// addPluginTree registers watches on dir and every subdirectory beneath it,
// resolving symlinks (so a `juggler ext link` target dir is watched at its real
// location) and de-duplicating via the shared watched set. Every directory added
// is also recorded in extDirs when that map is non-nil, marking the subtree as
// extension code. It returns the number of directories newly added. A missing
// dir contributes nothing.
func addPluginTree(watcher *fsnotify.Watcher, dir string, watched, extDirs map[string]bool) int {
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return 0 // absent or dangling — nothing to watch
	}
	return addDirRecursive(watcher, resolved, watched, extDirs, 0)
}

// addDirRecursive adds a single resolved directory and recurses into its
// subdirectories, following symlinked children (each extension under a container
// may itself be a symlink). depth is bounded by maxPluginWatchDepth.
func addDirRecursive(watcher *fsnotify.Watcher, dir string, watched, extDirs map[string]bool, depth int) int {
	if depth > maxPluginWatchDepth || watched[dir] {
		return 0
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return 0
	}
	if err := watcher.Add(dir); err != nil {
		return 0
	}
	watched[dir] = true
	if extDirs != nil {
		extDirs[dir] = true
	}
	count := 1

	entries, err := os.ReadDir(dir)
	if err != nil {
		return count
	}
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		// Resolve each child so a symlinked extension dir is followed to its real
		// path; non-directories and dangling links are skipped.
		childResolved, err := filepath.EvalSymlinks(full)
		if err != nil {
			continue
		}
		fi, err := os.Stat(childResolved)
		if err != nil || !fi.IsDir() {
			continue
		}
		count += addDirRecursive(watcher, childResolved, watched, extDirs, depth+1)
	}
	return count
}
