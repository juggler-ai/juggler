//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"compress/flate"
	"context"
	"net/http"

	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
	"juggler/internal/jlog"

	"github.com/gorilla/websocket"
)

// handleWebSocket handles WebSocket connections for streaming
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Negotiate (and use) permessage-deflate only for remote peers — remote
	// ingress, or any non-loopback LAN viewer — where the link is the bottleneck
	// this targets. The engine and a local desktop-app/browser viewer ride
	// loopback, where deflate is pure CPU cost with zero bandwidth benefit, so
	// they upgrade with no extension negotiated. EnableCompression is per-request
	// here via a copy of the shared upgrader.
	remotePeer := isRemoteIngress(r) || !isLoopbackAddr(r.RemoteAddr)
	upgrader := s.upgrader
	upgrader.EnableCompression = remotePeer

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		jlog.Error("WebSocket upgrade error: %v (origin=%q host=%q remote=%s)", err, r.Header.Get("Origin"), r.Host, r.RemoteAddr)
		return
	}

	if remotePeer {
		conn.EnableWriteCompression(true)
		_ = conn.SetCompressionLevel(flate.DefaultCompression)
	}

	// Parse client role from query parameter (default: viewer).
	// Engine connections are only legitimate from this process — either the
	// dedicated engine WebviewWindow or, in test mode, the engine iframe in
	// the loopback test slot. Restrict role=engine upgrades to loopback (and
	// exclude remote ingress) so an external browser can't claim the engine
	// slot.
	roleParam := r.URL.Query().Get("role")
	role := ClientRoleViewer
	if roleParam == "engine" {
		if !engineRoleAllowed(r) {
			jlog.Debug("Rejected engine WS upgrade from %s (ingress=%q)", r.RemoteAddr, RemoteIngressKind(r))
			conn.Close()
			return
		}
		// An engine that names a token must name ours. The token is minted per
		// process, so this is the one thing that tells an engine of this server
		// apart from one that outlived the server before it and is still dialling
		// the address we now hold — and the engine slot goes to the newest
		// arrival, so a stranger taking it means the work goes to a realm that
		// cannot do it. A token-less engine is still admitted: the webview host's
		// socket runs in a worker with no token to send, and loopback plus the
		// origin check is what has always vouched for it.
		if token := r.URL.Query().Get("token"); token != "" && token != s.apiToken {
			jlog.Info("Rejected an engine WS upgrade from %s carrying another instance's token — an engine outlived its server and found this one", r.RemoteAddr)
			conn.Close()
			return
		}
		role = ClientRoleEngine
	}

	// Per-instance token gate for local viewer upgrades (§S.1) — the defense
	// against a same-machine cross-site page opening a socket to the agent.
	// Exempt:
	//   - the engine role: restricted to the in-process loopback WebView by
	//     engineRoleAllowed, and gated above on the token when it sends one —
	//     the webview host's worker has none to send;
	//   - remote ingress: these are the user's explicit remote grants
	//     (possession of the unguessable URL), authorized exactly like the
	//     LAN gate authorizes them, and their transport need not thread the token
	//     through the WS handshake.
	// Skipped entirely in test mode, where the headless harness drives many
	// synthetic viewers without a token.
	tokenExempt := role == ClientRoleEngine || isRemoteIngress(r)
	if !s.testMode && !tokenExempt && r.URL.Query().Get("token") != s.apiToken {
		jlog.Debug("Rejected viewer WS upgrade from %s: missing or invalid session token", r.RemoteAddr)
		conn.Close()
		return
	}

	// Create WSClient with dedicated writer goroutine
	viewerID := sanitiseViewerID(r.URL.Query().Get("viewerId"))
	info := clientInfoFromRequest(r)
	// A detached pinboard names the window it was popped out of. The same
	// alphabet as a viewer id, because it is one and is relayed the same way.
	info.Owner = sanitiseViewerID(r.URL.Query().Get("owner"))
	client := NewWSClient(conn, role, viewerID, info, s.stats)
	defer client.Close()

	msgCh := make(chan []byte, 100)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer close(msgCh)
		for {
			_, msgBytes, err := conn.ReadMessage()
			if err != nil {
				// CloseAbnormalClosure (1006) is the normal case when a viewer's
				// process exits without a close handshake — e.g. a desktop-app
				// window closing — not a server fault, so don't log it as an error.
				if websocket.IsUnexpectedCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseNoStatusReceived, websocket.CloseAbnormalClosure) {
					jlog.Error("WebSocket error: %v", err)
				}
				return
			}
			select {
			case msgCh <- msgBytes:
			case <-r.Context().Done():
				return
			}
		}
	}()

	s.runRealtimeClientLoop(r.Context(), client, msgCh, done)
}

// processShellRequest handles a streaming shell command execution.
// Runs in its own goroutine to allow concurrent shell executions.
//
// Chunks go straight back to the client that requested the shell (`requester`),
// NOT to the project's viewer group. shell-output is consumed solely by the
// engine's shellExecuteStreaming, which resolves the bash tool on the `done`
// chunk. The engine is persistent across SwitchProject, but the viewer group is
// per-project and replaced on every switch — and the engine, unlike viewers,
// never reloads to re-join the new group. Broadcasting via the viewer group
// therefore stranded the engine's bash results after any project switch (read/
// grep over HTTP and worker-messages kept working, so only bash wedged). Sending
// to the requester is project-independent and order-preserving (the WSClient
// writer goroutine serializes its sends). Viewers still see live bash output via
// the separate engine-bridge/action-progress channel, untouched here.
func (s *Server) processShellRequest(
	ctx context.Context,
	req ShellStartRequest,
	requester Sender,
	completeChan chan<- string,
) {
	// Notify completion when done (non-blocking)
	defer func() {
		select {
		case completeChan <- req.ShellID:
		default:
		}
	}()

	s.streamShell(ctx, s.Workspaces().Resolve, req, requester)
}

// streamShell runs one streaming command in the requesting conversation's
// workspace — the project when it named none — and forwards its output to the
// requester until the command is over.
//
// The workspace runs the command itself, confining the requested cwd to its
// root, so this is what stops a bound conversation's command running in the
// wrong tree. It is resolved by the same resolver /api/ops/call uses: a
// streaming command and a one-shot one must be confined identically.
func (s *Server) streamShell(ctx context.Context, resolve workspace.ResolveFunc, req ShellStartRequest, requester Sender) {
	ws, err := resolve(req.WorkspaceID)
	if err != nil {
		// Refuse to the requester in the shape it is waiting for: a done chunk
		// carrying the reason, so the engine's shellExecuteStreaming settles with
		// the refusal instead of sitting at `running` until its safety timeout.
		requester.Send(map[string]any{
			"type":    "shell-output",
			"shellId": req.ShellID,
			"done":    true,
			"error":   err.Error(),
		})
		return
	}

	// Create output channel for streaming chunks
	outputChan := make(chan ops.ShellStreamChunk, 100)

	// Start streaming execution; the workspace closes the channel when it is over.
	go ws.StreamShell(ctx, workspace.ShellRequest{
		ShellID: req.ShellID, ConvID: req.ConvId, Command: req.Command, Cwd: req.Cwd, TimeoutMs: req.Timeout,
	}, outputChan)

	// Forward chunks to the requesting engine (see func doc for why not the
	// viewer group).
	for chunk := range outputChan {
		msg := map[string]any{
			"type":    "shell-output",
			"shellId": chunk.ShellID,
			"data":    chunk.Data,
			"done":    chunk.Done,
		}
		// Status chunks (awaiting-permission / running) explain why a silent
		// command is still running. They are non-Done with empty Data.
		if chunk.Status != "" {
			msg["status"] = chunk.Status
			if chunk.Hint != "" {
				msg["hint"] = chunk.Hint
			}
		}
		if chunk.Done {
			msg["exitCode"] = chunk.ExitCode
			if chunk.Error != "" {
				msg["error"] = chunk.Error
			}
			// Full-output spill accounting, present only when output was spilled.
			if chunk.OutputFile != "" {
				msg["outputFile"] = chunk.OutputFile
				msg["outputBytes"] = chunk.OutputBytes
				msg["truncated"] = chunk.Truncated
			}
		}
		requester.Send(msg)
	}
}

// WebSocketWriter wraps server viewer broadcasting to implement io.Writer
// for streaming chunks to all viewers.

// streamMessageToWebSocketWithAgent processes a message with streaming and sends chunks via WebSocket
