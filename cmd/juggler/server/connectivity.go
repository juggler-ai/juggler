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
	"juggler/internal/jlog"

	"github.com/gorilla/mux"
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
// them from any session, which passes the call on (exposureRoute). So does
// GET /api/connectivity/server, the machine server's status: which process it
// is, and whether the desktop app started it or someone at a terminal. And
// GET /api/machine/events relays the machine server's events to the page
// (handleMachineEvents), and /api/machine/sessions and /api/machine/folders
// pass on the page's switcher's opens, stops and new folders (machineRoute).
func (s *Server) setupConnectivityRoutes() {
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/connectivity", s.handleGetConnectivity).Methods("GET")
	api.Handle("/connectivity/lan", s.exposureRoute("/api/server/lan")).Methods("GET", "PUT")
	api.Handle("/connectivity/tunnel", s.exposureRoute("/api/server/tunnel")).Methods("GET", "PUT")
	api.Handle("/connectivity/launch", s.exposureRoute("/api/server/launch")).Methods("GET", "PUT")
	api.Handle("/connectivity/server", s.exposureRoute("/api/server/status")).Methods("GET")
	// Before the events route: gorilla/mux answers a wrong method with 405
	// only when no route with a method of its own follows the one whose path
	// it matched.
	api.Handle("/machine/sessions", s.machineRoute(func(*http.Request) string { return "/api/server/sessions" })).Methods("POST")
	api.Handle("/machine/sessions/{id}", s.machineStopRoute()).Methods("DELETE")
	api.Handle("/machine/folders", s.machineRoute(func(*http.Request) string { return "/api/server/folders" })).Methods("POST")
	api.HandleFunc("/machine/events", s.handleMachineEvents).Methods("GET")
}

// machineRoute passes a call of the page's switcher — open a session, make a
// folder — to the machine server's route at path(r), with the control token,
// and hands back its answer as it stands. Like the events relay, the page
// holds no control token and any viewer this child's own auth admits may ask:
// the sessions page lets any viewer, on this machine or off it, do the same.
// A session with no machine server has no such route.
func (s *Server) machineRoute(path func(*http.Request) string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.supervisor.Addr == "" {
			http.NotFound(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), supervisorCallTimeout)
		defer cancel()
		resp, err := s.callSupervisor(ctx, r.Method, path(r), http.MaxBytesReader(w, r.Body, maxExposureBody))
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

// machineStopRoute passes a stop of a session to the machine server, as
// machineRoute does. A stop of this child's own session is answered 202 at
// once and passed on after: the machine server's stop waits for this child to
// exit, and the child's shutdown waits for its handlers, so a relay that
// waited for the answer would hold up its own teardown. DELETE
// /api/machine/sessions/{id}.
func (s *Server) machineStopRoute() http.Handler {
	relay := s.machineRoute(func(r *http.Request) string {
		return "/api/server/sessions/" + url.PathEscape(mux.Vars(r)["id"])
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["id"]
		if s.supervisor.Addr == "" || id == "" || id != s.supervisor.Session {
			relay.ServeHTTP(w, r)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), supervisorCallTimeout)
			defer cancel()
			resp, err := s.callSupervisor(ctx, http.MethodDelete, "/api/server/sessions/"+url.PathEscape(id), http.NoBody)
			if err != nil {
				jlog.Error("[server] stopping its own session %s: %v", id, err)
				return
			}
			_ = resp.Body.Close()
		}()
	})
}

// callSupervisor sends one call to the machine server's path with the control
// token.
func (s *Server) callSupervisor(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, "http://"+s.supervisor.Addr+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Juggler-Token", s.supervisor.Token)
	req.Header.Set("Content-Type", "application/json")
	return http.DefaultClient.Do(req) //nolint:gosec // loopback machine server named by our spawner
}

// handleMachineEvents relays the machine server's events stream — every
// session's attention and the recent projects, as the sessions page follows
// them — to this session's page, which shows what waits in the machine's
// other projects. GET /api/machine/events.
//
// The page holds this child's API token, not the control token, which can stop
// sessions; the child calls with the one it holds, naming its session, and
// passes back only what the stream says. So any viewer this child's own auth
// admits may follow it, on this machine or off it — a viewer off it already
// sees every project on the machine from the sessions page.
//
// Each read is written and flushed as it arrives, with no bound on the whole:
// the stream lasts as long as the viewer's request, and ends the upstream one
// when that goes. A session with no machine server has no stream to relay.
func (s *Server) handleMachineEvents(w http.ResponseWriter, r *http.Request) {
	if s.supervisor.Addr == "" {
		http.NotFound(w, r)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	target := url.URL{Scheme: "http", Host: s.supervisor.Addr, Path: "/api/server/events"}
	if s.supervisor.Session != "" {
		target.RawQuery = url.Values{"session": {s.supervisor.Session}}.Encode()
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Juggler-Token", s.supervisor.Token)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req) //nolint:gosec // loopback machine server named by our spawner
	if err != nil {
		http.Error(w, "The machine server could not be reached.", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "The machine server refused its events.", http.StatusBadGateway)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	buf := make([]byte, 32<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			flusher.Flush()
		}
		if err != nil {
			return
		}
	}
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
