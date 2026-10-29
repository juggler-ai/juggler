//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// clientHub is the process-scoped actor that owns the set of all connected
// WebSocket clients. Use it for full-fleet broadcasts (
// providers-update, session-changed, shutdown notices) — anything that
// needs to reach engine and every viewer regardless of project.
//
// Delivery is per-client and asynchronous: each registered client owns a
// mailbox.Mailbox, so the actor hands a broadcast off in one goroutine hop and
// a client that has stopped draining delays nobody but itself (see
// cmd/juggler/mailbox). The single exception is the shutdown notice, which is
// sent inline for the reason recorded at that site.

package server

import "juggler/cmd/juggler/mailbox"

type hubOpKind int

const (
	hubRegister hubOpKind = iota
	hubReserve
	hubUnregister
	hubBroadcast
	hubViewerCount
	hubViewerList
	hubShutdown

	// maxViewerClients is a deliberately generous guardrail for a desktop server.
	// The hidden engine is not a viewer and does not consume one of these slots.
	maxViewerClients = 32
)

type hubOp struct {
	kind       hubOpKind
	client     RealtimeClient
	msg        any
	doneCh     chan struct{}
	boolResult chan bool
	intResult  chan int
	listResult chan []clientDescriptor
}

// clientDescriptor is the wire shape of one connected viewer, sent to the other
// viewers (via clients-changed and GET /api/connectivity) so the UI can list who
// shares the session. The id lets each recipient exclude itself; the viewer id,
// when the client supplied one, is how a viewer that holds another's identity
// can tell whether it is still connected. The owner, set on a detached pinboard
// window, names the viewer it was popped out of — so the UI can count it as part
// of that window rather than as another client.
type clientDescriptor struct {
	ID            string `json:"id"`
	ViewerID      string `json:"viewerId,omitempty"`
	OwnerViewerID string `json:"ownerViewerId,omitempty"`
	Origin        string `json:"origin"`
	Detail        string `json:"detail"`
	Name          string `json:"name,omitempty"`
	UserAgent     string `json:"userAgent"`
	ConnectedAt   int64  `json:"connectedAt"`
}

type clientHub struct {
	ch chan hubOp
}

func newClientHub() *clientHub {
	h := &clientHub{ch: make(chan hubOp, 64)}
	go h.run()
	return h
}

// hubClient is one registered client and its outbound pipeline. The client
// itself is kept because the hub reports on it (role and display info feed
// clients-changed and GET /api/connectivity); the mailbox is how anything
// actually reaches it. Everything the hub sends goes through mb — a client's
// Send blocks while its send buffer is full, and calling it from the actor
// loop would stall every other client behind the slowest one.
type hubClient struct {
	c  RealtimeClient
	mb *mailbox.Mailbox[outboundMsg]
}

func (h *clientHub) run() {
	clients := make(map[string]hubClient)
	// reserved holds the viewer slots granted by reserve to clients not yet
	// registered. They count toward the limit, so a slot promised to one
	// arrival cannot be taken by another before it registers.
	reserved := make(map[string]bool)

	// remove drops a client and releases its delivery goroutines. Undelivered
	// messages go with it, which is right for a client that has left.
	remove := func(id string) {
		if hc, ok := clients[id]; ok {
			hc.mb.Stop()
			delete(clients, id)
		}
	}

	// viewerDescriptors returns one descriptor per connected user-facing (viewer)
	// client. The engine's hidden headless browser is not a viewer and is omitted.
	viewerDescriptors := func() []clientDescriptor {
		list := make([]clientDescriptor, 0, len(clients))
		for _, hc := range clients {
			if hc.c.ClientRole() != ClientRoleViewer {
				continue
			}
			info := hc.c.ClientInfo()
			list = append(list, clientDescriptor{
				ID:            hc.c.ClientID(),
				ViewerID:      hc.c.ViewerID(),
				OwnerViewerID: info.Owner,
				Origin:        info.Origin,
				Detail:        info.Detail,
				Name:          info.Name,
				UserAgent:     info.UserAgent,
				ConnectedAt:   info.ConnectedAt,
			})
		}
		return list
	}

	// broadcastViewers tells every viewer who is now connected, so each can show
	// how many OTHER clients share the session and describe them. Sent only to
	// viewers; the engine ignores it.
	broadcastViewers := func() {
		list := viewerDescriptors()
		msg := clientsChangedFrame{Type: frameClientsChanged, Count: len(list), Clients: list}
		for _, hc := range clients {
			if hc.c.ClientRole() == ClientRoleViewer {
				hc.mb.Enqueue(outboundMsg{json: msg})
			}
		}
	}

	for op := range h.ch {
		switch op.kind {
		case hubReserve:
			id := op.client.ClientID()
			_, replacing := clients[id]
			if op.client.ClientRole() != ClientRoleViewer || replacing || reserved[id] {
				op.boolResult <- true
				continue
			}
			if len(viewerDescriptors())+len(reserved) >= maxViewerClients {
				op.boolResult <- false
				continue
			}
			reserved[id] = true
			op.boolResult <- true
		case hubRegister:
			id := op.client.ClientID()
			_, replacing := clients[id]
			held := reserved[id]
			delete(reserved, id)
			if op.client.ClientRole() == ClientRoleViewer && !replacing && !held &&
				len(viewerDescriptors())+len(reserved) >= maxViewerClients {
				op.boolResult <- false
				continue
			}
			// A re-register under a live id replaces the entry, so the old
			// pipeline is stopped rather than orphaned with its goroutines.
			remove(id)
			clients[id] = hubClient{c: op.client, mb: newClientMailbox(op.client)}
			if op.client.ClientRole() == ClientRoleViewer {
				broadcastViewers()
			}
			op.boolResult <- true
		case hubUnregister:
			id := op.client.ClientID()
			delete(reserved, id)
			if _, ok := clients[id]; ok {
				remove(id)
				if op.client.ClientRole() == ClientRoleViewer {
					broadcastViewers()
				}
			}
		case hubBroadcast:
			for _, hc := range clients {
				hc.mb.Enqueue(outboundMsg{json: op.msg})
			}
		case hubViewerCount:
			op.intResult <- len(viewerDescriptors())
		case hubViewerList:
			op.listResult <- viewerDescriptors()
		case hubShutdown:
			shutdownMsg := messageFrame{Type: frameServerShutdown, Message: "Server is shutting down"}
			for _, hc := range clients {
				// Sent inline, and deliberately not through the mailbox: the
				// notice exists to be read on the way out, and the ordering with
				// the Close below is what makes that work — writePump flushes
				// what is already queued when it sees the close. Enqueuing makes
				// the hand-off asynchronous, so the Close can land first and the
				// client goes down without ever hearing why. The stall a wedged
				// client can cause here reaches only teardown, which is bounded
				// by serverShutdownTimeout / quitGraceTimeout.
				hc.mb.Stop()
				hc.c.Send(shutdownMsg)
				hc.c.Close()
			}
			close(op.doneCh)
			return
		}
	}
}

// reserve holds a viewer slot for a client about to register, or reports that
// the viewer limit leaves none. It records nothing else and tells no one, so a
// caller can greet an admitted client before registering it (and announcing it
// to the others), and send a refused one nothing that implies a session.
// Engine clients, and a client already registered under its id, always pass.
func (h *clientHub) reserve(c RealtimeClient) bool {
	r := make(chan bool, 1)
	h.ch <- hubOp{kind: hubReserve, client: c, boolResult: r}
	return <-r
}

// register atomically admits and records a client. Viewer admission fails once
// the process-wide viewer limit is reached; engine clients are always admitted.
func (h *clientHub) register(c RealtimeClient) bool {
	r := make(chan bool, 1)
	h.ch <- hubOp{kind: hubRegister, client: c, boolResult: r}
	return <-r
}

func (h *clientHub) unregister(c RealtimeClient) { h.ch <- hubOp{kind: hubUnregister, client: c} }
func (h *clientHub) broadcast(msg any)           { h.ch <- hubOp{kind: hubBroadcast, msg: msg} }

// viewerCount returns the number of connected viewer (user-facing) clients,
// excluding the engine's hidden headless browser.
func (h *clientHub) viewerCount() int {
	r := make(chan int, 1)
	h.ch <- hubOp{kind: hubViewerCount, intResult: r}
	return <-r
}

// viewerClients returns a descriptor for each connected viewer client, for the
// connected-clients UI. Excludes the engine's hidden headless browser.
func (h *clientHub) viewerClients() []clientDescriptor {
	r := make(chan []clientDescriptor, 1)
	h.ch <- hubOp{kind: hubViewerList, listResult: r}
	return <-r
}

func (h *clientHub) shutdown() {
	done := make(chan struct{})
	h.ch <- hubOp{kind: hubShutdown, doneCh: done}
	<-done
}
