//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mcp

import (
	"context"
	"encoding/base64"
	"fmt"

	"juggler/cmd/juggler/ops"
	"juggler/internal/jlog"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Register creates the process-global manager, starts it, and registers the
// "mcp" ops handler. Call once at startup, adjacent to ops.RegisterAll() (from
// app/run.go, not from inside the ops package — that would import-cycle).
//
// The snapshot-change hook (which tells the engine to reload registries) is
// installed separately via SetChangeHook once the server — the owner of the
// client broadcast — is up.
func Register() {
	manager = NewManager()
	manager.Start()
	ops.Register("mcp", func(scope ops.PathScope) ops.Operations {
		return &operations{scope: scope}
	})
}

// StartDiscovery begins connecting the configured servers for a project. Call it
// as soon as the project is known.
//
// Without it, nothing starts a server until the first client asks for a snapshot
// — and that client is the engine building a turn's tool list, so the request
// that starts discovery is the one that has to answer before it finishes. Say so
// in the log: an MCP server that is slow, wrong, or silent is otherwise invisible
// from the outside.
func StartDiscovery(project string) {
	if manager == nil {
		return
	}
	manager.Reconcile(project)
	if n := len(manager.ListServers()); n > 0 {
		jlog.Info("[mcp] %d server(s) configured for %s", n, project)
	}
}

// SetChangeHook installs the callback fired whenever the discovered tool
// snapshot changes (server ready, crashed, or tools/list_changed). The server
// wires this to a plugin-changed broadcast so connected engines reload their
// registries and pick up the new tool set — the same path extension hot-reload
// uses. The hook is applied on the manager goroutine, so it is race-free even
// though the caller runs on another goroutine. No-op if Register hasn't run.
func SetChangeHook(fn func()) {
	if manager == nil {
		return
	}
	manager.reqCh <- mcpReq{kind: reqSetHook, hookFn: fn}
}

// operations is the per-request ops handler. It reconciles the manager to the
// request's project before serving state-dependent operations.
type operations struct {
	scope ops.PathScope
}

// Execute dispatches an mcp operation. Operation names mirror the JS ops-api
// wrappers (listServers, listTools, callTool, serverControl, getLog, getConfig,
// setConfig, trustServer).
func (o *operations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	if manager == nil {
		return nil, fmt.Errorf("mcp manager not initialized")
	}
	project := o.scope.Root()

	switch operation {
	case "listServers":
		manager.Reconcile(project)
		return map[string]any{"servers": manager.ListServers()}, nil

	case "listTools":
		manager.Reconcile(project)
		server, _ := params["server"].(string)
		return map[string]any{"tools": manager.ListTools(server)}, nil

	case "snapshot":
		manager.Reconcile(project)
		tools, complete := manager.Snapshot(ctx)
		return map[string]any{"tools": tools, "complete": complete}, nil

	case "callTool":
		manager.Reconcile(project)
		return o.callTool(ctx, params)

	case "serverControl":
		manager.Reconcile(project)
		server, _ := params["server"].(string)
		action, _ := params["action"].(string)
		if err := manager.Control(server, action); err != nil {
			return nil, err
		}
		return map[string]any{"servers": manager.ListServers()}, nil

	case "getLog":
		server, _ := params["server"].(string)
		return map[string]any{"log": manager.GetLog(server)}, nil

	case "getConfig":
		return o.getConfig(project)

	case "setConfig":
		return o.setConfig(project, params)

	case "trustServer":
		// The settings UI's answer to an untrusted project server: record that the
		// user trusts its command as it stands, and start it.
		server, _ := params["server"].(string)
		if err := trustProjectServer(project, server); err != nil {
			return nil, err
		}
		manager.Reconcile(project)
		return map[string]any{"servers": manager.ListServers()}, nil

	default:
		return nil, fmt.Errorf("unknown mcp operation: %s", operation)
	}
}

// callTool proxies a tool call to the target server, converting the MCP result
// content blocks into a JSON-friendly shape for the engine.
func (o *operations) callTool(ctx context.Context, params map[string]any) (any, error) {
	server, _ := params["server"].(string)
	tool, _ := params["tool"].(string)
	if server == "" || tool == "" {
		return nil, fmt.Errorf("callTool requires 'server' and 'tool'")
	}
	args, _ := params["args"].(map[string]any)

	result, err := manager.CallTool(ctx, server, tool, args)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"content": convertContent(result.Content),
		"isError": result.IsError,
	}, nil
}

// getConfig returns the merged config plus the raw per-file maps so the settings
// UI can show where each server is defined.
func (o *operations) getConfig(project string) (any, error) {
	merged, err := loadMergedConfig(project)
	if err != nil {
		return nil, err
	}
	global, err := readConfigFile(globalConfigPath())
	if err != nil {
		return nil, err
	}
	proj, err := readConfigFile(projectConfigPath(project))
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"merged":     merged,
		"global":     global.Servers,
		"project":    proj.Servers,
		"hasProject": project != "",
	}, nil
}

// setConfig writes servers to either the global or project mcp.json and triggers
// a reconcile so changes take effect without a restart.
func (o *operations) setConfig(project string, params map[string]any) (any, error) {
	target, _ := params["scope"].(string)
	if target == "" {
		target = "global"
	}
	servers, err := decodeServers(params["servers"])
	if err != nil {
		return nil, err
	}

	var path string
	switch target {
	case "global":
		path = globalConfigPath()
	case "project":
		if project == "" {
			return nil, fmt.Errorf("no project loaded; cannot write project mcp.json")
		}
		path = projectConfigPath(project)
	default:
		return nil, fmt.Errorf("unknown config scope %q (want 'global' or 'project')", target)
	}
	// What was on disk before, to tell the entries the user changed from those
	// carried over. An unreadable file has nothing carried over.
	var prev Config
	if target == "project" {
		prev, _ = readConfigFile(path)
	}
	if err := writeConfigFile(path, servers); err != nil {
		return nil, err
	}
	if target == "project" {
		// A command the user typed into the settings form is one they have seen.
		if err := trustAuthored(project, prev.Servers, servers); err != nil {
			return nil, err
		}
	}
	manager.Reconcile(project)
	return map[string]any{"servers": manager.ListServers()}, nil
}

// convertContent flattens MCP content blocks into engine-friendly maps.
func convertContent(blocks []mcp.Content) []map[string]any {
	out := make([]map[string]any, 0, len(blocks))
	for _, b := range blocks {
		switch c := b.(type) {
		case *mcp.TextContent:
			out = append(out, map[string]any{"type": "text", "text": c.Text})
		case *mcp.ImageContent:
			out = append(out, map[string]any{
				"type": "image", "mimeType": c.MIMEType,
				"data": base64.StdEncoding.EncodeToString(c.Data),
			})
		case *mcp.AudioContent:
			out = append(out, map[string]any{
				"type": "audio", "mimeType": c.MIMEType,
				"data": base64.StdEncoding.EncodeToString(c.Data),
			})
		case *mcp.ResourceLink:
			out = append(out, map[string]any{
				"type": "resource_link", "uri": c.URI, "name": c.Name,
				"title": c.Title, "description": c.Description, "mimeType": c.MIMEType,
			})
		case *mcp.EmbeddedResource:
			m := map[string]any{"type": "resource"}
			if c.Resource != nil {
				m["uri"] = c.Resource.URI
				m["mimeType"] = c.Resource.MIMEType
				if c.Resource.Text != "" {
					m["text"] = c.Resource.Text
				}
			}
			out = append(out, m)
		default:
			out = append(out, map[string]any{"type": "unknown"})
		}
	}
	return out
}

// decodeServers coerces the JSON `servers` param (map[string]any) into typed
// ServerConfig entries via a JSON round-trip.
func decodeServers(v any) (map[string]ServerConfig, error) {
	if v == nil {
		return map[string]ServerConfig{}, nil
	}
	raw, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("'servers' must be an object")
	}
	out := make(map[string]ServerConfig, len(raw))
	for name, entry := range raw {
		sc, err := coerceServerConfig(entry)
		if err != nil {
			return nil, fmt.Errorf("server %q: %w", name, err)
		}
		out[name] = sc
	}
	return out, nil
}

// ---- Manager public request API (used by ops above) ---------------------------

// Reconcile sets the active project and diffs config against running servers.
func (m *Manager) Reconcile(project string) {
	resp := make(chan mcpResp, 1)
	m.reqCh <- mcpReq{kind: reqReconcile, project: project, resp: resp}
	// reqReconcile does not send a response; use a fenced no-wait by sending a
	// cheap follow-up that does. A listServers round-trip guarantees the
	// reconcile has been processed (same mailbox, FIFO).
	fence := make(chan mcpResp, 1)
	m.reqCh <- mcpReq{kind: reqListServers, resp: fence}
	<-fence
}

// ListServers returns the status of every configured server.
func (m *Manager) ListServers() []ServerStatus {
	resp := make(chan mcpResp, 1)
	m.reqCh <- mcpReq{kind: reqListServers, resp: resp}
	return (<-resp).servers
}

// Snapshot returns every running server's discovered tools, waiting (bounded by
// settleTimeout) while any server is still on its first connect attempt. The
// second return reports whether every enabled server has published its list, so
// a caller that caches the snapshot knows whether it is safe to stop asking.
//
// The wait is the point. This snapshot is what a turn's tool list is built from,
// and discovery is started by the same client that asks for it, so answering
// immediately means the first turn of every session ships a tool list missing
// every MCP tool — while the settings UI, reading the manager directly a moment
// later, shows them all. Callers that cannot wait cancel ctx and get whatever has
// been discovered so far.
func (m *Manager) Snapshot(ctx context.Context) ([]ToolInfo, bool) {
	resp := make(chan mcpResp, 1)
	m.reqCh <- mcpReq{kind: reqSnapshotSettled, resp: resp}
	select {
	case r := <-resp:
		return r.tools, r.complete
	case <-ctx.Done():
		// The parked waiter still holds resp, which is buffered, so the manager's
		// later send lands harmlessly in a channel nobody reads.
		unsettled := make(chan mcpResp, 1)
		m.reqCh <- mcpReq{kind: reqSnapshot, resp: unsettled}
		r := <-unsettled
		return r.tools, r.complete
	}
}

// ListTools returns tools for one server, or all servers when server is "".
func (m *Manager) ListTools(server string) []ToolInfo {
	resp := make(chan mcpResp, 1)
	m.reqCh <- mcpReq{kind: reqListTools, server: server, resp: resp}
	return (<-resp).tools
}

// GetLog returns the recent stderr tail for a server.
func (m *Manager) GetLog(server string) string {
	resp := make(chan mcpResp, 1)
	m.reqCh <- mcpReq{kind: reqGetLog, server: server, resp: resp}
	return (<-resp).log
}

// Control performs a server lifecycle action (start/stop/restart/reload).
func (m *Manager) Control(server, action string) error {
	resp := make(chan mcpResp, 1)
	m.reqCh <- mcpReq{kind: reqControl, server: server, action: action, resp: resp}
	return (<-resp).err
}

// CallTool ensures the target server is running and invokes the tool. It honors
// ctx cancellation via the SDK session, so an aborted op fetch cancels the call.
func (m *Manager) CallTool(ctx context.Context, server, tool string, args map[string]any) (*mcp.CallToolResult, error) {
	resp := make(chan mcpResp, 1)
	m.reqCh <- mcpReq{kind: reqEnsure, server: server, resp: resp}
	er := (<-resp).ensure
	if er.err != nil {
		return nil, er.err
	}
	if er.session == nil {
		return nil, fmt.Errorf("mcp server %q has no session", server)
	}
	// Defense in depth: a stale engine tool definition (built before the config
	// changed) could still target a now-hidden tool. Reject it here so a filtered
	// tool is unreachable even if it slips back into a tool list.
	if er.allows != nil && !er.allows(tool) {
		return nil, fmt.Errorf("mcp tool %q is not permitted on server %q", tool, server)
	}
	return er.session.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: mergeDefaultArgs(er.defaultArgs, args)})
}
