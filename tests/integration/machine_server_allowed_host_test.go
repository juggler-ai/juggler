//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"juggler/internal/apipaths"
)

// TestMachineServerAdmitsAllowedHostAsRemote stands in for a reverse proxy on
// this machine (tailscale serve) in front of a real `serve --allow-host`. It
// connects over loopback and forwards its public name as Host. A session's page
// and API work under that name while LAN access is off. The real child behind
// the proxy treats the caller as remote: it cannot write this machine's UI
// preferences or take the engine slot. A name not on the list is still
// refused.
func TestMachineServerAdmitsAllowedHostAsRemote(t *testing.T) {
	const allowed = "box.tailnet.example.ts.net"
	ms, stop := startMachineServer(t, "--allow-host", allowed)
	defer stop()
	sess := ms.openSession(newProjectDir(t), http.StatusCreated)
	prefix := strings.TrimSuffix(sess.Link, "/")

	do := func(method, path, host, token, body string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, ms.url(path), strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		req.Header.Set("Origin", "https://"+host)
		if token != "" {
			req.Header.Set("X-Juggler-Token", token)
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	code, page := do(http.MethodGet, prefix+"/", allowed, "", "")
	m := apiTokenPattern.FindStringSubmatch(page)
	if code != http.StatusOK || m == nil {
		t.Fatalf("GET %s/ with Host %s: status %d, token found %v; want 200 with a token", prefix, allowed, code, m != nil)
	}
	token := m[1]

	if code, body := do(http.MethodPut, prefix+"/api/session/ui-prefs", allowed, token, `{"ui":{"juggler-column-width":"31.5"}}`); code != http.StatusForbidden {
		t.Errorf("PUT ui-prefs through the proxy: status %d (%s), want 403 (a remote viewer)", code, strings.TrimSpace(body))
	}
	addr := strings.TrimPrefix(ms.url(""), "http://")
	if code, body := do(http.MethodPut, prefix+"/api/session/ui-prefs", addr, token, `{"ui":{"juggler-column-width":"31.5"}}`); code != http.StatusOK {
		t.Errorf("PUT ui-prefs from this machine: status %d (%s), want 200", code, strings.TrimSpace(body))
	}
	if code, _ := do(http.MethodGet, prefix+"/", "other.tailnet.example.ts.net", "", ""); code != http.StatusForbidden {
		t.Errorf("GET %s/ with an unlisted Host: status %d, want 403", prefix, code)
	}

	// The engine slot, asked for with the session's own token so that only
	// where the request came from can be what refuses it.
	dialer := websocket.Dialer{
		NetDial: func(network, _ string) (net.Conn, error) { return net.Dial(network, addr) },
	}
	header := http.Header{"Origin": []string{"https://" + allowed}}
	conn, resp, err := dialer.Dial("ws://"+allowed+prefix+apipaths.WebSocket+"?role=engine&token="+url.QueryEscape(token), header)
	assertEngineSlotRefused(t, conn, resp, err, "a caller through the proxy")
}
