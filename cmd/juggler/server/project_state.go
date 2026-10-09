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
	"juggler/cmd/juggler/mcp"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/workspace"
	"juggler/internal/jlog"
)

// taskStopGrace is how long a background task has to act on the polite stop
// signal before its process group is taken. Short on purpose: it is paid on the
// shutdown path, where the alternative to a brisk kill is a hang.
const taskStopGrace = 250 * time.Millisecond

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

	// teardownDone is closed once this state has been fully released by the
	// goroutine SwitchProject leaves behind: watcher stopped, forwarder exited,
	// session manager down, instance lock released. Releasing the lock is what
	// closes the OS handle on the project's juggler.lock, so this is the only
	// point at which nothing of the project is held open any more. Nil on a
	// state assembled by hand, which carries no such signal.
	teardownDone chan struct{}

	// viewerGroup owns this project's viewer-role clients, request cancel
	// map, and shell cancel map. Project-scoped so a SwitchProject cleanly
	// cancels in-flight work tied to the old project.
	viewers *viewerGroup
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

// WorkspaceLookup resolves workspace ids against the live session, rather than
// against a table captured when something was built: a project switch retargets
// it, and a workspace registered a moment ago resolves without rebuilding
// anything. Everything that acts on a conversation's binding asks through this
// one func, by way of Workspaces.
func (s *Server) WorkspaceLookup() core.WorkspaceLookup {
	return func(id string) (core.Workspace, bool) {
		mgr := s.SessionManager()
		if mgr == nil {
			return core.Workspace{}, false
		}
		return mgr.GetWorkspace(id)
	}
}

// Workspaces is the resolver everything that acts on a conversation's tree goes
// through — the ops API, the streaming shell, "@" completion, the git views, the
// directory a turn's provider spawns in, the sandbox's imports — so the answer,
// or the refusal, cannot differ between them. It reads the live project, session
// and path index on every Resolve, so it never needs rebuilding.
func (s *Server) Workspaces() *workspace.Resolver {
	return workspace.NewResolver(s.ProjectPath, s.WorkspaceLookup(), func() ops.PathSearcher {
		if fw := s.FileWatcher(); fw != nil {
			return fw.Index()
		}
		return nil
	})
}

// turnDir is the directory a conversation's turn runs in, as a provider is told
// it (provider.Config.WorkspaceRoot): "" when it is bound to nothing, so the
// provider roots itself at the project, and the workspace's
// LocalDir otherwise.
//
// An unusable workspace (still provisioning, closed, root gone, never
// registered) returns the error that says which — failing the turn rather than
// quietly running it in the project, where it would edit the wrong tree and
// look exactly like working. So does a workspace with no directory on this
// machine when the provider is one Juggler spawns as a subprocess
// (ProviderInfo.SpawnsLocalProcess): that CLI would run here while every
// operation of the turn ran somewhere else. A provider reached over HTTP is
// told nothing and runs as it would anywhere.
func turnDir(resolve workspace.ResolveFunc, workspaceID, providerName string) (string, error) {
	if workspaceID == core.DefaultWorkspaceID {
		return "", nil
	}
	ws, err := resolve(workspaceID)
	if err != nil {
		return "", err
	}
	if dir, ok := ws.LocalDir(); ok {
		return dir, nil
	}
	if info, found := provider.GetProviderInfo(providerName); found && info.SpawnsLocalProcess {
		name := info.DisplayName
		if name == "" {
			name = providerName
		}
		return "", fmt.Errorf("%s runs on this machine, and workspace %s is not on it — pick a model that does not run locally", name, ws.Name())
	}
	return "", nil
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
		teardownDone:   make(chan struct{}),
		viewers:        newViewerGroup(),
	}

	// Atomic swap.
	s.projectState.Store(newState)

	// Release the previous project's cached conversations — and the live CLI
	// subprocesses they hold — now that the project has changed. Conversations
	// are project-bound (transcript directory, warm-resume sidecar, CLAUDE.md),
	// so they must not outlive the switch; the next turn re-opens under
	// newState, re-initializing providers against the new project root. Done
	// after the swap so any concurrent GetOrOpen re-initializes with newPath.
	if s.conversationCache != nil {
		s.conversationCache.CloseAllConversations()
	}

	// Start the new file-change forwarder if we got a watcher.
	if newWatcher != nil {
		go s.forwardFileChanges(newState)
	} else {
		close(newState.fileChangesCh)
	}

	// Tear down old asynchronously (gives in-flight handlers time to drain).
	if old != nil {
		go func(prev *projectState) {
			if prev.teardownDone != nil {
				defer close(prev.teardownDone)
			}
			time.Sleep(250 * time.Millisecond)
			// A background task runs in the project it was started in and is
			// addressed through that project's session. Once the switch is done
			// nothing can reach it — not to read it, not to stop it — so leaving
			// it running would leave a process nobody can see doing work in a
			// directory nobody is looking at.
			if stopped := ops.StopBackgroundTasks(prev.projectPath, "Stopped when the project changed", taskStopGrace); stopped > 0 {
				jlog.Info("⏹️  Stopped %d background task(s) from the previous project", stopped)
			}
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
			if prev.lock != nil {
				_ = prev.lock.Release()
			}
		}(old)
	}

	// MCP config is per-project (global mcp.json plus the project's own), so the
	// new project's servers start here rather than when something next asks for a
	// tool list — by which time a turn may already have been sent without them.
	mcp.StartDiscovery(newPath)

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

// convName resolves a conversation's human-readable name via the current
// session manager, returning ("", false) when no project is loaded. It is the
// name provider workers use for their log filenames and the auto-naming gate.
func (s *Server) convName(convID string) (string, bool) {
	sm := s.SessionManager()
	if sm == nil {
		return "", false
	}
	return sm.ConvName(convID)
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
