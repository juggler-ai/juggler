//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// The routes and pages only the test harness reaches. A production build
// compiles test_routes_production.go instead, whose RegisterTestRoutes refuses.

//go:build !production

package server

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"juggler/cmd/juggler/server/handlers"
	"juggler/web"
)

// RegisterTestRoutes registers test-specific API routes (called by testing wrapper)
//
// Each feature is matched against testAPI via a locally-declared structural
// interface (keeping this package free of the testing package's types). A
// failed match means signature drift between the two packages — the feature
// would silently unregister — so every miss is reported through
// mustMatch/panic rather than skipped. TestRegisterTestRoutesStructuralMatches
// additionally pins every match at test time.
func (s *Server) RegisterTestRoutes(testAPI any) {
	api := s.router.PathPrefix("/api/test").Subrouter()

	// mustMatch makes a silently-failed structural assertion impossible: a
	// test-mode server missing a test feature is a broken test server, and a
	// panic at startup is the loudest possible acknowledgment.
	mustMatch := func(ok bool, feature string) {
		if !ok {
			panic(fmt.Sprintf("RegisterTestRoutes: testAPI does not satisfy the %s interface — "+
				"either a method signature drifted between the server and testing packages "+
				"(the feature would silently unregister), or this is a production-tagged build "+
				"whose testing stub has no handlers (--test is unsupported there)", feature))
		}
	}

	type taskAPI interface {
		HandleGetTask(w http.ResponseWriter, r *http.Request)
		HandleResetFixture(w http.ResponseWriter, r *http.Request)
		HandleDeleteFile(w http.ResponseWriter, r *http.Request)
		HandleMkdir(w http.ResponseWriter, r *http.Request)
		HandleDumpTape(w http.ResponseWriter, r *http.Request)
		HandleTapeHead(w http.ResponseWriter, r *http.Request)
		HandleExtensionTests(w http.ResponseWriter, r *http.Request)
	}
	tapi, ok := testAPI.(taskAPI)
	mustMatch(ok, "task-API")
	api.HandleFunc("/task", tapi.HandleGetTask).Methods("GET")
	api.HandleFunc("/reset-fixture", tapi.HandleResetFixture).Methods("POST")
	api.HandleFunc("/delete-file", tapi.HandleDeleteFile).Methods("POST")
	api.HandleFunc("/mkdir", tapi.HandleMkdir).Methods("POST")
	api.HandleFunc("/dump-tape", tapi.HandleDumpTape).Methods("GET")
	api.HandleFunc("/tape-head", tapi.HandleTapeHead).Methods("GET")
	api.HandleFunc("/extension-tests", tapi.HandleExtensionTests).Methods("GET")

	// Wire the worker manager's tape dumper into the test API so the
	// dump-tape endpoint can surface per-conv worker tapes at failure
	// time. Passed as a func value so this package stays free of the
	// testing package's interface type (the two structurally-identical
	// interfaces would otherwise not satisfy method-signature equality).
	type tapeDumperSetter interface {
		SetTapeDumper(fn func(string) any)
		SetTapeHead(fn func(string) int64)
	}
	tds, ok := testAPI.(tapeDumperSetter)
	mustMatch(ok, "tape-dumper")
	if s.workerManager != nil {
		tds.SetTapeDumper(s.workerManager.DumpTape)
		tds.SetTapeHead(s.workerManager.TapeHead)
	}

	// Conversation-ownership guard: in the multi-lane pool, a conversation may
	// only be deleted/binned by the lane that created it (cross-lane deletes
	// tear down a live test's worker mid-test). The ledger lives on the test
	// API; convOwnershipMiddleware applies it around the named create, delete
	// and bin routes, and the owners endpoint lets the Go harness fail the run
	// on leaked conversations.
	type convOwnershipAPI interface {
		convOwnershipLedger
		HandleConversationOwners(w http.ResponseWriter, r *http.Request)
	}
	coa, ok := testAPI.(convOwnershipAPI)
	mustMatch(ok, "conversation-ownership")
	s.router.Use(convOwnershipMiddleware(coa))
	api.HandleFunc("/conversation-owners", coa.HandleConversationOwners).Methods("GET")

	type runAPI interface {
		HandleRun(w http.ResponseWriter, r *http.Request)
		HandlePending(w http.ResponseWriter, r *http.Request)
		HandlePostResult(w http.ResponseWriter, r *http.Request)
		HandleGetResult(w http.ResponseWriter, r *http.Request)
		HandlePostNames(w http.ResponseWriter, r *http.Request)
		HandleGetNames(w http.ResponseWriter, r *http.Request)
		HandleJSTrace(w http.ResponseWriter, r *http.Request)
		HandleAudit(w http.ResponseWriter, r *http.Request)
		HandlePostProgress(w http.ResponseWriter, r *http.Request)
		HandleMachine(w http.ResponseWriter, r *http.Request)
	}
	rapi, ok := testAPI.(runAPI)
	mustMatch(ok, "run-API")
	api.HandleFunc("/run", rapi.HandleRun).Methods("POST")
	api.HandleFunc("/pending", rapi.HandlePending).Methods("GET")
	api.HandleFunc("/result", rapi.HandlePostResult).Methods("POST")
	api.HandleFunc("/result", rapi.HandleGetResult).Methods("GET")
	api.HandleFunc("/names", rapi.HandlePostNames).Methods("POST")
	api.HandleFunc("/names", rapi.HandleGetNames).Methods("GET")
	api.HandleFunc("/jstrace", rapi.HandleJSTrace).Methods("POST")
	// Queue audit: the server's own count of each test's queue/result
	// transitions, read by the harness on timeout to pin where a lost test was
	// lost. Both the queue and the result buffer are destructive reads, so this
	// is the only record that outlives the loss.
	api.HandleFunc("/audit", rapi.HandleAudit).Methods("GET")
	// A lane's report that its test is still making progress, which the
	// harness waits on the result for as long as it keeps getting.
	api.HandleFunc("/progress", rapi.HandlePostProgress).Methods("POST")
	// The machine's load average, read by a failing lane so its failure block
	// says whether anything was running. A page has no way to ask.
	api.HandleFunc("/machine", rapi.HandleMachine).Methods("GET")

	// Engine connection status — used by the JS test executor to wait for engine.
	s.router.HandleFunc("/api/engine/status", s.handleEngineStatus).Methods("GET")

	// Engine restart: the realm is replaced through the engine recovery hook,
	// as the supervisor replaces a dead one. The engine is shared by every lane
	// of this server, so only a test scheduled alone may call it.
	api.HandleFunc("/restart-engine", s.handleTestRestartEngine).Methods("POST")

	// The processes outside this server's tree that run its pages, for the
	// harness's slow-core mode (SetTestProcessPIDs). An empty list where there
	// are none to report or no lister is installed.
	api.HandleFunc("/process-pids", func(w http.ResponseWriter, r *http.Request) {
		pids := []int{}
		if fn := s.testProcessPIDs.Load(); fn != nil {
			pids = append(pids, (*fn)()...)
		}
		handlers.WriteJSON(w, r, 0, map[string]any{"pids": pids})
	}).Methods("GET")

	// Browser-side diagnostic logger — POST a JSON body and the message lands
	// in the subprocess stderr (captured per-fixture by main_test.go). Lets
	// integration tests trace what the browser is actually doing without
	// fighting the webview console.
	s.router.HandleFunc("/api/test/debug-log", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		fmt.Fprintf(os.Stderr, "[BROWSER-DEBUG] %s\n", body)
		w.WriteHeader(http.StatusNoContent)
	}).Methods("POST")

	// Headless test runner page (test binary only)
	s.router.HandleFunc("/headless-test", s.serveHeadlessTest).Methods("GET")

	// Test-pool host page: tiles N iframes of /headless-test for the
	// "one window, N iframes" stress topology.
	s.router.HandleFunc("/test-pool", s.serveTestPool).Methods("GET")

	// Last, so a test API that panicked a match above leaves a server that
	// behaves as production does (see testCapabilities).
	s.test = testCapabilities{
		authDisabled:     true,
		offlineProviders: true,
		offlineUpdates:   true,
		frameableIndex:   true,
		pageUILocale:     true,
		harnessPage:      true,
	}
}

// testEngineRestartTimeout bounds how long handleTestRestartEngine waits for
// the replacement engine to connect. A page reload boots the engine in a few
// seconds; this leaves room for a loaded machine.
const testEngineRestartTimeout = 60 * time.Second

// handleTestRestartEngine replaces the engine's realm the way a crash and the
// server's own recovery would: the recovery hook reloads the engine host, which
// drops every execution in flight without a word to any document, and a fresh
// engine connects as a new client. It answers once that new engine is attached
// and live, so the worker has already been told of the change.
func (s *Server) handleTestRestartEngine(w http.ResponseWriter, r *http.Request) {
	reload := s.engineRecovery.Load()
	if reload == nil {
		http.Error(w, "no engine recovery hook is installed", http.StatusNotImplemented)
		return
	}
	previous := s.engineClient.Load()
	(*reload)()
	deadline := time.Now().Add(testEngineRestartTimeout)
	for time.Now().Before(deadline) {
		if c := s.engineClient.Load(); c != nil && c != previous && s.IsEngineConnected() {
			handlers.WriteJSON(w, r, 0, map[string]any{"clientId": c.ClientID()})
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(50 * time.Millisecond):
		}
	}
	http.Error(w, fmt.Sprintf("no new engine connected within %v of the reload", testEngineRestartTimeout),
		http.StatusGatewayTimeout)
}

// serveHeadlessTest serves the headless test page (only registered by RegisterTestRoutes)
func (s *Server) serveHeadlessTest(w http.ResponseWriter, r *http.Request) {
	// With assets-from-disk, read from disk so edits take effect without
	// rebuilding. juggler-test runs with --assets-from-disk, so tests never use
	// baked-in files.
	content, err := s.readWebAsset("js-tests/headless-test.html", web.TestFiles)
	if err != nil {
		http.Error(w, "Headless test runner not found", http.StatusNotFound)
		return
	}

	nonce := generateCSPNonce()
	serveTemplatedHTML(w, string(content), map[string]string{
		"StaticVersion": s.staticVersion,
		"CSPNonce":      nonce,
		// Safe to substitute unescaped: requestBasePath admits only plain
		// path segments.
		"BasePath": requestBasePath(r),
		// Allow same-origin framing so the /test-pool host page can tile N copies
		// of this page in iframes.
	}, func() { setHTMLSecurityHeadersFramed(w, nonce, true, "") })
}

// serveTestPool serves a tiling host page that mounts N copies of
// /headless-test in cross-origin-style iframes laid out in a grid. The Wails
// window loads this page in test-iframe mode; each iframe is an independent
// test client that polls /api/test/pending for work.
func (s *Server) serveTestPool(w http.ResponseWriter, r *http.Request) {
	n := r.URL.Query().Get("n")
	if n == "" {
		n = "4"
	}
	nonce := generateCSPNonce()
	page := `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Juggler Test Pool</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0d1117; color: #e6edf3; font-family: monospace; }
  #grid { display: grid; gap: 1px; width: 100vw; height: 100vh; background: #30363d; }
  iframe { width: 100%; height: 100%; border: 0; background: #0d1117; }
</style>
</head>
<body>
<div id="grid"></div>
<script nonce="` + nonce + `">
(() => {
  const n = parseInt(new URLSearchParams(location.search).get('n') || '` + n + `', 10) || 4;
  // Square-ish grid: cols = ceil(sqrt(n)), rows = ceil(n/cols).
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const grid = document.getElementById('grid');
  // Each lane is given a page of its own, floored at the size the host window
  // is built from (600x450 per lane — runTestPoolWindowApp, cmd/juggler/app),
  // so a lane lays out in the same page on every platform and a test that
  // measures something measures it in the size the pool was built for rather
  // than in whatever the window ended up with.
  //
  // The floor is a minimum, not the size: the window is sized to hold exactly
  // this grid, and the tracks take the rest as 1fr. It stays a floor because a
  // lane must not collapse — a lane with no size measures every rect as empty,
  // and the tests that measure something then pass vacuously.
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(600px, 1fr))';
  grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(450px, 1fr))';
  for (let i = 0; i < n; i++) {
    const f = document.createElement('iframe');
    f.src = '` + requestBasePath(r) + `/headless-test?lane=' + i;
    f.setAttribute('data-lane', String(i));
    grid.appendChild(f);
  }
})();
</script>
</body>
</html>`
	setHTMLSecurityHeadersFramed(w, nonce, false, "")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")
	_, _ = w.Write([]byte(page))
}
