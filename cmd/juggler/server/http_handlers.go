//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"
)

// handleHealthActive returns whether any conversation is actively running a turn
// (turns parked solely on a pending tool approval are not counted — they survive
// a restart intact, so callers like the desktop quit guard need not warn). The
// machine server polls it every couple of seconds, so it is a read: it asks no
// conversation's actor anything. Whether anything holds the session is asked
// only by a retirement (handleHealthRetire).
func (s *Server) handleHealthActive(w http.ResponseWriter, r *http.Request) {
	ids := []string{}
	if s.workerManager != nil {
		ids = s.ActiveConversationIDs()
	}
	handlers.WriteJSON(w, r, 0, map[string]any{
		"active":          len(ids) > 0,
		"conversationIds": ids,
	})
}

// handleHealthInstance returns this server's identity: its project, process
// and start time.
func (s *Server) handleHealthInstance(w http.ResponseWriter, r *http.Request) {
	// relaunchGen reflects how many times the main-thread watchdog has
	// re-exec'd this server in place (JUGGLER_RELAUNCH_GEN, set on each
	// re-exec). 0 for a normally-launched process. Surfaced for observability:
	// a non-zero value means this process is a self-recovered relaunch.
	relaunchGen, _ := strconv.Atoi(os.Getenv("JUGGLER_RELAUNCH_GEN"))
	handlers.WriteJSON(w, r, 0, map[string]any{
		"status":      "ok",
		"projectPath": s.ProjectPath(),
		"pid":         os.Getpid(),
		"startedAt":   s.startTime.Format(time.RFC3339),
		"relaunchGen": relaunchGen,
	})
}

// BindPort finds and binds to an available port but doesn't start serving
func (s *Server) BindPort() error {
	listener, actualAddr, err := s.findAvailablePort()
	if err != nil {
		return fmt.Errorf("failed to find available port: %w", err)
	}

	s.listener = listener
	s.addr = actualAddr
	jlog.Info("🤹 Juggler server starting on http://%s\n", s.addr)

	return nil
}
