//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/workspace"
)

// projectState holds the server's per-project resources: the project it was
// started for, which never changes. Reads are lock-free via the atomic pointer
// on Server, which is stored at startup (seedProjectState) and once more when
// the file watcher starts (StartBackgroundServices).
type projectState struct {
	projectPath    string
	sessionManager *core.SessionManager
	fileWatcher    *core.FileWatcher
	lock           *core.InstanceLock
	fileChangesCh  chan struct{} // closed when the file-change forwarder for this state has exited

	// viewers owns this project's viewer-role clients, request cancel map,
	// and shell cancel map.
	viewers *viewerGroup
}

// SessionManager returns the project's SessionManager.
func (s *Server) SessionManager() *core.SessionManager {
	st := s.projectState.Load()
	if st == nil {
		return nil
	}
	return st.sessionManager
}

// ProjectPath returns the project path.
func (s *Server) ProjectPath() string {
	st := s.projectState.Load()
	if st == nil {
		return ""
	}
	return st.projectPath
}

// WorkspaceLookup resolves workspace ids against the live session, rather than
// against a table captured when something was built: a workspace registered a
// moment ago resolves without rebuilding anything. Everything that acts on a conversation's binding asks through this
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

// FileWatcher returns the project's file watcher, or nil before it starts.
func (s *Server) FileWatcher() *core.FileWatcher {
	st := s.projectState.Load()
	if st == nil {
		return nil
	}
	return st.fileWatcher
}

// forwardFileChanges batches a projectState's file-watcher events and
// broadcasts them. It exits when the watcher's Changes channel closes (Stop
// was called), then closes fileChangesCh.
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
// manager, returning ("", false) when there is none. It is the shared
// path provider for worker path resolution and the per-conversation asset store.
func (s *Server) convDir(convID string) (string, bool) {
	sm := s.SessionManager()
	if sm == nil {
		return "", false
	}
	return sm.ConvDir(convID)
}

// convName resolves a conversation's human-readable name via the current
// session manager, returning ("", false) when there is none. It is the
// name provider workers use for their log filenames and the auto-naming gate.
func (s *Server) convName(convID string) (string, bool) {
	sm := s.SessionManager()
	if sm == nil {
		return "", false
	}
	return sm.ConvName(convID)
}
