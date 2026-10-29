//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"juggler/internal/userpaths/userpathstest"
)

// lanCall sends one control-API request to front with the token and returns
// the status and body.
func lanCall(t *testing.T, method, url, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// TestLANAccessIsSwitchedFromThisMachineOnly: LAN access is off at the start
// and switched through the control API, by a caller on this machine alone. A
// caller on the LAN can neither read its addresses nor flip it — nor stop the
// whole server — and a status says it.
func TestLANAccessIsSwitchedFromThisMachineOnly(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1)}
	local := httptest.NewServer(s.routes())
	defer local.Close()
	remote := httptest.NewServer(asCaller("192.168.1.20:54321", s.routes()))
	defer remote.Close()

	var got lanResponse
	code, body := lanCall(t, "GET", local.URL+"/api/server/lan", "")
	if err := json.Unmarshal([]byte(body), &got); code != http.StatusOK || err != nil || got.Enabled {
		t.Fatalf("GET lan at the start: %d %s; want 200, off", code, body)
	}

	if code, body := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"enabled":true}`); code != http.StatusOK || !s.lan.Load() {
		t.Fatalf("PUT lan on from this machine: %d %s, on=%v; want 200, on", code, body, s.lan.Load())
	}
	var st statusResponse
	_, body = lanCall(t, "GET", local.URL+"/api/server/status", "")
	if err := json.Unmarshal([]byte(body), &st); err != nil || !st.LAN {
		t.Errorf("status with LAN on: %s; want lan true", body)
	}

	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/server/lan", ""},
		{"PUT", "/api/server/lan", `{"enabled":false}`},
		{"POST", "/api/server/shutdown", ""},
	} {
		if code, _ := lanCall(t, c.method, remote.URL+c.path, c.body); code != http.StatusForbidden {
			t.Errorf("%s %s from the LAN: status %d, want 403", c.method, c.path, code)
		}
	}
	if !s.lan.Load() || len(s.shutdownReq) != 0 {
		t.Errorf("a LAN caller changed the server: lan on=%v, shutdown signalled=%v", s.lan.Load(), len(s.shutdownReq) != 0)
	}

	if code, _ := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"enabled":false}`); code != http.StatusOK || s.lan.Load() {
		t.Errorf("PUT lan off from this machine: %d, on=%v; want 200, off", code, s.lan.Load())
	}
	if code, _ := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"enabled":"yes"}`); code != http.StatusBadRequest {
		t.Errorf("PUT lan with a body that says nothing: status %d, want 400", code)
	}
}

// TestLANAccessListsTheAddressesToUse: with LAN access on, the server names a
// URL for each of this machine's LAN addresses at its own port, each with a
// QR code of it for a phone; with it off it names none.
func TestLANAccessListsTheAddressesToUse(t *testing.T) {
	addrs := lanAddresses()
	if len(addrs) == 0 {
		t.Skip("this machine has no LAN address")
	}
	s := &Server{reg: newRegistry(), token: testToken, addr: "127.0.0.1:3941"}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	var got lanResponse
	_, body := lanCall(t, "GET", front.URL+"/api/server/lan", "")
	if err := json.Unmarshal([]byte(body), &got); err != nil || len(got.URLs) != 0 {
		t.Errorf("LAN off: %s; want no URLs", body)
	}
	s.lan.Store(true)
	_, body = lanCall(t, "GET", front.URL+"/api/server/lan", "")
	if err := json.Unmarshal([]byte(body), &got); err != nil || len(got.URLs) != len(addrs) {
		t.Fatalf("LAN on: %s; want one URL per address %v", body, addrs)
	}
	for i, u := range got.URLs {
		want := "http://" + net.JoinHostPort(addrs[i].ip, "3941") + "/"
		if u.URL != want || !strings.HasPrefix(u.QR, "<svg") || !strings.Contains(u.QR, "currentColor") {
			t.Errorf("URL %d: %q with QR %.40q; want %q with an SVG QR", i, u.URL, u.QR, want)
		}
	}
}

// TestServeLANStartsWithLANAccessOn: `serve --lan` starts a server with LAN
// access on (a container's, a headless machine's); without it, or the saved
// setting (TestServeOpensTheSavedWaysIn), a server starts with it off.
func TestServeLANStartsWithLANAccessOn(t *testing.T) {
	for _, c := range []struct {
		args []string
		want bool
	}{{[]string{"--port", "0"}, false}, {[]string{"--port", "0", "--lan"}, true}} {
		userpathstest.Isolate(t)
		got := servedHere(t)
		code := make(chan int, 1)
		go func() { code <- RunCommand(c.args, nil, nil) }()
		var s *Server
		select {
		case s = <-got:
		case n := <-code:
			t.Fatalf("serve %v exited %d before serving", c.args, n)
		}
		if s.lan.Load() != c.want {
			t.Errorf("serve %v: LAN access on=%v, want %v", c.args, s.lan.Load(), c.want)
		}
		s.requestShutdown()
		select {
		case n := <-code:
			if n != 0 {
				t.Errorf("serve %v exited %d", c.args, n)
			}
		case <-time.After(30 * time.Second):
			t.Fatalf("serve %v did not stop", c.args)
		}
	}
}

// TestServerLANCommand: `juggler server lan` says whether LAN access is on and
// where to connect from, and `on`/`off` switch it.
func TestServerLANCommand(t *testing.T) {
	s, _ := cliServer(t)
	s.addr = "127.0.0.1:" + strconv.Itoa(DefaultPort)

	if code, out, errOut := runCLI(t, RunServerCommand, "lan"); code != 0 || !strings.Contains(out, "off") {
		t.Errorf("server lan with it off: %d %q %q; want 0, saying off", code, out, errOut)
	}
	code, out, errOut := runCLI(t, RunServerCommand, "lan", "on")
	if code != 0 || !s.lan.Load() || !strings.Contains(out, "on") {
		t.Fatalf("server lan on: %d %q %q, on=%v; want 0, on", code, out, errOut, s.lan.Load())
	}
	for _, a := range lanAddresses() {
		if want := "http://" + net.JoinHostPort(a.ip, strconv.Itoa(DefaultPort)) + "/"; !strings.Contains(out, want) {
			t.Errorf("server lan on does not name %s: %q", want, out)
		}
	}
	if code, _, _ := runCLI(t, RunServerCommand, "lan", "off"); code != 0 || s.lan.Load() {
		t.Errorf("server lan off: %d, on=%v; want 0, off", code, s.lan.Load())
	}
	if code, _, _ := runCLI(t, RunServerCommand, "lan", "maybe"); code != 2 {
		t.Errorf("server lan maybe: exit %d, want 2", code)
	}
}
