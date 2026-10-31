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
	"cmp"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/tunnel"
	"juggler/cmd/juggler/webui"
	"juggler/internal/hostcheck"
	"juggler/internal/ingress"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
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
	// implicit is serve --implicit: a client started this server on demand.
	implicit bool
	// lan is LAN access: off unless serve --lan or this machine turns it on
	// (lan.go), and while off every caller off loopback is refused (lanGate).
	lan atomic.Bool
	// assets is the web tree the sessions page and its assets are served from
	// (ServeOptions.Assets); nil serves no page.
	assets fs.FS
	// recents is the machine's recent-projects list: every project a session
	// is opened for goes to its front, and the sessions page offers it back.
	recents *core.RecentsStore
	// uiLocale returns the UI language the sessions page is written in ("" for
	// the source language; nil is the same). serve reads it from settings.
	uiLocale func() string
	// restart governs respawning crashed children (zero: the defaults).
	restart restartPolicy
	// life is the server's root context (see lifetime), and endLife its cancel.
	lifeOnce sync.Once
	life     context.Context
	endLife  context.CancelFunc
	// work counts the claims on sessions (registry.open) not yet released:
	// every spawn in flight and every supervisor. Shutdown waits for it.
	work sync.WaitGroup
	// testChildren (serve --test) spawns every child as a test server whose
	// test window loads its session through this server's proxy. Test
	// binaries only: a production-tagged child panics on --test.
	testChildren bool
	// childDev and childAssetsFromDisk (serve --dev, --assets-from-disk) are
	// the developer flags this server passes to every child it spawns.
	childDev            bool
	childAssetsFromDisk bool
	// allowedHosts are the extra Host names a reverse proxy on this machine
	// serves this server under (serve --allow-host and the saved setting).
	// See hostGuard and callerKind.
	allowedHosts hostcheck.AllowList
	// starter holds startup until this pid attaches or dies; zero holds nothing.
	starter     int
	starterGone atomic.Bool
	// attached counts the clients holding the server up (see attach).
	attached atomic.Int64
	// closing is raised while a conditional shutdown decides (shutdownIf);
	// an attach that sees it refuses.
	closing atomic.Bool
	// attachments are the held POST /api/server/attach requests, by id
	// (*attachment; see checkAttachments).
	attachments sync.Map
	// build is what this server reports as its build (BuildOf its own
	// binary); "" reports its version alone.
	build string
	// peer answers a tunnel's WebRTC offers (ServeOptions.Peer); nil answers none.
	peer Peer
	// tunnel is the running tunnel, if any (tunnel.go).
	tunnel atomic.Pointer[runningTunnel]
	// ingress is the in-process listener a tunnel's data channels dial, and
	// ingressSrv what serves it; both started on first use (ingressServer).
	ingressOnce sync.Once
	ingress     atomic.Pointer[pipeListener]
	ingressSrv  atomic.Pointer[http.Server]
}

// TokenHeader carries the control-API token on a request to /api/server/*.
const TokenHeader = "X-Juggler-Token"

// lifetime is the server's root context. Every session's context derives from
// it, and endLifetime cancels it at shutdown. Made on first use, so a Server
// literal needs none.
func (s *Server) lifetime() context.Context {
	s.lifeOnce.Do(func() { s.life, s.endLife = context.WithCancel(context.Background()) })
	return s.life
}

// endLifetime cancels the root context: every backoff ends, every child still
// in its handshake is killed, and no session opens again.
func (s *Server) endLifetime() {
	s.lifetime()
	s.endLife()
}

// childExtraArgs returns the flags a session child gets beyond the fixed
// ones: this server's developer flags, and under --test the test harness, in
// a window pointed at the child's own session URL here, so a browser test
// drives it through the proxy (always from on-disk assets).
func (s *Server) childExtraArgs(sessionID string) []string {
	var args []string
	if s.childDev {
		args = append(args, "--dev")
	}
	if s.childAssetsFromDisk || s.testChildren {
		args = append(args, "--assets-from-disk")
	}
	if s.testChildren {
		args = append(args, "--test", "--test-window-url", "http://"+s.addr+"/s/"+sessionID+"/")
	}
	return args
}

// childEnv is what the child for session id is told of this server: its
// loopback address and control token (ingress.SupervisorAddrEnv/TokenEnv), by
// which the child serves its viewer's switches for LAN access and tunnels, and
// the session's id (SupervisorSessionEnv), by which it asks for the links that
// open it. It widens nothing: server.json already gives both to any process
// of this user, and the id is in every URL of the session. A server with no
// address or token yet tells nothing.
func (s *Server) childEnv(id string) []string {
	if s.addr == "" || s.token == "" {
		return nil
	}
	return []string{
		ingress.SupervisorAddrEnv + "=" + s.addr,
		ingress.SupervisorTokenEnv + "=" + s.token,
		ingress.SupervisorSessionEnv + "=" + id,
	}
}

// routes builds the machine server's handler: the sessions page at / and the
// assets it loads, the control API under /api/server, and the /s/<id>/ session
// proxy. Everything is wrapped in the
// tunnel gate, the LAN gate, then the host guard, then the origin guard, so no
// caller gets in through a tunnel that has closed, none off loopback while LAN
// access is off, and neither a DNS-rebinding page nor a drive-by page on
// another origin can drive the control API or ride the proxy. The control API alone also takes the token (tokenGuard); a session's
// routes are guarded by its child, with the child's own token.
func (s *Server) routes() http.Handler {
	r := mux.NewRouter()
	api := r.PathPrefix("/api/server").Subrouter()
	api.Use(s.tokenGuard)
	api.HandleFunc("/status", s.handleStatus).Methods("GET")
	api.HandleFunc("/sessions", s.handleListSessions).Methods("GET")
	api.HandleFunc("/sessions", s.handleOpenSession).Methods("POST")
	api.HandleFunc("/sessions/{id}", s.handleStopSession).Methods("DELETE")
	api.HandleFunc("/recents", s.handleRecents).Methods("GET")
	api.HandleFunc("/folders", s.handleCreateFolder).Methods("POST")
	api.HandleFunc("/shutdown", s.localOnly(s.handleShutdown)).Methods("POST")
	// Reading the ways in is this machine's alone, as switching them is: a
	// LAN viewer who could read the running tunnel's link would carry its
	// grant off the network.
	api.HandleFunc("/lan", s.localOnly(s.handleGetLAN)).Methods("GET")
	api.HandleFunc("/lan", s.localOnly(s.handleSetLAN)).Methods("PUT")
	api.HandleFunc("/tunnel", s.localOnly(s.handleGetTunnel)).Methods("GET")
	api.HandleFunc("/tunnel", s.localOnly(s.handleSetTunnel)).Methods("PUT")
	api.HandleFunc("/launch", s.localOnly(s.handleGetLaunch)).Methods("GET")
	api.HandleFunc("/launch", s.localOnly(s.handleSetLaunch)).Methods("PUT")
	api.HandleFunc("/attach", s.handleAttach).Methods("POST")
	api.HandleFunc("/attach/{id}/beat", s.handleBeat).Methods("POST")
	r.HandleFunc("/api/version", s.handleVersion).Methods("GET")
	r.HandleFunc("/s/{id}", s.redirectSession)
	r.PathPrefix("/s/{id}/").HandlerFunc(s.handleSessionProxy)
	r.HandleFunc("/", s.handlePage).Methods("GET")
	r.PathPrefix("/v" + assetVersion + "/").Handler(s.assetHandler()).Methods("GET")
	// What a desktop window showing the page drags by (page.go, IsWindow).
	r.HandleFunc("/wails/runtime.js", webui.ServeWailsRuntime).Methods("GET")
	r.HandleFunc("/wails/custom.js", webui.ServeWailsCustomJS).Methods("GET", "HEAD")
	return s.tunnelGate(s.lanGate(s.hostGuard(originGuard(r))))
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
// it asks for, before anything is forwarded. Exposure is the machine server's
// alone: a child binds loopback and every caller reaches it from here. A
// caller through the user's own reverse proxy (ingress.KindProxy) is not
// refused: naming the proxy's host is the user's grant. Nor is a tunnel's,
// whose gate is the tunnel's own (tunnelGate).
func (s *Server) lanGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.lan.Load() && s.callerKind(r) == ingress.KindLAN {
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
// made here, once, before anything is forwarded. The user's allowed hosts
// pass too: a name they list is one whose DNS they control, which is what a
// rebinding page lacks. So does a tunnel's caller naming the tunnel's own
// public host (tunnelHostAllowed).
func (s *Server) hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostcheck.NamesThisMachine(r.Host) && !s.allowedHosts.Has(r.Host) && !tunnelHostAllowed(r) {
			http.Error(w, hostcheck.Refusal(r.Host), http.StatusForbidden)
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
	// Implicit is serve --implicit (see ServerInfo.Implicit).
	Implicit bool `json:"implicit,omitempty"`
	// Attached is how many clients hold the server up (see attach).
	Attached int `json:"attached"`
	// AwaitingStarter is the client that started the server not yet attached,
	// which holds it up until it does or dies (ServeOptions.StartedBy).
	AwaitingStarter bool `json:"awaitingStarter,omitempty"`
	// AppStarted is a server the desktop app started: run with --started-by,
	// which only DetachedStarter passes. A server run in a terminal — bare
	// juggler, or juggler serve by hand — is not, implicit or not.
	AppStarted bool `json:"appStarted,omitempty"`
	// Build is which build of Version the server is (BuildOf).
	Build string `json:"build,omitempty"`
	// LAN is whether LAN access is on (lan.go).
	LAN bool `json:"lan"`
	// Tunnel is the mode of the running tunnel, if any (tunnel.go).
	Tunnel string `json:"tunnel,omitempty"`
	// TunnelTitle is that mode's title (tunnel.ModeSpec.Title), for a client
	// process with no modes registered to name it by.
	TunnelTitle *msg.Message `json:"tunnelTitle,omitempty"`
	// PeerIdentity is the fingerprint this machine presents to a peer, while a
	// tunnel is open and if it answers offers.
	PeerIdentity string `json:"peerIdentity,omitempty"`
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.status())
}

// status is the server's status record, as GET /api/server/status serves it.
func (s *Server) status() statusResponse {
	st := statusResponse{
		Status:    "ok",
		PID:       os.Getpid(),
		Addr:      s.addr,
		Version:   core.Version,
		StartedAt: s.startedAt,
		Sessions:  len(s.reg.snapshot()),
		Implicit:  s.implicit,
		Attached:  int(s.attached.Load()),
		Build:     cmp.Or(s.build, core.Version),
		LAN:       s.lan.Load(),
		// The same reading of the hold as heldUp's.
		AwaitingStarter: s.starter > 0 && !s.starterGone.Load(),
		AppStarted:      s.starter > 0,
	}
	// The peer identity is named while a tunnel is open, the only time a peer
	// can reach this machine. Asking for it reads or mints it, which every
	// client's status probe would otherwise do on a machine that never opens
	// one.
	if t := s.tunnel.Load(); t != nil {
		st.Tunnel = string(t.mode)
		st.TunnelTitle = modeTitle(st.Tunnel)
		if s.peer != nil {
			st.PeerIdentity = s.peer.Fingerprint()
		}
	}
	return st
}

// handleVersion serves the version and rendezvous protocol, with no token: a
// rendezvous bootstrap checks it before it loads the page. GET /api/version.
func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, versionResponse{Version: core.Version, ProtocolVersion: tunnel.RendezvousProtocolVersion})
}

func (s *Server) handleListSessions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.reg.snapshot())
}

// awaitingSpawn is called as an open with "wait" starts waiting for the spawn
// in flight for session id. A seam for tests, which settle the spawn only once
// the open is waiting on it.
var awaitingSpawn = func(string) {}

// handleOpenSession spawns (or reuses) the session child for a project (see
// openSession). POST /api/server/sessions {"project": "/abs/path" or
// "~/path", "wait": bool}.
func (s *Server) handleOpenSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Project string `json:"project"`
		Wait    bool   `json:"wait"`
	}
	body := http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeMessageError(w, http.StatusBadRequest, msg.New("invalid request body: {error}", "error", err.Error()))
		return
	}
	project, err := resolveProject(req.Project)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	res := s.openSession(r.Context(), project, req.Wait)
	switch {
	case res.status == 0:
		// The caller went while it waited: there is no one to answer.
	case res.refusal != nil:
		writeMessageError(w, res.status, *res.refusal)
	default:
		writeJSON(w, res.status, res.sess)
	}
}

// openResult is how an open went: the session's record and the status that
// reports it, or a refusal. A zero status means the caller went before there
// was an answer.
type openResult struct {
	sess    Session
	status  int
	refusal *msg.Message
}

// openSession spawns (or reuses) the session child for project, an absolute
// folder (resolveProject). Reuse answers 200 with the live record; a fresh
// spawn waits until the child reports its address (bounded by
// childStartTimeout) and answers 201. A spawn already in flight answers
// "starting" at once, or with wait once that spawn has settled, as a fresh one
// would (see awaitStarted). A wait ends early when caller ends. The server
// shutting down refuses with 503.
func (s *Server) openSession(caller context.Context, project string, wait bool) openResult {
	sess, cl, err := s.reg.open(s.lifetime(), project, &s.work)
	if err != nil {
		return refused(http.StatusServiceUnavailable, msg.New("the machine server is shutting down"))
	}
	if cl == nil {
		if sess.State == SessionStopping {
			if done := s.reg.whenStopped(sess.ID); done != nil {
				select {
				case <-done:
				case <-caller.Done():
					return openResult{}
				}
			}
			return s.openSession(caller, project, wait)
		}
		// A running child, or a spawn already in flight (state "starting"),
		// which the caller either waits for here or polls the sessions list
		// until it flips.
		if wait {
			return s.awaitStarted(caller, sess.ID)
		}
		return openResult{sess: sess, status: http.StatusOK}
	}

	c, err := spawnChild(cl.ctx, s.childBin, project, s.childExtraArgs(sess.ID), s.childEnv(sess.ID))
	if err != nil {
		if cl.ctx.Err() != nil {
			// A stop or shutdown cancelled the spawn, and removes the session
			// itself once this claim is released.
			cl.release()
			return refused(http.StatusConflict, msg.New("session was removed during spawn"))
		}
		jlog.Error("[machineserver] spawn failed for %s: %v", project, err)
		s.reg.setError(sess.ID, err.Error())
		cl.release()
		errSess, _ := s.reg.get(sess.ID)
		return openResult{sess: errSess, status: http.StatusBadGateway}
	}
	if !s.reg.setRunning(sess.ID, c, c.cmd.Process.Pid) {
		// A stop claimed the session as the handshake finished — don't leak
		// an unsupervised child.
		c.stop()
		cl.release()
		return refused(http.StatusConflict, msg.New("session was removed during spawn"))
	}
	s.startSupervising(sess.ID, c, cl)
	jlog.Info("[machineserver] session %s: %s at %s (pid %d)", sess.ID, project, c.addr, c.cmd.Process.Pid)
	s.rememberRecent(project)
	sess, _ = s.reg.get(sess.ID)
	return openResult{sess: sess, status: http.StatusCreated}
}

// refused is an openResult that refuses with status and m.
func refused(status int, m msg.Message) openResult {
	return openResult{status: status, refusal: &m}
}

// awaitStarted answers an open with "wait" for session id, which another open
// is spawning or has spawned: once the session is no longer starting, with
// its record — 200 running, 502 errored — or 409 if a stop removed it. A
// session waiting to restart is answered as it stands: its backoff is not a
// spawn in flight. The wait is bounded by the spawn's own handshake timeout
// and by the caller staying.
func (s *Server) awaitStarted(caller context.Context, id string) openResult {
	if started := s.reg.whenStarted(id); started != nil {
		awaitingSpawn(id)
		select {
		case <-started:
		case <-caller.Done():
			return openResult{}
		}
	}
	sess, ok := s.reg.get(id)
	switch {
	case !ok:
		return refused(http.StatusConflict, msg.New("session was removed during spawn"))
	case sess.State == SessionError:
		return openResult{sess: sess, status: http.StatusBadGateway}
	default:
		return openResult{sess: sess, status: http.StatusOK}
	}
}

// rememberRecent puts project at the front of the machine's recents. A failure
// costs only a missing entry on the sessions page, so it is logged, not served.
func (s *Server) rememberRecent(project string) {
	if s.recents == nil {
		return
	}
	if err := s.recents.Add(project); err != nil {
		jlog.Error("[machineserver] recording %s in recents: %v", project, err)
	}
}

// recentsResponse is the GET /api/server/recents payload.
type recentsResponse struct {
	Paths []string `json:"paths"`
}

// handleRecents serves the machine's recent projects, most recent first, with
// folders that no longer exist dropped (RecentsStore.Prune).
// GET /api/server/recents.
func (s *Server) handleRecents(w http.ResponseWriter, _ *http.Request) {
	paths := []string{}
	if s.recents != nil {
		got, err := s.recents.Prune()
		if err != nil {
			jlog.Error("[machineserver] reading recents: %v", err)
		}
		paths = append(paths, got...)
	}
	writeJSON(w, http.StatusOK, recentsResponse{Paths: paths})
}

// handleStopSession stops a session child and drops its registry entry. A
// session with no live child yet — starting, or waiting to restart — is
// cancelled: a child in its handshake is killed, a backoff ends, and the stop
// answers once its spawner or supervisor has let it go.
// DELETE /api/server/sessions/{id}.
func (s *Server) handleStopSession(w http.ResponseWriter, r *http.Request) {
	if !s.stopSession(mux.Vars(r)["id"]) {
		writeMessageError(w, http.StatusNotFound, msg.New("unknown session"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// stopSession joins any existing teardown or owns it. A retirement still
// being decided is taken over (takeRetirement): the child is stopped rather
// than waited on. Only a completed teardown removes a child.
func (s *Server) stopSession(id string) bool {
	found := false
	for {
		if c, ok := s.reg.beginStop(id); ok {
			c.stop()
			s.reg.remove(id)
			return true
		}
		if c, ok := s.reg.takeRetirement(id); ok {
			c.stop()
			s.reg.remove(id)
			return true
		}
		if done, ok := s.reg.cancelPending(id); ok {
			<-done
			s.reg.remove(id)
			return true
		}
		if done := s.reg.whenStopped(id); done != nil {
			found = true
			<-done
			continue
		}
		var exists, removed bool
		s.reg.do(func(m map[string]*sessionEntry) {
			e := m[id]
			exists = e != nil
			if exists && e.State == SessionError {
				e.end()
				delete(m, id)
				removed = true
			}
		})
		if removed || !exists {
			return found || removed
		}
		// A lifecycle transition occurred between the actor calls above.
		found = true
	}
}

// handleShutdown asks the whole machine server to shut down gracefully.
// Responds 202 first; the run loop drains children after. With "expect"
// (shutdownRequest) the shutdown happens only if the server holds no more
// than that (shutdownIf), and is otherwise refused 409 with what it holds.
// This machine only (localOnly): a viewer on the LAN stops sessions, not the
// server. POST /api/server/shutdown [{"expect": Occupancy}].
func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	var req shutdownRequest
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			writeMessageError(w, http.StatusBadRequest, msg.New("invalid request body: {error}", "error", err.Error()))
			return
		}
	}
	if req.Expect != nil {
		if now, ok := s.shutdownIf(*req.Expect); !ok {
			m := msg.New("the Juggler server is in use, so it was not stopped")
			writeJSON(w, http.StatusConflict, shutdownRefusal{errorBody: errorBody{Error: m.English(), Message: &m}, Occupancy: now})
			return
		}
		w.WriteHeader(http.StatusAccepted)
		jlog.Info("[machineserver] conditional shutdown requested via control API")
		return
	}
	w.WriteHeader(http.StatusAccepted)
	jlog.Info("[machineserver] shutdown requested via control API")
	s.requestShutdown()
}

// shutdownRefusal is the 409 answer to a conditional shutdown refused.
type shutdownRefusal struct {
	errorBody
	Occupancy Occupancy `json:"occupancy"`
}

// shutdownIf begins the shutdown if the server holds no more than expect
// (Occupancy.Covers), and returns what it holds. The decision and the end of
// the lifetime are one step on the registry actor, so no session opens (open
// checks the lifetime on the actor) between them. An attach is not on the
// actor: closing is raised before the client count is read, and an attach
// counts itself before it reads closing (handleAttach), so of the two at least
// one sees the other and refuses.
func (s *Server) shutdownIf(expect Occupancy) (Occupancy, bool) {
	var now Occupancy
	ok := false
	s.reg.do(func(m map[string]*sessionEntry) {
		s.closing.Store(true)
		now = Occupancy{Sessions: make([]Session, 0, len(m)), Clients: int(s.attached.Load()), LAN: s.lan.Load(), HandStarted: !s.implicit}
		for _, e := range m {
			now.Sessions = append(now.Sessions, e.Session)
		}
		sort.Slice(now.Sessions, func(i, j int) bool { return now.Sessions[i].StartedAt.Before(now.Sessions[j].StartedAt) })
		if s.starter > 0 && !s.starterGone.Load() {
			now.Clients++
		}
		if t := s.tunnel.Load(); t != nil {
			now.Tunnel = string(t.mode)
			now.TunnelTitle = modeTitle(now.Tunnel)
		}
		if !expect.Covers(now) {
			s.closing.Store(false)
			return
		}
		s.endLifetime()
		ok = true
	})
	if ok {
		s.requestShutdown()
	}
	return now, ok
}

// requestShutdown asks serve's run loop to shut the server down, the one path
// every shutdown takes. A request while one is pending adds nothing.
func (s *Server) requestShutdown() {
	select {
	case s.shutdownReq <- struct{}{}:
	default:
	}
}

// stopAllChildren shuts every session down and waits for it: it ends the
// server's lifetime (endLifetime), stops each running child concurrently and
// claims each starting or restarting session for the stop (cancelPending),
// then waits for every spawn and supervisor to release its claim before it
// drops the records. The snapshot it takes after ending the lifetime is the
// registry call open's counting relies on. Part of server shutdown: called
// once the HTTP listener has stopped accepting.
func (s *Server) stopAllChildren() {
	s.endLifetime()
	done := make(chan struct{})
	sessions := s.reg.snapshot()
	for _, sess := range sessions {
		go func() {
			s.stopSession(sess.ID)
			done <- struct{}{}
		}()
	}
	for range sessions {
		<-done
	}
	s.work.Wait()
}

// resolveProject validates a control-API project path: absolute, or under ~
// (expanded to the home of the user the server runs as); it must exist and be a
// directory. A relative path is refused: it would resolve against the folder
// `juggler serve` started in, which means nothing to a caller in a browser, so
// a CLI caller sends an absolute path instead.
func resolveProject(p string) (string, error) {
	if p == "" {
		return "", msg.NewError("project path is required")
	}
	expanded := userpaths.ExpandHome(p)
	if !filepath.IsAbs(expanded) {
		return "", msg.NewError("project {path}: give an absolute path, or one starting with ~/", "path", p)
	}
	abs := filepath.Clean(expanded)
	info, err := os.Stat(abs)
	if err != nil {
		return "", msg.NewError("project {path}: {error}", "path", abs, "error", err.Error()).Wrap(err)
	}
	if !info.IsDir() {
		return "", msg.NewError("project {path}: not a directory", "path", abs)
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

// errorBody is the control API's error envelope, the one a session child's
// /api routes send: {"error": English, "message": {...}}. Error is for the CLI
// and logs; Message, when present, is the same text for the sessions page to
// show translated with serverText.
type errorBody struct {
	Error   string       `json:"error"`
	Message *msg.Message `json:"message,omitempty"`
}

// writeMessageError sends the error envelope for m.
func writeMessageError(w http.ResponseWriter, status int, m msg.Message) {
	writeJSON(w, status, errorBody{Error: m.English(), Message: &m})
}

// writeError sends err as the error envelope, with the message of the
// *msg.Error it is or wraps when that message is the whole of its text.
func writeError(w http.ResponseWriter, status int, err error) {
	body := errorBody{Error: err.Error()}
	var me *msg.Error
	if errors.As(err, &me) && me.Error() == err.Error() {
		m := me.Message
		body.Message = &m
	}
	writeJSON(w, status, body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		jlog.Error("[machineserver] failed to encode response: %v", err)
	}
}
