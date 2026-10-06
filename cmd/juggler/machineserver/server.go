//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package machineserver implements `juggler serve`: the persistent, per-machine
// supervisor + broker. It owns a registry of per-project session children
// (today's server, spawned with --session-child), a single client-facing
// endpoint that reverse-proxies /s/<id>/… to the owning child, and a control
// API to list/spawn/stop sessions. It is a plain HTTP process: no engine, no
// webview, no providers.
package machineserver

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/internal/hostcheck"
	"juggler/internal/jlog"
)

// Server is the machine server: registry, control API, and session proxy.
type Server struct {
	reg         *registry
	lock        *MachineLock
	childBin    string
	addr        string
	startedAt   time.Time
	httpSrv     *http.Server
	shutdownReq chan struct{} // control-API shutdown signal (buffered, len 1)
	// token is the control API's credential, minted per process and published
	// only in server.json (see tokenGuard). Empty refuses every caller.
	token string
	// lan is LAN access: off at startup, and while off every caller off
	// loopback is refused (see lanGate).
	lan atomic.Bool
	// testChildren (serve --test) spawns every child as a test server whose
	// test window loads its session through this server's proxy. Test
	// binaries only: a production-tagged child panics on --test.
	testChildren bool
}

// TokenHeader carries the control-API token on a request to /api/server/*.
const TokenHeader = "X-Juggler-Token"

// childExtraArgs returns the flags a session child gets beyond the fixed
// ones. Under --test, each child runs the test harness in a window pointed at
// its own session URL here, so a browser test drives it through the proxy.
func (s *Server) childExtraArgs(sessionID string) []string {
	if !s.testChildren {
		return nil
	}
	return []string{"--test", "--assets-from-disk",
		"--test-window-url", "http://" + s.addr + "/s/" + sessionID + "/"}
}

// routes builds the machine server's handler: the control API under
// /api/server, plus the /s/<id>/ session proxy. Everything is wrapped in the
// LAN gate, then the host guard, then the origin guard, so no caller off
// loopback gets in while LAN access is off, and neither a DNS-rebinding page
// nor a drive-by page on another origin can drive the control API or ride the
// proxy. The control API alone also takes the token (tokenGuard); a session's
// routes are guarded by its child, with the child's own token.
func (s *Server) routes() http.Handler {
	r := mux.NewRouter()
	api := r.PathPrefix("/api/server").Subrouter()
	api.Use(s.tokenGuard)
	api.HandleFunc("/status", s.handleStatus).Methods("GET")
	api.HandleFunc("/sessions", s.handleListSessions).Methods("GET")
	api.HandleFunc("/sessions", s.handleOpenSession).Methods("POST")
	api.HandleFunc("/sessions/{id}", s.handleStopSession).Methods("DELETE")
	api.HandleFunc("/shutdown", s.handleShutdown).Methods("POST")
	r.HandleFunc("/s/{id}", s.redirectSession)
	r.PathPrefix("/s/{id}/").HandlerFunc(s.handleSessionProxy)
	return s.lanGate(hostGuard(originGuard(r)))
}

// mintToken returns a fresh random control-API token.
func mintToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// A guessable token would hand the control API to anything that can
		// reach the port, so refuse to start rather than serve with one.
		panic("machineserver.mintToken: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// tokenGuard holds the control API to the same discipline as a session
// child's /api: the request must carry the token, in TokenHeader, or it is
// refused with 401 before the route runs. The token is published only in
// server.json, which only the user the server runs as can read, so it is what
// tells this user's own clients apart from anything else that can reach the
// port — another account on this machine, or a page that got past the Host
// and Origin guards. A custom header also forces a CORS preflight on any
// cross-origin fetch, which the origin guard then refuses. A server with no
// token refuses everyone; an empty header never matches.
func (s *Server) tokenGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get(TokenHeader)
		if s.token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			http.Error(w, "Unauthorized: missing or invalid server token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// lanGate refuses every caller off loopback while LAN access is off, whatever
// it asks for, before anything is forwarded. It is the machine server's half
// of exposure: behind the proxy a child's own LAN gate cannot hold, since every
// caller reaches the child from here over loopback, and one the proxy vouches
// for as remote is admitted by the child's gate on that tag.
func (s *Server) lanGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.lan.Load() && callerIsRemote(r) {
			http.Error(w, "Forbidden: this Juggler server accepts connections from this machine only", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// hostGuard is the machine server's DNS-rebinding defence: every request must
// name this machine in its Host (hostcheck.NamesThisMachine), whoever sends it
// and whatever it asks for. A rebinding page passes originGuard — its Origin
// and Host are both the attacker's domain — so without this it could drive the
// control API from loopback, and load a session's page (which carries that
// child's API token) and open its WebSocket. Behind the proxy the child cannot
// make up for it: a caller off loopback reaches it tagged as remote ingress,
// which skips its own Host check and its viewer-socket token. So the check is
// made here, once, before anything is forwarded.
func hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostcheck.NamesThisMachine(r.Host) {
			http.Error(w, hostcheck.RefusalMessage(r.Host), http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// originGuard rejects browser requests whose Origin is a different host. A
// request with no Origin (curl, the desktop app, same-origin fetches without
// one) passes; a cross-origin page's fetch/POST against the loopback control
// API is refused. The session children keep their own per-instance API-token
// auth behind the proxy — this guard is the machine server's own surface.
func originGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" {
			u, err := url.Parse(o)
			if err != nil || u.Host != r.Host {
				http.Error(w, "cross-origin request rejected", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// statusResponse is the GET /api/server/status payload — the machine-scope
// analogue of a child's /api/health/instance, used by discovery to classify a
// lock holder as healthy or stale.
type statusResponse struct {
	Status    string    `json:"status"`
	PID       int       `json:"pid"`
	Addr      string    `json:"addr"`
	Version   string    `json:"version"`
	StartedAt time.Time `json:"startedAt"`
	Sessions  int       `json:"sessions"`
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, statusResponse{
		Status:    "ok",
		PID:       os.Getpid(),
		Addr:      s.addr,
		Version:   core.Version,
		StartedAt: s.startedAt,
		Sessions:  len(s.reg.snapshot()),
	})
}

func (s *Server) handleListSessions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.reg.snapshot())
}

// handleOpenSession spawns (or reuses) the session child for a project.
// POST /api/server/sessions {"project": "/abs/or/relative/path"}.
// Reuse returns the live record; a fresh spawn blocks until the child reports
// its address (bounded by childStartTimeout) and returns 201.
func (s *Server) handleOpenSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Project string `json:"project"`
	}
	body := http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	project, err := resolveProject(req.Project)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	sess, created := s.reg.reserve(project)
	if !created {
		// A running child, or a spawn already in flight (state "starting" —
		// the caller polls the sessions list until it flips).
		writeJSON(w, http.StatusOK, sess)
		return
	}

	c, err := spawnChild(s.childBin, project, s.childExtraArgs(sess.ID))
	if err != nil {
		jlog.Error("[machineserver] spawn failed for %s: %v", project, err)
		s.reg.setError(sess.ID, err.Error())
		errSess, _ := s.reg.get(sess.ID)
		writeJSON(w, http.StatusBadGateway, errSess)
		return
	}
	if !s.reg.setRunning(sess.ID, c, c.cmd.Process.Pid) {
		// The reservation vanished while we were spawning — don't leak an
		// unsupervised child.
		c.stop()
		http.Error(w, "session was removed during spawn", http.StatusConflict)
		return
	}
	// Surface an unexpected child exit in the registry. A supervised stop
	// (beginStop) is exempt inside noteExit.
	go func() {
		<-c.exited
		s.reg.noteExit(sess.ID)
	}()
	go s.pollActivity(sess.ID, c, activityPollInterval)
	jlog.Info("[machineserver] session %s: %s at %s (pid %d)", sess.ID, project, c.addr, c.cmd.Process.Pid)
	sess, _ = s.reg.get(sess.ID)
	writeJSON(w, http.StatusCreated, sess)
}

// handleStopSession stops a session child and drops its registry entry.
// DELETE /api/server/sessions/{id}.
func (s *Server) handleStopSession(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if c, ok := s.reg.beginStop(id); ok {
		c.stop()
		s.reg.remove(id)
		jlog.Info("[machineserver] session %s stopped", id)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	sess, ok := s.reg.get(id)
	if !ok {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	if sess.State == SessionStarting {
		// Its spawner still holds the reservation; removing it now would leak
		// the child the spawner is about to register.
		http.Error(w, "session is still starting", http.StatusConflict)
		return
	}
	// No live child (an errored entry) — just drop the record.
	s.reg.remove(id)
	w.WriteHeader(http.StatusNoContent)
}

// handleShutdown asks the whole machine server to shut down gracefully.
// Responds 202 first; the run loop drains children after.
func (s *Server) handleShutdown(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusAccepted)
	select {
	case s.shutdownReq <- struct{}{}:
	default:
	}
}

// stopAllChildren stops every session child concurrently and waits for them.
// Part of server shutdown: called after the HTTP listener stops accepting.
func (s *Server) stopAllChildren() {
	done := make(chan struct{})
	n := 0
	for _, sess := range s.reg.snapshot() {
		c, ok := s.reg.beginStop(sess.ID)
		if !ok {
			s.reg.remove(sess.ID)
			continue
		}
		n++
		go func(id string, c *child) {
			c.stop()
			s.reg.remove(id)
			done <- struct{}{}
		}(sess.ID, c)
	}
	for range n {
		<-done
	}
}

// resolveProject validates a control-API project path: absolute-ized, must
// exist, must be a directory. Mirrors the --project validation in the child.
func resolveProject(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("project path is required")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("project %s: %w", p, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("project %s: %w", abs, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("project %s: not a directory", abs)
	}
	return abs, nil
}

// childBinPath locates the binary to spawn session children from:
// $JUGGLER_SERVER_BIN if set (dev/test override), else our own executable —
// the machine server and the session child are the same binary.
func childBinPath() (string, error) {
	if env := os.Getenv("JUGGLER_SERVER_BIN"); env != "" {
		return env, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("cannot locate own executable to spawn session children: %w", err)
	}
	return exe, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		jlog.Error("[machineserver] failed to encode response: %v", err)
	}
}
