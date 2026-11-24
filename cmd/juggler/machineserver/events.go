//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"juggler/internal/jlog"
)

// eventsKeepAlive is how often a quiet events stream sends a comment, so a
// proxy or tunnel between it and the page does not take it for dead.
const eventsKeepAlive = 25 * time.Second

// eventsPayload is a sessions event: what the sessions page shows of this
// machine, as GET /sessions and GET /recents serve it.
type eventsPayload struct {
	Sessions []Session       `json:"sessions"`
	Recents  recentsResponse `json:"recents"`
	// InstalledBuild is statusResponse.InstalledBuild: the build a relaunch
	// would take up, while there is another.
	InstalledBuild string `json:"installedBuild,omitempty"`
}

// handleEvents streams the sessions page's state as server-sent events: a
// sessions event at once, then another whenever what it carries has changed
// (registry.changes), never the same one twice running. It ends when the
// caller goes or the server's lifetime does, so a shutdown is never held by
// it; a lifetime ended to relaunch sends a last relaunching event, so
// a page knows the server is coming back. GET /api/server/events.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	base := s.requestBase(r)
	life := s.lifetime()
	keepAlive := time.NewTicker(eventsKeepAlive)
	defer keepAlive.Stop()
	var last []byte
	for {
		// Watched before reading, so a change between the two is not missed.
		changed := s.reg.changes()
		data, err := json.Marshal(eventsPayload{
			Sessions:       sessionsUnder(base, s.reg.snapshot()),
			Recents:        s.recentsNow().under(base),
			InstalledBuild: s.installedBuild(),
		})
		if err != nil {
			jlog.Error("[machineserver] encoding a sessions event: %v", err)
			return
		}
		if !bytes.Equal(data, last) {
			if _, err := fmt.Fprintf(w, "event: sessions\ndata: %s\n\n", data); err != nil {
				return
			}
			flusher.Flush()
			last = data
		}
		select {
		case <-r.Context().Done():
			return
		case <-life.Done():
			if s.ending.relaunching() {
				_, _ = fmt.Fprint(w, "event: relaunching\ndata: {}\n\n")
				flusher.Flush()
			}
			return
		case <-changed:
		case <-keepAlive.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
