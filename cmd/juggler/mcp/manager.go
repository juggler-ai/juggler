//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"juggler/internal/httpx"
	"juggler/internal/jlog"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Server status values, exposed verbatim to the engine/UI.
const (
	statusStopped  = "stopped"
	statusStarting = "starting"
	statusRunning  = "running"
	statusFailed   = "failed"
)

const (
	// maxRestartAttempts bounds crash-restart before a server is marked failed,
	// so a broken server never restart-loops silently.
	maxRestartAttempts = 3
	// stderrRingBytes is how much recent stderr is retained per server for the
	// diagnostics UI (mcpGetLog).
	stderrRingBytes = 32 * 1024
	// connectTimeout bounds a single initialize+list handshake.
	connectTimeout = 30 * time.Second
)

// restartBackoff is the fixed delay before a crash restart. Kept simple in
// phase 1 (no exponential curve); the attempt cap is the real safety valve. A
// var (not const) so tests can shrink it.
var restartBackoff = 2 * time.Second

// ToolInfo is a discovered tool, flattened for the engine. It intentionally
// mirrors the fields the JS context item needs to build a tool definition.
type ToolInfo struct {
	Server       string `json:"server"`
	Name         string `json:"name"`         // raw MCP tool name
	Title        string `json:"title"`        // display title (falls back to name)
	Description  string `json:"description"`  // server-provided, may be long
	InputSchema  any    `json:"inputSchema"`  // JSON Schema object as decoded from the server
	ReadOnly     bool   `json:"readOnly"`     // annotations.readOnlyHint
	Destructive  bool   `json:"destructive"`  // annotations.destructiveHint (meaningful when !ReadOnly)
	SchemaTokens int    `json:"schemaTokens"` // ~chars/4 estimate of the input schema
}

// ServerStatus is one entry in the mcpListServers response.
type ServerStatus struct {
	Name         string `json:"name"`
	Status       string `json:"status"`
	Error        string `json:"error,omitempty"`
	Transport    string `json:"transport"`
	Enabled      bool   `json:"enabled"`
	ToolCount    int    `json:"toolCount"`
	SchemaTokens int    `json:"schemaTokens"`
	ServerName   string `json:"serverName,omitempty"`
	ServerVer    string `json:"serverVersion,omitempty"`
}

// serverState is owned exclusively by the manager goroutine. The session pointer
// is the one exception: once assigned it is safe for concurrent use (the SDK
// session is goroutine-safe), so callTool can use it off-goroutine.
type serverState struct {
	name     string
	cfg      ServerConfig
	status   string
	lastErr  string
	tools    []ToolInfo
	srvName  string
	srvVer   string
	session  *mcp.ClientSession
	stderr   *tailRing
	attempts int
	// generation increments on every stop/reconfigure so stale connect/crash
	// events from a superseded process are ignored.
	generation int
	// waiters are callTool callers parked until this server reaches a terminal
	// start outcome (running or failed).
	waiters []chan ensureResult
}

// ensureResult is delivered to a parked callTool caller.
type ensureResult struct {
	session *mcp.ClientSession
	err     error
}

// reqKind enumerates messages to the manager goroutine.
type reqKind int

const (
	reqReconcile reqKind = iota
	reqListServers
	reqSnapshot
	reqListTools
	reqEnsure
	reqControl
	reqGetLog
	reqSetHook
	// internal events posted by connect/monitor goroutines
	evStarting
	evConnected
	evCrashed
	evAppendLog
	evToolsChanged
	evSetTools
)

type mcpReq struct {
	kind    reqKind
	project string
	server  string
	action  string
	// event payloads
	generation int
	session    *mcp.ClientSession
	srvName    string
	srvVer     string
	tools      []ToolInfo
	logData    string
	err        error
	hookFn     func()
	// response
	resp chan mcpResp
}

type mcpResp struct {
	servers []ServerStatus
	tools   []ToolInfo
	ensure  ensureResult
	log     string
	err     error
}

// Manager is the process-global MCP client. Construct with NewManager and call
// Start once; all state lives behind reqCh and is owned by the run goroutine.
type Manager struct {
	reqCh chan mcpReq
	// onChange is owned by the run goroutine: it is invoked whenever the
	// discovered tool snapshot changes, so the engine can reload registries.
	// Installed via the reqSetHook message (never written from another
	// goroutine) so there is no data race.
	onChange func()
}

// pkg-global manager instance, wired by Register (ops.go).
var manager *Manager

// NewManager creates a manager. Start must be called to run its goroutine.
func NewManager() *Manager {
	return &Manager{reqCh: make(chan mcpReq, 32)}
}

// Start launches the manager goroutine. Call once at process startup.
func (m *Manager) Start() { go m.run() }

// notifyChange fires the change hook without blocking the manager goroutine.
func (m *Manager) notifyChange() {
	if m.onChange != nil {
		go m.onChange()
	}
}

// run is the single owner goroutine for all server state.
func (m *Manager) run() {
	servers := map[string]*serverState{}
	activeProject := ""

	for req := range m.reqCh {
		switch req.kind {
		case reqReconcile:
			activeProject = req.project
			m.reconcile(servers, req.project)

		case reqListServers:
			req.resp <- mcpResp{servers: listStatuses(servers)}

		case reqSnapshot:
			req.resp <- mcpResp{tools: flattenTools(servers)}

		case reqListTools:
			var out []ToolInfo
			if req.server == "" {
				out = flattenTools(servers)
			} else if s := servers[req.server]; s != nil {
				out = append(out, s.tools...)
			}
			req.resp <- mcpResp{tools: out}

		case reqEnsure:
			m.handleEnsure(servers, req)

		case reqControl:
			req.resp <- mcpResp{err: m.handleControl(servers, req.server, req.action, activeProject)}

		case reqSetHook:
			m.onChange = req.hookFn

		case reqGetLog:
			log := ""
			if s := servers[req.server]; s != nil && s.stderr != nil {
				log = string(s.stderr.bytes())
			}
			req.resp <- mcpResp{log: log}

		case evStarting:
			if s := servers[req.server]; s != nil && s.generation == req.generation {
				s.status = statusStarting
			}

		case evConnected:
			m.handleConnected(servers, req)

		case evCrashed:
			m.handleCrashed(servers, req)

		case evAppendLog:
			if s := servers[req.server]; s != nil && s.stderr != nil {
				s.stderr.write([]byte(req.logData))
			}

		case evToolsChanged:
			// The server announced tools/list_changed; re-list off-goroutine.
			if s := servers[req.server]; s != nil && s.session != nil && s.generation == req.generation {
				go m.relist(req.server, req.generation, s.session)
			}

		case evSetTools:
			if s := servers[req.server]; s != nil && s.generation == req.generation {
				s.tools = req.tools
				m.notifyChange()
			}
		}
	}
}

// reconcile diffs the desired config against running servers: it stops servers
// that were removed or disabled, updates configs, and starts newly-enabled ones.
func (m *Manager) reconcile(servers map[string]*serverState, project string) {
	desired, err := loadMergedConfig(project)
	if err != nil {
		jlog.Error("[mcp] config load failed for %s: %v", project, err)
		return
	}

	// Stop servers no longer desired or now disabled.
	for name, s := range servers {
		dc, ok := desired[name]
		if !ok || !dc.IsEnabled() {
			m.stopServer(s)
			if !ok {
				delete(servers, name)
			} else {
				s.cfg = dc
				s.status = statusStopped
			}
		}
	}

	changed := false
	for name, dc := range desired {
		s := servers[name]
		if s == nil {
			s = &serverState{name: name, status: statusStopped, stderr: newTailRing(stderrRingBytes)}
			servers[name] = s
			changed = true
		}
		s.cfg = dc
		if dc.IsEnabled() && s.status == statusStopped {
			m.startServer(s)
		}
	}
	if changed {
		m.notifyChange()
	}
}

// failStart marks a server failed before it could launch (bad config) and wakes
// any parked callers with the reason. Must run on the manager goroutine.
func (m *Manager) failStart(s *serverState, msg string) {
	s.status = statusFailed
	s.lastErr = msg
	m.drainWaiters(s, ensureResult{err: fmt.Errorf("mcp server %q: %s", s.name, msg)})
}

// startServer transitions a stopped server to starting and launches its connect
// goroutine. Must run on the manager goroutine.
func (m *Manager) startServer(s *serverState) {
	switch s.cfg.transportKind() {
	case "stdio":
		if strings.TrimSpace(s.cfg.Command) == "" {
			m.failStart(s, "no command configured")
			return
		}
	case "http", "streamable", "sse":
		if strings.TrimSpace(s.cfg.URL) == "" {
			m.failStart(s, "no url configured")
			return
		}
	default:
		m.failStart(s, fmt.Sprintf("unsupported transport %q", s.cfg.transportKind()))
		return
	}
	s.generation++
	s.status = statusStarting
	s.lastErr = ""
	gen := s.generation
	name := s.name
	cfg := s.cfg
	go m.connect(name, gen, cfg)
}

// stopServer closes a running session and marks the server stopped. Bumping the
// generation makes any in-flight connect/monitor events for the old process
// no-ops. Must run on the manager goroutine.
func (m *Manager) stopServer(s *serverState) {
	s.generation++
	if s.session != nil {
		sess := s.session
		go func() { _ = sess.Close() }()
		s.session = nil
	}
	s.status = statusStopped
	s.tools = nil
	// Fail any parked callers.
	m.drainWaiters(s, ensureResult{err: fmt.Errorf("mcp server %q stopped", s.name)})
}

// connect runs the blocking handshake off the manager goroutine and posts the
// outcome back as an event.
func (m *Manager) connect(name string, gen int, cfg ServerConfig) {
	m.reqCh <- mcpReq{kind: evStarting, server: name, generation: gen}

	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()

	transport, err := m.buildTransport(name, cfg)
	if err != nil {
		m.reqCh <- mcpReq{kind: evCrashed, server: name, generation: gen, err: err}
		return
	}

	client := mcp.NewClient(&mcp.Implementation{Name: "juggler", Version: "1.0.0"}, &mcp.ClientOptions{
		ToolListChangedHandler: func(context.Context, *mcp.ToolListChangedRequest) {
			m.reqCh <- mcpReq{kind: evToolsChanged, server: name, generation: gen}
		},
	})

	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		m.reqCh <- mcpReq{kind: evCrashed, server: name, generation: gen, err: fmt.Errorf("connect: %w", err)}
		return
	}

	tools, err := listTools(ctx, name, session)
	if err != nil {
		_ = session.Close()
		m.reqCh <- mcpReq{kind: evCrashed, server: name, generation: gen, err: fmt.Errorf("tools/list: %w", err)}
		return
	}

	info := session.InitializeResult()
	srvName, srvVer := "", ""
	if info != nil && info.ServerInfo != nil {
		srvName, srvVer = info.ServerInfo.Name, info.ServerInfo.Version
	}
	m.reqCh <- mcpReq{
		kind: evConnected, server: name, generation: gen,
		session: session, tools: tools, srvName: srvName, srvVer: srvVer,
	}

	// Monitor the session; when it ends, report a crash so the manager can
	// restart or mark it failed.
	go func() {
		werr := session.Wait()
		m.reqCh <- mcpReq{kind: evCrashed, server: name, generation: gen, err: waitErr(werr)}
	}()
}

// buildTransport constructs the SDK transport for a server from its configured
// transport kind. stdio spawns a child process and routes its stderr into the
// server's log ring; http/streamable and sse connect to a remote URL, with any
// configured headers injected on every request. startServer has already
// validated that the required Command/URL is present for the kind.
func (m *Manager) buildTransport(name string, cfg ServerConfig) (mcp.Transport, error) {
	switch cfg.transportKind() {
	case "stdio":
		cmd := exec.Command(cfg.Command, cfg.Args...) //nolint:gosec // user-approved server command
		cmd.Env = os.Environ()
		for k, v := range cfg.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		// Route stderr into the server's ring via events so the manager goroutine
		// remains the sole owner of the ring buffer.
		cmd.Stderr = &logWriter{ch: m.reqCh, server: name}
		return &mcp.CommandTransport{Command: cmd}, nil
	case "http", "streamable":
		return &mcp.StreamableClientTransport{
			Endpoint:   cfg.URL,
			HTTPClient: httpClientWithHeaders(cfg.Headers),
		}, nil
	case "sse":
		return &mcp.SSEClientTransport{
			Endpoint:   cfg.URL,
			HTTPClient: httpClientWithHeaders(cfg.Headers),
		}, nil
	default:
		return nil, fmt.Errorf("unsupported transport %q", cfg.transportKind())
	}
}

// httpClientWithHeaders returns a proxy-aware *http.Client that injects the
// given static headers (e.g. Authorization) on every request, so remote MCP
// servers are reachable through a configured proxy. With no headers it returns
// a plain proxy-aware client rather than nil.
func httpClientWithHeaders(headers map[string]string) *http.Client {
	if len(headers) == 0 {
		return httpx.Client(0)
	}
	return &http.Client{Transport: &headerRoundTripper{headers: headers, base: httpx.Transport()}}
}

// headerRoundTripper is an http.RoundTripper that sets static headers on each
// outgoing request before delegating to base.
type headerRoundTripper struct {
	headers map[string]string
	base    http.RoundTripper
}

func (h *headerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	// Clone so the shared request template is never mutated.
	req = req.Clone(req.Context())
	for k, v := range h.headers {
		req.Header.Set(k, v)
	}
	return h.base.RoundTrip(req)
}

// relist re-fetches the tool list after a tools/list_changed notification.
func (m *Manager) relist(name string, gen int, session *mcp.ClientSession) {
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	tools, err := listTools(ctx, name, session)
	if err != nil {
		jlog.Error("[mcp] relist %s failed: %v", name, err)
		return
	}
	m.reqCh <- mcpReq{kind: evSetTools, server: name, generation: gen, tools: tools}
}

// handleConnected records a successful connection and wakes parked callers.
func (m *Manager) handleConnected(servers map[string]*serverState, req mcpReq) {
	s := servers[req.server]
	if s == nil || s.generation != req.generation {
		// Superseded; drop this session.
		if req.session != nil {
			sess := req.session
			go func() { _ = sess.Close() }()
		}
		return
	}
	s.session = req.session
	s.tools = req.tools
	s.srvName = req.srvName
	s.srvVer = req.srvVer
	s.status = statusRunning
	s.lastErr = ""
	s.attempts = 0
	m.drainWaiters(s, ensureResult{session: req.session})
	m.notifyChange()
}

// handleCrashed handles a failed connect or a session that ended, applying
// bounded restart backoff.
func (m *Manager) handleCrashed(servers map[string]*serverState, req mcpReq) {
	s := servers[req.server]
	if s == nil || s.generation != req.generation {
		return
	}
	s.session = nil
	s.tools = nil
	errMsg := "server exited"
	if req.err != nil {
		errMsg = req.err.Error()
	}
	if tail := strings.TrimSpace(string(s.stderr.bytes())); tail != "" {
		errMsg = errMsg + "\n" + lastLines(tail, 5)
	}

	if s.attempts < maxRestartAttempts && s.cfg.IsEnabled() {
		s.attempts++
		s.status = statusStarting
		s.lastErr = errMsg
		name := s.name
		jlog.Info("[mcp] server %q crashed (attempt %d/%d): %s", name, s.attempts, maxRestartAttempts, errMsg)
		time.AfterFunc(restartBackoff, func() {
			m.reqCh <- mcpReq{kind: reqControl, server: name, action: "start-internal", resp: make(chan mcpResp, 1)}
		})
		m.notifyChange()
		return
	}

	s.status = statusFailed
	s.lastErr = errMsg
	jlog.Error("[mcp] server %q failed: %s", s.name, errMsg)
	m.drainWaiters(s, ensureResult{err: fmt.Errorf("mcp server %q failed: %s", s.name, errMsg)})
	m.notifyChange()
}

// handleEnsure returns a ready session for callTool, starting the server if
// needed and parking the caller until a terminal outcome.
func (m *Manager) handleEnsure(servers map[string]*serverState, req mcpReq) {
	s := servers[req.server]
	if s == nil {
		req.resp <- mcpResp{ensure: ensureResult{err: fmt.Errorf("unknown mcp server %q", req.server)}}
		return
	}
	if !s.cfg.IsEnabled() {
		req.resp <- mcpResp{ensure: ensureResult{err: fmt.Errorf("mcp server %q is disabled", req.server)}}
		return
	}
	switch s.status {
	case statusRunning:
		req.resp <- mcpResp{ensure: ensureResult{session: s.session}}
	case statusFailed:
		// Give an explicit call a fresh attempt.
		s.attempts = 0
		s.waiters = append(s.waiters, forward(req.resp))
		m.startServer(s)
	case statusStopped:
		s.waiters = append(s.waiters, forward(req.resp))
		m.startServer(s)
	default: // starting
		s.waiters = append(s.waiters, forward(req.resp))
	}
}

// handleControl implements mcpServerControl actions plus the internal restart.
func (m *Manager) handleControl(servers map[string]*serverState, name, action, project string) error {
	if action == "start-internal" {
		if s := servers[name]; s != nil && s.status == statusStarting && s.session == nil {
			m.startServer(s)
		}
		return nil
	}
	s := servers[name]
	if s == nil && action != "reload" {
		return fmt.Errorf("unknown mcp server %q", name)
	}
	switch action {
	case "start":
		if s.status == statusRunning {
			return nil
		}
		s.attempts = 0
		m.startServer(s)
	case "stop":
		m.stopServer(s)
	case "restart":
		m.stopServer(s)
		s.attempts = 0
		m.startServer(s)
	case "reload":
		m.reconcile(servers, project)
	default:
		return fmt.Errorf("unknown action %q", action)
	}
	return nil
}

// drainWaiters delivers a result to every parked caller and clears the list.
func (m *Manager) drainWaiters(s *serverState, res ensureResult) {
	for _, w := range s.waiters {
		w <- res
	}
	s.waiters = nil
}

// forward adapts a mcpResp response channel into an ensureResult channel so
// parked waiters can be woken uniformly.
func forward(resp chan mcpResp) chan ensureResult {
	ch := make(chan ensureResult, 1)
	go func() { resp <- mcpResp{ensure: <-ch} }()
	return ch
}

// listTools fetches and flattens the server's tool list.
func listTools(ctx context.Context, server string, session *mcp.ClientSession) ([]ToolInfo, error) {
	res, err := session.ListTools(ctx, nil)
	if err != nil {
		return nil, err
	}
	out := make([]ToolInfo, 0, len(res.Tools))
	for _, t := range res.Tools {
		if t == nil {
			continue
		}
		ti := ToolInfo{
			Server:      server,
			Name:        t.Name,
			Title:       displayTitle(t),
			Description: t.Description,
			InputSchema: t.InputSchema,
		}
		if t.Annotations != nil {
			ti.ReadOnly = t.Annotations.ReadOnlyHint
			if t.Annotations.DestructiveHint != nil {
				ti.Destructive = *t.Annotations.DestructiveHint
			} else {
				ti.Destructive = !t.Annotations.ReadOnlyHint
			}
		} else {
			ti.Destructive = true // unknown → treat as destructive
		}
		ti.SchemaTokens = estimateSchemaTokens(t.InputSchema)
		out = append(out, ti)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// displayTitle resolves the human display name: title, annotations.title, name.
func displayTitle(t *mcp.Tool) string {
	if t.Title != "" {
		return t.Title
	}
	if t.Annotations != nil && t.Annotations.Title != "" {
		return t.Annotations.Title
	}
	return t.Name
}

// estimateSchemaTokens approximates the token cost of a tool's input schema as
// chars/4 of its JSON encoding.
func estimateSchemaTokens(schema any) int {
	if schema == nil {
		return 0
	}
	data, err := json.Marshal(schema)
	if err != nil {
		return 0
	}
	return len(data) / 4
}

// listStatuses builds the mcpListServers response.
func listStatuses(servers map[string]*serverState) []ServerStatus {
	out := make([]ServerStatus, 0, len(servers))
	for _, s := range servers {
		tokens := 0
		for _, t := range s.tools {
			tokens += t.SchemaTokens
		}
		out = append(out, ServerStatus{
			Name:         s.name,
			Status:       s.status,
			Error:        s.lastErr,
			Transport:    s.cfg.transportKind(),
			Enabled:      s.cfg.IsEnabled(),
			ToolCount:    len(s.tools),
			SchemaTokens: tokens,
			ServerName:   s.srvName,
			ServerVer:    s.srvVer,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// flattenTools returns every running server's tools as one snapshot.
func flattenTools(servers map[string]*serverState) []ToolInfo {
	var out []ToolInfo
	for _, name := range sortedServerNames(servers) {
		out = append(out, servers[name].tools...)
	}
	return out
}

func sortedServerNames(servers map[string]*serverState) []string {
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// waitErr normalizes a session.Wait() error into a non-nil error for reporting.
func waitErr(err error) error {
	if err != nil {
		return err
	}
	return fmt.Errorf("server process exited")
}

// lastLines returns the last n lines of s.
func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// logWriter forwards a server's stderr into the manager as append-log events.
type logWriter struct {
	ch     chan mcpReq
	server string
}

func (w *logWriter) Write(p []byte) (int, error) {
	// Copy: the caller may reuse p after Write returns.
	w.ch <- mcpReq{kind: evAppendLog, server: w.server, logData: string(p)}
	return len(p), nil
}
