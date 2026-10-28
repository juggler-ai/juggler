//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"compress/flate"
	"context"
	"net/http"
	"time"

	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
	"juggler/internal/jlog"

	"github.com/gorilla/websocket"
)

// handleWebSocket handles WebSocket connections for streaming
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Who may connect is settled before the upgrade wherever the client can do
	// without a socket to learn it was refused; see each gate.
	query := r.URL.Query()
	token := query.Get("token")
	role := ClientRoleViewer
	if query.Get("role") == "engine" {
		// The engine slot goes to the newest arrival, so it is open only to this
		// process's own engine realm — loopback, not remote ingress
		// (engineRoleAllowed) — carrying this process's token. Both realms are
		// handed the token (the webview worker in engine-worker-main.js's start
		// message, the node host in JUGGLER_TOKEN), and it is the one thing that
		// tells an engine of this server from one that outlived the server
		// before it and is still dialling the address we now hold: a stranger in
		// the slot means the work goes to a realm that cannot do it. The engine
		// has no stale-page recovery that needs the socket to open, so it is
		// refused with a plain status.
		if !engineRoleAllowed(r) || token == "" || !s.isAPIToken(token) {
			jlog.Info("Rejected an engine WS upgrade from %s (ingress=%q, token sent=%v)", r.RemoteAddr, RemoteIngressKind(r), token != "")
			http.Error(w, "engine role refused", http.StatusForbidden)
			return
		}
		role = ClientRoleEngine
	}

	// Per-instance token gate for local viewer upgrades (§S.1) — the defense
	// against a same-machine cross-site page opening a socket to the agent.
	// Remote ingress is exempt: those are the user's explicit remote grants
	// (possession of the unguessable URL), authorized exactly like the LAN gate
	// authorizes them, and their transport need not thread the token through
	// the WS handshake. Skipped entirely on a test server (test.authDisabled), where the headless
	// harness drives many synthetic viewers without a token.
	//
	// A missing token is refused before the upgrade: no page this server serves
	// dials without one. A token that is present but not ours is refused only
	// after it, because that is a page an earlier instance of this server
	// served, and a browser cannot read the status of a refused upgrade — a
	// socket that opens and closes before the session frame is the only signal
	// that its page is stale, and the page reloads on it
	// (websocket.js _onTransportClosed).
	viewerGated := role == ClientRoleViewer && !s.test.authDisabled && !isRemoteIngress(r)
	if viewerGated && token == "" {
		jlog.Debug("Rejected viewer WS upgrade from %s: no session token", r.RemoteAddr)
		http.Error(w, "missing session token", http.StatusForbidden)
		return
	}

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

	if viewerGated && !s.isAPIToken(token) {
		jlog.Debug("Rejected viewer WS upgrade from %s: its session token belongs to another instance", r.RemoteAddr)
		conn.Close()
		return
	}

	// Create WSClient with dedicated writer goroutine
	viewerID := sanitiseViewerID(query.Get("viewerId"))
	info := clientInfoFromRequest(r)
	// A detached pinboard names the window it was popped out of. The same
	// alphabet as a viewer id, because it is one and is relayed the same way.
	info.Owner = sanitiseViewerID(query.Get("owner"))
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
// Chunks go straight back to the requester — the connection that asked, or for
// the engine whichever engine connection is current (engineRecipient) — NOT to
// the project's viewer group. shell-output is consumed solely by the
// engine's shellStreaming, which resolves the bash tool on the `done`
// chunk. The engine is persistent across SwitchProject, but the viewer group is
// per-project and replaced on every switch — and the engine, unlike viewers,
// never reloads to re-join the new group. Broadcasting via the viewer group
// therefore stranded the engine's bash results after any project switch (read/
// grep over HTTP and worker-messages kept working, so only bash wedged). Sending
// to the requester is project-independent and order-preserving (the WSClient
// writer goroutine serializes its sends). Viewers still see live bash output via
// the separate engine-bridge/action-progress channel, untouched here.
//
// complete is called with the shell's id once it is over and its output has
// been delivered.
func (s *Server) processShellRequest(
	ctx context.Context,
	req ShellStartRequest,
	requester Sender,
	complete func(shellID string),
) {
	defer complete(req.ShellID)

	s.streamShell(ctx, s.Workspaces().Resolve, req, requester)
}

// engineRecipient is where a shell the engine started sends its output:
// whichever engine is attached at the moment of each send, rather than the
// connection that asked. The engine's socket can close under a realm that is
// still running — an eviction (engine_liveness.go), a write that timed out, a
// stalled link — and that realm reconnects and goes on awaiting the command.
// Send reports false while no engine is attached, and streamShell holds what
// it could not deliver until one is.
type engineRecipient struct{ s *Server }

func (e engineRecipient) Send(msg any) bool {
	if c := e.s.engineClient.Load(); c != nil {
		return c.Send(msg)
	}
	return false
}

func (e engineRecipient) SendRaw(data []byte) bool {
	if c := e.s.engineClient.Load(); c != nil {
		return c.SendRaw(data)
	}
	return false
}

// engineRedeliveryInterval is how often output held for an absent engine is
// offered again. It sets only how soon after the engine is back the output
// follows it, never whether it does.
const engineRedeliveryInterval = 100 * time.Millisecond

// deliverInOrder sends frames to to, oldest first, stopping at the first it
// will not take, and returns those still to send.
func deliverInOrder(to Sender, frames []shellOutputFrame) []shellOutputFrame {
	for len(frames) > 0 && to.Send(frames[0]) {
		frames = frames[1:]
	}
	return frames
}

// awaitEngine delivers output held for an absent engine once one is attached
// again, however long that takes. A shell's final chunk is the only word its
// bash tool will ever get, and the realm awaiting it is coming back. It gives
// up only when the server shuts down.
func (e engineRecipient) awaitEngine(shellID string, held []shellOutputFrame) {
	jlog.Info("[shell] %s: no engine attached to take its output — holding %d frame(s) until one is", shellID, len(held))
	tick := time.NewTicker(engineRedeliveryInterval)
	defer tick.Stop()
	for len(held) > 0 {
		select {
		case <-e.s.ShutdownChan():
			jlog.Info("[shell] %s: server shutting down with %d frame(s) undelivered", shellID, len(held))
			return
		case <-tick.C:
			held = deliverInOrder(e, held)
		}
	}
	jlog.Info("[shell] %s: held output delivered to the reattached engine", shellID)
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
		// carrying the reason, so the engine's shellStreaming settles with
		// the refusal instead of sitting at `running` until its safety timeout.
		requester.Send(shellRefusedFrame(req.ShellID, err.Error()))
		return
	}

	// Create output channel for streaming chunks
	outputChan := make(chan ops.ShellStreamChunk, 100)

	// Start streaming execution; the workspace closes the channel when it is over.
	go ws.StreamShell(ctx, workspace.ShellRequest{
		ShellID: req.ShellID, ConvID: req.ConvId, ThreadID: req.ThreadId, ToolUseID: req.ToolUseId,
		Command: req.Command, Cwd: req.Cwd, TimeoutMs: req.Timeout,
	}, outputChan)

	// Forward chunks to the requester (see processShellRequest for why not the
	// viewer group). Status chunks (awaiting-permission / running) explain why
	// a silent command is still running; a done chunk carries its exit, and the
	// spill accounting when the output was spilled (shellOutputFrameOf).
	engine, toEngine := requester.(engineRecipient)
	var held []shellOutputFrame
	for chunk := range outputChan {
		if !toEngine {
			// A viewer that has gone does not come back to this shell.
			requester.Send(shellOutputFrameOf(chunk))
			continue
		}
		held = deliverInOrder(engine, append(held, shellOutputFrameOf(chunk)))
	}
	if len(held) > 0 {
		engine.awaitEngine(req.ShellID, held)
	}
}

// WebSocketWriter wraps server viewer broadcasting to implement io.Writer
// for streaming chunks to all viewers.

// streamMessageToWebSocketWithAgent processes a message with streaming and sends chunks via WebSocket
