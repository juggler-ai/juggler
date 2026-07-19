//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
)

// worktreesHome is the directory under which per-repository worktree groups
// live — beside Juggler's other per-user data, never scattered next to the
// user's repositories.
func worktreesHome() string {
	return filepath.Join(userpaths.ConfigDir(), "worktrees")
}

// projectState holds the per-project resources that get swapped wholesale
// when the user opens a different project at runtime. Reads are lock-free
// via the atomic pointer on Server; writes are serialized through the
// switchToken channel so torn-down resources are released exactly once.
type projectState struct {
	projectPath    string // "" indicates no-project mode
	sessionManager *core.SessionManager
	fileWatcher    *core.FileWatcher
	lock           *core.InstanceLock
	fileChangesCh  chan struct{} // closed when the file-change forwarder for this state has exited

	// viewerGroup owns this project's viewer-role clients, request cancel
	// map, and shell cancel map. Project-scoped so a SwitchProject cleanly
	// cancels in-flight work tied to the old project.
	viewers *viewerGroup

	// convWorktrees maps each conversation to its dedicated git worktree so
	// parallel conversations (side-tabs) never share a working tree. Nil in
	// no-project mode; when worktree isolation is disabled or the project is
	// not a git repo, every lookup resolves to projectPath (see
	// core.ConvWorktrees). Project-scoped, so a SwitchProject builds a fresh
	// one for the new repo and Closes the old.
	convWorktrees *core.ConvWorktrees
}

// repoRemapper returns a path remapper for a conversation: a function that
// redirects an already-validated real path into that conversation's dedicated
// git worktree of whichever repository the path belongs to (see
// core.ConvWorktrees.Remap). Returns nil (⇒ no redirect) in no-project mode,
// when isolation is disabled, or for an empty convID — so ops keep operating on
// the real project path. This is how every conversation-aware surface (ops, the
// streaming shell) routes into the right per-(conversation, repo) worktree.
func (s *Server) repoRemapper(convID string) func(string) string {
	st := s.projectState.Load()
	if st == nil || st.convWorktrees == nil || convID == "" {
		return nil
	}
	cw := st.convWorktrees
	return func(absPath string) string { return cw.Remap(convID, absPath) }
}

// worktreeForRepo resolves a conversation's worktree for one repository toplevel
// (used by the git-status card to scan each discovered repo in the
// conversation's checkout). "" when isolation doesn't apply.
func (s *Server) worktreeForRepo(convID, repoTop string) string {
	st := s.projectState.Load()
	if st == nil || st.convWorktrees == nil {
		return ""
	}
	return st.convWorktrees.WorktreeForRepo(convID, repoTop)
}

// releaseConvWorktree prunes a deleted conversation's worktrees (permanent +
// pristine only). Safe no-op in no-project mode or when isolation is disabled.
func (s *Server) releaseConvWorktree(convID string, permanent bool) {
	st := s.projectState.Load()
	if st != nil && st.convWorktrees != nil {
		st.convWorktrees.Release(convID, permanent)
	}
}

// newConvWorktrees builds the per-conversation worktree registry for a project
// path. It returns nil in no-project mode. Whether isolation is actually active
// is decided inside core.ConvWorktrees from the enabled flag (worktreeEnabledFor)
// and whether the path is a git repo.
func (s *Server) newConvWorktrees(path string) *core.ConvWorktrees {
	if path == "" {
		return nil
	}
	return core.NewConvWorktrees(path, worktreesHome(), s.worktreeEnabledFor(path))
}

// worktreeEnabledFor decides whether per-conversation worktree isolation is on
// for path: an explicit --worktree/--no-worktree launch flag wins; otherwise the
// project's own config decides, defaulting to on.
func (s *Server) worktreeEnabledFor(path string) bool {
	if s.worktreeOverride != nil {
		return *s.worktreeOverride
	}
	cfg, err := core.LoadConfig(path)
	if err != nil {
		return true // config unreadable — fall back to the default (on)
	}
	return cfg.Project.WorktreeEnabled()
}

// SessionManager returns the current per-project SessionManager (always non-nil).
func (s *Server) SessionManager() *core.SessionManager {
	st := s.projectState.Load()
	if st == nil {
		return nil
	}
	return st.sessionManager
}

// ProjectPath returns the current project path. "" means no project loaded.
func (s *Server) ProjectPath() string {
	st := s.projectState.Load()
	if st == nil {
		return ""
	}
	return st.projectPath
}

// FileWatcher returns the current file watcher, or nil in no-project mode.
func (s *Server) FileWatcher() *core.FileWatcher {
	st := s.projectState.Load()
	if st == nil {
		return nil
	}
	return st.fileWatcher
}

// switchToken is a buffered-size-1 channel used as a single-token lock to
// serialize SwitchProject calls. It is held only for the duration of one
// switch and never around request handling. The atomic pointer on
// projectState makes all readers lock-free.

// SwitchProject tears down the current project state and replaces it with
// state for newPath. newPath == "" switches to no-project mode. The HTTP
// server, websockets, engine, and worker manager all keep running. After
// the swap completes, every connected viewer receives a "project-changed"
// broadcast so it reloads its session.
//
// This is the only mutator of s.projectState. It is serialized internally.
func (s *Server) SwitchProject(newPath string) error {
	if newPath != "" {
		abs, err := filepath.Abs(newPath)
		if err != nil {
			return fmt.Errorf("%w: %v", core.ErrProjectNotFound, err)
		}
		info, statErr := os.Stat(abs)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				return fmt.Errorf("%w: %s", core.ErrProjectNotFound, abs)
			}
			return fmt.Errorf("%s: %w", abs, statErr)
		}
		if !info.IsDir() {
			return fmt.Errorf("%w: %s", core.ErrProjectNotDir, abs)
		}
		newPath = abs
	}

	<-s.switchToken
	defer func() { s.switchToken <- struct{}{} }()

	old := s.projectState.Load()
	if old != nil && old.projectPath == newPath {
		return nil // no-op
	}

	// Acquire instance lock for the new project (skip in no-project mode).
	var newLock *core.InstanceLock
	if newPath != "" {
		newLock = core.NewInstanceLock(newPath)
		res, err := newLock.TryAcquire(s.getPort(), s.host())
		if err != nil {
			return fmt.Errorf("failed to check instance lock: %w", err)
		}
		if !res.Acquired {
			isRunning, _ := core.VerifyInstance(res.Existing, newPath)
			if isRunning {
				return fmt.Errorf("%w (open at http://%s:%d/)", core.ErrProjectLocked, res.Existing.Host, res.Existing.Port)
			}
			// stale lock — retry once
			res, err = newLock.TryAcquire(s.getPort(), s.host())
			if err != nil || !res.Acquired {
				return fmt.Errorf("failed to acquire instance lock for %s", newPath)
			}
		}
	}

	// Build new SessionManager + FileWatcher.
	newMgr, err := core.NewSessionManagerForPath(newPath)
	if err != nil {
		if newLock != nil {
			_ = newLock.Release()
		}
		return fmt.Errorf("failed to create session manager: %w", err)
	}

	var newWatcher *core.FileWatcher
	if newPath != "" {
		fw, err := core.NewFileWatcher(newPath)
		if err != nil {
			jlog.Error("Failed to create file watcher for %s: %v", newPath, err)
		} else {
			newWatcher = fw
			fw.Start()
		}
	}

	newState := &projectState{
		projectPath:    newPath,
		sessionManager: newMgr,
		fileWatcher:    newWatcher,
		lock:           newLock,
		fileChangesCh:  make(chan struct{}),
		viewers:        newViewerGroup(),
		convWorktrees:  s.newConvWorktrees(newPath),
	}

	// Atomic swap.
	s.projectState.Store(newState)

	// Start the new file-change forwarder if we got a watcher.
	if newWatcher != nil {
		go s.forwardFileChanges(newState)
	} else {
		close(newState.fileChangesCh)
	}

	// Tear down old asynchronously (gives in-flight handlers time to drain).
	if old != nil {
		go func(prev *projectState) {
			time.Sleep(250 * time.Millisecond)
			if prev.fileWatcher != nil {
				prev.fileWatcher.Stop()
			}
			// Wait for the previous file-change forwarder to exit so we
			// don't double-broadcast.
			if prev.fileChangesCh != nil {
				<-prev.fileChangesCh
			}
			if prev.viewers != nil {
				prev.viewers.stop()
			}
			if prev.sessionManager != nil {
				prev.sessionManager.Shutdown()
			}
			if prev.convWorktrees != nil {
				prev.convWorktrees.Close()
			}
			if prev.lock != nil {
				_ = prev.lock.Release()
			}
		}(old)
	}

	// Notify all clients.
	s.broadcastToAll(map[string]any{
		"type":        "project-changed",
		"projectPath": newPath,
	})

	jlog.Info("📁 Switched project to %q", newPath)
	return nil
}

// forwardFileChanges batches a projectState's file-watcher events and
// broadcasts them. It exits when the watcher's Changes channel closes (Stop
// was called), then closes fileChangesCh so SwitchProject knows the previous
// forwarder is done.
func (s *Server) forwardFileChanges(st *projectState) {
	defer close(st.fileChangesCh)

	const batchWindow = 100 * time.Millisecond
	const maxBatchSize = 50

	var batch []core.FileChange
	ticker := time.NewTicker(batchWindow)
	defer ticker.Stop()

	for {
		select {
		case notification, ok := <-st.fileWatcher.Changes():
			if !ok {
				if len(batch) > 0 {
					s.flushFileChangeBatch(batch)
				}
				return
			}
			batch = append(batch, notification.Changes...)
			if len(batch) >= maxBatchSize {
				s.flushFileChangeBatch(batch)
				batch = nil
			}
		case <-ticker.C:
			if len(batch) > 0 {
				s.flushFileChangeBatch(batch)
				batch = nil
			}
		}
	}
}

// convDir resolves a conversation's on-disk directory via the current session
// manager, returning ("", false) when no project is loaded. It is the shared
// path provider for worker path resolution and the per-conversation asset store.
func (s *Server) convDir(convID string) (string, bool) {
	sm := s.SessionManager()
	if sm == nil {
		return "", false
	}
	return sm.ConvDir(convID)
}

// host returns the configured listen host for instance-lock writes. addr is
// "host:port"; an empty or unparseable host defaults to "localhost".
func (s *Server) host() string {
	h, _, err := net.SplitHostPort(s.addr)
	if err != nil || h == "" {
		return "localhost"
	}
	return h
}
