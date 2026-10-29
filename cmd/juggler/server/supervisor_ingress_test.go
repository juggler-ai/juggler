//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/tunnel"
	"juggler/internal/ingress"
)

// testTunnelMode is a tunnel mode registered for this package's tests, as a
// distribution registers its own before app.Run.
const testTunnelMode = "relay-test"

func TestMain(m *testing.M) {
	tunnel.RegisterMode(tunnel.ModeSpec{
		Mode:  testTunnelMode,
		Title: msg.New("Test relay"),
		New:   func(tunnel.Host) tunnel.Provider { return nil },
	})
	os.Exit(m.Run())
}

// TestSupervisorIngressHeader checks the child's half of caller identity: only
// its supervisor's secret, arriving over loopback, tags a request as remote
// ingress, and the header never reaches a handler, honoured or not.
func TestSupervisorIngressHeader(t *testing.T) {
	cases := []struct {
		name, secret, header, remoteAddr string
		wantKind                         string
	}{
		{"the supervisor's secret", "right", "right", "127.0.0.1:5000", supervisorIngressKind},
		{"another secret", "right", "wrong", "127.0.0.1:5000", ""},
		{"a prefix of the secret", "right", "righ", "127.0.0.1:5000", ""},
		{"no header", "right", "", "127.0.0.1:5000", ""},
		{"the secret from off loopback", "right", "right", remoteEdgeAddr, ""},
		{"a server with no supervisor", "", "anything", "127.0.0.1:5000", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var gotKind, gotHeader string
			reached := false
			s := &Server{router: mux.NewRouter(), ingressSecret: c.secret}
			s.router.Use(s.supervisorIngressMiddleware)
			s.router.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				reached = true
				gotKind = RemoteIngressKind(r)
				gotHeader = r.Header.Get(ingress.Header)
			})
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = c.remoteAddr
			if c.header != "" {
				req.Header.Set(ingress.Header, c.header)
			}
			s.router.ServeHTTP(httptest.NewRecorder(), req)
			if !reached {
				t.Fatal("request never reached the handler")
			}
			if gotKind != c.wantKind {
				t.Errorf("remote-ingress kind = %q, want %q", gotKind, c.wantKind)
			}
			if gotHeader != "" {
				t.Errorf("handler saw %s %q, want it stripped", ingress.Header, gotHeader)
			}
		})
	}
}

// TestSupervisorIngressNamesTheTransport checks the child believes what its
// supervisor says about a remote caller — how it arrived, from where, and who
// its transport says it is — only alongside the secret, so the clients list
// shows a LAN viewer by its address and a tunnel's by the tunnel's title and
// the caller's name, while the request stays remote ingress. Anything it
// cannot read falls back to "Via machine server", and the headers never reach
// a handler.
func TestSupervisorIngressNamesTheTransport(t *testing.T) {
	cases := []struct {
		name, secret, kind, addr, user   string
		wantOrigin, wantDetail, wantName string
		wantRemote                       bool
	}{
		{name: "a tunnel's caller", secret: "right", kind: testTunnelMode, wantOrigin: "remote", wantDetail: "Test relay", wantRemote: true},
		{name: "a tunnel's named caller", secret: "right", kind: testTunnelMode, user: `{"issuer":"https://id.example","subject":"u1","name":"Alice"}`,
			wantOrigin: "remote", wantDetail: "Test relay", wantName: "Alice", wantRemote: true},
		{name: "a name that does not parse", secret: "right", kind: testTunnelMode, user: "{", wantOrigin: "remote", wantDetail: "Test relay", wantRemote: true},
		{name: "a name without the secret", secret: "wrong", kind: testTunnelMode, user: `{"name":"Mallory"}`, wantOrigin: "local"},
		{"a LAN caller", "right", ingress.KindLAN, "192.168.1.20:54321", "", "lan", "192.168.1.20", "", true},
		{"an IPv6 LAN caller", "right", ingress.KindLAN, "[fe80::1]:54321", "", "lan", "fe80::1", "", true},
		{"a caller through the user's reverse proxy", "right", ingress.KindProxy, "", "", "remote", "Via reverse proxy", "", true},
		{"no transport named", "right", "", "", "", "remote", "Via machine server", "", true},
		{"a transport it does not know", "right", "carrier-pigeon", "192.168.1.20:54321", "", "remote", "Via machine server", "", true},
		{"a LAN caller with no usable address", "right", ingress.KindLAN, "nonsense", "", "remote", "Via machine server", "", true},
		{"a LAN claim without the secret", "wrong", ingress.KindLAN, "192.168.1.20:54321", "", "local", "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var got ClientInfo
			var remote bool
			var leaked []string
			s := &Server{router: mux.NewRouter(), ingressSecret: "right"}
			s.router.Use(s.supervisorIngressMiddleware)
			s.router.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				got = clientInfoFromRequest(r)
				remote = isRemoteIngress(r)
				for _, h := range []string{ingress.Header, ingress.KindHeader, ingress.AddrHeader, ingress.UserHeader} {
					if v := r.Header.Get(h); v != "" {
						leaked = append(leaked, h+"="+v)
					}
				}
			})
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = "127.0.0.1:5000"
			req.Header.Set(ingress.Header, c.secret)
			if c.kind != "" {
				req.Header.Set(ingress.KindHeader, c.kind)
			}
			if c.addr != "" {
				req.Header.Set(ingress.AddrHeader, c.addr)
			}
			if c.user != "" {
				req.Header.Set(ingress.UserHeader, c.user)
			}
			s.router.ServeHTTP(httptest.NewRecorder(), req)
			if got.Origin != c.wantOrigin || got.Detail != c.wantDetail || got.Name != c.wantName {
				t.Errorf("client info = %+v, want origin %q detail %q name %q", got, c.wantOrigin, c.wantDetail, c.wantName)
			}
			if remote != c.wantRemote {
				t.Errorf("remote ingress = %v, want %v", remote, c.wantRemote)
			}
			if len(leaked) != 0 {
				t.Errorf("handler saw %v, want every ingress header stripped", leaked)
			}
		})
	}
}

// TestSupervisorIngressIsRemote pins what the tag means downstream: a request
// the supervisor vouched for is neither local-direct nor allowed the engine
// role, though it arrives over loopback.
func TestSupervisorIngressIsRemote(t *testing.T) {
	r := MarkRemoteIngress(httptest.NewRequest(http.MethodGet, "/api/ws?role=engine", nil), supervisorIngressKind)
	r.RemoteAddr = "127.0.0.1:5000"
	if isLocalDirect(r) || engineRoleAllowed(r) {
		t.Fatalf("supervisor ingress: isLocalDirect=%v engineRoleAllowed=%v, want both false", isLocalDirect(r), engineRoleAllowed(r))
	}
	if got := clientInfoFromRequest(r); got.Origin != "remote" || got.Detail != "Via machine server" {
		t.Fatalf("client info = %+v, want a remote client via the machine server", got)
	}
}
