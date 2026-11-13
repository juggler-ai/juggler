//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/basepath"
	"juggler/internal/hostcheck"
	"juggler/internal/userpaths/userpathstest"
	"juggler/web"
)

// request sends method url with headers, as from host when host is set, and
// returns the status, headers and body. Redirects are not followed.
func request(t *testing.T, method, url, host string, headers map[string]string) (int, http.Header, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(body)
}

// TestSessionsPageUnderAForwardedPrefix: behind a reverse proxy that mounts
// the machine server under a path and names it in X-Forwarded-Prefix, the
// sessions page addresses everything through that path — its assets, the
// Wails runtime a desktop window loads, and the control API (the config's
// base). A malformed prefix is ignored, as is one too long for a project's
// link below it to fit what a session child accepts.
func TestSessionsPageUnderAForwardedPrefix(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	longest := "/" + strings.Repeat("a", maxBasePath-1)
	for header, want := range map[string]string{
		"":               "",
		"/juggler":       "/juggler",
		"/a/b-c_d":       "/a/b-c_d",
		longest:          longest,
		longest + "a":    "",
		"/juggler/":      "",
		"/a b":           "",
		"//evil.example": "",
	} {
		headers := map[string]string{}
		if header != "" {
			headers[basepath.Header] = header
		}
		code, _, body := request(t, "GET", front.URL+"/?window=1", "", headers)
		if code != http.StatusOK {
			t.Fatalf("under %q: status %d", header, code)
		}
		if got := decodePageConfig(t, body)["base"]; got != want {
			t.Errorf("under %q: config base = %v, want %q", header, got, want)
		}
		refs := pageRefPattern.FindAllStringSubmatch(body, -1)
		if len(refs) < 4 {
			t.Fatalf("under %q: page references %d assets", header, len(refs))
		}
		for _, m := range refs {
			if !strings.HasPrefix(m[1], want+"/v"+assetVersion+"/") && m[1] != want+"/wails/runtime.js" {
				t.Errorf("under %q: page references %q, outside %q", header, m[1], want)
			}
		}
		if !strings.Contains(body, `src="`+want+`/wails/runtime.js"`) {
			t.Errorf("under %q: a window's page does not load the Wails runtime from %q", header, want+"/wails/runtime.js")
		}
	}
}

// TestBasePathFlagServesTheLocalProxy: --base-path is the prefix of a reverse
// proxy on this machine that cannot name it (tailscale serve --set-path). It
// is for that proxy's callers only — a loopback request naming an allowed
// host — whom it addresses whatever they send; a client reaching the server
// directly, a desktop window among them, is addressed by its own request.
func TestBasePathFlagServesTheLocalProxy(t *testing.T) {
	allowed, err := hostcheck.NewAllowList([]string{"box.tailnet.ts.net"})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" },
		allowedHosts: allowed, fixedBase: "/jg"}
	s.lan.Store(true)
	for _, c := range []struct {
		name, caller, host, header, want string
	}{
		{"the proxy", "127.0.0.1:5000", "box.tailnet.ts.net", "", "/jg"},
		{"the proxy, naming another prefix", "127.0.0.1:5000", "box.tailnet.ts.net", "/other", "/jg"},
		{"a client on this machine", "127.0.0.1:5000", "", "", ""},
		{"a client on this machine behind its own proxy", "127.0.0.1:5000", "", "/hdr", "/hdr"},
		{"a LAN caller naming the proxy's host", "192.168.1.20:54321", "box.tailnet.ts.net", "", ""},
	} {
		front := httptest.NewServer(asCaller(c.caller, s.routes()))
		headers := map[string]string{}
		if c.header != "" {
			headers[basepath.Header] = c.header
		}
		_, _, body := request(t, "GET", front.URL+"/", c.host, headers)
		front.Close()
		if got := decodePageConfig(t, body)["base"]; got != c.want {
			t.Errorf("%s: config base = %v, want %q", c.name, got, c.want)
		}
	}
}

// TestProjectLinksCarryTheBase: every project link the control API hands a
// viewer — each session's, each recent's, an open's answer, and the events
// stream's — is addressed under the prefix the viewer reached the server by,
// so the page that follows one stays behind the proxy. The links a session
// offers for LAN access and tunnels (askedSession) do not: those reach the
// server directly, never through the proxy.
func TestProjectLinksCarryTheBase(t *testing.T) {
	home := userpathstest.Isolate(t)
	store, err := core.NewRecentsStore()
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(home, "proj")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.Add(project); err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), token: testToken, recents: store}
	sess, _ := s.reg.reserve(project)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	for _, base := range []string{"", "/juggler"} {
		headers := map[string]string{TokenHeader: testToken}
		if base != "" {
			headers[basepath.Header] = base
		}
		want := base + projectLink(project)

		var sessions []Session
		_, _, body := request(t, "GET", front.URL+"/api/server/sessions", "", headers)
		if err := json.Unmarshal([]byte(body), &sessions); err != nil || len(sessions) != 1 || sessions[0].Link != want {
			t.Errorf("under %q: sessions = %s, want the link %q", base, body, want)
		}

		var recents recentsResponse
		_, _, body = request(t, "GET", front.URL+"/api/server/recents", "", headers)
		if err := json.Unmarshal([]byte(body), &recents); err != nil || recents.Links[project] != want {
			t.Errorf("under %q: recents = %s, want the link %q", base, body, want)
		}

		req, err := http.NewRequest("POST", front.URL+"/api/server/sessions", strings.NewReader(`{"project":`+jsonString(project)+`}`))
		if err != nil {
			t.Fatal(err)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var opened Session
		err = json.NewDecoder(resp.Body).Decode(&opened)
		resp.Body.Close()
		if err != nil || opened.Link != want {
			t.Errorf("under %q: an open answered the link %q (%v), want %q", base, opened.Link, err, want)
		}

		ctx, cancel := context.WithCancel(context.Background())
		req, err = http.NewRequestWithContext(ctx, "GET", front.URL+"/api/server/events", nil)
		if err != nil {
			t.Fatal(err)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err = http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var ev eventsPayload
		if err := json.Unmarshal([]byte(nextEvent(t, readEvents(resp.Body)).data), &ev); err != nil {
			t.Fatal(err)
		}
		cancel()
		resp.Body.Close()
		if len(ev.Sessions) != 1 || ev.Sessions[0].Link != want || ev.Recents.Links[project] != want {
			t.Errorf("under %q: events carried %+v, want the link %q", base, ev, want)
		}

		asked := httptest.NewRequest("GET", "/api/server/lan?session="+sess.ID, nil)
		for k, v := range headers {
			asked.Header.Set(k, v)
		}
		if got := s.askedSession(asked); got != projectLink(project) {
			t.Errorf("under %q: the link offered for LAN access and tunnels is %q, want %q", base, got, projectLink(project))
		}
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// TestSessionProxyForwardsTheMachinesPrefix: a child is told the prefix it is
// served under — its link, below the prefix a proxy mounts the machine server
// under — and the machine server's own prefix, which it passes back on the
// calls it relays for the viewer. Both are this server's to say: the child
// never sees a client's own value of either, only one rebuilt here, and a
// malformed prefix is dropped. A bare /p/<key> redirects under the prefix too.
func TestSessionProxyForwardsTheMachinesPrefix(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Join(r.Header.Values(basepath.Header), ",")+"|"+strings.Join(r.Header.Values(basepath.MachineHeader), ","))
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)
	front := httptest.NewServer(s.routes())
	defer front.Close()
	link := strings.TrimSuffix(sess.Link, "/")

	for _, c := range []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{"direct", nil, link + "|"},
		{"under a prefix", map[string]string{basepath.Header: "/juggler"}, "/juggler" + link + "|/juggler"},
		{"under a malformed prefix", map[string]string{basepath.Header: "/e vil"}, link + "|"},
		{"naming the machine's prefix itself", map[string]string{basepath.MachineHeader: "/evil"}, link + "|"},
		{"under a prefix, naming another", map[string]string{basepath.Header: "/juggler", basepath.MachineHeader: "/evil"}, "/juggler" + link + "|/juggler"},
	} {
		if _, _, body := request(t, "GET", front.URL+sess.Link, "", c.headers); body != c.want {
			t.Errorf("%s: the child saw %q, want %q", c.name, body, c.want)
		}
	}

	code, hdr, _ := request(t, "GET", front.URL+link+"?c=conv_1", "", map[string]string{basepath.Header: "/juggler"})
	if loc := hdr.Get("Location"); code != http.StatusMovedPermanently || loc != "/juggler"+sess.Link+"?c=conv_1" {
		t.Errorf("a bare link under /juggler: %d to %q, want a redirect to %q", code, loc, "/juggler"+sess.Link+"?c=conv_1")
	}
}

// TestBasePathFlagIsChecked: --base-path takes a path a page may be served
// under, with or without its trailing slash, short enough that a project's
// link below it fits what a session child accepts.
func TestBasePathFlagIsChecked(t *testing.T) {
	for in, want := range map[string]string{
		"":          "",
		"/juggler":  "/juggler",
		"/juggler/": "/juggler",
		"/a/b":      "/a/b",
	} {
		if got, err := checkBasePath(in); err != nil || got != want {
			t.Errorf("checkBasePath(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"juggler", "/", "/a b", "/a/../b", "/" + strings.Repeat("a", maxBasePath)} {
		if got, err := checkBasePath(in); err == nil {
			t.Errorf("checkBasePath(%q) = %q, want it refused", in, got)
		}
	}
}
