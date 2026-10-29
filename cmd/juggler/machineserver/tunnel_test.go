//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/tunnel"
	"juggler/internal/ingress"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

// The tunnel modes this package's tests offer, registered once for the whole
// run (the registry is sealed by the first Serve).
const (
	fwdMode   tunnel.Mode = "fwd-test"   // forwards a private listener, as a relay does
	offerMode tunnel.Mode = "offer-test" // answers offers, as a rendezvous does
	goneMode  tunnel.Mode = "gone-test"  // never available
	fwdHost               = "fwd.example"
)

// lastForward and lastOfferHost are the most recent fake tunnel's insides, for
// a test to reach the tunnel through.
var (
	lastForward   atomic.Pointer[fakeForward]
	lastOfferHost atomic.Pointer[tunnel.Host]
	// offerStarts counts the fake rendezvous tunnels started.
	offerStarts atomic.Int32
)

func TestMain(m *testing.M) {
	tunnel.RegisterMode(tunnel.ModeSpec{
		Mode:        fwdMode,
		Title:       msg.New("Fake relay"),
		Description: msg.New("Relays through {via}.", "via", "nothing"),
		StartLabel:  msg.New("Start the fake relay"),
		RelayNote:   msg.New("Traffic goes through nothing."),
		New:         func(h tunnel.Host) tunnel.Provider { return &fakeForward{host: h, done: make(chan struct{})} },
	})
	tunnel.RegisterMode(tunnel.ModeSpec{
		Mode:  offerMode,
		Title: msg.New("Fake rendezvous"),
		// Its link is a bootstrap that loads the page its hash names.
		PageURL: func(link, path string) string { return link + "#" + path },
		New:     func(h tunnel.Host) tunnel.Provider { return &fakeOffers{host: h, done: make(chan struct{})} },
	})
	tunnel.RegisterMode(tunnel.ModeSpec{
		Mode:            goneMode,
		Title:           msg.New("Fake helper"),
		UnavailableHint: msg.New("Requires the fake helper."),
		Available:       func() bool { return false },
		New:             func(tunnel.Host) tunnel.Provider { return nil },
	})
	os.Exit(m.Run())
}

// fakeForward serves its host's ingress on a private loopback listener and
// names fwdHost as its public address.
type fakeForward struct {
	host     tunnel.Host
	srv      *http.Server
	addr     string
	done     chan struct{}
	stopOnce sync.Once
}

func (f *fakeForward) Done() <-chan struct{} { return f.done }
func (f *fakeForward) Stop()                 { f.stopOnce.Do(func() { _ = f.srv.Close(); close(f.done) }) }
func (f *fakeForward) Start(context.Context) (tunnel.Info, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return tunnel.Info{}, err
	}
	f.srv = f.host.NewIngressHTTPServer()
	f.addr = ln.Addr().String()
	go func() { _ = f.srv.Serve(ln) }()
	lastForward.Store(f)
	return tunnel.Info{URL: "https://" + fwdHost + "/", Relay: true}, nil
}

// fakeOffers keeps its host for a test to offer through.
type fakeOffers struct {
	host     tunnel.Host
	done     chan struct{}
	stopOnce sync.Once
}

func (f *fakeOffers) Done() <-chan struct{} { return f.done }
func (f *fakeOffers) Stop()                 { f.stopOnce.Do(func() { close(f.done) }) }
func (f *fakeOffers) Start(context.Context) (tunnel.Info, error) {
	offerStarts.Add(1)
	lastOfferHost.Store(&f.host)
	return tunnel.Info{URL: "https://rendezvous.example/c/abcdefghijklmnop"}, nil
}

// fakePeer stands in for tunnel/peer: it keeps what it was asked to bridge.
type fakePeer struct {
	dial   func(context.Context) (net.Conn, error)
	host   string
	life   context.Context
	answer chan struct{}
	// asked counts Fingerprint calls: what reads or mints a real peer's identity.
	asked atomic.Int32
}

func (p *fakePeer) Fingerprint() string { p.asked.Add(1); return "AA:BB:CC" }
func (p *fakePeer) Accept(_, life context.Context, offer tunnel.SessionDescription, _ []tunnel.ICEServer,
	dial func(context.Context) (net.Conn, error), host string) (tunnel.SessionDescription, error) {
	p.dial, p.host, p.life = dial, host, life
	close(p.answer)
	return tunnel.SessionDescription{Type: "answer", SDP: "answer to " + offer.SDP}, nil
}

// tunnelCall sends one request to base with the control token and returns
// the status and body.
func tunnelCall(t *testing.T, c *http.Client, method, url, host, body string, header http.Header) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	for k, v := range header {
		req.Header[k] = v
	}
	req.Header.Set(TokenHeader, testToken)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// tunnelServer is a Server with its routes behind httptest, as a caller on
// this machine reaches it, at the address it dials itself by.
func tunnelServer(t *testing.T, p Peer) (*Server, string) {
	t.Helper()
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1), peer: p}
	front := httptest.NewServer(s.routes())
	s.addr = front.Listener.Addr().String()
	t.Cleanup(front.Close)
	t.Cleanup(s.stopTunnel)
	t.Cleanup(s.closeIngress)
	return s, front.URL
}

// headerEcho is a session child that answers with the ingress headers it got.
func headerEcho(t *testing.T, s *Server) string {
	t.Helper()
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"secret": r.Header.Get(ingress.Header),
			"kind":   r.Header.Get(ingress.KindHeader),
			"addr":   r.Header.Get(ingress.AddrHeader),
			"user":   r.Header.Get(ingress.UserHeader),
		})
	}))
	t.Cleanup(backend.Close)
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://"), ingressSecret: "child-secret"}, 1)
	return sess.ID
}

// TestTunnelIsSwitchedFromThisMachineOnly: the tunnel API lists every
// registered mode with its copy (English, and the message beside it), opens
// one tunnel at a time from this machine, and refuses a caller off it. A
// status names the running tunnel.
func TestTunnelIsSwitchedFromThisMachineOnly(t *testing.T) {
	s, local := tunnelServer(t, nil)
	remote := httptest.NewServer(asCaller("192.168.1.20:54321", s.routes()))
	defer remote.Close()
	s.lan.Store(true)
	c := http.DefaultClient

	var got tunnelResponse
	code, body := tunnelCall(t, c, "GET", local+"/api/server/tunnel", "", "", nil)
	if err := json.Unmarshal([]byte(body), &got); code != http.StatusOK || err != nil || got.Running != nil {
		t.Fatalf("GET tunnel at the start: %d %s; want 200, none running", code, body)
	}
	var raw struct{ Modes []map[string]any }
	_ = json.Unmarshal([]byte(body), &raw)
	if len(raw.Modes) != 3 {
		t.Fatalf("modes: %s; want the three registered", body)
	}
	fwd := raw.Modes[0]
	if fwd["mode"] != string(fwdMode) || fwd["available"] != true || fwd["title"] != "Fake relay" ||
		fwd["description"] != "Relays through nothing." || fwd["relayNote"] != "Traffic goes through nothing." {
		t.Errorf("relay mode: %v", fwd)
	}
	if m, _ := fwd["descriptionMessage"].(map[string]any); m["key"] != "Relays through {via}." {
		t.Errorf("relay mode's description message: %v", fwd["descriptionMessage"])
	}
	if _, ok := raw.Modes[1]["relayNoteMessage"]; ok {
		t.Errorf("a mode with no relay note sends no message: %v", raw.Modes[1])
	}
	if gone := raw.Modes[2]; gone["available"] != false || gone["unavailableHint"] != "Requires the fake helper." {
		t.Errorf("unavailable mode: %v", gone)
	}

	code, body = tunnelCall(t, c, "PUT", local+"/api/server/tunnel", "", `{"mode":"fwd-test"}`, nil)
	if err := json.Unmarshal([]byte(body), &got); code != http.StatusOK || err != nil || got.Running == nil ||
		got.Running.Mode != fwdMode || got.Running.URL != "https://fwd.example/" || !got.Running.Relay || !strings.HasPrefix(got.Running.QR, "<svg") {
		t.Fatalf("PUT tunnel fwd from this machine: %d %s; want it running with its URL and QR", code, body)
	}
	var st statusResponse
	_, body = tunnelCall(t, c, "GET", local+"/api/server/status", "", "", nil)
	if err := json.Unmarshal([]byte(body), &st); err != nil || st.Tunnel != string(fwdMode) {
		t.Errorf("status with the relay running: %s; want tunnel %q", body, fwdMode)
	}

	for _, front := range []string{remote.URL, "http://" + lastForward.Load().addr} {
		host := ""
		if !strings.HasPrefix(front, remote.URL) {
			host = fwdHost
		}
		// The status says a tunnel runs, never where it is: its link works
		// from anywhere, so reading it would turn a LAN grant into a WAN one.
		if code, body := tunnelCall(t, c, "GET", front+"/api/server/status", host, "", nil); code != http.StatusOK || strings.Contains(body, "fwd.example") {
			t.Errorf("GET status via %s: %d %s; want 200 without the tunnel's link", front, code, body)
		}
		for _, call := range []struct{ method, path, body string }{
			{"GET", "/api/server/tunnel", ""},
			{"GET", "/api/server/lan", ""},
			{"GET", "/api/server/launch", ""},
			{"PUT", "/api/server/tunnel", `{"mode":""}`},
			{"PUT", "/api/server/lan", `{"enabled":false}`},
			{"POST", "/api/server/shutdown", ""},
		} {
			if code, _ := tunnelCall(t, c, call.method, front+call.path, host, call.body, nil); code != http.StatusForbidden {
				t.Errorf("%s %s via %s: status %d, want 403", call.method, call.path, front, code)
			}
		}
	}
	if s.tunnel.Load() == nil || !s.lan.Load() || len(s.shutdownReq) != 0 {
		t.Fatal("a caller off this machine changed the server")
	}

	if code, body := tunnelCall(t, c, "PUT", local+"/api/server/tunnel", "", `{"mode":"gone-test"}`, nil); code != http.StatusBadRequest || !strings.Contains(body, "Requires the fake helper.") {
		t.Errorf("PUT an unavailable mode: %d %s; want 400 with its hint", code, body)
	}
	if code, _ := tunnelCall(t, c, "PUT", local+"/api/server/tunnel", "", `{"mode":"nope"}`, nil); code != http.StatusBadRequest {
		t.Errorf("PUT an unknown mode: status %d, want 400", code)
	}
	if s.tunnel.Load() == nil || s.tunnel.Load().mode != fwdMode {
		t.Fatal("a refused switch stopped the running tunnel")
	}
	if code, body := tunnelCall(t, c, "PUT", local+"/api/server/tunnel", "", `{"mode":""}`, nil); code != http.StatusOK || s.tunnel.Load() != nil {
		t.Fatalf("PUT tunnel off: %d %s; want 200, none running", code, body)
	}
	select {
	case <-lastForward.Load().done:
	default:
		t.Error("turning the tunnel off left its provider running")
	}
}

// TestASwitchStopsOnlyTheTunnelItReplaced: a switch stops the tunnel it found
// running and no other, so a start that raced in after it looked is left be,
// and concurrent starts of one mode share one tunnel.
func TestASwitchStopsOnlyTheTunnelItReplaced(t *testing.T) {
	s, _ := tunnelServer(t, nil)
	if _, err := s.startTunnel(fwdMode); err != nil {
		t.Fatal(err)
	}
	found := s.tunnel.Load()
	s.stopTunnel()
	if _, err := s.startTunnel(offerMode); err != nil {
		t.Fatal(err)
	}
	current := s.tunnel.Load()
	if s.stopTunnelIf(found) {
		t.Fatal("stopping a tunnel that had already gone reported stopping one")
	}
	if s.tunnel.Load() != current {
		t.Fatal("stopping a tunnel that had already gone stopped the one that replaced it")
	}
	select {
	case <-current.provider.Done():
		t.Fatal("stopping a tunnel that had already gone stopped the provider of the one that replaced it")
	default:
	}

	for round := 0; round < 50; round++ {
		if _, err := s.startTunnel(fwdMode); err != nil {
			t.Fatal(err)
		}
		before := offerStarts.Load()
		var wg sync.WaitGroup
		for range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := s.startTunnel(offerMode); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		if n := offerStarts.Load() - before; n != 1 {
			t.Fatalf("round %d: 8 concurrent starts of one mode started it %d times", round, n)
		}
		running := s.tunnel.Load()
		if running == nil || running.mode != offerMode {
			t.Fatalf("round %d: after 8 starts of %s, %v runs", round, offerMode, running)
		}
		select {
		case <-running.provider.Done():
			t.Fatalf("round %d: the tunnel left running was stopped", round)
		default:
		}
	}
}

// TestTunnelCallersAreGatedByTheirTunnel: a forwarder's callers are admitted
// under the tunnel's own public Host whether or not LAN access is on, never
// under another name, and not at all once the tunnel has stopped.
func TestTunnelCallersAreGatedByTheirTunnel(t *testing.T) {
	_, local := tunnelServer(t, nil)
	c := http.DefaultClient
	if code, body := tunnelCall(t, c, "PUT", local+"/api/server/tunnel", "", `{"mode":"fwd-test"}`, nil); code != http.StatusOK {
		t.Fatalf("PUT tunnel: %d %s", code, body)
	}
	f := lastForward.Load()
	via := "http://" + f.addr

	if code, body := tunnelCall(t, c, "GET", via+"/api/server/status", fwdHost, "", http.Header{"Origin": {"https://" + fwdHost}}); code != http.StatusOK {
		t.Errorf("via the relay, LAN off, its own Host: %d %s; want 200", code, body)
	}
	for _, host := range []string{"attacker.com", "fwd.example.attacker.com"} {
		if code, _ := tunnelCall(t, c, "GET", via+"/api/server/status", host, "", nil); code != http.StatusForbidden {
			t.Errorf("via the relay, Host %q: status %d, want 403", host, code)
		}
	}

	handler := f.srv.Handler
	if code, _ := tunnelCall(t, c, "PUT", local+"/api/server/tunnel", "", `{"mode":""}`, nil); code != http.StatusOK {
		t.Fatal("could not stop the tunnel")
	}
	req := httptest.NewRequest("GET", "/api/server/status", nil)
	req.Host = fwdHost
	req.RemoteAddr = "127.0.0.1:5000"
	req.Header.Set(TokenHeader, testToken)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("a request through a stopped tunnel: status %d, want 403", rec.Code)
	}
}

// TestTunnelCallersReachSessionsAsTheirMode: the proxy vouches for a tunnel's
// caller with the child's secret and names the mode as its kind — and only the
// proxy speaks for one: a client's own identity header never reaches a child.
// (A caller its transport names is TestDataChannelIngressIsTheTunnels'.)
func TestTunnelCallersReachSessionsAsTheirMode(t *testing.T) {
	s, local := tunnelServer(t, nil)
	id := headerEcho(t, s)
	c := http.DefaultClient
	if code, body := tunnelCall(t, c, "PUT", local+"/api/server/tunnel", "", `{"mode":"fwd-test"}`, nil); code != http.StatusOK {
		t.Fatalf("PUT tunnel: %d %s", code, body)
	}
	via := "http://" + lastForward.Load().addr

	seen := func(base, host string, header http.Header) map[string]string {
		t.Helper()
		code, body := tunnelCall(t, c, "GET", base+"/s/"+id+"/", host, "", header)
		var m map[string]string
		if code != http.StatusOK || json.Unmarshal([]byte(body), &m) != nil {
			t.Fatalf("GET the session via %s: %d %s", base, code, body)
		}
		return m
	}
	forged := http.Header{ingress.UserHeader: {`{"name":"mallory"}`}}

	if got := seen(via, fwdHost, forged); got["user"] != "" || got["secret"] != "child-secret" ||
		got["kind"] != string(fwdMode) || got["addr"] != "" {
		t.Errorf("a caller via the relay forging a name: the child saw %v; want the secret, kind %q, no name", got, fwdMode)
	}
	if got := seen(local, "", forged); got["user"] != "" || got["secret"] != "" {
		t.Errorf("a local caller forging a name: the child saw %v; want nothing", got)
	}
}

// TestDataChannelIngressIsTheTunnels: an offer through the host is answered
// by the peer, bridged into this server's own handler at its own address; what
// arrives over it is the tunnel's caller, named as the transport said, and
// nothing does once the tunnel stops — whose links then end.
func TestDataChannelIngressIsTheTunnels(t *testing.T) {
	p := &fakePeer{answer: make(chan struct{})}
	s, local := tunnelServer(t, p)
	id := headerEcho(t, s)
	if code, body := tunnelCall(t, http.DefaultClient, "PUT", local+"/api/server/tunnel", "", `{"mode":"offer-test"}`, nil); code != http.StatusOK {
		t.Fatalf("PUT tunnel: %d %s", code, body)
	}
	host := *lastOfferHost.Load()
	answer, err := host.AcceptWebRTCOffer(t.Context(), tunnel.SessionDescription{Type: "offer", SDP: "v=0"},
		tunnel.OfferOptions{Caller: tunnel.CallerIdentity{Issuer: "https://test.example", Subject: "id-bob", Name: "bob"}})
	if err != nil || answer.SDP != "answer to v=0" {
		t.Fatalf("AcceptWebRTCOffer: %+v, %v", answer, err)
	}
	if p.host != s.addr {
		t.Errorf("the link names Host %q, want this server's own %q", p.host, s.addr)
	}
	link := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return p.dial(ctx) }}}
	base := "http://" + p.host

	code, body := tunnelCall(t, link, "GET", base+"/api/version", "", "", nil)
	var v struct {
		ProtocolVersion int `json:"protocolVersion"`
	}
	if err := json.Unmarshal([]byte(body), &v); code != http.StatusOK || err != nil || v.ProtocolVersion != tunnel.RendezvousProtocolVersion {
		t.Errorf("GET /api/version over the link: %d %s; want protocol %d", code, body, tunnel.RendezvousProtocolVersion)
	}
	// A name the request itself carries is the caller forging one: the child
	// hears the transport's.
	code, body = tunnelCall(t, link, "GET", base+"/s/"+id+"/", "", "", http.Header{ingress.UserHeader: {`{"name":"mallory"}`}})
	var got map[string]string
	var who tunnel.CallerIdentity
	if err := json.Unmarshal([]byte(body), &got); code != http.StatusOK || err != nil || got["kind"] != string(offerMode) ||
		json.Unmarshal([]byte(got["user"]), &who) != nil || got["secret"] != "child-secret" ||
		who != (tunnel.CallerIdentity{Issuer: "https://test.example", Subject: "id-bob", Name: "bob"}) {
		t.Errorf("the session over the link: %d %s; want kind %q, bob, the secret", code, body, offerMode)
	}
	if code, _ := tunnelCall(t, link, "PUT", base+"/api/server/tunnel", "", `{"mode":""}`, nil); code != http.StatusForbidden {
		t.Errorf("PUT tunnel over the link: status %d, want 403", code)
	}

	if code, _ := tunnelCall(t, http.DefaultClient, "PUT", local+"/api/server/tunnel", "", `{"mode":""}`, nil); code != http.StatusOK {
		t.Fatal("could not stop the tunnel")
	}
	select {
	case <-p.life.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("the link outlived its tunnel")
	}
	link.CloseIdleConnections()
	if code, _ := tunnelCall(t, link, "GET", base+"/api/server/status", "", "", nil); code != http.StatusForbidden {
		t.Errorf("over a stopped tunnel's link: status %d, want 403", code)
	}
}

// TestOffersNeedAPeer: a server handed no peer answers no offers.
func TestOffersNeedAPeer(t *testing.T) {
	_, local := tunnelServer(t, nil)
	if code, body := tunnelCall(t, http.DefaultClient, "PUT", local+"/api/server/tunnel", "", `{"mode":"offer-test"}`, nil); code != http.StatusOK {
		t.Fatalf("PUT tunnel: %d %s", code, body)
	}
	host := *lastOfferHost.Load()
	if _, err := host.AcceptWebRTCOffer(t.Context(), tunnel.SessionDescription{Type: "offer", SDP: "v=0"}, tunnel.OfferOptions{}); err == nil {
		t.Fatal("an offer was answered with no peer")
	}
}

// TestStatusNamesThePeerIdentityWhileATunnelIsOpen: a status says the
// machine's fingerprint while a tunnel is open, the only time a peer can reach
// it, and never asks the peer for it otherwise — asking is what reads or mints
// the identity, which every client's status probe would otherwise do.
func TestStatusNamesThePeerIdentityWhileATunnelIsOpen(t *testing.T) {
	p := &fakePeer{answer: make(chan struct{})}
	_, local := tunnelServer(t, p)
	status := func() statusResponse {
		t.Helper()
		var st statusResponse
		_, body := tunnelCall(t, http.DefaultClient, "GET", local+"/api/server/status", "", "", nil)
		if err := json.Unmarshal([]byte(body), &st); err != nil {
			t.Fatalf("status: %s: %v", body, err)
		}
		return st
	}
	if st := status(); st.PeerIdentity != "" || st.Tunnel != "" || p.asked.Load() != 0 {
		t.Errorf("status with no tunnel: %+v, peer asked %d times; want no identity, not asked", st, p.asked.Load())
	}
	if code, body := tunnelCall(t, http.DefaultClient, "PUT", local+"/api/server/tunnel", "", `{"mode":"offer-test"}`, nil); code != http.StatusOK {
		t.Fatalf("PUT tunnel: %d %s", code, body)
	}
	if st := status(); st.PeerIdentity != "AA:BB:CC" || st.Tunnel != string(offerMode) {
		t.Errorf("status with a tunnel open: %+v; want peerIdentity AA:BB:CC", st)
	}
}

// TestVersionNeedsNoToken: what a rendezvous bootstrap checks before it loads
// anything is served to a caller with no token.
func TestVersionNeedsNoToken(t *testing.T) {
	_, local := tunnelServer(t, nil)
	code, body := get(t, local+"/api/version")
	if code != http.StatusOK || !strings.Contains(body, `"protocolVersion":3`) {
		t.Errorf("GET /api/version: %d %s; want 200 with the protocol", code, body)
	}
}

// TestServeTunnelStartsWithTheTunnelOpen: `serve --tunnel <mode>` opens the
// tunnel once it is serving, and stopping the server stops the tunnel.
func TestServeTunnelStartsWithTheTunnelOpen(t *testing.T) {
	userpathstest.Isolate(t)
	got := servedHere(t)
	code := make(chan int, 1)
	go func() { code <- RunCommand([]string{"--port", "0", "--tunnel", string(fwdMode)}, nil, nil) }()
	var s *Server
	select {
	case s = <-got:
	case n := <-code:
		t.Fatalf("serve exited %d before serving", n)
	}
	waitForTunnel(t, s, fwdMode)
	f := lastForward.Load()
	s.requestShutdown()
	select {
	case n := <-code:
		if n != 0 {
			t.Errorf("serve exited %d", n)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("serve did not stop")
	}
	select {
	case <-f.done:
	default:
		t.Error("the server stopped and left its tunnel running")
	}

	if n := RunCommand([]string{"--port", "0", "--tunnel", "nope"}, nil, nil); n != 2 {
		t.Errorf("serve --tunnel nope: exit %d, want 2", n)
	}
}

// waitForTunnel waits for s's tunnel in mode to be up.
func waitForTunnel(t *testing.T, s *Server, mode tunnel.Mode) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		if r := s.tunnel.Load(); r != nil && r.info.Load() != nil {
			if r.mode != mode {
				t.Fatalf("tunnel open in %q, want %q", r.mode, mode)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the %s tunnel never opened", mode)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// saveLaunchExposure writes the settings document's ways in to open at start.
func saveLaunchExposure(t *testing.T, lan bool, mode tunnel.Mode) {
	t.Helper()
	dir := userpaths.ConfigDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	doc, _ := json.Marshal(map[string]any{"connectivity": map[string]any{"lanOnLaunch": lan, "wanOnLaunch": mode}})
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), doc, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestServeOpensTheSavedWaysIn: every start of the machine server opens the
// ways in Settings → Connectivity saved to open at start — LAN access and a
// tunnel — however it was started.
func TestServeOpensTheSavedWaysIn(t *testing.T) {
	userpathstest.Isolate(t)
	saveLaunchExposure(t, true, fwdMode)
	got := servedHere(t)
	code := make(chan int, 1)
	go func() { code <- RunCommand([]string{"--port", "0"}, nil, nil) }()
	var s *Server
	select {
	case s = <-got:
	case n := <-code:
		t.Fatalf("serve exited %d before serving", n)
	}
	if !s.lan.Load() {
		t.Error("saved LAN access is off after a start")
	}
	waitForTunnel(t, s, fwdMode)
	s.requestShutdown()
	select {
	case n := <-code:
		if n != 0 {
			t.Errorf("serve exited %d", n)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("serve did not stop")
	}
}

// TestLaunchExposure: what a start opens. The flags add to the saved
// settings, and --tunnel names the tunnel over a saved one. A saved mode
// this build lacks, or that cannot start here, opens nothing, and the test
// harness never reads a developer's settings.
func TestLaunchExposure(t *testing.T) {
	for _, c := range []struct {
		name      string
		savedLAN  bool
		savedMode tunnel.Mode
		opts      ServeOptions
		wantLAN   bool
		wantMode  tunnel.Mode
	}{
		{"nothing saved", false, "", ServeOptions{}, false, ""},
		{"saved", true, fwdMode, ServeOptions{}, true, fwdMode},
		{"flags alone", false, "", ServeOptions{LAN: true, Tunnel: offerMode}, true, offerMode},
		{"--tunnel names the tunnel", false, fwdMode, ServeOptions{Tunnel: offerMode}, false, offerMode},
		{"unavailable here", false, goneMode, ServeOptions{}, false, ""},
		{"not in this build", false, "nope", ServeOptions{}, false, ""},
		{"test harness", true, fwdMode, ServeOptions{TestChildren: true}, false, ""},
		{"test harness with flags", true, fwdMode, ServeOptions{TestChildren: true, LAN: true, Tunnel: offerMode}, true, offerMode},
	} {
		t.Run(c.name, func(t *testing.T) {
			userpathstest.Isolate(t)
			saveLaunchExposure(t, c.savedLAN, c.savedMode)
			lan, mode := launchExposure(c.opts)
			if lan != c.wantLAN || mode != c.wantMode {
				t.Errorf("launchExposure = LAN %v, tunnel %q; want LAN %v, tunnel %q", lan, mode, c.wantLAN, c.wantMode)
			}
		})
	}
}

// TestServerTunnelCommand: `juggler server tunnel` says which modes there are
// and which runs, `<mode>` opens one and prints its URL, `off` stops it.
func TestServerTunnelCommand(t *testing.T) {
	s, _ := cliServer(t)
	t.Cleanup(s.stopTunnel)
	t.Cleanup(s.closeIngress)

	code, out, errOut := runCLI(t, RunServerCommand, "tunnel")
	if code != 0 || !strings.Contains(out, "off") || !strings.Contains(out, string(fwdMode)) || !strings.Contains(out, "Fake relay") {
		t.Errorf("server tunnel with none: %d %q %q; want 0, off, and the modes", code, out, errOut)
	}
	code, out, errOut = runCLI(t, RunServerCommand, "tunnel", string(fwdMode))
	if code != 0 || s.tunnel.Load() == nil || !strings.Contains(out, "https://fwd.example/") {
		t.Fatalf("server tunnel %s: %d %q %q; want 0 and its URL", fwdMode, code, out, errOut)
	}
	if code, _, _ := runCLI(t, RunServerCommand, "tunnel", "off"); code != 0 || s.tunnel.Load() != nil {
		t.Errorf("server tunnel off: %d, running=%v; want 0, none", code, s.tunnel.Load() != nil)
	}
	if code, _, errOut := runCLI(t, RunServerCommand, "tunnel", string(goneMode)); code != 1 || !strings.Contains(errOut, "fake helper") {
		t.Errorf("server tunnel %s: %d %q; want 1 with its hint", goneMode, code, errOut)
	}
	if code, _, _ := runCLI(t, RunServerCommand, "tunnel", "a", "b"); code != 2 {
		t.Errorf("server tunnel a b: exit %d, want 2", code)
	}
}
