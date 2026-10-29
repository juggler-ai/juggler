//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"time"

	"juggler/cmd/juggler/server/handlers"
)

// Supervisor is how a session child reaches the machine server that spawned
// it (ingress.SupervisorAddrEnv/TokenEnv/SessionEnv): its loopback address
// and control token, and the child's session id there. Zero for a server with
// no machine server.
type Supervisor struct {
	Addr  string
	Token string
	// Session is this child's session id at the machine server, which names
	// the links that open it ("" names none).
	Session string
}

// supervisorCallTimeout bounds one call passed on to the machine server. The
// machine server answers these from memory, except a tunnel's start, which
// waits on its provider (a rendezvous, a cloudflared URL).
const supervisorCallTimeout = 2 * time.Minute

// maxExposureBody bounds the body of a switch passed on to the machine server.
const maxExposureBody = 64 << 10

// setupConnectivityRoutes registers the session's Settings → Connectivity:
// GET /api/connectivity (who else is connected), the switches for LAN access
// and tunnels, and which of them opens whenever Juggler starts. Those are the
// machine server's, machine-wide; a viewer on this machine switches and saves
// them from any session, which passes the call on (exposureRoute).
func (s *Server) setupConnectivityRoutes() {
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/connectivity", s.handleGetConnectivity).Methods("GET")
	api.Handle("/connectivity/lan", s.exposureRoute("/api/server/lan")).Methods("GET", "PUT")
	api.Handle("/connectivity/tunnel", s.exposureRoute("/api/server/tunnel")).Methods("GET", "PUT")
	api.Handle("/connectivity/launch", s.exposureRoute("/api/server/launch")).Methods("GET", "PUT")
}

func (s *Server) handleGetConnectivity(w http.ResponseWriter, r *http.Request) {
	// One descriptor per connected viewer (this client included). The UI excludes
	// itself by id to show how many OTHER clients share the session.
	clients := s.hub.viewerClients()
	handlers.WriteJSON(w, r, 0, map[string]any{
		"clientCount": len(clients),
		"clients":     clients,
		// exposure: this viewer may switch LAN access and tunnels here, and
		// choose which opens at start.
		"exposure": s.supervisor.Addr != "" && isLocalDirect(r),
	})
}

// exposureRoute passes a GET or PUT to the machine server's route at path,
// with the control token, and hands back its answer as it stands. It names
// this session, so the answer carries, beside each address of the machine,
// the link that opens this session through it (?session=). Only a viewer on
// this machine may (the machine server's localOnly, which cannot tell callers
// apart once they arrive from here); a session with no machine server has no
// such route.
func (s *Server) exposureRoute(path string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.supervisor.Addr == "" {
			http.NotFound(w, r)
			return
		}
		if !isLocalDirect(r) {
			http.Error(w, "Only this machine can do that.", http.StatusForbidden)
			return
		}
		target := "http://" + s.supervisor.Addr + path
		if s.supervisor.Session != "" {
			target += "?session=" + url.QueryEscape(s.supervisor.Session)
		}
		ctx, cancel := context.WithTimeout(r.Context(), supervisorCallTimeout)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, r.Method, target,
			http.MaxBytesReader(w, r.Body, maxExposureBody))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		req.Header.Set("X-Juggler-Token", s.supervisor.Token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req) //nolint:gosec // loopback machine server named by our spawner
		if err != nil {
			http.Error(w, "The machine server could not be reached.", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		if ct := resp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	})
}
