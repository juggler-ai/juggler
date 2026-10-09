//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"
)

// handleEngineStatus reports whether the engine is usable, and separately
// whether its socket is merely open. The two differ exactly when the engine has
// wedged — the case worth diagnosing — so both are published rather than folded
// into one flag.
func (s *Server) handleEngineStatus(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"connected": s.IsEngineConnected(),
		"socket":    s.engineClient.Load() != nil,
	}
	if c := s.engineClient.Load(); c != nil {
		body["silentFor"] = s.engineSilence().Round(time.Second).String()
		body["queuedWrites"] = c.QueuedWrites()
	}
	handlers.WriteJSON(w, r, 0, body)
}

// handleHealthActive returns whether any conversation is actively running a turn
// (turns parked solely on a pending tool approval are not counted — they survive
// a restart intact, so callers like the desktop quit guard need not warn).
func (s *Server) handleHealthActive(w http.ResponseWriter, r *http.Request) {
	ids := s.ActiveConversationIDs()
	handlers.WriteJSON(w, r, 0, map[string]any{
		"active":          len(ids) > 0,
		"conversationIds": ids,
	})
}

// handleHealthInstance returns detailed instance info for single-instance detection
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
		// parentPid + exitWithParent let a discovering viewer detect an
		// about-to-exit orphan: a --exit-with-parent server whose parent has died
		// is reparented to init/launchd (ppid<=1) and self-terminates imminently,
		// so a new viewer must spawn its own server rather than attach to this one.
		"parentPid":      os.Getppid(),
		"exitWithParent": s.exitWithParent,
		"startedAt":      s.startTime.Format(time.RFC3339),
		"relaunchGen":    relaunchGen,
	})
}

// handleShutdown initiates a graceful server shutdown
func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	jlog.Info("Shutdown requested via API")
	handlers.WriteJSON(w, r, http.StatusAccepted, map[string]any{
		"status":  "shutting_down",
		"message": "Graceful shutdown initiated",
	})

	// Trigger shutdown asynchronously
	go s.initiateShutdown()
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

// getPort returns the server's bound port (extracted from s.addr)
func (s *Server) getPort() int {
	_, portStr, err := net.SplitHostPort(s.addr)
	if err != nil {
		return 0
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return 0
	}
	return port
}
