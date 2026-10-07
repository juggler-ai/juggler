//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/apipaths"
	"juggler/internal/srcroot"
)

const testAPIToken = "test-instance-token-abc123"

// newAuthTestServer builds a minimal non-test-mode server whose router carries
// only the api-auth middleware, plus a gated /api/ops/call, an exempt
// /api/health, the board routes either side of the delete exemption, and a
// non-/api "/" — enough to exercise every branch of the token + Host allowlist
// without standing up the full New() machinery.
func newAuthTestServer(t *testing.T) (*Server, *bool) {
	t.Helper()
	var reached bool
	s := &Server{router: mux.NewRouter(), apiToken: testAPIToken}
	s.router.Use(s.apiAuthMiddleware)
	hit := func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}
	s.router.HandleFunc("/api/ops/call", hit).Methods("POST")
	s.router.HandleFunc("/api/health", hit).Methods("GET")
	s.router.HandleFunc("/api/session/window-state", hit).Methods("GET", "PUT")
	s.router.HandleFunc("/api/session/conversations/{convId}/assets/{sha}", hit).Methods("GET")
	s.router.HandleFunc("/api/session/files/content", hit).Methods("GET")
	s.router.HandleFunc("/api/session/files/bytes", hit).Methods("POST")
	// The board routes carry every method the exemption has to tell apart, so
	// what refuses one is the middleware and not a router with no route for it.
	s.router.HandleFunc("/api/session/pinboard/boards", hit).Methods("GET", "POST", "PUT", "DELETE")
	s.router.HandleFunc("/api/session/pinboard/boards/restore", hit).Methods("POST", "DELETE")
	s.router.HandleFunc("/api/session/pinboard/seed", hit).Methods("POST", "DELETE")
	s.router.HandleFunc("/api/session/pinboard", hit).Methods("GET", "DELETE")
	s.router.HandleFunc("/", hit).Methods("GET")
	return s, &reached
}

// TestAPIAuthRejectsUntokenedOpsCall is the core §S assertion: a cross-site page
// POSTing to /api/ops/call without the per-instance token is rejected with 401
// and never reaches the handler — closing the localhost cross-site RCE vector.
func TestAPIAuthRejectsUntokenedOpsCall(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "localhost" // isolate the token check from the Host check
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("untokened ops/call: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for an untokened ops/call")
	}
}

func TestAPIAuthRejectsWrongToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "localhost"
	req.Header.Set("X-Juggler-Token", "not-the-real-token")
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-token ops/call: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for a wrong-token ops/call")
	}
}

func TestAPIAuthAllowsCorrectToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "localhost"
	req.Header.Set("X-Juggler-Token", testAPIToken)
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("correctly-tokened ops/call: got %d, want 200", rec.Code)
	}
	if !*reached {
		t.Fatal("handler must run for a correctly-tokened, same-host ops/call")
	}
}

// TestAPIAuthAssetGetAcceptsQueryToken covers the <img src> path: an asset GET
// carries no X-Juggler-Token header (image loads can't set one), so the token
// rides as a ?token= query param and is accepted for this read-only route.
func TestAPIAuthAssetGetAcceptsQueryToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	const sha = "82203b2013a5381d5f1ae5ec3f85a0edf91bb7e65a82a91684a9aa1fc53e9da9"
	req := httptest.NewRequest(http.MethodGet, "/api/session/conversations/conv_x/assets/"+sha+"?token="+testAPIToken, nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("query-token asset GET: got %d reached=%v, want 200 reached=true", rec.Code, *reached)
	}
}

// TestAPIAuthAssetGetRejectsMissingToken confirms the query-param relaxation is
// still a gate: an asset GET with neither header nor ?token= is rejected 401.
func TestAPIAuthAssetGetRejectsMissingToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	const sha = "82203b2013a5381d5f1ae5ec3f85a0edf91bb7e65a82a91684a9aa1fc53e9da9"
	req := httptest.NewRequest(http.MethodGet, "/api/session/conversations/conv_x/assets/"+sha, nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("untokened asset GET: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for an untokened asset GET")
	}
}

// TestAPIAuthQueryTokenIgnoredOffAssetRoute confirms the ?token= fallback is
// scoped to the asset route only: a POST /api/ops/call with the token in the
// query string (but no header) is still rejected, preserving the header-only
// gate — and its forced CORS preflight — on the sensitive tool surface.
func TestAPIAuthQueryTokenIgnoredOffAssetRoute(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call?token="+testAPIToken, nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("query-token ops/call: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for a query-token-only ops/call")
	}
}

// TestAPIAuthFileBytesRequiresHeaderToken is what lets the raw-bytes POST honour
// the read op's out-of-root escape hatches: unlike the streaming GET beside it,
// its token is accepted ONLY as a header (so the request also carries a CORS
// preflight no cross-origin caller survives). A ?token= URL that leaks — the
// exact exposure the GET route is contained against — buys nothing here.
func TestAPIAuthFileBytesRequiresHeaderToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/session/files/bytes?token="+testAPIToken, nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("query-token files/bytes: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for a query-token-only files/bytes POST")
	}

	*reached = false
	req = httptest.NewRequest(http.MethodPost, "/api/session/files/bytes", nil)
	req.Host = "localhost"
	req.Header.Set("X-Juggler-Token", testAPIToken)
	rec = httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("header-token files/bytes: got %d reached=%v, want 200 reached=true", rec.Code, *reached)
	}
}

// TestAPIAuthFileContentAcceptsQueryToken is the counterpart: the streaming GET
// is loaded by <canvas>/<iframe>, which cannot set a header, so it keeps the
// ?token= relaxation — and pays for it with containment to the project root.
func TestAPIAuthFileContentAcceptsQueryToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/session/files/content?path=a.txt&token="+testAPIToken, nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("query-token files/content GET: got %d reached=%v, want 200 reached=true", rec.Code, *reached)
	}
}

// TestAPIAuthFileTreeTakesTokenFromPath: the tree route frames a page whose
// relative links drop any query string, so its token is the first path segment
// — and a wrong or missing one is refused like any other.
func TestAPIAuthFileTreeTakesTokenFromPath(t *testing.T) {
	s, reached := newAuthTestServer(t)
	s.router.PathPrefix("/api/session/files/tree/").HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*reached = true
		w.WriteHeader(http.StatusOK)
	}).Methods("GET")

	cases := []struct {
		path string
		want int
	}{
		{"/api/session/files/tree/" + testAPIToken + "/proj/page/img.png", http.StatusOK},
		{"/api/session/files/tree/wrong/proj/page/img.png", http.StatusUnauthorized},
		{"/api/session/files/tree/proj/page/img.png", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		*reached = false
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)
		if rec.Code != tc.want || *reached != (tc.want == http.StatusOK) {
			t.Errorf("GET %s: got %d reached=%v, want %d", tc.path, rec.Code, *reached, tc.want)
		}
	}
}

// TestAPIAuthRejectsRebindingHost covers §S.2: even with a valid token, a Host
// header naming a DNS name (as a DNS-rebinding attacker's page would send) is
// rejected before the token is even consulted.
func TestAPIAuthRejectsRebindingHost(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "attacker.com" // a name, not localhost or an IP literal
	req.Header.Set("X-Juggler-Token", testAPIToken)
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("rebinding host: got %d, want 403", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for a disallowed Host")
	}
}

// TestAPIAuthAllowsDotLocalhostHost covers per-instance hostnames: running
// several instances and reaching each as <project>.localhost:<port> must work.
// RFC 6761 reserves the .localhost TLD and requires it to resolve to loopback,
// so such a name identifies this machine as surely as "localhost" and cannot be
// pointed at an attacker's address.
func TestAPIAuthAllowsDotLocalhostHost(t *testing.T) {
	s, reached := newAuthTestServer(t)

	for _, host := range []string{"myproject.localhost:8317", "myproject.localhost", "a.b.localhost:8317", "MyProject.LocalHost:8317"} {
		*reached = false
		req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
		req.Host = host
		req.Header.Set("X-Juggler-Token", testAPIToken)
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !*reached {
			t.Fatalf("host %q: got %d reached=%v, want 200 reached=true", host, rec.Code, *reached)
		}
	}
}

// TestAPIAuthRejectsLocalhostLookalikeHosts pins the boundary of that
// relaxation: only a label *under* .localhost is admitted. serveIndex embeds the
// API token in the page for any host that can load it, so a name merely
// containing or ending near "localhost" must stay refused.
func TestAPIAuthRejectsLocalhostLookalikeHosts(t *testing.T) {
	s, reached := newAuthTestServer(t)

	for _, host := range []string{"notlocalhost:8317", "evil-localhost:8317", "localhost.attacker.com:8317", "attacker.com:8317"} {
		*reached = false
		req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
		req.Host = host
		req.Header.Set("X-Juggler-Token", testAPIToken)
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("host %q: got %d, want 403", host, rec.Code)
		}
		if *reached {
			t.Fatalf("handler must not run for disallowed Host %q", host)
		}
	}
}

func TestAPIAuthAllowsIPHost(t *testing.T) {
	s, reached := newAuthTestServer(t)

	for _, host := range []string{"127.0.0.1:8317", "localhost:8317", "192.168.1.5:8317", "[::1]:8317"} {
		*reached = false
		req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
		req.Host = host
		req.Header.Set("X-Juggler-Token", testAPIToken)
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !*reached {
			t.Fatalf("host %q: got %d reached=%v, want 200 reached=true", host, rec.Code, *reached)
		}
	}
}

// TestAPIAuthExemptRoutesAreRegistered pins the correspondence the exempt list
// asserts and that nothing else can check: every path the gate lets through
// without a token must be a route this server actually registers.
//
// The two are three files apart and the compiler sees neither against the other,
// so the failure this catches is silent in both directions — a route renamed out
// from under the gate leaves the desktop app unable to save a window frame, and
// a gate entry outliving its route leaves an unauthenticated path standing for
// whatever is registered there next. Walking the real router is what makes the
// exempt list an assertion rather than a claim.
func TestAPIAuthExemptRoutesAreRegistered(t *testing.T) {
	s := &Server{router: mux.NewRouter()}
	s.setupBootstrapRoutes()
	// The remaining exempt paths are session routes; a zero SessionAPI is enough
	// to register them, since nothing here serves a request.
	s.setupSessionRoutes(&handlers.SessionAPI{})

	var registered []string
	if err := s.router.Walk(func(route *mux.Route, _ *mux.Router, _ []*mux.Route) error {
		// A route matched by a function rather than a path has no template.
		if tmpl, err := route.GetPathTemplate(); err == nil {
			registered = append(registered, tmpl)
		}
		return nil
	}); err != nil {
		t.Fatalf("walking the router: %v", err)
	}

	for path := range exemptRoutes {
		if !slices.Contains(registered, path) {
			t.Errorf("apiAuthExempt admits %s without a token, but no route serves it — "+
				"registered: %v", path, registered)
		}
	}
}

// TestAPIAuthExemptsNothingByPrefix pins the shape of the exemption rather than
// its contents: an entry admits its own path and nothing below it, so a route
// registered beneath an exempt one is gated like any other. A prefix rule is the
// one way this list could grow to cover a route nobody weighed, since the route
// it admits need not exist when the rule is written.
func TestAPIAuthExemptsNothingByPrefix(t *testing.T) {
	for path := range exemptRoutes {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
			if apiAuthExempt(method, path+"/anything") {
				t.Errorf("%s %s/anything is exempt: an exemption must not extend past its own path",
					method, path)
			}
		}
	}
	for _, path := range []string{"/api/test/run", "/api/engine/status", "/api/ops/call"} {
		if apiAuthExempt(http.MethodPost, path) {
			t.Errorf("POST %s is exempt from the token gate", path)
		}
	}
}

// TestAPIAuthExemptEndpointsSkipToken confirms cross-process discovery endpoints
// (probed by peers that cannot know this instance's token) stay reachable.
func TestAPIAuthExemptEndpointsSkipToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, apipaths.Health},
		{http.MethodGet, apipaths.SessionWindowState},
		{http.MethodPut, apipaths.SessionWindowState},
		// The desktop app forgets a closed window's board over this, with no
		// page and so no token to quote.
		{http.MethodDelete, apipaths.SessionPinboardBoards},
	} {
		*reached = false
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK || !*reached {
			t.Fatalf("exempt %s %s: got %d reached=%v, want 200 reached=true", tc.method, tc.path, rec.Code, *reached)
		}
	}
}

// TestAPIAuthExemptsOnlyTheBoardDelete pins the boundary of that one. Forgetting
// a board is let through because the app that does it has no token; reading the
// boards is what names them, and it must stay gated, or the exemption hands out
// the ids that are the only thing making it narrow.
func TestAPIAuthExemptsOnlyTheBoardDelete(t *testing.T) {
	s, reached := newAuthTestServer(t)

	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut} {
		*reached = false
		req := httptest.NewRequest(method, "/api/session/pinboard/boards", nil)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s boards without a token: got %d, want 401", method, rec.Code)
		}
		if *reached {
			t.Fatalf("%s boards must not reach the handler without a token", method)
		}
	}

	// Neither is anything else under the pinboard, which the delete's path is a
	// prefix of nothing in — but a future route named beneath it would be caught
	// by a sloppier match here.
	for _, path := range []string{"/api/session/pinboard", "/api/session/pinboard/boards/restore", "/api/session/pinboard/seed"} {
		*reached = false
		req := httptest.NewRequest(http.MethodDelete, path, nil)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized || *reached {
			t.Fatalf("DELETE %s: got %d reached=%v, want 401 reached=false", path, rec.Code, *reached)
		}
	}
}

// The seed claim is spent by asking, so an untokened caller must not be able to
// spend it: a board furnished by nobody is a board the window that asked next is
// told is already done.
func TestAPIAuthRejectsUntokenedBoardSeed(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/session/pinboard/seed", nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST seed without a token: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("POST seed must not reach the handler without a token")
	}
}

func TestAPIAuthIgnoresNonAPIPaths(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "example.com" // the pages' Host rule is pageHostMiddleware's, not this gate's
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("non-/api path: got %d reached=%v, want 200 reached=true", rec.Code, *reached)
	}
}

// TestAPIAuthTestModeBypass confirms the gate is inert in test mode so the
// browser integration harness (many synthetic origins) is unaffected.
func TestAPIAuthTestModeBypass(t *testing.T) {
	s, reached := newAuthTestServer(t)
	s.testMode = true

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "attacker.com"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("test-mode bypass: got %d reached=%v, want 200 reached=true", rec.Code, *reached)
	}
}

// TestServedEngineCarriesTokenForWorkerAPIFetches guards the production-only
// regression where /engine booted a module worker with no token. Browser tests
// run with s.testMode=true (auth disabled), so they still passed while real
// engine-side registry/config and fallback/background bash ops hit /api without
// X-Juggler-Token and wedged the tool lifecycle.
func TestServedEngineCarriesTokenForWorkerAPIFetches(t *testing.T) {
	s := &Server{apiToken: testAPIToken, staticVersion: "test-static-version"}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/engine", nil)
	s.serveEngine(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("serveEngine: got %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "window.__jugglerToken = '"+testAPIToken+"';") {
		t.Fatalf("engine page must embed API token for its worker-side /api fetches; body was:\n%s", body)
	}
	if !strings.Contains(body, "window.JUGGLER_ENGINE = true;") {
		t.Fatalf("engine page lost engine role marker; body was:\n%s", body)
	}
}

func TestEngineWorkerRuntimeInstallsTokenFetchShim(t *testing.T) {
	root, err := srcroot.Find("")
	if err != nil {
		t.Fatalf("srcroot.Find: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(root, "web", "js", "engine-worker-runtime.js"))
	if err != nil {
		t.Fatalf("read engine-worker-runtime.js: %v", err)
	}
	src := string(body)
	for _, want := range []string{
		"function installAPITokenFetchShim(token)",
		"headers.set('X-Juggler-Token', token)",
		"installAPITokenFetchShim(",
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("engine worker runtime missing %q", want)
		}
	}
}

// TestHostAllowedRemoteIngressBypass covers the remote-grant carve-out: a
// remote-transport request names an arbitrary Host but is admitted on its
// ingress tag (the token remains its authenticator).
func TestHostAllowedRemoteIngressBypass(t *testing.T) {
	base := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	base.Host = "abc123.trycloudflare.com"
	if hostAllowed(base) {
		t.Fatal("untagged tunnel-hostname request should fail hostAllowed")
	}
	if !hostAllowed(withRemoteIngress(base)) {
		t.Fatal("remote-ingress request should pass hostAllowed regardless of Host")
	}
}

// TestPageHostMiddlewareRefusesRebindingHosts covers the routes a rebinding
// page could still use once the /api gate refuses it: the pages that embed the
// API token, the test pages that host the app, and the viewer WebSocket, whose
// upgrade the /api gate exempts. Each refuses a DNS name as Host, in test mode
// too, and admits this machine's names and a remote-ingress caller. Static
// assets carry no token and stay ungated.
func TestPageHostMiddlewareRefusesRebindingHosts(t *testing.T) {
	gated := []string{"/", "/index.html", "/engine", "/headless-test", "/test-pool", apipaths.WebSocket}
	for _, testMode := range []bool{false, true} {
		var reached bool
		s := &Server{router: mux.NewRouter(), apiToken: testAPIToken, testMode: testMode}
		s.router.Use(s.pageHostMiddleware)
		hit := func(w http.ResponseWriter, _ *http.Request) {
			reached = true
			w.WriteHeader(http.StatusOK)
		}
		for _, p := range gated {
			s.router.HandleFunc(p, hit).Methods("GET")
		}
		s.router.HandleFunc("/v1/js/app.js", hit).Methods("GET")

		serve := func(path, host string, remote bool) (int, bool) {
			reached = false
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Host = host
			if remote {
				req = withRemoteIngress(req)
			}
			rec := httptest.NewRecorder()
			s.router.ServeHTTP(rec, req)
			return rec.Code, reached
		}

		for _, p := range gated {
			for _, host := range []string{"attacker.com:8317", "localhost.attacker.com:8317", "notlocalhost:8317"} {
				if code, ran := serve(p, host, false); code != http.StatusForbidden || ran {
					t.Errorf("testMode=%v GET %s Host %s: got %d reached=%v, want 403 unreached", testMode, p, host, code, ran)
				}
			}
			for _, host := range []string{"127.0.0.1:8317", "localhost:8317", "myproject.localhost:8317", "192.168.1.5:8317", "[::1]:8317"} {
				if code, ran := serve(p, host, false); code != http.StatusOK || !ran {
					t.Errorf("testMode=%v GET %s Host %s: got %d reached=%v, want 200 reached", testMode, p, host, code, ran)
				}
			}
			if code, ran := serve(p, "abc123.trycloudflare.com", true); code != http.StatusOK || !ran {
				t.Errorf("testMode=%v GET %s from remote ingress: got %d reached=%v, want 200 reached", testMode, p, code, ran)
			}
		}
		if code, ran := serve("/v1/js/app.js", "attacker.com:8317", false); code != http.StatusOK || !ran {
			t.Errorf("testMode=%v static asset under a DNS-name Host: got %d reached=%v, want 200 reached", testMode, code, ran)
		}
	}
}
