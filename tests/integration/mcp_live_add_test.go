//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// liveMCPServerName is the server the test adds mid-run; its tools reach the
// model as mcp__<name>__<tool>.
const liveMCPServerName = "livefake"

// liveMCPServerJS is a minimal newline-delimited JSON-RPC MCP server over stdio,
// run under the same node the engine host needs, so it costs no extra
// dependency.
const liveMCPServerJS = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'livefake', version: '1.0.0' } } });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'alpha', description: 'Alpha tool', inputSchema: { type: 'object', properties: {} } }
      ] } });
      break;
    default:
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`

// TestMCPServerAddedMidRunReachesTheNextRequest holds the node engine host to
// the promise the Settings panel makes: an MCP server added while Juggler is
// running is offered to the model from the next request on, without a restart.
//
// The run starts with no MCP servers, which is the state that lets the engine
// treat its (empty) tool snapshot as final. Between the turn's two LLM
// round-trips the gateway adds a server through the same `mcp setConfig` op the
// Settings panel calls and waits until the manager reports it running — the
// green dot. The second request must then carry the server's tool.
//
// It runs on the node host because that is the host where the engine and its
// extensions are loaded by different routes (the engine from an on-disk
// snapshot, extensions over /worker-module), so a module an extension imports
// from the core can be a second copy of the engine's own. The webview host
// loads both through one route and cannot show that.
func TestMCPServerAddedMidRunReachesTheNextRequest(t *testing.T) {
	binary := oneShotBinary(t)

	proj := t.TempDir()
	wantPath := filepath.Join(proj, oneShotFileName)
	serverScript := filepath.Join(t.TempDir(), "livefake-mcp.js")
	if err := os.WriteFile(serverScript, []byte(liveMCPServerJS), 0o600); err != nil {
		t.Fatalf("write fake MCP server: %v", err)
	}

	gateway, requests := startMCPAddingGateway(t, proj, wantPath, serverScript)
	cfgDir := writeOneShotConfig(t, gateway.URL+"/v1")

	stdout, stderr, code := runOneShot(t, binary, proj, cfgDir, 3*time.Minute,
		"Create "+oneShotFileName+" in the project containing the word potato.")
	if code != 0 {
		t.Fatalf("`juggler run` exited %d, want 0.\nstdout:\n%s\n%s", code, stdout, tailLog(stderr))
	}

	got := requests()
	if len(got) < 2 {
		t.Fatalf("gateway saw %d tool-carrying requests, want 2 (before and after the server was added): %v", len(got), got)
	}
	want := "mcp__" + liveMCPServerName + "__alpha"
	if hasTool(got[0], want) {
		t.Fatalf("the first request already carried %s, before the server was added: %v", want, got[0])
	}
	if !hasTool(got[1], want) {
		t.Errorf("the request after the MCP server was added and reported running does not carry %s.\n"+
			"before: %d tools %v\nafter:  %d tools %v", want, len(got[0]), got[0], len(got[1]), got[1])
	}
}

// hasTool reports whether name is among names.
func hasTool(names []string, name string) bool {
	for _, n := range names {
		if n == name {
			return true
		}
	}
	return false
}

// startMCPAddingGateway stands up the scripted gateway for the test above. The
// first tool-carrying request adds the MCP server through the running Juggler's
// own API, waits for it to report running, and answers with a `write` call; the
// request carrying that call's result gets the final answer. It returns the tool
// names of every tool-carrying request, in order.
func startMCPAddingGateway(t *testing.T, proj, wantPath, serverScript string) (*httptest.Server, func() [][]string) {
	t.Helper()
	// Buffered well past any real run, so the handler never blocks on it.
	seen := make(chan []string, 64)
	var added atomic.Bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"object":"list","data":[{"id":%q,"object":"model","owned_by":"juggler-test"}]}`, oneShotModelID)
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{}`)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read completions body: %v", err)
			return
		}
		var payload struct {
			Messages []struct {
				Role string `json:"role"`
			} `json:"messages"`
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("parse completions body: %v", err)
			return
		}
		if len(payload.Tools) == 0 {
			writeSSE(t, w, textChunk("Potato"), stopChunk("stop"))
			return
		}
		names := make([]string, 0, len(payload.Tools))
		for _, tool := range payload.Tools {
			names = append(names, tool.Function.Name)
		}
		carriesToolResult := false
		for _, msg := range payload.Messages {
			if msg.Role == "tool" {
				carriesToolResult = true
			}
		}

		seen <- names
		first := added.CompareAndSwap(false, true)

		switch {
		case carriesToolResult:
			writeSSE(t, w, textChunk("The file is planted. "+oneShotSentinel), stopChunk("stop"))
		case first:
			if err := addMCPServerAndWait(proj, serverScript); err != nil {
				t.Errorf("add MCP server through the running app: %v", err)
			}
			writeSSE(t, w, writeToolChunk(t, wantPath), stopChunk("tool_calls"))
		default:
			writeSSE(t, w, textChunk("Potato"), stopChunk("stop"))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, func() [][]string {
		var out [][]string
		for {
			select {
			case names := <-seen:
				out = append(out, names)
			default:
				return out
			}
		}
	}
}

// addMCPServerAndWait does what the Settings panel does to add a server — the
// `mcp setConfig` op on the running instance — and returns once the manager
// lists it as running, which is when the panel shows its green dot.
func addMCPServerAndWait(proj, serverScript string) error {
	base, token, err := runningInstance(proj)
	if err != nil {
		return err
	}
	servers := map[string]any{
		liveMCPServerName: map[string]any{"command": "node", "args": []string{serverScript}},
	}
	if _, err := callOp(base, token, "setConfig", map[string]any{"scope": "global", "servers": servers}); err != nil {
		return fmt.Errorf("setConfig: %w", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		res, err := callOp(base, token, "listServers", map[string]any{})
		if err != nil {
			return fmt.Errorf("listServers: %w", err)
		}
		var list struct {
			Servers []struct {
				Name   string `json:"name"`
				Status string `json:"status"`
			} `json:"servers"`
		}
		if err := json.Unmarshal(res, &list); err != nil {
			return fmt.Errorf("parse listServers %s: %w", res, err)
		}
		for _, s := range list.Servers {
			if s.Name == liveMCPServerName && s.Status == "running" {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("server %q never reported running", liveMCPServerName)
}

// runningInstance finds the base URL of the Juggler serving proj, from the
// instance.json it records once bound, and the API token its index page
// carries.
func runningInstance(proj string) (base, token string, err error) {
	data, err := os.ReadFile(filepath.Join(proj, ".juggler", "instance.json"))
	if err != nil {
		return "", "", fmt.Errorf("read instance.json: %w", err)
	}
	var info struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}
	if err := json.Unmarshal(data, &info); err != nil {
		return "", "", fmt.Errorf("parse instance.json: %w", err)
	}
	base = "http://" + net.JoinHostPort(info.Host, strconv.Itoa(info.Port))
	resp, err := http.Get(base + "/")
	if err != nil {
		return "", "", fmt.Errorf("GET index: %w", err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	m := apiTokenPattern.FindSubmatch(page)
	if m == nil {
		return "", "", fmt.Errorf("index page (status %d) carries no API token", resp.StatusCode)
	}
	return base, string(m[1]), nil
}

// callOp invokes one `mcp` operation over /api/ops/call and returns its result.
func callOp(base, token, operation string, params map[string]any) (json.RawMessage, error) {
	body, err := json.Marshal(map[string]any{"toolId": "mcp", "operation": operation, "params": params})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, base+"/api/ops/call", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Juggler-Token", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var envelope struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
		Error   string          `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || resp.StatusCode != http.StatusOK || !envelope.Success {
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return envelope.Data, nil
}
