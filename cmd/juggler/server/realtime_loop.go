//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/worker"
	"juggler/internal/jlog"
)

// ClientInfo is descriptive metadata about a connected client, captured once at
// connect time, so the OTHER clients sharing the session can be shown who is
// connected and how. Purely presentational — nothing keys off it.
type ClientInfo struct {
	Origin      string // "local" (same machine), "lan", or "remote"
	Detail      string // LAN IP, or the remote transport label; empty for local
	Name        string // who a remote caller is, as its transport named it; usually empty
	UserAgent   string // raw User-Agent, when the transport carried one
	ConnectedAt int64  // connection time, unix milliseconds
	Owner       string // viewer id of the window a detached pinboard belongs to; empty for a window of its own
}

// RealtimeClient is the transport-independent server-side client surface used
// by the WebSocket protocol.
type RealtimeClient interface {
	Sender
	Close()
	ClientID() string
	ClientRole() ClientRole
	ClientInfo() ClientInfo
	// ViewerID is the identity the viewer chose for itself and kept across
	// reloads, as opposed to ClientID, which the server mints per connection.
	// Empty when the client did not supply one, and an empty id addresses
	// nothing (see viewerSendToViewer).
	ViewerID() string
}

// runRealtimeClientLoop runs the WS message protocol on top of any
// ordered, reliable text transport. msgCh carries raw inbound JSON text frames;
// done is closed when the transport reader ends.
func (s *Server) runRealtimeClientLoop(ctx context.Context, client RealtimeClient, msgCh <-chan []byte, done <-chan struct{}) {
	role := client.ClientRole()

	// Track engine client and register on worker manager.
	if role == ClientRoleEngine {
		if wsClient, ok := client.(*WSClient); ok {
			s.engineClient.Store(wsClient)
		}
		// A connection that has just been opened is proof the realm was running a
		// moment ago: seed the liveness stamp so the first heartbeat has a window
		// to arrive in, and re-arm the silence report for this incarnation.
		s.noteEngineAlive()
		s.engineSilenceReported.Store(false)
		// Counted separately from the liveness stamp above: that one says the
		// engine is here, this one notices how often it has had to say so.
		s.noteEngineAttached()
		s.workerManager.SetEngineClient(client.ClientID(), func(convID string, msg []byte) {
			envelope := worker.FormatWorkerMessage(convID, msg)
			if envelope != nil {
				client.SendRaw(envelope)
			}
		})
		jlog.Debug("Internal browser connected")
		defer func() {
			s.workerManager.ClearEngineClient(client.ClientID())
			if wsClient, ok := client.(*WSClient); ok && s.engineClient.CompareAndSwap(wsClient, nil) {
				jlog.Debug("Internal browser disconnected")
			}
		}()
	}

	// Hold this client's place under the viewer limit before telling it anything.
	// A client sent its session starts loading the app, so one the limit turns
	// away is told only that, and closed.
	if !s.reserveClientSlot(client) {
		client.Send(messageFrame{Type: frameServerFull, Message: "Too many clients are connected"})
		client.Close()
		return
	}

	// Send session ready signal to client. It carries the client's own
	// server-assigned id so the UI can exclude itself from the connected-clients
	// list it receives via clients-changed, and this instance's boot id so a
	// client that reconnects can tell a link blip (same id — catch up with a Yjs
	// state-vector resync) from a restarted server (different id — the page's
	// token and asset URLs belong to a process that is gone, so it must reload).
	// The viewer id is echoed back as the server accepted it, which is empty when
	// the client sent nothing usable — so a viewer can tell whether anything can
	// address it before it hands its id to another viewer.
	client.Send(sessionFrame{Type: frameSession, ClientID: client.ClientID(), ViewerID: client.ViewerID(), BootID: s.bootID})

	// Register with server state for broadcasts. Done AFTER the session send so
	// the client already knows its own id before the first clients-changed
	// broadcast (which registering triggers) can reach it. The slot reserved
	// above makes this admission certain; a refusal would be the hub
	// contradicting its own reservation, and the client is closed rather than
	// half served.
	if !s.registerClient(client) {
		client.Close()
		return
	}
	defer s.unregisterClient(client)

	// Seed providers snapshot. `ready` is false until the first refresh has
	// computed real availability, so clients don't mistake the empty/stale connect
	// seed for a settled "no providers configured" result.
	client.Send(providersUpdateFrame{Type: frameProvidersUpdate, Providers: s.cachedProviders(), Ready: s.providersReadyNow()})

	// Join viewer group for multi-view broadcasting.
	s.joinViewerGroup(client)
	defer s.leaveViewerGroup(client.ClientID())

	clientCtx, cancelClient := context.WithCancel(ctx)
	defer cancelClient()

	shellStartChan := make(chan ShellStartRequest, 100)
	shellCancelChan := make(chan string, 100)
	shellCompleteChan := make(chan string, 100)

	// Watch the link itself: beat when it goes quiet, and close a viewer that has
	// gone quiet in the other direction (see link_liveness.go). Owned by this
	// goroutine, which is the only one that touches it.
	link := newLinkSupervisor(s, client)
	linkTick := time.NewTicker(s.linkCheckInterval())
	defer linkTick.Stop()

	for {
		select {
		case <-linkTick.C:
			link.tick()

		case <-done:
			if s.workerManager != nil {
				s.workerManager.ClientDisconnected(client.ClientID())
			}
			return

		case msgBytes, ok := <-msgCh:
			if !ok {
				if s.workerManager != nil {
					s.workerManager.ClientDisconnected(client.ClientID())
				}
				return
			}
			var generic GenericWSMessage
			if err := json.Unmarshal(msgBytes, &generic); err != nil {
				jlog.Error("Realtime: failed to parse message: %v", err)
				continue
			}

			s.stats.record(statsIn, msgBytes, role)

			// Anything at all arriving proves the link still carries traffic, so the
			// beat below only covers a client with nothing else to say.
			link.noteInbound()

			// Who may send what is decided here, once, from inboundFrameRoles —
			// never inside a case below.
			if known, allowed := inboundFrameAllowed(frameType(generic.Type), role); !known {
				jlog.Error("Realtime: unrecognized message type %q", generic.Type)
				continue
			} else if !allowed {
				jlog.Info("Realtime: refused %q from a %s client %s (%s)", generic.Type, role, client.ClientID(), client.ClientInfo().Origin)
				continue
			}

			// Engine traffic refreshes the liveness stamp: a message the engine
			// composed is proof that the realm which composes messages is running.
			// See engineTrafficProvesLiveness for the one message that is exempt.
			if role == ClientRoleEngine && engineTrafficProvesLiveness(generic) {
				s.noteEngineAlive()
			}

			switch frameType(generic.Type) {
			case frameEngineHeartbeat:
				// Liveness only; the stamp above is the whole effect. Sent from the
				// engine's module worker, the realm that must be running for a tool to
				// execute, so it cannot be answered by a transport whose page has
				// stopped (see engine_liveness.go).

			case frameViewerHeartbeat:
				// Liveness only, same as above: a viewer saying it is still there on a
				// link that has carried nothing else (see link_liveness.go).

			case frameViewerFault:
				fault, ok := unmarshalWS[ViewerFault](msgBytes, "viewer-fault")
				if !ok {
					continue
				}
				// Logged at Error because it is one: a viewer that threw rendered
				// something wrong or stopped rendering, and the page has no other way
				// to say so — its console cannot be opened in a release build.
				jlog.Error("[viewer-fault] %s: %s%s%s\n%s",
					fault.Source, fault.Message,
					labelled(" conv=", fault.ConvID),
					labelled(" detail=", fault.Detail),
					fault.Stack)

			case frameShellStart:
				shellReq, ok := unmarshalWS[ShellStartRequest](msgBytes, "shell-start")
				if !ok {
					continue
				}
				select {
				case shellStartChan <- shellReq:
				default:
					jlog.Error("Realtime: shell-start channel full, dropping")
				}

			case frameShellCancel:
				shellCancel, ok := unmarshalWS[ShellCancelRequest](msgBytes, "shell-cancel")
				if !ok {
					continue
				}
				select {
				case shellCancelChan <- shellCancel.ShellID:
				default:
				}

			case frameEngineBridge:
				s.viewerSendRawToAll(msgBytes)

			case frameViewerRelay:
				relay, ok := unmarshalWS[ViewerRelay](msgBytes, "viewer-relay")
				if !ok {
					continue
				}
				// `from` is the sending connection's own id rather than anything in
				// the message, so a relay always says truthfully who sent it.
				s.viewerSendToViewer(relay.To, viewerRelayFrame{Type: frameViewerRelay, From: client.ViewerID(), Payload: relay.Payload})

			case frameOneShotResult:
				res, ok := unmarshalWS[OneShotResult](msgBytes, "one-shot-result")
				if !ok {
					continue
				}
				s.oneShot.deliver(res)

			case frameSessionChanged:
				s.broadcastToAll(bareFrame{Type: frameSessionChanged})

			case frameWorkerMessage:
				if s.workerManager == nil {
					continue
				}
				wm, ok := unmarshalWS[worker.WorkerMessage](msgBytes, "worker-message")
				if !ok {
					continue
				}
				convID := wm.ConversationID
				sendCallback := func(msg []byte) {
					envelope := worker.FormatWorkerMessage(convID, msg)
					if envelope != nil {
						client.SendRaw(envelope)
					}
				}
				if !s.workerManager.HandleMessageWithClient(wm.ConversationID, client.ClientID(), wm.WorkerMsgType, wm.Payload, sendCallback) {
					// The manager declined to create a worker for this id: it
					// is binned, or its folder is gone. No worker exists to
					// answer, so say so — a client that sent an init is waiting
					// on a "ready" that is never coming, and silence leaves it
					// on a spinner until its own timeout expires.
					if payload, err := json.Marshal(conversationGoneFrame()); err == nil {
						sendCallback(payload)
					}
				}

			}

		case shellID := <-shellCancelChan:
			if s.viewerCancelShell(shellID) {
				jlog.Info("Cancelled shell: %s", shellID)
			} else {
				// Not necessarily a bug (the shell may have completed just as the
				// cancel arrived), but never swallow it silently: a cancel that
				// misses a still-running shell orphans its process until timeout.
				jlog.Info("shell-cancel for %s matched no active shell (completed already, or tracking lost)", shellID)
			}

		case shellID := <-shellCompleteChan:
			// Diagnostic for the "tool stuck in running" wedge: pairs with the
			// shell-start line below (match on shellID) so a hung bash shows up as
			// a shell-start with no matching shell-complete.
			jlog.Debug("Shell complete: shellID=%s", shellID)
			s.viewerCompleteShell(shellID)

		case shellReq := <-shellStartChan:
			jlog.Debug("Shell start: shellID=%s", shellReq.ShellID)
			// A viewer's shell is this connection's: it ends with it, and its
			// output goes to it. The engine's outlives it (see engineRecipient):
			// the server's lifetime bounds it, its output follows the engine to
			// whichever connection it has, and it records its own completion,
			// since this loop may be gone by then.
			var (
				ctx      context.Context
				cancel   context.CancelFunc
				started  bool
				to       Sender = client
				complete        = func(id string) {
					select {
					case shellCompleteChan <- id:
					default:
					}
				}
			)
			if role == ClientRoleEngine {
				ctx, cancel = s.serverLifetimeContext()
				started = s.viewerStartEngineShell(shellReq.ShellID, cancel)
				to = engineRecipient{s}
				complete = func(id string) {
					jlog.Debug("Shell complete: shellID=%s", id)
					s.viewerCompleteShell(id)
				}
			} else {
				ctx, cancel = context.WithCancel(clientCtx)
				started = s.viewerStartShell(shellReq.ShellID, cancel)
			}
			if !started {
				cancel()
				jlog.Error("Shell start REJECTED (ID already in use): shellID=%s", shellReq.ShellID)
				// Route the rejection to the requester (not the viewer group) so
				// the engine's shellStreaming settles. Matches the
				// output-delivery path in processShellRequest.
				client.Send(shellRefusedFrame(shellReq.ShellID, "Shell ID already in use"))
				continue
			}
			go s.processShellRequest(ctx, shellReq, to, complete)
		}
	}
}

// inboundFrameRoles is which client roles may send each inbound frame. It is
// the whole of the socket's authorization by role: runRealtimeClientLoop
// consults it before dispatch and drops a frame its sender's role may not send.
// A type with no entry is refused from everyone, and
// TestInboundFrameRoles_CoverTheVocabulary holds it to allInboundFrames.
//
//   - Heartbeats are per role: each proves something only its own realm can
//     (engine_liveness.go, link_liveness.go).
//   - viewer-fault is a viewer's render fault; the engine reports its own over
//     /api/client/report.
//   - shell-start / shell-cancel are the bash tool's streaming transport, open
//     to both roles. Their output goes back to the requester alone
//     (processShellRequest). The bash tool runs in the engine, but its code
//     (shell-streaming.js) is not engine-only — the browser suite drives it
//     from viewer lanes — and refusing a viewer would protect nothing: every
//     token-holding viewer can run the same command through /api/ops/call.
//   - engine-bridge and one-shot-result speak for the engine: a viewer
//     bridging would be impersonating it to every viewer, and a viewer answering
//     a run the engine was asked to make would be answering for it.
//   - viewer-relay is a viewer addressing a named viewer; the engine has
//     nothing to say to one viewer that engine-bridge does not already carry.
//   - session-changed follows a PUT /session, which the session model in either
//     realm makes, and carries nothing but "re-read it".
//   - worker-message is how both realms talk to a conversation's worker.
var inboundFrameRoles = map[frameType][]ClientRole{
	frameEngineHeartbeat: {ClientRoleEngine},
	frameViewerHeartbeat: {ClientRoleViewer},
	frameViewerFault:     {ClientRoleViewer},
	frameShellStart:      {ClientRoleViewer, ClientRoleEngine},
	frameShellCancel:     {ClientRoleViewer, ClientRoleEngine},
	frameEngineBridge:    {ClientRoleEngine},
	frameViewerRelay:     {ClientRoleViewer},
	frameOneShotResult:   {ClientRoleEngine},
	frameSessionChanged:  {ClientRoleViewer, ClientRoleEngine},
	frameWorkerMessage:   {ClientRoleViewer, ClientRoleEngine},
}

// inboundFrameAllowed reports whether t is an inbound frame type at all, and
// whether a client in role may send it.
func inboundFrameAllowed(t frameType, role ClientRole) (known, allowed bool) {
	roles, known := inboundFrameRoles[t]
	return known, slices.Contains(roles, role)
}

// labelled prefixes a value with its label, or yields nothing at all when the
// value is empty. Keeps an optional field out of a log line entirely rather
// than leaving a bare "conv=" for a reader to wonder about.
func labelled(label, value string) string {
	if value == "" {
		return ""
	}
	return label + value
}

// conversationGoneFrame is the error a client is sent for a conversation the
// server declined to open: binned, or its folder gone.
func conversationGoneFrame() textFrame {
	m := msg.New("Couldn't open this conversation: the server no longer has it.")
	return textFrame{Type: frameError, Message: m.English(), Text: m}
}
