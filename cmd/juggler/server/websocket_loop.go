//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"compress/flate"
	"context"
	"net/http"

	"juggler/cmd/juggler/ops"
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
		role = ClientRoleEngine
	}

	// Per-instance token gate for local viewer upgrades (§S.1) — the defense
	// against a same-machine cross-site page opening a socket to the agent.
	// Exempt:
	//   - the engine role: already restricted to the in-process loopback WebView
	//     by engineRoleAllowed, and its page carries no token;
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
	client := NewWSClient(conn, role, clientInfoFromRequest(r), s.stats)
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

	// Create shell operations rooted at the REAL project path, with paths
	// redirected into the requesting conversation's per-repo worktrees. The
	// requested cwd is validated against the real root, then redirected, inside
	// ExecuteStreaming.
	shellOps := ops.NewShellOperations(
		ops.NewPathScope(s.SessionManager().GetProjectPath(), nil).WithRemap(s.repoRemapper(req.ConversationID)),
	)

	// Create output channel for streaming chunks
	outputChan := make(chan ops.ShellStreamChunk, 100)

	// Start streaming execution
	go shellOps.ExecuteStreaming(ctx, req.ShellID, req.Command, req.Cwd, req.Timeout, outputChan)

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
		}
		requester.Send(msg)
	}
}

// WebSocketWriter wraps server viewer broadcasting to implement io.Writer
// for streaming chunks to all viewers.

// streamMessageToWebSocketWithAgent processes a message with streaming and sends chunks via WebSocket
