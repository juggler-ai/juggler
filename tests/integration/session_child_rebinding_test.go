//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"io"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"juggler/internal/apipaths"
	"juggler/internal/ingress"
)

// TestSessionChildRefusesRebindingHost plays a DNS-rebinding page against a
// real session child reached on loopback directly, not through its supervisor:
// the attacker's own domain,
// pointed at 127.0.0.1, so the page sends that domain as Host and as its
// Origin and passes every same-origin check. The pages that carry the API token
// must not be served to it, and the viewer WebSocket must refuse it even when
// it presents the right token. The same requests naming the server by its
// address work.
func TestSessionChildRefusesRebindingHost(t *testing.T) {
	addr := startSessionChild(t, newProjectDir(t), ingress.NewSecret(), ingress.NewSecret())
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("server addr %q: %v", addr, err)
	}
	rebound := "attacker.example:" + port

	get := func(path, host string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, "http://"+addr+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		req.Header.Set("Origin", "http://"+host)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	code, page := get("/", addr)
	m := apiTokenPattern.FindStringSubmatch(page)
	if code != http.StatusOK || m == nil {
		t.Fatalf("GET / with Host %s: status %d, token found %v; want 200 with a token", addr, code, m != nil)
	}
	token := m[1]

	for _, p := range []string{"/", "/engine"} {
		code, body := get(p, rebound)
		if code != http.StatusForbidden {
			t.Errorf("GET %s with Host %s: status %d, want 403", p, rebound, code)
		}
		if apiTokenPattern.MatchString(body) {
			t.Errorf("GET %s with Host %s handed out the API token", p, rebound)
		}
		if code, _ := get(p, addr); code != http.StatusOK {
			t.Errorf("GET %s with Host %s: status %d, want 200", p, addr, code)
		}
	}

	dial := func(host string) (*websocket.Conn, *http.Response, error) {
		dialer := websocket.Dialer{
			NetDial: func(network, _ string) (net.Conn, error) { return net.Dial(network, addr) },
		}
		header := http.Header{"Origin": []string{"http://" + host}}
		return dialer.Dial("ws://"+host+apipaths.WebSocket+"?role=viewer&token="+token, header)
	}

	conn, resp, err := dial(rebound)
	if conn != nil {
		_ = conn.Close()
	}
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Errorf("viewer WebSocket upgrade with Host %s and a valid token: err %v, status %d; want refused with 403", rebound, err, status)
	}

	conn, resp, err = dial(addr)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("viewer WebSocket upgrade with Host %s: %v", addr, err)
	}
	_ = conn.Close()
}

// TestSessionChildHasNoProjectSwitching: a session child serves the one
// project its supervisor spawned it for. Another folder is another session,
// opened on the machine server, so the child routes nothing that opens,
// checks or lists projects, and its page carries no marker saying whether its
// project could be switched.
func TestSessionChildHasNoProjectSwitching(t *testing.T) {
	token := ingress.NewSecret()
	project := newProjectDir(t)
	addr := startSessionChild(t, project, ingress.NewSecret(), token)
	other := newProjectDir(t)

	for _, c := range []struct{ method, path, body string }{
		{http.MethodPost, "/api/project", `{"path":"` + other + `"}`},
		{http.MethodGet, "/api/project", ""},
		{http.MethodGet, "/api/project/check?path=" + other, ""},
		{http.MethodGet, "/api/recents", ""},
		{http.MethodDelete, "/api/recents", `{"path":"` + other + `"}`},
	} {
		req, err := http.NewRequest(c.method, "http://"+addr+c.path, strings.NewReader(c.body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Juggler-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("%s %s: status %d (%s), want it unrouted", c.method, c.path, resp.StatusCode, strings.TrimSpace(string(body)))
		}
	}

	resp, err := http.Get("http://" + addr + "/") //nolint:gosec // the test's own loopback child
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if strings.Contains(string(page), "data-fixed-project") {
		t.Error("the page carries data-fixed-project")
	}
}
