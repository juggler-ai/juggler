//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"io"
	"net/http"

	"juggler/cmd/juggler/server/handlers"
)

// handleHealthRetire is the authenticated conditional shutdown handshake. A 202
// means worker actors are quiesced and admission is irreversibly closed, not
// merely that an earlier activity sample looked idle; 409 means something holds
// the session and every worker has resumed. The decision runs to its end
// whether or not the caller stays: the answer is written before shutdown
// begins, and a caller that has gone learns a commit from this process's exit.
func (s *Server) handleHealthRetire(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, 1<<10))
	accepted := true
	if s.workerManager != nil {
		var err error
		accepted, err = s.workerManager.TryRetire()
		if err != nil {
			handlers.WriteJSON(w, r, http.StatusServiceUnavailable, map[string]any{"status": "unavailable"})
			return
		}
	}
	if !accepted {
		handlers.WriteJSON(w, r, http.StatusConflict, map[string]any{"status": "held"})
		return
	}
	handlers.WriteJSON(w, r, http.StatusAccepted, map[string]any{"status": "retiring"})
	s.initiateShutdown()
}
