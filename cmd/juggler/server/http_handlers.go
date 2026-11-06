//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/attention"
	"juggler/internal/jlog"
)

// handleHealthActive returns whether any conversation is actively running a turn
// (turns parked solely on a pending tool approval are not counted — they survive
// a restart intact, so callers like the desktop quit guard need not warn). The
// machine server polls it every couple of seconds, so it is a read: it asks no
// conversation's actor anything. Whether anything holds the session is asked
// only by a retirement (handleHealthRetire). attentionRev is the revision of
// the attention report (handleHealthAttention), which the poller fetches only
// when it moves; conversations is how many conversations the project has.
func (s *Server) handleHealthActive(w http.ResponseWriter, r *http.Request) {
	ids := []string{}
	var rev uint64
	if s.workerManager != nil {
		ids = s.ActiveConversationIDs()
		if project := s.ProjectPath(); project != "" {
			rev = s.workerManager.Attention(project).Rev
		}
	}
	conversations := 0
	if sm := s.SessionManager(); sm != nil {
		conversations = len(sm.ConvNames())
	}
	handlers.WriteJSON(w, r, 0, map[string]any{
		"active":          len(ids) > 0,
		"conversationIds": ids,
		"attentionRev":    rev,
		"conversations":   conversations,
	})
}

// handleHealthAttention reports which of the project's conversations wait on
// the user, are working, or failed (attention.Report), oldest first: those
// loaded as they stand, the rest as the project's saved summary last recorded
// them. A conversation whose folder has gone is left out. Like
// handleHealthActive it is a read and asks no actor anything.
func (s *Server) handleHealthAttention(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, s.attentionReport())
}

// attentionReport is the project's attention as handleHealthAttention serves
// it.
func (s *Server) attentionReport() attention.Report {
	report := attention.Report{Conversations: []attention.Conversation{}}
	project := s.ProjectPath()
	if s.workerManager == nil || project == "" {
		return report
	}
	summary := s.workerManager.Attention(project)
	report.Rev, report.LastActive = summary.Rev, summary.LastActive
	var names map[string]string
	if sm := s.SessionManager(); sm != nil {
		names = sm.ConvNames()
	}
	for id, e := range summary.Conversations {
		name, ok := names[id]
		if !ok {
			continue
		}
		report.Conversations = append(report.Conversations, attention.Conversation{ID: id, Name: name, Entry: e})
	}
	slices.SortFunc(report.Conversations, func(a, b attention.Conversation) int {
		if c := a.Since.Compare(b.Since); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return report
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
