//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// viewerGroup is the actor that owns the set of viewer-role clients plus the
// per-conversation request-cancel and per-shell-cancel maps. When the last
// viewer leaves, all in-flight requests and shells are cancelled.

package server

import (
	"context"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/mailbox"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/workspace"
)

type viewerOpKind int

const (
	vgJoin viewerOpKind = iota
	vgLeave
	vgSendToAll
	vgSendRawToAll
	vgSendToViewer
	vgStartRequest
	vgCompleteRequest
	vgCancelRequest
	vgStartShell
	vgCompleteShell
	vgCancelShell
	vgStop
)

type viewerOp struct {
	kind       viewerOpKind
	sender     Sender
	clientID   string
	viewerID   string
	msg        any
	raw        []byte
	convID     string
	shellID    string
	cancel     context.CancelFunc
	engine     bool // a shell the engine started (see shellEntry)
	boolResult chan bool
	intResult  chan int
}

type viewerGroup struct {
	ch chan viewerOp
}

func newViewerGroup() *viewerGroup {
	g := &viewerGroup{ch: make(chan viewerOp, 64)}
	go g.run()
	return g
}

// outboundMsg is one queued broadcast for a single client: either a JSON
// value or raw bytes. Mirrors wsMessage but stays local to the mailbox so
// the mailbox works with any Sender, not just *WSClient.
type outboundMsg struct {
	json any
	raw  []byte
}

// viewerEntry is one joined viewer: the identity it named itself by (empty when
// it named none, which addresses nothing) and its ordered delivery pipeline.
type viewerEntry struct {
	viewerID string
	mb       *mailbox.Mailbox[outboundMsg]
}

// newClientMailbox builds one client's ordered delivery pipeline
// (mailbox.Mailbox — never blocks the actor that enqueues, preserves enqueue
// order). Both the viewerGroup and the clientHub fan out through it.
// Streaming consumers depend on that ordering: a viewer's live
// engine-bridge/action-progress chunks must arrive in order, or a later
// snapshot is overtaken by an earlier one and the panel shows stale output.
// Foreground bash output does not ride the viewer group — shell-output goes
// straight to the requesting engine; see processShellRequest. The delivery
// goroutine is the only caller of the (possibly blocking) Sender; Stop discards
// anything undelivered, which the departed client could no longer receive anyway.
func newClientMailbox(sender Sender) *mailbox.Mailbox[outboundMsg] {
	return mailbox.NewMailbox(func(v outboundMsg) {
		if v.raw != nil {
			sender.SendRaw(v.raw)
		} else {
			sender.Send(v.json)
		}
	})
}

// shellEntry is one running streaming shell. engine marks one the engine
// started: the engine is the only client that comes back to the same realm
// after losing its socket, still awaiting the command, so its shells are not
// swept when the group empties — only when the group itself stops.
type shellEntry struct {
	cancel context.CancelFunc
	engine bool
}

func (g *viewerGroup) run() {
	clients := make(map[string]viewerEntry)
	requests := make(map[string]context.CancelFunc)
	shells := make(map[string]shellEntry)

	// Fan a message out to every connection presenting the given viewer id. It is
	// normally one, but a duplicated tab can carry a copied id, and delivering to
	// both is a harmless duplicate where picking one would be a coin toss.
	sendToViewer := func(viewerID string, msg any) {
		if viewerID == "" {
			return
		}
		for _, e := range clients {
			if e.viewerID == viewerID {
				e.mb.Enqueue(outboundMsg{json: msg})
			}
		}
	}

	// cancelAll cancels every request and shell; withEngineShells false spares
	// the engine's (see shellEntry).
	cancelAll := func(withEngineShells bool) {
		for id, cancel := range requests {
			cancel()
			delete(requests, id)
		}
		for id, sh := range shells {
			if sh.engine && !withEngineShells {
				continue
			}
			sh.cancel()
			delete(shells, id)
		}
	}

	for op := range g.ch {
		switch op.kind {
		case vgJoin:
			clients[op.clientID] = viewerEntry{viewerID: op.viewerID, mb: newClientMailbox(op.sender)}

		case vgLeave:
			if e, ok := clients[op.clientID]; ok {
				e.mb.Stop()
			}
			delete(clients, op.clientID)
			remaining := len(clients)
			if remaining == 0 {
				cancelAll(false)
			}
			if op.intResult != nil {
				op.intResult <- remaining
			}

		case vgSendToAll:
			for _, e := range clients {
				e.mb.Enqueue(outboundMsg{json: op.msg})
			}

		case vgSendRawToAll:
			for _, e := range clients {
				e.mb.Enqueue(outboundMsg{raw: op.raw})
			}

		case vgSendToViewer:
			sendToViewer(op.viewerID, op.msg)

		case vgStartRequest:
			if _, exists := requests[op.convID]; exists {
				op.boolResult <- false
			} else {
				requests[op.convID] = op.cancel
				op.boolResult <- true
			}

		case vgCompleteRequest:
			delete(requests, op.convID)

		case vgCancelRequest:
			cancel, exists := requests[op.convID]
			if exists {
				cancel()
				delete(requests, op.convID)
			}
			op.boolResult <- exists

		case vgStartShell:
			if _, exists := shells[op.shellID]; exists {
				op.boolResult <- false
			} else {
				shells[op.shellID] = shellEntry{cancel: op.cancel, engine: op.engine}
				op.boolResult <- true
			}

		case vgCompleteShell:
			delete(shells, op.shellID)

		case vgCancelShell:
			sh, exists := shells[op.shellID]
			if exists {
				sh.cancel()
				delete(shells, op.shellID)
			}
			op.boolResult <- exists

		case vgStop:
			for _, e := range clients {
				e.mb.Stop()
			}
			cancelAll(true)
			return
		}
	}
}

func (g *viewerGroup) join(c RealtimeClient) {
	g.ch <- viewerOp{kind: vgJoin, sender: c, clientID: c.ClientID(), viewerID: c.ViewerID()}
}

func (g *viewerGroup) leave(id string)         { g.ch <- viewerOp{kind: vgLeave, clientID: id} }
func (g *viewerGroup) sendToAll(msg any)       { g.ch <- viewerOp{kind: vgSendToAll, msg: msg} }
func (g *viewerGroup) sendRawToAll(raw []byte) { g.ch <- viewerOp{kind: vgSendRawToAll, raw: raw} }
func (g *viewerGroup) sendToViewer(viewerID string, msg any) {
	g.ch <- viewerOp{kind: vgSendToViewer, viewerID: viewerID, msg: msg}
}
func (g *viewerGroup) completeRequest(id string) {
	g.ch <- viewerOp{kind: vgCompleteRequest, convID: id}
}
func (g *viewerGroup) completeShell(id string) { g.ch <- viewerOp{kind: vgCompleteShell, shellID: id} }

func (g *viewerGroup) startRequest(convID string, cancel context.CancelFunc) bool {
	r := make(chan bool, 1)
	g.ch <- viewerOp{kind: vgStartRequest, convID: convID, cancel: cancel, boolResult: r}
	return <-r
}

func (g *viewerGroup) cancelRequest(convID string) bool {
	r := make(chan bool, 1)
	g.ch <- viewerOp{kind: vgCancelRequest, convID: convID, boolResult: r}
	return <-r
}

func (g *viewerGroup) startShell(shellID string, cancel context.CancelFunc, engine bool) bool {
	r := make(chan bool, 1)
	g.ch <- viewerOp{kind: vgStartShell, shellID: shellID, cancel: cancel, engine: engine, boolResult: r}
	return <-r
}

func (g *viewerGroup) cancelShell(shellID string) bool {
	r := make(chan bool, 1)
	g.ch <- viewerOp{kind: vgCancelShell, shellID: shellID, boolResult: r}
	return <-r
}

// stop cancels all pending requests and shells then exits the actor goroutine.
// Used when a projectState that owns this group is being torn down.
func (g *viewerGroup) stop() {
	g.ch <- viewerOp{kind: vgStop}
}

// =============================================================================
// Server-scoped wrappers around the per-project viewerGroup actor.
//
// These resolve the current project's viewer group and forward operations.
// Kept next to the actor so the broadcast/tracking surface lives in one file.
// =============================================================================

// viewers resolves the current project's viewer group. Always non-nil after
// seedProjectState/SwitchProject have run.
func (s *Server) viewers() *viewerGroup {
	st := s.projectState.Load()
	if st == nil {
		return nil
	}
	return st.viewers
}

// joinViewerGroup adds a viewer client to the current project's viewer group.
func (s *Server) joinViewerGroup(client RealtimeClient) {
	if g := s.viewers(); g != nil {
		g.join(client)
	}
}

// leaveViewerGroup removes a viewer client and cancels in-flight work if no
// viewers remain in the project.
func (s *Server) leaveViewerGroup(clientID string) {
	if g := s.viewers(); g != nil {
		g.leave(clientID)
	}
}

// registerClient atomically admits a client to the process-scoped client hub.
func (s *Server) registerClient(client RealtimeClient) bool { return s.hub.register(client) }

// reserveClientSlot holds a viewer slot for a client about to register; false
// when the viewer limit is reached (see clientHub.reserve).
func (s *Server) reserveClientSlot(client RealtimeClient) bool { return s.hub.reserve(client) }

// unregisterClient removes a client from the process-scoped client hub.
//
// A viewer leaving empty-handed is told to the session: with no window left,
// nothing can be provisioning a workspace, so a row still claiming to be is the
// wreck of a provision that went with the window — a reloaded tab, most often,
// which the load-time sweep never sees because the server never restarted.
func (s *Server) unregisterClient(client RealtimeClient) {
	s.hub.unregister(client)
	if client.ClientRole() != ClientRoleViewer {
		return
	}
	// viewerCount synchronizes with the hub actor, so the unregister above has
	// landed by the time it answers.
	if s.hub.viewerCount() == 0 {
		if mgr := s.SessionManager(); mgr != nil {
			mgr.WorkspacesUnwatched()
		}
	}
}

// broadcastToAll sends a message to every connected WebSocket client.
//
// A Server assembled without a hub — a bare one built to exercise a single
// handler — has no clients, so there is nothing to send. A handler that publishes
// its change is then exercised for what it returns and what it stored, and the
// publishing itself is covered where it can be observed: over real sockets.
func (s *Server) broadcastToAll(msg any) {
	if s.hub == nil {
		return
	}
	s.hub.broadcast(msg)
}

// serverBroadcaster adapts *Server to the handlers.Broadcaster interface so
// HTTP handlers can publish session-changed without depending on the full
// Server type.
type serverBroadcaster struct {
	srv *Server
}

// BroadcastSessionChanged signals viewers that session-level metadata
// (messageHistory, metadata flags) was updated via PUT /session. This is
// the ONLY thing it's for — any conversation-list mutation must go
// through BroadcastConversationsChanged, never here.
func (b serverBroadcaster) BroadcastSessionChanged() {
	b.srv.broadcastToAll(bareFrame{Type: frameSessionChanged})
}

// BroadcastSessionMetadataChanged publishes a targeted metadata patch. Unlike
// session-changed, clients can apply this without refetching the full session.
func (b serverBroadcaster) BroadcastSessionMetadataChanged(metadata map[string]any) {
	b.srv.broadcastToAll(sessionMetadataChangedFrame{Type: frameSessionMetadataChanged, Metadata: metadata})
}

// BroadcastWorkspacesChanged publishes the whole workspace table after an edit,
// so every viewer converges on it — and so a window that is only watching sees a
// workspace appear, become usable, and be finished with, without asking.
func (b serverBroadcaster) BroadcastWorkspacesChanged(workspaces []workspace.Row) {
	b.srv.broadcastToAll(workspacesChangedFrame{Type: frameWorkspacesChanged, Workspaces: workspaces})
}

// BroadcastPinboardChanged publishes one board's whole composition after an
// edit, so every viewer of that board converges on it without replaying
// operations.
//
// Sent to everyone rather than to the viewers of that board, because the server
// does not know who they are: which board a document reads is in its URL and is
// never reported back. Naming the board is what lets a viewer of another one
// ignore it, and the frame is small enough that this is cheaper than tracking
// the answer would be.
func (b serverBroadcaster) BroadcastPinboardChanged(board string, pins []core.Pin) {
	b.srv.broadcastToAll(pinboardChangedFrame{Type: framePinboardChanged, Board: board, Pins: pins})
}

// BroadcastPinboardReveal asks viewers to open one board on one pin. The request
// is advisory: from identifies the conversation that made it, and each viewer
// decides whether following it would interrupt unrelated work or a draft.
func (b serverBroadcaster) BroadcastPinboardReveal(board, pin, from string) {
	b.srv.broadcastToAll(pinboardRevealFrame{Type: framePinboardReveal, Board: board, Pin: pin, From: from})
}

// BroadcastConversationsChanged publishes a single op-tagged
// conversation-list diff. `op` is one of "created", "deleted",
// "renamed", "binned", "restored", "binned-deleted", "bin-emptied",
// "naming-started", "naming-ended" (the auto-namer working on a tab).
// `name` is the canonical folder name; included on the wire only when
// non-empty (created / renamed / restored).
func (b serverBroadcaster) BroadcastConversationsChanged(op, id, name string) {
	b.srv.broadcastToAll(conversationsChangedFrame{Type: frameConversationsChanged, Op: op, ID: id, Name: name})
}

// BroadcastConversationFocus asks viewers to switch to a conversation. Rides
// the same `conversations-changed` event type with `op:"focus"`; `from` names
// the conversation that requested the switch and is included on the wire only
// when non-empty (an unattributed request every viewer follows).
func (b serverBroadcaster) BroadcastConversationFocus(id, from string) {
	b.srv.broadcastToAll(conversationsChangedFrame{Type: frameConversationsChanged, Op: "focus", ID: id, From: from})
}

// BroadcastNotice publishes a short, human-readable message for every viewer to
// show as a transient toast. It is for background work the user never asked for
// and cannot see failing — an out-of-band auto-name giving up, say — so it
// carries no id and demands no response; anything the user must act on belongs
// in the conversation, not here. The frame carries the English as `message`
// and the message itself as `text`, for the client to show translated.
func (b serverBroadcaster) BroadcastNotice(m msg.Message) {
	b.srv.broadcastToAll(textFrame{Type: frameNotice, Message: m.English(), Text: m})
}

// BroadcastConversationsReordered publishes a drag-reorder as the full new
// id order. Rides the same `conversations-changed` event type with
// `op:"reordered"` and an `order` array carrying the post-reorder ids in
// display order.
func (b serverBroadcaster) BroadcastConversationsReordered(order []string) {
	b.srv.broadcastToAll(conversationsReorderedFrame{Type: frameConversationsChanged, Op: "reordered", Order: order})
}

// shutdownAllClients sends shutdown notice to all clients and waits for completion.
func (s *Server) shutdownAllClients() { s.hub.shutdown() }

// viewerSendToAll broadcasts a JSON message to all viewers in the current project.
func (s *Server) viewerSendToAll(msg any) {
	if g := s.viewers(); g != nil {
		g.sendToAll(msg)
	}
}

// viewerSendRawToAll broadcasts raw bytes to all viewers in the current project.
func (s *Server) viewerSendRawToAll(data []byte) {
	if g := s.viewers(); g != nil {
		g.sendRawToAll(data)
	}
}

// viewerSendToViewer delivers a message to the viewers in the current project
// presenting viewerID. An empty or unmatched id reaches nobody: this addresses,
// it does not broadcast, and there is no queue for a viewer that is not here.
func (s *Server) viewerSendToViewer(viewerID string, msg any) {
	if g := s.viewers(); g != nil {
		g.sendToViewer(viewerID, msg)
	}
}

// viewerStartRequest registers an active LLM request for a conversation.
// Returns false if the conversation already has an active request.
func (s *Server) viewerStartRequest(convID string, cancel context.CancelFunc) bool {
	if g := s.viewers(); g != nil {
		return g.startRequest(convID, cancel)
	}
	return false
}

// viewerCompleteRequest removes tracking for a completed request.
func (s *Server) viewerCompleteRequest(convID string) {
	if g := s.viewers(); g != nil {
		g.completeRequest(convID)
	}
}

// viewerCancelRequest cancels an active request and removes tracking.
// Returns true if the request existed.
func (s *Server) viewerCancelRequest(convID string) bool {
	if g := s.viewers(); g != nil {
		return g.cancelRequest(convID)
	}
	return false
}

// viewerStartShell registers an active shell execution.
// Returns false if the shell ID is already active.
func (s *Server) viewerStartShell(shellID string, cancel context.CancelFunc) bool {
	if g := s.viewers(); g != nil {
		return g.startShell(shellID, cancel, false)
	}
	return false
}

// viewerStartEngineShell is viewerStartShell for a shell the engine started,
// which the group spares when it empties (see shellEntry).
func (s *Server) viewerStartEngineShell(shellID string, cancel context.CancelFunc) bool {
	if g := s.viewers(); g != nil {
		return g.startShell(shellID, cancel, true)
	}
	return false
}

// viewerCompleteShell removes tracking for a completed shell.
func (s *Server) viewerCompleteShell(shellID string) {
	if g := s.viewers(); g != nil {
		g.completeShell(shellID)
	}
}

// viewerCancelShell cancels an active shell and removes tracking.
// Returns true if the shell existed.
func (s *Server) viewerCancelShell(shellID string) bool {
	if g := s.viewers(); g != nil {
		return g.cancelShell(shellID)
	}
	return false
}
