//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"juggler/cmd/juggler/core"
	"juggler/internal/ingress"
	"juggler/internal/userpaths/userpathstest"
	"juggler/web"
)

// get performs a GET and returns (statusCode, body).
func get(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url) //nolint:gosec // test-local httptest URL
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, string(body)
}

func TestSessionProxyRoutesAndStripsPrefix(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "path="+r.URL.Path)
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)

	front := httptest.NewServer(s.routes())
	defer front.Close()

	if code, body := get(t, front.URL+sess.Link+"api/health"); code != http.StatusOK || body != "path=/api/health" {
		t.Fatalf("proxied request: code=%d body=%q", code, body)
	}
	// The session root proxies to the child's "/".
	if code, body := get(t, front.URL+sess.Link); code != http.StatusOK || body != "path=/" {
		t.Fatalf("session root: code=%d body=%q", code, body)
	}
	// A bare /p/<key> redirects to /p/<key>/ (the default client follows it).
	if code, body := get(t, front.URL+strings.TrimSuffix(sess.Link, "/")); code != http.StatusOK || body != "path=/" {
		t.Fatalf("bare session path: code=%d body=%q", code, body)
	}
}

// TestSessionProxyForwardsPrefix checks the child is told the prefix it is
// being served under, and that a client cannot choose it: a forged
// X-Forwarded-Prefix is replaced, not passed on.
func TestSessionProxyForwardsPrefix(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Join(r.Header.Values("X-Forwarded-Prefix"), ","))
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	req, err := http.NewRequest("GET", front.URL+sess.Link, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-Prefix", "/evil")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if got, want := string(body), strings.TrimSuffix(sess.Link, "/"); got != want {
		t.Fatalf("child saw X-Forwarded-Prefix %q, want %q", got, want)
	}
}

// asCaller serves h as if every request came from addr. A test server listens
// on loopback, so this is the only way a test can put a caller off loopback in
// front of the proxy.
func asCaller(addr string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.RemoteAddr = addr
		h.ServeHTTP(w, r)
	})
}

// TestSessionProxyIdentifiesRemoteCallers checks the proxy's half of caller
// identity: a caller off loopback is forwarded with the child's ingress secret,
// a loopback caller with none, and a client's own copy of the header never
// reaches the child either way.
func TestSessionProxyIdentifiesRemoteCallers(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Join(r.Header.Values(ingress.Header), ","))
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	s.lan.Store(true)
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://"), ingressSecret: "child-secret"}, 1)

	for _, c := range []struct {
		caller, want string
	}{
		{"127.0.0.1:5000", ""},
		{"[::1]:5000", ""},
		{"203.0.113.7:54321", "child-secret"},
		{"192.168.1.20:54321", "child-secret"},
	} {
		front := httptest.NewServer(asCaller(c.caller, s.routes()))
		req, err := http.NewRequest("GET", front.URL+sess.Link, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(ingress.Header, "forged")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		front.Close()
		if resp.StatusCode != http.StatusOK || string(body) != c.want {
			t.Errorf("caller %s: child saw %s %q (status %d), want %q", c.caller, ingress.Header, body, resp.StatusCode, c.want)
		}
	}
}

// A remote caller forwarded without the tag would look local to the child, so
// a child with no secret to send is not proxied to at all for one.
func TestSessionProxyRefusesRemoteCallerItCannotIdentify(t *testing.T) {
	var reached atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached.Add(1)
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	s.lan.Store(true)
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)

	remote := httptest.NewServer(asCaller("203.0.113.7:54321", s.routes()))
	defer remote.Close()
	if code, _ := get(t, remote.URL+sess.Link); code != http.StatusBadGateway || reached.Load() != 0 {
		t.Fatalf("remote caller, child without a secret: status %d after %d proxied requests, want 502 after none", code, reached.Load())
	}

	local := httptest.NewServer(s.routes())
	defer local.Close()
	if code, _ := get(t, local.URL+sess.Link); code != http.StatusOK || reached.Load() != 1 {
		t.Fatalf("loopback caller: status %d after %d proxied requests, want 200 after one", code, reached.Load())
	}
}

func TestSessionProxyRejectsUnknownAndNotRunning(t *testing.T) {
	s := &Server{reg: newRegistry()}
	starting, _ := s.reg.reserve("/p")

	front := httptest.NewServer(s.routes())
	defer front.Close()

	if code, _ := get(t, front.URL+projectLink("/nope")+"anything"); code != http.StatusNotFound {
		t.Fatalf("unknown project: code=%d, want 404", code)
	}
	// A session is addressed by its project's link alone; its id addresses
	// nothing.
	if code, _ := get(t, front.URL+"/s/"+starting.ID+"/anything"); code != http.StatusNotFound {
		t.Fatalf("/s/<id>/: code=%d, want 404", code)
	}
	if code, _ := get(t, front.URL+starting.Link+"anything"); code != http.StatusServiceUnavailable {
		t.Fatalf("starting session: code=%d, want 503", code)
	}
}

// TestProjectLinkWithoutChildServesTheOpener: a project's link is its
// session's address, and outlives the session. A browser loading it while the
// project has no running child — none at all, or one starting, restarting,
// stopping or failed — gets the sessions page set to open that project there,
// which it does through the control API; the load itself starts nothing.
// Anything else asking — a script's fetch, an asset, a socket — gets 404 when
// the project has no session and 503 while it is not running. A key that
// names no project the server knows of is the page saying so, as a 404.
func TestProjectLinkWithoutChildServesTheOpener(t *testing.T) {
	home := userpathstest.Isolate(t)
	store, err := core.NewRecentsStore()
	if err != nil {
		t.Fatal(err)
	}
	recent := filepath.Join(home, "recent")
	if err := os.Mkdir(recent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.Add(recent); err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, recents: store, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	starting, _ := s.reg.reserve("/work/starting")
	restarting, _ := s.reg.reserve("/work/restarting")
	rc := &child{addr: "127.0.0.1:1"}
	s.reg.setRunning(restarting.ID, rc, 1)
	s.reg.setRestarting(restarting.ID, rc, "crashed", time.Now().Add(time.Hour))
	stopping, _ := s.reg.reserve("/work/stopping")
	s.reg.setRunning(stopping.ID, &child{addr: "127.0.0.1:1"}, 1)
	s.reg.beginStop(stopping.ID)
	failed, _ := s.reg.reserve("/work/failed")
	s.reg.setError(failed.ID, "spawn failed")
	before := s.reg.snapshot()

	// load answers the status and body of a GET of path with hdr.
	load := func(path string, hdr map[string]string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", front.URL+path, nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	pageLoads := []map[string]string{
		{"Sec-Fetch-Dest": "document", "Accept": "text/html,application/xhtml+xml"},
		{"Accept": "text/html,application/xhtml+xml"}, // a browser that sends no Sec-Fetch-*
	}
	notPages := []struct {
		rest string
		hdr  map[string]string
	}{
		{"", map[string]string{"Sec-Fetch-Dest": "empty", "Accept": "*/*"}},
		{"", nil},
		{"api/health", map[string]string{"Sec-Fetch-Dest": "document", "Accept": "text/html"}},
		{"js/app.js", map[string]string{"Sec-Fetch-Dest": "script"}},
		{"api/ws", map[string]string{"Sec-Fetch-Dest": "websocket", "Connection": "Upgrade", "Upgrade": "websocket"}},
	}

	for _, c := range []struct {
		what, project string
		other         int // what a request that is no page load gets
	}{
		{"no session, a recent project", recent, http.StatusNotFound},
		{"starting", starting.Project, http.StatusServiceUnavailable},
		{"restarting", restarting.Project, http.StatusServiceUnavailable},
		{"stopping", stopping.Project, http.StatusServiceUnavailable},
		{"failed", failed.Project, http.StatusServiceUnavailable},
	} {
		link := projectLink(c.project)
		for _, hdr := range pageLoads {
			for _, path := range []string{link, link + "?x=1"} {
				code, body := load(path, hdr)
				if code != http.StatusOK {
					t.Errorf("%s: page load %s with %v: status %d, want the opener's 200", c.what, path, hdr, code)
					continue
				}
				if cfg := decodePageConfig(t, body); cfg["open"] != c.project || cfg["token"] != testToken {
					t.Errorf("%s: page load %s: config %v, want open %q with the token", c.what, path, cfg, c.project)
				}
			}
		}
		for _, np := range notPages {
			if code, _ := load(link+np.rest, np.hdr); code != c.other {
				t.Errorf("%s: GET %s with %v: status %d, want %d", c.what, link+np.rest, np.hdr, code, c.other)
			}
		}
	}

	code, body := load(projectLink(filepath.Join(home, "elsewhere")), pageLoads[0])
	if code != http.StatusNotFound {
		t.Errorf("unknown key: page load status %d, want 404", code)
	}
	if cfg := decodePageConfig(t, body); cfg["openMissing"] != true || cfg["open"] != nil {
		t.Errorf("unknown key's page config = %v; want openMissing and no open", cfg)
	}

	// The sessions page itself names nothing to open.
	if _, body := load("/", pageLoads[0]); decodePageConfig(t, body)["open"] != nil {
		t.Errorf("GET / page config = %v; want nothing to open", decodePageConfig(t, body))
	}

	after := s.reg.snapshot()
	if len(after) != len(before) {
		t.Fatalf("loading links changed the sessions from %d to %d; a load opens nothing", len(before), len(after))
	}
	for i := range before {
		if after[i].ID != before[i].ID || after[i].State != before[i].State {
			t.Errorf("session %s went from %s to %s (%s); a load opens nothing", before[i].Project, before[i].State, after[i].State, after[i].ID)
		}
	}
}

// TestProjectLinkOpenerAsksAnotherSitesVisitor: the page at a project's link
// opens the project as it loads for a visitor who came from this server's own
// pages, a bookmark, an address typed or scanned — and asks first, with a
// button, one sent from anywhere else (Sec-Fetch-Site), so a link planted on
// another site, or another server on this machine, starts nothing until the
// user says so.
func TestProjectLinkOpenerAsksAnotherSitesVisitor(t *testing.T) {
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	sess, _ := s.reg.reserve("/work/proj")

	for site, ask := range map[string]bool{"": false, "none": false, "same-origin": false, "same-site": true, "cross-site": true} {
		req, _ := http.NewRequest("GET", front.URL+sess.Link, nil)
		req.Header.Set("Accept", "text/html")
		if site != "" {
			req.Header.Set("Sec-Fetch-Site", site)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		cfg := decodePageConfig(t, string(body))
		if cfg["open"] != sess.Project || (cfg["confirm"] == true) != ask {
			t.Errorf("Sec-Fetch-Site %q: page config %v; want open %q, confirm %v", site, cfg, sess.Project, ask)
		}
	}
}

// TestHostGuardRejectsRebindingHosts is the machine server's DNS-rebinding
// defence. A page whose own domain an attacker has pointed at this machine
// sends that domain as Host, and passes the Origin guard because its Origin
// names the same domain. So every request — the control API, the proxy, a
// WebSocket upgrade, from loopback or off it — must name this machine in its
// Host, or it is refused before it reaches anything.
func TestHostGuardRejectsRebindingHosts(t *testing.T) {
	var reached atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached.Add(1)
	}))
	defer backend.Close()

	// LAN access on, so what refuses the off-loopback caller is the Host guard
	// and not the LAN gate in front of it.
	s := &Server{reg: newRegistry(), token: testToken}
	s.lan.Store(true)
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://"), ingressSecret: "child-secret"}, 1)

	paths := []string{"/api/server/status", "/api/server/sessions", sess.Link, sess.Link + "api/ws"}
	for _, caller := range []string{"127.0.0.1:5000", "192.168.1.20:54321"} {
		front := httptest.NewServer(asCaller(caller, s.routes()))
		for _, host := range []string{"attacker.com", "attacker.com:8080", "localhost.attacker.com", "notlocalhost.com:8080"} {
			for _, p := range paths {
				before := reached.Load()
				req, err := http.NewRequest("GET", front.URL+p, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.Host = host
				// The rebinding page is same-origin with itself, and is given
				// the token so only the Host can be what refuses it.
				req.Header.Set("Origin", "http://"+host)
				req.Header.Set(TokenHeader, testToken)
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				_ = resp.Body.Close()
				if resp.StatusCode != http.StatusForbidden || reached.Load() != before {
					t.Errorf("caller %s, Host %q, GET %s: status %d, reached child %v; want 403, not reached",
						caller, host, p, resp.StatusCode, reached.Load() != before)
				}
			}
		}
		front.Close()
	}

	// Every name that can only mean this machine still gets through.
	front := httptest.NewServer(s.routes())
	defer front.Close()
	for _, host := range []string{"127.0.0.1:8317", "localhost:8317", "LocalHost", "myproject.localhost:8317", "192.168.1.5:8317", "[::1]:8317"} {
		for _, p := range []string{"/api/server/status", sess.Link} {
			req, err := http.NewRequest("GET", front.URL+p, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Host = host
			req.Header.Set(TokenHeader, testToken)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Errorf("Host %q, GET %s: status %d, want 200", host, p, resp.StatusCode)
			}
		}
	}
}

func TestOriginGuardRejectsCrossOrigin(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	req, err := http.NewRequest("GET", front.URL+"/api/server/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(TokenHeader, testToken)
	req.Header.Set("Origin", "http://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin request: code=%d, want 403", resp.StatusCode)
	}

	// Same-origin passes.
	req2, err := http.NewRequest("GET", front.URL+"/api/server/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	req2.Header.Set(TokenHeader, testToken)
	req2.Header.Set("Origin", front.URL)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("same-origin request: code=%d, want 200", resp2.StatusCode)
	}
}

// TestProxiedRequestRenewsAnUnviewedGrace: a page still loading its session —
// fetching through the proxy, its socket not yet open — is a viewer on its way,
// so each request it makes renews the grace, and a slow load is not retired
// under it. With a viewer connected the grace is not running, and a request
// leaves it alone.
func TestProxiedRequestRenewsAnUnviewedGrace(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	c := &child{addr: strings.TrimPrefix(backend.URL, "http://")}
	s.reg.setRunning(sess.ID, c, 1)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	// A fixed past instant, so the renewal is later however coarse the clock.
	past := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	s.reg.do(func(m map[string]*sessionEntry) { m[sess.ID].unviewedSince = past })
	if code, _ := get(t, front.URL+sess.Link+"js/app.js"); code != http.StatusOK {
		t.Fatalf("proxied asset: status %d, want 200", code)
	}
	if s.reg.retireUnviewed(sess.ID, c, past.Add(sessionViewerGrace)) {
		t.Fatal("a session whose page was loading through the proxy was retired on the grace that ran before it")
	}

	release, ok := s.reg.holdViewer(sess.ID)
	if !ok {
		t.Fatal("viewer refused")
	}
	defer release()
	s.reg.do(func(m map[string]*sessionEntry) { m[sess.ID].unviewedSince = past })
	get(t, front.URL+sess.Link+"js/app.js")
	s.reg.do(func(m map[string]*sessionEntry) {
		if !m[sess.ID].unviewedSince.Equal(past) {
			t.Errorf("a request with a viewer connected moved the grace to %s", m[sess.ID].unviewedSince)
		}
	})
}

// TestProxiedWebSocketDoesNotAttachToServer: a viewer's socket to its
// session is a session viewer, not a local client holding the server up.
func TestProxiedWebSocketDoesNotAttachToServer(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !websocket.IsWebSocketUpgrade(r) {
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	if code, _ := get(t, front.URL+sess.Link+"api/health"); code != http.StatusOK || s.attached.Load() != 0 {
		t.Fatalf("plain proxied request: status %d, %d attached; want 200, none", code, s.attached.Load())
	}
	conn, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(front.URL, "http")+sess.Link+"api/ws", nil)
	if err != nil {
		t.Fatalf("dial through the proxy: %v", err)
	}
	_ = resp.Body.Close()
	defer conn.Close()
	viewers := func() (n int) {
		s.reg.do(func(m map[string]*sessionEntry) { n = m[sess.ID].viewers })
		return n
	}
	if got := viewers(); got != 1 {
		t.Fatalf("with a proxied socket open: %d session viewers, want 1", got)
	}
	if got := s.attached.Load(); got != 0 {
		t.Fatalf("with a proxied socket open: %d attached, want none", got)
	}
	_ = conn.Close()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for viewers() != 0 {
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatal("closed proxied socket still holds a session viewer")
		}
	}
	s.reg.do(func(m map[string]*sessionEntry) {
		if m[sess.ID].unviewedSince.IsZero() {
			t.Error("last socket departure did not start viewer grace")
		}
	})
	waitAttached(t, s, 0)
}
