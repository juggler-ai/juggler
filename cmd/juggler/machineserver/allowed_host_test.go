//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"juggler/internal/hostcheck"
	"juggler/internal/ingress"
)

// TestAllowedHostReachesTheChildAsAProxiedRemoteCaller covers a reverse proxy
// on this machine (tailscale serve) in front of the machine server. It
// connects over loopback and forwards its public name as Host. That name must
// pass the Host guard, and its callers must reach the child vouched for as
// remote, of kind proxy, even while LAN access is off: the loopback address
// is the proxy's, not theirs. A caller off loopback that sends the same name
// gains nothing by it. The LAN gate still decides it, and it is forwarded as
// a LAN caller.
func TestAllowedHostReachesTheChildAsAProxiedRemoteCaller(t *testing.T) {
	var reached atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		_, _ = io.WriteString(w, r.Header.Get(ingress.Header)+"|"+r.Header.Get(ingress.KindHeader)+"|"+r.Header.Get(ingress.AddrHeader))
	}))
	defer backend.Close()

	allowed, err := hostcheck.NewAllowList([]string{"box.tailnet.ts.net"})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), token: testToken, allowedHosts: allowed}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://"), ingressSecret: "child-secret"}, 1)

	fetch := func(caller, host, path string) (int, string) {
		t.Helper()
		front := httptest.NewServer(asCaller(caller, s.routes()))
		defer front.Close()
		req, err := http.NewRequest("GET", front.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		req.Header.Set(TokenHeader, testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	page := sess.Link

	for _, c := range []struct {
		name, caller, host string
		lan                bool
		wantCode           int
		wantChild          string // "" = must not be reached
	}{
		{"the proxy, LAN off", "127.0.0.1:5000", "box.tailnet.ts.net", false, http.StatusOK, "child-secret|" + ingress.KindProxy + "|"},
		{"the proxy with a port and in capitals", "[::1]:5000", "BOX.tailnet.ts.net:443", false, http.StatusOK, "child-secret|" + ingress.KindProxy + "|"},
		{"a local client by this machine's name", "127.0.0.1:5000", "localhost:3939", false, http.StatusOK, "||"},
		{"an unlisted name", "127.0.0.1:5000", "other.tailnet.ts.net", false, http.StatusForbidden, ""},
		{"a LAN caller naming the allowed host, LAN off", "203.0.113.7:54321", "box.tailnet.ts.net", false, http.StatusForbidden, ""},
		{"a LAN caller naming the allowed host, LAN on", "203.0.113.7:54321", "box.tailnet.ts.net", true, http.StatusOK, "child-secret|" + ingress.KindLAN + "|203.0.113.7:54321"},
	} {
		s.lan.Store(c.lan)
		before := reached.Load()
		code, body := fetch(c.caller, c.host, page)
		if code != c.wantCode {
			t.Errorf("%s: status %d, want %d", c.name, code, c.wantCode)
			continue
		}
		if c.wantChild == "" {
			if reached.Load() != before {
				t.Errorf("%s: the request reached the child", c.name)
			}
		} else if body != c.wantChild {
			t.Errorf("%s: child saw secret|kind|addr %q, want %q", c.name, body, c.wantChild)
		}
	}

	// The control API answers the proxy too: the name is the user's grant,
	// as LAN access is.
	s.lan.Store(false)
	if code, _ := fetch("127.0.0.1:5000", "box.tailnet.ts.net", "/api/server/status"); code != http.StatusOK {
		t.Errorf("control API through the proxy, LAN off: status %d, want 200", code)
	}

	// A refused name is told which name it was and how to allow it, since the
	// browser shows this body as the page.
	if _, body := fetch("127.0.0.1:5000", "other.tailnet.ts.net", page); !strings.Contains(body, "--allow-host other.tailnet.ts.net") {
		t.Errorf("refusal body does not say how to allow the host: %q", body)
	}
}
