//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"time"

	"juggler/cmd/juggler/gitops"
	"juggler/cmd/juggler/worker"
	"juggler/internal/jlog"
)

// turnSnapshotTimeout bounds one turn-start snapshot. The snapshot runs beside
// the turn's first model call, but the turn's tools wait for it, so a repository
// slow enough to reach it costs the turn its @turn baseline rather than holding
// its tools up.
const turnSnapshotTimeout = 5 * time.Second

// turnSnapshotter is the worker's TurnSnapshotFunc: it records the working tree
// the conversation's turn starts from — the project's, or its workspace's — as
// the conversation's turn snapshot. A tree in no repository, a workspace not on
// this machine or one that no longer resolves records nothing; a failure is
// logged and the turn goes on without a snapshot.
func (s *Server) turnSnapshotter() worker.TurnSnapshotFunc {
	return func(convID, workspaceID string) {
		dir := s.ProjectPath()
		if workspaceID != "" {
			ws, err := s.Workspaces().Resolve(workspaceID)
			if err != nil {
				jlog.Info("turn snapshot %s: workspace %s: %v", convID, workspaceID, err)
				return
			}
			local, ok := ws.LocalDir()
			if !ok {
				return
			}
			dir = local
		}
		if dir == "" {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), turnSnapshotTimeout)
		defer cancel()
		start := time.Now()
		if _, _, err := gitops.SnapshotTurn(ctx, s.GitQueue(), dir, convID); err != nil {
			jlog.Info("turn snapshot %s in %s: %v", convID, dir, err)
			return
		}
		jlog.Debug("turn snapshot %s in %s took %s", convID, dir, time.Since(start))
	}
}
