//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/tunnel"
	"juggler/internal/jlog"
)

// Tunnels: WAN exposure through the modes a distribution registers
// (tunnel.RegisterMode). One tunnel runs at a time, per run, like LAN access:
// a start opens one only if serve --tunnel or the saved
// connectivity.wanOnLaunch names it (launchExposure), and only a caller on
// this machine opens or closes one (localOnly). Everything a tunnel carries enters
// this server's own handler tagged with that tunnel (ingressTag), so it meets
// the guards, the proxy's vouching and the viewer holds every other caller
// does, as a remote caller of the tunnel's kind.

// Peer is what this server calls on this machine's WebRTC peer
// (*tunnel/peer.Peer, which satisfies it). It is an interface, not that type,
// because the desktop app links this package and must link no WebRTC stack:
// cmd/juggler hands the peer in (ServeOptions.Peer). Nil answers no offers.
type Peer interface {
	// Fingerprint is the DTLS fingerprint the peer presents, or "".
	Fingerprint() string
	// Accept answers offer, its setup bounded by ctx; the data channel it
	// opens carries traffic over dial, naming host, until life ends.
	Accept(ctx, life context.Context, offer tunnel.SessionDescription, ice []tunnel.ICEServer,
		dial func(context.Context) (net.Conn, error), host string) (tunnel.SessionDescription, error)
}

// runningTunnel is the server's record of its one tunnel. info is set once the
// provider's Start returns, and ready closed when Start has returned either
// way (err set on failure), so concurrent opens see the same outcome. life
// ends when the tunnel stops, and every link through it with it.
type runningTunnel struct {
	mode     tunnel.Mode
	provider tunnel.Provider
	life     context.Context
	end      context.CancelFunc
	info     atomic.Pointer[tunnel.Info]
	ready    chan struct{}
	err      error
}

// publicHost is the Host its callers name: the host of its public URL.
func (t *runningTunnel) publicHost() string {
	info := t.info.Load()
	if info == nil {
		return ""
	}
	u, err := url.Parse(info.URL)
	if err != nil {
		return ""
	}
	return u.Host
}

// ingressTag marks a request that arrived through a tunnel: which one, and
// who its transport says the caller is.
type ingressTag struct {
	tunnel *runningTunnel
	caller tunnel.CallerIdentity
}

type ingressKey struct{}

func withIngress(r *http.Request, tag ingressTag) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), ingressKey{}, tag))
}

// ingressOf returns the tunnel a request arrived through, if it did.
func ingressOf(r *http.Request) (ingressTag, bool) {
	tag, ok := r.Context().Value(ingressKey{}).(ingressTag)
	return tag, ok
}

// startTunnel opens a tunnel in mode and returns its info once its public URL
// is known. A tunnel already running or starting in mode is answered with
// that one; one in another mode is stopped first, the owner's switch. Every
// stop and install is of the tunnel just read (stopTunnelIf, CompareAndSwap),
// so concurrent switches each act on what they saw, and starts of one mode
// share one tunnel.
func (s *Server) startTunnel(mode tunnel.Mode) (tunnel.Info, error) {
	spec, err := startableMode(mode)
	if err != nil {
		return tunnel.Info{}, err
	}
	for {
		existing := s.tunnel.Load()
		if existing != nil && existing.mode == mode {
			return awaitTunnel(existing)
		}
		if existing != nil {
			s.stopTunnelIf(existing)
			continue
		}
		life, end := context.WithCancel(s.lifetime())
		t := &runningTunnel{mode: mode, life: life, end: end, ready: make(chan struct{})}
		t.provider = spec.New(tunnelHost{s: s, t: t})
		if !s.tunnel.CompareAndSwap(nil, t) {
			end()
			continue
		}
		info, err := t.provider.Start(life)
		if err != nil {
			s.tunnel.CompareAndSwap(t, nil)
			end()
			t.provider.Stop()
			t.err = err
			close(t.ready)
			jlog.Error("Tunnel (%s): %v", mode, err)
			return tunnel.Info{}, err
		}
		if s.tunnel.Load() != t {
			// Switched off or away while it started: what replaced it ended
			// its life and stopped its provider, so it never opened.
			t.provider.Stop()
			t.err = msg.NewError("This tunnel is closed.")
			close(t.ready)
			return tunnel.Info{}, t.err
		}
		t.info.Store(&info)
		close(t.ready)
		jlog.Info("🌍 %s open — no password: anyone with this link can use this server: %s", spec.Title.English(), info.URL)
		// When the provider stops for good on its own (a helper exiting, a
		// rendezvous refusing it), the tunnel is closed.
		go func() {
			select {
			case <-t.provider.Done():
				if s.tunnel.CompareAndSwap(t, nil) {
					end()
					jlog.Info("🔒 %s closed", spec.Title.English())
				}
			case <-life.Done():
			}
		}()
		return info, nil
	}
}

// startableMode is the spec of mode, or why it cannot be started here.
func startableMode(mode tunnel.Mode) (tunnel.ModeSpec, error) {
	spec, ok := tunnel.Find(mode)
	if !ok {
		return spec, msg.NewError("unknown tunnel mode {mode}", "mode", strconv.Quote(string(mode)))
	}
	if !spec.IsAvailable() {
		return spec, msg.NewError("{mode} is not available: {hint}", "mode", spec.Title.English(), "hint", spec.UnavailableHint.English())
	}
	return spec, nil
}

// awaitTunnel waits for t's Start and returns how it went.
func awaitTunnel(t *runningTunnel) (tunnel.Info, error) {
	<-t.ready
	if info := t.info.Load(); info != nil {
		return *info, nil
	}
	return tunnel.Info{}, t.err
}

// stopTunnel closes the running tunnel, if any, and every link through it.
func (s *Server) stopTunnel() {
	for {
		t := s.tunnel.Load()
		if t == nil || s.stopTunnelIf(t) {
			return
		}
	}
}

// stopTunnelIf closes t and every link through it if t is still the running
// tunnel, and reports whether it was. A tunnel another caller has replaced
// since t was read is left alone.
func (s *Server) stopTunnelIf(t *runningTunnel) bool {
	if t == nil || !s.tunnel.CompareAndSwap(t, nil) {
		return false
	}
	t.end()
	t.provider.Stop()
	if spec, ok := tunnel.Find(t.mode); ok {
		jlog.Info("🔒 %s closed", spec.Title.English())
	}
	return true
}

// tunnelHost is the tunnel.Host one tunnel's provider is handed.
type tunnelHost struct {
	s *Server
	t *runningTunnel
}

func (h tunnelHost) AcceptWebRTCOffer(ctx context.Context, offer tunnel.SessionDescription, opts tunnel.OfferOptions) (tunnel.SessionDescription, error) {
	if h.s.peer == nil {
		return tunnel.SessionDescription{}, msg.NewError("this server answers no WebRTC offers")
	}
	tag := ingressTag{tunnel: h.t, caller: opts.Caller}
	dial := func(ctx context.Context) (net.Conn, error) { return h.s.dialIngress(ctx, tag) }
	return h.s.peer.Accept(ctx, h.t.life, offer, opts.ICEServers, dial, h.s.addr)
}

func (h tunnelHost) NewIngressHTTPServer() *http.Server {
	handler := h.s.routes()
	tag := ingressTag{tunnel: h.t}
	return &http.Server{
		ReadHeaderTimeout: 10 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			handler.ServeHTTP(w, withIngress(r, tag))
		}),
	}
}

// tunnelGate refuses a request that arrived through a tunnel no longer
// running: a forwarder's last requests, a link's after the owner closed it.
func (s *Server) tunnelGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tag, ok := ingressOf(r); ok && s.tunnel.Load() != tag.tunnel {
			writeMessageError(w, http.StatusForbidden, msg.New("This tunnel is closed."))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// tunnelHostAllowed is the Host guard's one exemption for a tunnel: a request
// through it naming the tunnel's own public host. That name is the tunnel's,
// which a rebinding page cannot send.
func tunnelHostAllowed(r *http.Request) bool {
	tag, ok := ingressOf(r)
	if !ok {
		return false
	}
	host := tag.tunnel.publicHost()
	return host != "" && strings.EqualFold(r.Host, host)
}

// The in-process ingress: a listener nothing outside this process can reach,
// which a data channel's link dials for every request it carries. Each
// connection carries its tag, put on its requests' contexts.

// taggedConn is one connection to the in-process ingress.
type taggedConn struct {
	net.Conn
	tag ingressTag
}

// pipeListener accepts the connections dialIngress makes.
type pipeListener struct {
	conns     chan net.Conn
	done      chan struct{}
	closeOnce sync.Once
}

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "in-process" }

func (l *pipeListener) Addr() net.Addr { return pipeAddr{} }

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *pipeListener) Close() error {
	l.closeOnce.Do(func() { close(l.done) })
	return nil
}

// ingressServer returns the in-process ingress, starting it on first use.
func (s *Server) ingressServer() *pipeListener {
	s.ingressOnce.Do(func() {
		ln := &pipeListener{conns: make(chan net.Conn), done: make(chan struct{})}
		srv := &http.Server{
			Handler:           s.routes(),
			ReadHeaderTimeout: 10 * time.Second,
			ConnContext: func(ctx context.Context, c net.Conn) context.Context {
				if tc, ok := c.(*taggedConn); ok {
					return context.WithValue(ctx, ingressKey{}, tc.tag)
				}
				return ctx
			},
		}
		s.ingress.Store(ln)
		s.ingressSrv.Store(srv)
		go func() { _ = srv.Serve(ln) }()
	})
	return s.ingress.Load()
}

// dialIngress opens one connection to the in-process ingress, its requests
// tagged with tag.
func (s *Server) dialIngress(ctx context.Context, tag ingressTag) (net.Conn, error) {
	ln := s.ingressServer()
	client, server := net.Pipe()
	select {
	case ln.conns <- &taggedConn{Conn: server, tag: tag}:
		return client, nil
	case <-ln.done:
	case <-ctx.Done():
	}
	_ = client.Close()
	_ = server.Close()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return nil, net.ErrClosed
}

// closeIngress stops the in-process ingress, if it ever started.
func (s *Server) closeIngress() {
	if srv := s.ingressSrv.Load(); srv != nil {
		_ = srv.Close()
	}
	if ln := s.ingress.Load(); ln != nil {
		_ = ln.Close()
	}
}

// tunnelResponse is the GET/PUT /api/server/tunnel payload: every registered
// mode with its copy for Settings → Connectivity, and the running tunnel, if any.
type tunnelResponse struct {
	Modes   []map[string]any `json:"modes"`
	Running *runningView     `json:"running"`
}

// runningView is the running tunnel: where to connect from, and its QR.
type runningView struct {
	Mode  tunnel.Mode `json:"mode"`
	URL   string      `json:"url"`
	Relay bool        `json:"relay"`
	QR    string      `json:"qr,omitempty"`
	// Session is the session the caller asked about, through the tunnel.
	Session *pageLink `json:"session,omitempty"`
}

// tunnelState is the tunnel API's view of the server, with the page at
// sessionPath through the running tunnel ("" for none). Each mode's copy is
// sent as its English under the plain key and, when the spec sets it, as the
// message under the key plus "Message" (titleMessage, …), for the page to
// show translated.
func (s *Server) tunnelState(sessionPath string) tunnelResponse {
	resp := tunnelResponse{Modes: []map[string]any{}}
	for _, spec := range tunnel.Modes() {
		mode := map[string]any{"mode": string(spec.Mode), "available": spec.IsAvailable()}
		for _, field := range []struct {
			name    string
			message msg.Message
		}{
			{"title", spec.Title},
			{"description", spec.Description},
			{"startLabel", spec.StartLabel},
			{"relayNote", spec.RelayNote},
			{"unavailableHint", spec.UnavailableHint},
		} {
			mode[field.name] = field.message.English()
			if !field.message.IsZero() {
				mode[field.name+"Message"] = field.message
			}
		}
		resp.Modes = append(resp.Modes, mode)
	}
	if t := s.tunnel.Load(); t != nil {
		if info := t.info.Load(); info != nil {
			root := newPageLink(info.URL)
			view := &runningView{Mode: t.mode, URL: root.URL, Relay: info.Relay, QR: root.QR}
			if spec, ok := tunnel.Find(t.mode); ok && sessionPath != "" {
				view.Session = newPageLink(spec.LinkTo(info.URL, sessionPath))
			}
			resp.Running = view
		}
	}
	return resp
}

// handleGetTunnel serves the tunnel as it stands. GET /api/server/tunnel,
// with ?session=<id> for that session's link (askedSession); this machine
// only (localOnly), since the link it names works from anywhere.
func (s *Server) handleGetTunnel(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.tunnelState(s.askedSession(r)))
}

// handleSetTunnel opens the tunnel in a mode, or with "" closes it, and
// answers with the result. PUT /api/server/tunnel {"mode": "<mode>" | ""},
// with ?session= as GET has it; this machine only (localOnly).
func (s *Server) handleSetTunnel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mode *string `json:"mode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil || req.Mode == nil {
		writeMessageError(w, http.StatusBadRequest, msg.New("say which tunnel to open: mode, or \"\" to close it"))
		return
	}
	if *req.Mode == "" {
		s.stopTunnel()
		writeJSON(w, http.StatusOK, s.tunnelState(s.askedSession(r)))
		return
	}
	mode := tunnel.Mode(*req.Mode)
	if _, err := startableMode(mode); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if _, err := s.startTunnel(mode); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, s.tunnelState(s.askedSession(r)))
}

// versionResponse is GET /api/version: what a rendezvous bootstrap checks
// before it loads anything over a data channel.
type versionResponse struct {
	Version         string `json:"version"`
	ProtocolVersion int    `json:"protocolVersion"`
}
