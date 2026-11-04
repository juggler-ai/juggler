//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestMain lets the test binary double as a fake MCP server: when MCP_FAKE_MODE
// is set, it speaks the protocol over stdio (via the official SDK server, so the
// handshake is genuinely compatible) instead of running tests. The manager
// spawns os.Args[0] with this env set as its "server command".
func TestMain(m *testing.M) {
	// A test that must know whether the command ever ran names a file here.
	if marker := os.Getenv("MCP_FAKE_MARKER"); marker != "" {
		_ = os.WriteFile(marker, []byte("ran\n"), 0o600)
	}
	switch os.Getenv("MCP_FAKE_MODE") {
	case "":
		os.Exit(m.Run())
	case "crash":
		os.Stderr.WriteString("fake server: boom\n")
		os.Exit(3)
	case "slow":
		// Serve, but only after a delay long enough that an unwaiting snapshot
		// would answer first.
		time.Sleep(500 * time.Millisecond)
		runFakeServer()
		os.Exit(0)
	case "mute":
		// Starts, never speaks the protocol, then goes away: a server stuck
		// "starting" for longer than any caller should wait on it.
		time.Sleep(time.Second)
		os.Exit(0)
	default:
		runFakeServer()
		os.Exit(0)
	}
}

// runFakeServer serves a tiny MCP server over stdio: an echo tool (write) and a
// peek tool annotated read-only. It reports MCP_FAKE_VERSION as its version when
// set, so a test can tell which spawn of a server it is talking to.
func runFakeServer() {
	version := os.Getenv("MCP_FAKE_VERSION")
	if version == "" {
		version = "9.9.9"
	}
	srv := mcp.NewServer(&mcp.Implementation{Name: "fake", Version: version}, nil)
	objSchema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"msg": map[string]any{"type": "string"}},
	}
	srv.AddTool(&mcp.Tool{Name: "echo", Description: "Echo the arguments back", InputSchema: objSchema}, echoHandler)
	srv.AddTool(&mcp.Tool{
		Name:        "peek",
		Description: "A read-only tool",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
		InputSchema: objSchema,
	}, echoHandler)
	_ = srv.Run(context.Background(), &mcp.StdioTransport{})
}

func echoHandler(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	text := "echo:" + req.Params.Name + ":" + string(req.Params.Arguments)
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil
}

// writeGlobalConfig points the manager's global config at a temp dir and writes
// one fake-server entry, returning nothing (project is "").
func writeGlobalConfig(t *testing.T, servers map[string]ServerConfig) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("JUGGLER_CONFIG_DIR", dir)
	data, err := json.MarshalIndent(Config{Servers: servers}, "", "  ")
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, mcpFileName), data, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
}

// waitFor polls until cond returns true or the deadline elapses.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}

func fakeServerConfig(mode string) ServerConfig {
	return ServerConfig{
		Command: os.Args[0],
		Env:     map[string]string{"MCP_FAKE_MODE": mode},
	}
}

func TestManagerDiscoveryAndCall(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{"fake": fakeServerConfig("serve")})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "fake" && s.Status == statusRunning {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("fake server never reached running: %+v", m.ListServers())
	}

	// Discovery: two tools, one read-only.
	tools := m.ListTools("fake")
	if len(tools) != 2 {
		t.Fatalf("want 2 tools, got %d: %+v", len(tools), tools)
	}
	var peek, echo *ToolInfo
	for i := range tools {
		switch tools[i].Name {
		case "peek":
			peek = &tools[i]
		case "echo":
			echo = &tools[i]
		}
	}
	if peek == nil || echo == nil {
		t.Fatalf("missing expected tools: %+v", tools)
	}
	if !peek.ReadOnly {
		t.Errorf("peek should be read-only")
	}
	if echo.ReadOnly {
		t.Errorf("echo should not be read-only")
	}
	if echo.SchemaTokens <= 0 {
		t.Errorf("echo should have a positive schema-token estimate")
	}

	// Server info surfaced.
	statuses := m.ListServers()
	if len(statuses) != 1 || statuses[0].ServerName != "fake" || statuses[0].ServerVer != "9.9.9" {
		t.Errorf("server info not surfaced: %+v", statuses)
	}

	// Call round-trips and echoes the arguments.
	res, err := m.CallTool(context.Background(), "fake", "echo", map[string]any{"msg": "hi"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected isError")
	}
	got := convertContent(res.Content)
	if len(got) != 1 || got[0]["type"] != "text" || !strings.Contains(got[0]["text"].(string), `"msg":"hi"`) {
		t.Fatalf("echo did not round-trip args: %+v", got)
	}

	// Stop transitions to stopped and drops tools.
	if err := m.Control("fake", "stop"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if !waitFor(t, 5*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "fake" {
				return s.Status == statusStopped && s.ToolCount == 0
			}
		}
		return false
	}) {
		t.Fatalf("fake server did not stop cleanly: %+v", m.ListServers())
	}
}

// TestSnapshotWaitsForFirstConnect covers the bug where a turn's tool list was
// built from a snapshot taken before discovery finished: the request that starts
// the servers is the same one that has to answer, so answering immediately meant
// the first turn of every session offered the model no MCP tools at all while the
// settings UI listed them.
func TestSnapshotWaitsForFirstConnect(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{"slowpoke": fakeServerConfig("slow")})

	m := NewManager()
	m.Start()
	m.Reconcile("") // starts the server; it is still connecting when we ask

	tools, complete := m.Snapshot(context.Background())
	if len(tools) == 0 {
		t.Fatalf("snapshot answered before the server finished connecting: %+v", m.ListServers())
	}
	if !complete {
		t.Errorf("every enabled server published its tools, so the snapshot is complete: %+v", m.ListServers())
	}
	for _, tool := range tools {
		if tool.Server != "slowpoke" {
			t.Errorf("unexpected server in snapshot: %+v", tool)
		}
	}
}

// TestSnapshotWaitIsBounded covers the other half: a server that will never
// answer must cost the caller settleTimeout, not the turn.
func TestSnapshotWaitIsBounded(t *testing.T) {
	old := settleTimeout
	settleTimeout = 200 * time.Millisecond
	oldBackoff := restartBackoff
	restartBackoff = 10 * time.Millisecond
	t.Cleanup(func() { settleTimeout = old; restartBackoff = oldBackoff })

	// A command that exists but never speaks MCP: connect blocks until the
	// handshake times out, well past the settle wait.
	writeGlobalConfig(t, map[string]ServerConfig{"mute": {Command: os.Args[0], Env: map[string]string{"MCP_FAKE_MODE": "mute"}}})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	start := time.Now()
	tools, complete := m.Snapshot(context.Background())
	elapsed := time.Since(start)

	if len(tools) != 0 {
		t.Errorf("a mute server should contribute no tools, got %+v", tools)
	}
	if elapsed > 5*time.Second {
		t.Errorf("snapshot waited %v — the settle wait is not bounded", elapsed)
	}
	// The empty answer must not be reported as the final word: the engine latches
	// its tool cache on this, and a server that has not answered yet still might.
	if complete {
		t.Errorf("a server that never published its tools leaves discovery incomplete: %+v", m.ListServers())
	}
}

// TestSnapshotCancelledCallerGetsWhatThereIs covers a caller that gives up
// waiting: it gets the current snapshot rather than hanging or erroring.
func TestSnapshotCancelledCallerGetsWhatThereIs(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{"slowpoke": fakeServerConfig("slow")})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	tools, complete := m.Snapshot(ctx)
	if len(tools) != 0 {
		t.Errorf("cancelled snapshot should return the (empty) current set, got %+v", tools)
	}
	if complete {
		t.Errorf("giving up early cannot make a half-discovered snapshot complete: %+v", m.ListServers())
	}
}

func TestManagerToolFilterAndDefaultArgs(t *testing.T) {
	cfg := fakeServerConfig("serve")
	cfg.Tools = &ToolFilter{Allow: []string{"echo"}} // hide "peek"
	cfg.DefaultArguments = map[string]any{"msg": "fixed"}
	writeGlobalConfig(t, map[string]ServerConfig{"fake": cfg})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "fake" && s.Status == statusRunning {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("fake server never reached running: %+v", m.ListServers())
	}

	// Filter: only the allowed tool is discovered; "peek" is hidden.
	tools := m.ListTools("fake")
	if len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("want only [echo], got %+v", tools)
	}

	// Schema hiding: the fixed "msg" key is stripped from the exposed schema.
	if schema, ok := tools[0].InputSchema.(map[string]any); ok {
		if props, ok := schema["properties"].(map[string]any); ok {
			if _, present := props["msg"]; present {
				t.Errorf("fixed-argument key msg should be hidden from schema: %+v", props)
			}
		}
	}

	// Defense in depth: a call to the hidden tool is rejected before dispatch.
	if _, err := m.CallTool(context.Background(), "fake", "peek", nil); err == nil {
		t.Errorf("expected a hidden tool call to be rejected")
	}

	// Merge: config value wins over the model-supplied argument.
	res, err := m.CallTool(context.Background(), "fake", "echo", map[string]any{"msg": "model"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	got := convertContent(res.Content)
	text, _ := got[0]["text"].(string)
	if !strings.Contains(text, `"msg":"fixed"`) {
		t.Errorf("config default should win, got %q", text)
	}
	if strings.Contains(text, `"msg":"model"`) {
		t.Errorf("model value should have been overridden, got %q", text)
	}
}

// An edit to a running server's env, command or args is a different process, so
// the next reconcile must spawn it again rather than keep the old one running
// with the old environment until someone restarts it by hand.
func TestReconcileRestartsOnSpawnConfigChange(t *testing.T) {
	cfg := fakeServerConfig("serve")
	cfg.Env["MCP_FAKE_VERSION"] = "1.0.0"
	writeGlobalConfig(t, map[string]ServerConfig{"fake": cfg})

	m := NewManager()
	m.Start()
	m.Reconcile("")
	if !waitFor(t, 15*time.Second, func() bool {
		s := statusOf(m, "fake")
		return s.Status == statusRunning && s.ServerVer == "1.0.0"
	}) {
		t.Fatalf("fake server never reached running: %+v", statusOf(m, "fake"))
	}

	edited := fakeServerConfig("serve")
	edited.Env["MCP_FAKE_VERSION"] = "2.0.0"
	writeGlobalConfig(t, map[string]ServerConfig{"fake": edited})
	m.Reconcile("")
	if !waitFor(t, 15*time.Second, func() bool {
		s := statusOf(m, "fake")
		return s.Status == statusRunning && s.ServerVer == "2.0.0"
	}) {
		t.Fatalf("an env edit did not respawn the server: %+v", statusOf(m, "fake"))
	}
}

// What a server is allowed to show and the arguments fixed for it are read per
// call, so editing them must leave the running process alone.
func TestReconcileKeepsServerOnFilterOnlyChange(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{"fake": fakeServerConfig("serve")})

	m := NewManager()
	m.Start()
	m.Reconcile("")
	if !waitFor(t, 15*time.Second, func() bool { return statusOf(m, "fake").Status == statusRunning }) {
		t.Fatalf("fake server never reached running: %+v", statusOf(m, "fake"))
	}

	edited := fakeServerConfig("serve")
	edited.Tools = &ToolFilter{Allow: []string{"echo"}}
	edited.DefaultArguments = map[string]any{"msg": "fixed"}
	writeGlobalConfig(t, map[string]ServerConfig{"fake": edited})
	m.Reconcile("")
	// Reconcile has been processed by now, and a restart leaves the server
	// starting, so a running status here means it was kept.
	if s := statusOf(m, "fake"); s.Status != statusRunning {
		t.Fatalf("a filter-only edit restarted the server: %+v", s)
	}
	if tools := m.ListTools("fake"); len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("the new filter was not applied to the running server: %+v", tools)
	}
}

// A restart's caller needs its outcome, not "starting": AwaitSettled returns
// once the server is running or has given up, with the reason it gave up.
func TestAwaitSettledReportsRestartOutcome(t *testing.T) {
	old := restartBackoff
	restartBackoff = 10 * time.Millisecond
	t.Cleanup(func() { restartBackoff = old })

	writeGlobalConfig(t, map[string]ServerConfig{
		"fake": fakeServerConfig("serve"),
		"boom": fakeServerConfig("crash"),
	})
	m := NewManager()
	m.Start()
	m.Reconcile("")

	for name, want := range map[string]string{"fake": statusRunning, "boom": statusFailed} {
		if err := m.Control(name, "restart"); err != nil {
			t.Fatalf("restart %s: %v", name, err)
		}
		m.AwaitSettled(t.Context(), name)
		if got := statusOf(m, name); got.Status != want {
			t.Errorf("%s settled as %+v, want %s", name, got, want)
		}
	}
	if s := statusOf(m, "boom"); !strings.Contains(s.Error, "boom") {
		t.Errorf("a failed restart should carry the server's stderr, got %q", s.Error)
	}
}

func TestManagerCrashMarksFailed(t *testing.T) {
	old := restartBackoff
	restartBackoff = 10 * time.Millisecond
	t.Cleanup(func() { restartBackoff = old })

	writeGlobalConfig(t, map[string]ServerConfig{"boom": fakeServerConfig("crash")})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "boom" && s.Status == statusFailed {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("crashing server never marked failed: %+v", m.ListServers())
	}

	// The captured stderr tail should be attached to the failure.
	for _, s := range m.ListServers() {
		if s.Name == "boom" && !strings.Contains(s.Error, "boom") {
			t.Errorf("failure should include stderr tail, got %q", s.Error)
		}
	}

	// A tool call against a failed server returns a clear error.
	if _, err := m.CallTool(context.Background(), "boom", "whatever", nil); err == nil {
		t.Errorf("expected error calling a failed server")
	}
}

// newHTTPFakeServer starts an httptest server speaking the streamable-HTTP MCP
// transport via the official SDK handler. If wantAuth is non-empty, requests
// must carry a matching Authorization header or they are rejected with 401.
func newHTTPFakeServer(t *testing.T, wantAuth string) *httptest.Server {
	t.Helper()
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		srv := mcp.NewServer(&mcp.Implementation{Name: "fake-http", Version: "8.8.8"}, nil)
		srv.AddTool(&mcp.Tool{
			Name:        "echo",
			Description: "Echo the arguments back",
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{"msg": map[string]any{"type": "string"}}},
		}, echoHandler)
		return srv
	}, nil)
	var h http.Handler = handler
	if wantAuth != "" {
		h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != wantAuth {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			handler.ServeHTTP(w, r)
		})
	}
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return ts
}

func TestManagerHTTPTransport(t *testing.T) {
	ts := newHTTPFakeServer(t, "")
	writeGlobalConfig(t, map[string]ServerConfig{
		"remote": {Transport: "http", URL: ts.URL},
	})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "remote" && s.Status == statusRunning {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("http server never reached running: %+v", m.ListServers())
	}

	if tools := m.ListTools("remote"); len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("want one echo tool, got %+v", tools)
	}

	res, err := m.CallTool(context.Background(), "remote", "echo", map[string]any{"msg": "hi"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	got := convertContent(res.Content)
	if len(got) != 1 || !strings.Contains(got[0]["text"].(string), `"msg":"hi"`) {
		t.Fatalf("echo did not round-trip args: %+v", got)
	}

	// Close the session so the standalone SSE stream drains before httptest's
	// Close (registered earlier, so it runs after this) waits on connections.
	stopAndWait(t, m, "remote")
}

// stopAndWait stops a running server and blocks until it reports stopped, so any
// persistent HTTP/SSE connection is torn down before the test's httptest.Server
// is closed.
func stopAndWait(t *testing.T, m *Manager, name string) {
	t.Helper()
	if err := m.Control(name, "stop"); err != nil {
		t.Fatalf("stop %q: %v", name, err)
	}
	waitFor(t, 5*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == name {
				return s.Status == statusStopped
			}
		}
		return false
	})
}

func TestManagerHTTPHeaders(t *testing.T) {
	ts := newHTTPFakeServer(t, "Bearer sekret")

	// Without the header the connection is rejected.
	writeGlobalConfig(t, map[string]ServerConfig{"noauth": {Transport: "http", URL: ts.URL}})
	m := NewManager()
	m.Start()
	m.Reconcile("")
	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "noauth" && s.Status == statusFailed {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("unauthenticated http server should have failed: %+v", m.ListServers())
	}

	// With the header it connects and discovers tools.
	writeGlobalConfig(t, map[string]ServerConfig{
		"auth": {Transport: "http", URL: ts.URL, Headers: map[string]string{"Authorization": "Bearer sekret"}},
	})
	m2 := NewManager()
	m2.Start()
	m2.Reconcile("")
	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m2.ListServers() {
			if s.Name == "auth" && s.Status == statusRunning {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("authenticated http server never reached running: %+v", m2.ListServers())
	}
	if tools := m2.ListTools("auth"); len(tools) != 1 {
		t.Fatalf("want one tool from authed server, got %+v", tools)
	}
	stopAndWait(t, m2, "auth")
}

func TestManagerTransportValidation(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{
		"missing-url": {Transport: "http"},
		"bogus":       {Transport: "carrier-pigeon", URL: "http://example.invalid"},
		// The shape a config pasted from another agent takes once its "type" key
		// is dropped: a url and nothing else, which defaults to stdio.
		"url-only": {URL: "http://example.invalid"},
	})
	m := NewManager()
	m.Start()
	m.Reconcile("")

	check := func(name, wantSubstr string) {
		if !waitFor(t, 5*time.Second, func() bool {
			for _, s := range m.ListServers() {
				if s.Name == name {
					return s.Status == statusFailed && strings.Contains(s.Error, wantSubstr)
				}
			}
			return false
		}) {
			t.Fatalf("server %q not failed with %q: %+v", name, wantSubstr, m.ListServers())
		}
	}
	check("missing-url", "no url configured")
	check("bogus", "unsupported transport")
	check("url-only", `has a "url" but no transport`)
}

// writeRawGlobalConfig writes mcp.json bytes verbatim, so a test can present the
// exact JSON a user pastes rather than a marshalled ServerConfig.
func writeRawGlobalConfig(t *testing.T, body string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("JUGGLER_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, mcpFileName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A config copied from another agent keys its remote servers with "type", which
// is the spelling every other client uses. Left unfolded, such an entry defaults
// to stdio and fails for a missing command, so the fold is what makes a pasted
// config work at all.
func TestConfigTypeIsAcceptedAsTransport(t *testing.T) {
	writeRawGlobalConfig(t, `{
	  "mcpServers": {
	    "linear":     {"type": "http", "url": "https://mcp.linear.app/mcp"},
	    "streamable": {"type": "streamable-http", "url": "https://example.invalid/mcp"},
	    "legacy":     {"type": "sse", "url": "https://example.invalid/sse"},
	    "shouty":     {"type": "  HTTP  ", "url": "https://example.invalid/mcp"},
	    "both":       {"type": "sse", "transport": "http", "url": "https://example.invalid/mcp"},
	    "local":      {"command": "some-server"},
	    "nonsense":   {"type": "carrier-pigeon", "url": "https://example.invalid/mcp"}
	  }
	}`)

	cfg, err := loadMergedConfig("")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for name, want := range map[string]string{
		"linear":     "http",
		"streamable": "http",
		"legacy":     "sse",
		"shouty":     "http",
		"both":       "http", // our own key wins over the pasted one
		"local":      "stdio",
		"nonsense":   "carrier-pigeon", // passed through so startServer can name it
	} {
		if got := cfg[name].transportKind(); got != want {
			t.Errorf("server %q: transport %q, want %q", name, got, want)
		}
		if cfg[name].Type != "" {
			t.Errorf("server %q: Type should be folded away, got %q", name, cfg[name].Type)
		}
	}
}

// Saving from the settings UI rewrites the whole file, so a folded entry must
// come back out under "transport" alone — leaving both keys behind would give the
// next reader two sources of truth to disagree about.
func TestConfigWriteBackDropsTypeKey(t *testing.T) {
	writeRawGlobalConfig(t, `{"mcpServers": {"linear": {"type": "streamable-http", "url": "https://mcp.linear.app/mcp"}}}`)

	cfg, err := loadMergedConfig("")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	path := globalConfigPath()
	if err := writeConfigFile(path, cfg); err != nil {
		t.Fatalf("write: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if strings.Contains(string(data), `"type"`) {
		t.Errorf("rewritten config still carries a type key:\n%s", data)
	}
	if !strings.Contains(string(data), `"transport": "http"`) {
		t.Errorf("rewritten config lost the folded transport:\n%s", data)
	}
}

// The setConfig op accepts whatever shape the caller sends, so an entry posted
// with "type" (by hand or by a script) must be stored the same way a parsed file
// would be.
func TestCoerceServerConfigFoldsType(t *testing.T) {
	sc, err := coerceServerConfig(map[string]any{"type": "streamable-http", "url": "https://example.invalid/mcp"})
	if err != nil {
		t.Fatalf("coerce: %v", err)
	}
	if sc.transportKind() != "http" {
		t.Errorf("transport %q, want http", sc.transportKind())
	}
	if sc.Type != "" {
		t.Errorf("Type should be folded away, got %q", sc.Type)
	}
}

func TestConfigMergeProjectOverridesGlobal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JUGGLER_CONFIG_DIR", dir)
	global := Config{Servers: map[string]ServerConfig{
		"a": {Command: "global-a"},
		"b": {Command: "global-b"},
	}}
	data, _ := json.MarshalIndent(global, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, mcpFileName), data, 0o644); err != nil {
		t.Fatal(err)
	}

	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".juggler"), 0o755); err != nil {
		t.Fatal(err)
	}
	projCfg := Config{Servers: map[string]ServerConfig{"b": {Command: "project-b"}}}
	pdata, _ := json.MarshalIndent(projCfg, "", "  ")
	if err := os.WriteFile(filepath.Join(project, ".juggler", mcpFileName), pdata, 0o644); err != nil {
		t.Fatal(err)
	}

	merged, err := loadMergedConfig(project)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if merged["a"].Command != "global-a" {
		t.Errorf("global-only entry lost: %+v", merged["a"])
	}
	if merged["b"].Command != "project-b" {
		t.Errorf("project entry should override global: %+v", merged["b"])
	}
}

// A project's mcp.json can arrive with a cloned repository, so it must not be
// able to pre-approve its own tools: autoApprove is honoured from the global file
// only, and a project entry that replaces a trusted global one of the same name
// does not inherit the trust either.
func TestConfigAutoApproveIsGlobalOnly(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{
		"trusted":  {Command: "global-trusted", AutoApprove: true},
		"shadowed": {Command: "global-shadowed", AutoApprove: true},
	})
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".juggler"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".juggler", mcpFileName), []byte(`{"mcpServers": {
	  "shadowed": {"command": "project-shadowed", "autoApprove": true},
	  "local":    {"command": "project-local", "autoApprove": true}
	}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	merged, err := loadMergedConfig(project)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if !merged["trusted"].AutoApprove {
		t.Errorf("a global entry's autoApprove should be honoured: %+v", merged["trusted"])
	}
	if merged["shadowed"].Command != "project-shadowed" || merged["shadowed"].AutoApprove {
		t.Errorf("a project entry must win but not pre-approve itself: %+v", merged["shadowed"])
	}
	if merged["local"].AutoApprove {
		t.Errorf("a project-only entry must not pre-approve itself: %+v", merged["local"])
	}
}

// The engine decides approval from the snapshot, so every tool of a pre-approved
// server says so — and turning the setting off on a running server reaches the
// snapshot and fires the change hook without a restart, or an engine holding the
// old snapshot would go on approving.
func TestManagerAutoApproveRidesSnapshot(t *testing.T) {
	cfg := fakeServerConfig("serve")
	cfg.AutoApprove = true
	writeGlobalConfig(t, map[string]ServerConfig{"fake": cfg})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	tools, _ := m.Snapshot(context.Background())
	if len(tools) == 0 {
		t.Fatalf("no tools discovered: %+v", m.ListServers())
	}
	for _, tool := range tools {
		if !tool.AutoApprove {
			t.Errorf("a tool of a pre-approved server should carry autoApprove: %+v", tool)
		}
	}

	changed := make(chan struct{}, 8)
	m.reqCh <- mcpReq{kind: reqSetHook, hookFn: func() { changed <- struct{}{} }}

	cfg.AutoApprove = false
	writeGlobalConfig(t, map[string]ServerConfig{"fake": cfg})
	m.Reconcile("")

	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Errorf("withdrawing autoApprove did not fire the change hook")
	}
	tools, _ = m.Snapshot(context.Background())
	if len(tools) == 0 {
		t.Fatalf("the server should still be running: %+v", m.ListServers())
	}
	for _, tool := range tools {
		if tool.AutoApprove {
			t.Errorf("autoApprove was withdrawn but the snapshot still carries it: %+v", tool)
		}
	}
}
