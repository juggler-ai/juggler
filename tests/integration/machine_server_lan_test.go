//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"juggler/cmd/juggler/machineserver"
	"juggler/internal/apipaths"
)

// lanIP is an address of this machine's that is not loopback, which a request
// from this test arrives from as a caller off loopback would: a second machine
// on the LAN, as far as the server can tell. "" when there is none.
func lanIP(t *testing.T) string {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatalf("interface addresses: %v", err)
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP.To4() != nil && !ipnet.IP.IsLoopback() && !ipnet.IP.IsLinkLocalUnicast() {
			return ipnet.IP.String()
		}
	}
	return ""
}

// lanCall sends one request to base+path, with the control-API token for a
// /api/server path, and returns the status and body.
func lanCall(t *testing.T, ms *machineServer, method, base, path string, body any) (int, string) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, base+path, r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(path, "/api/server/") {
		req.Header.Set(machineserver.TokenHeader, ms.Token)
	}
	resp, err := (&http.Client{Timeout: sessionOpenTimeout}).Do(req)
	if err != nil {
		t.Fatalf("%s %s%s: %v", method, base, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// sessionCall sends one request to a session's API at u, with the session's
// API token, JSON-encoding body when given, and returns the status and body.
func sessionCall(t *testing.T, method, u, token string, body any) (int, string) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, u, r)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Juggler-Token", token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := (&http.Client{Timeout: sessionOpenTimeout}).Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, u, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

// TestMachineServerOnTheLAN is M4's exit, on the real binary, from this
// machine's own LAN address — a caller off loopback, as a second machine's
// browser or desktop app is. While LAN access is off it is refused everything.
// Turned on from this machine, it gets the sessions page, launches and lists a
// session, loads it through the link the session's Settings → Connectivity
// shares for that address, and joins it as a viewer; it cannot take the engine slot, switch LAN access or
// stop the server, nor through the session's own switch. Turned off again —
// from a session, by its viewer on this machine — it is refused again.
func TestMachineServerOnTheLAN(t *testing.T) {
	ip := lanIP(t)
	if ip == "" {
		t.Skip("this machine has no LAN address to call from")
	}
	ms, stop := startMachineServer(t)
	defer stop()
	_, port, err := net.SplitHostPort(ms.Addr)
	if err != nil {
		t.Fatalf("server addr %q: %v", ms.Addr, err)
	}
	lan := "http://" + net.JoinHostPort(ip, port)

	if code, _ := lanCall(t, ms, http.MethodGet, lan, "/", nil); code != http.StatusForbidden {
		t.Fatalf("LAN off: GET / from the LAN: status %d, want 403", code)
	}
	if code, _ := lanCall(t, ms, http.MethodGet, lan, "/api/server/sessions", nil); code != http.StatusForbidden {
		t.Fatalf("LAN off: GET sessions from the LAN with the token: status %d, want 403", code)
	}

	if code, out, errOut := ms.cli("server", "lan", "on"); code != 0 || !strings.Contains(out, lan+"/") {
		t.Fatalf("juggler server lan on: exit %d, stdout %q, stderr %q; want 0, naming %s/", code, out, errOut, lan)
	}

	code, page := lanCall(t, ms, http.MethodGet, lan, "/", nil)
	if code != http.StatusOK || !strings.Contains(page, `id="machine-config"`) {
		t.Fatalf("LAN on: GET / from the LAN: status %d; want the sessions page", code)
	}

	project := newProjectDir(t)
	code, body := lanCall(t, ms, http.MethodPost, lan, "/api/server/sessions", map[string]string{"project": project})
	if code != http.StatusCreated {
		t.Fatalf("LAN on: launch from the LAN: status %d (%s), want 201", code, body)
	}
	var sess machineserver.Session
	if err := json.Unmarshal([]byte(body), &sess); err != nil {
		t.Fatalf("decode session %s: %v", body, err)
	}
	ms.noteChild(sess)
	if code, list := lanCall(t, ms, http.MethodGet, lan, "/api/server/sessions", nil); code != http.StatusOK || !strings.Contains(list, sess.ID) {
		t.Fatalf("LAN on: list from the LAN: status %d, %s; want the session it launched", code, list)
	}

	// The link to this session its Settings → Connectivity shares for this
	// LAN address — asked of the session by its viewer on this machine — is
	// the one the other device opens.
	prefix := "/s/" + sess.ID
	local := "http://" + ms.Addr
	code, localPage := lanCall(t, ms, http.MethodGet, local, prefix+"/", nil)
	m := apiTokenPattern.FindStringSubmatch(localPage)
	if code != http.StatusOK || m == nil {
		t.Fatalf("the session's page from this machine: status %d, token found %v", code, m != nil)
	}
	code, shared := sessionCall(t, http.MethodGet, local+prefix+"/api/connectivity/lan", m[1], nil)
	var links struct {
		URLs []struct {
			URL     string `json:"url"`
			Session *struct {
				URL string `json:"url"`
				QR  string `json:"qr"`
			} `json:"session"`
		} `json:"urls"`
	}
	if err := json.Unmarshal([]byte(shared), &links); code != http.StatusOK || err != nil {
		t.Fatalf("the session's LAN links: status %d (%s)", code, shared)
	}
	link := ""
	for _, u := range links.URLs {
		if u.URL == lan+"/" && u.Session != nil && strings.HasPrefix(u.Session.QR, "<svg") {
			link = u.Session.URL
		}
	}
	if link != lan+prefix+"/" {
		t.Fatalf("the session's LAN links %s: want %s, with its QR, for %s/", shared, lan+prefix+"/", lan)
	}

	code, sessionPage := lanCall(t, ms, http.MethodGet, link, "", nil)
	m = apiTokenPattern.FindStringSubmatch(sessionPage)
	if code != http.StatusOK || m == nil {
		t.Fatalf("LAN on: the session's link from the LAN: status %d, token found %v", code, m != nil)
	}
	token := m[1]

	wsBase := "ws://" + net.JoinHostPort(ip, port) + prefix + apipaths.WebSocket
	header := http.Header{"Origin": []string{lan}}
	viewer, resp, err := websocket.DefaultDialer.Dial(wsBase+"?role=viewer&token="+url.QueryEscape(token), header)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("LAN on: viewer socket from the LAN: %v", err)
	}
	_ = viewer.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, first, err := viewer.ReadMessage()
	_ = viewer.Close()
	if err != nil || !strings.Contains(string(first), `"type":"session"`) {
		t.Fatalf("LAN on: viewer socket from the LAN: first frame %s, %v; want the session greeting", first, err)
	}
	conn, resp, err := websocket.DefaultDialer.Dial(wsBase+"?role=engine&token="+url.QueryEscape(token), header)
	assertEngineSlotRefused(t, conn, resp, err, "a caller on the LAN")

	for _, c := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPut, "/api/server/lan", map[string]bool{"enabled": false}},
		{http.MethodPost, "/api/server/shutdown", nil},
	} {
		if code, _ := lanCall(t, ms, c.method, lan, c.path, c.body); code != http.StatusForbidden {
			t.Errorf("LAN on: %s %s from the LAN: status %d, want 403", c.method, c.path, code)
		}
	}
	select {
	case <-ms.exited:
		t.Fatal("a caller on the LAN stopped the server")
	default:
	}

	// The proxy forwards any path, so the session's own routes are the gate: a
	// caller on the LAN without the session's token can neither stop it nor
	// read what it is and what it runs.
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/api/shutdown"},
		{http.MethodGet, apipaths.HealthInstance},
		{http.MethodGet, apipaths.HealthActive},
		{http.MethodGet, apipaths.Health},
	} {
		if code, body := lanCall(t, ms, c.method, lan, prefix+c.path, nil); code < 400 {
			t.Errorf("LAN on: tokenless %s %s%s from the LAN: status %d (%s), want refused", c.method, prefix, c.path, code, body)
		}
	}
	if code, body := sessionCall(t, http.MethodGet, lan+prefix+apipaths.HealthInstance, token, nil); code != http.StatusOK || !strings.Contains(body, `"pid":`) {
		t.Fatalf("LAN on: the session's instance with its token, after the tokenless calls: status %d (%s), want it still serving", code, body)
	}

	// A session's Settings → Connectivity switches the machine's LAN access
	// through the session's own route: refused to its viewer on the LAN, and
	// done for its viewer on this machine.
	switchOff := map[string]bool{"enabled": false}
	if code, body := sessionCall(t, http.MethodPut, lan+prefix+"/api/connectivity/lan", token, switchOff); code != http.StatusForbidden {
		t.Errorf("LAN on: the session's LAN switch from the LAN: status %d (%s), want 403", code, body)
	}
	if code, body := sessionCall(t, http.MethodPut, local+prefix+"/api/connectivity/lan", token, switchOff); code != http.StatusOK || !strings.Contains(body, `"enabled":false`) {
		t.Fatalf("the session's LAN switch from this machine: status %d (%s), want LAN access off", code, body)
	}
	if code, _ := lanCall(t, ms, http.MethodGet, lan, "/", nil); code != http.StatusForbidden {
		t.Fatalf("LAN off again: GET / from the LAN: status %d, want 403", code)
	}
}
