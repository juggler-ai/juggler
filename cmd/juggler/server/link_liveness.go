//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"time"

	"juggler/internal/jlog"
)

// Link liveness: proof that a client's connection still carries traffic in both
// directions. This is a different question from engine liveness
// (engine_liveness.go), which asks whether the engine's JS realm is running —
// here the link itself is what is in doubt.
//
// Nothing below the application layer answers it in useful time. A half-open TCP
// connection — a laptop suspended mid-turn, a phone leaving wifi, a NAT
// rebinding — stays open at both ends with no RST, and the kernel only gives up
// after the keepalive ladder on the machine server's listener
// (portbind.KeepAlive) has run, which is about two minutes. WebSocket ping/pong would be
// quicker and proves the wrong thing, for the same reason it does for the
// engine: in WebKit the socket lives in the network process, so control frames
// are still answered by a machine whose page has stopped.
//
// So both ends speak for themselves, at the application layer:
//
//   - the server sends {"type":"heartbeat"} whenever it has had nothing to say
//     for serverBeatInterval, so an idle viewer has something to measure its
//     link by rather than sitting in silence it cannot interpret;
//   - a viewer sends {"type":"viewer-heartbeat"} on the same terms (VIEWER_BEAT_MS
//     in web/js/services/websocket.js), and one that has said nothing at all for
//     viewerSilenceWindow has its socket closed so it reconnects.
//
// Traffic proves the same thing a beat does, so any inbound message refreshes
// the stamp and neither side beats on a link that is already busy: a streaming
// turn costs nothing extra.
const (
	// serverBeatInterval is how long a link may stay quiet before the server
	// speaks. The viewer's stall watchdog is what consumes it — it drops a link
	// that has produced nothing for three of these windows — so this is the unit
	// that decides how fast a dead link is noticed.
	serverBeatInterval = 15 * time.Second

	// viewerSilenceWindow is how long a viewer may say nothing before its socket
	// is closed. Five missed viewer beats, and deliberately generous: holding a
	// wedged viewer costs only its socket and whatever is queued for it, the
	// viewer's own watchdog drops a stalled link and reconnects well before this,
	// and a window tight enough to catch a viewer whose timers are merely starved
	// would also cut sessions that were fine.
	viewerSilenceWindow = 75 * time.Second
)

// beatInterval is serverBeatInterval unless a test has shortened it.
func (s *Server) beatInterval() time.Duration {
	if override := s.serverBeatIntervalNs.Load(); override > 0 {
		return time.Duration(override)
	}
	return serverBeatInterval
}

// viewerSilenceLimit is viewerSilenceWindow unless a test has shortened it.
func (s *Server) viewerSilenceLimit() time.Duration {
	if override := s.viewerSilenceWindowNs.Load(); override > 0 {
		return time.Duration(override)
	}
	return viewerSilenceWindow
}

// linkCheckInterval is how often each client's link is examined. A third of the
// beat interval, so a beat is never more than one and a third intervals late —
// which is the slack the client's stall threshold is chosen against — and a test
// that shortens the beat gets a proportionally faster tick without a second
// seam.
func (s *Server) linkCheckInterval() time.Duration {
	if tick := s.beatInterval() / 3; tick > 0 {
		return tick
	}
	return time.Millisecond
}

// outboundIdler is a client that can report how long it has had nothing to send.
// Both real transports implement it; the interface exists so the supervisor also
// works against a plain test stub, which simply always counts as idle.
type outboundIdler interface {
	IdleOutbound() time.Duration
}

// serverBeat is the beat itself: the smallest message that proves the link
// still carries one. Shared and never mutated.
var serverBeat = bareFrame{Type: frameHeartbeat}

// linkSupervisor watches one client's link from inside that client's own message
// loop. Every field is owned by that one goroutine, which is why plain fields
// are enough.
type linkSupervisor struct {
	srv         *Server
	client      RealtimeClient
	role        ClientRole
	lastInbound time.Time
	evicted     bool
}

// newLinkSupervisor starts watching a freshly connected client. The stamp starts
// at the connection itself: a client that has just completed an upgrade has, by
// definition, just spoken.
func newLinkSupervisor(s *Server, client RealtimeClient) *linkSupervisor {
	return &linkSupervisor{
		srv:         s,
		client:      client,
		role:        client.ClientRole(),
		lastInbound: time.Now(),
	}
}

// noteInbound records that the client said something. Any message counts —
// traffic proves the link as well as a beat does.
func (l *linkSupervisor) noteInbound() { l.lastInbound = time.Now() }

// tick is one supervision step, driven by the client loop's ticker.
func (l *linkSupervisor) tick() {
	if l.evictSilentViewer() {
		return
	}
	l.beatIfIdle()
}

// evictSilentViewer closes a viewer that has gone quiet, reporting whether the
// link is finished with. Closing is the whole treatment: the read loop unblocks,
// the client's registrations are dropped by the usual defers, and the page's own
// backoff loop brings it straight back if anything is still alive over there.
//
// Viewers only. A silent ENGINE is the engine supervisor's business, because
// there the escalation continues past eviction into reloading the WebView that
// hosts it (engine_liveness.go) — a viewer that stops answering has no such
// second act and needs none.
func (l *linkSupervisor) evictSilentViewer() bool {
	if l.role != ClientRoleViewer || l.evicted {
		return l.evicted
	}
	silence := time.Since(l.lastInbound)
	if silence <= l.srv.viewerSilenceLimit() {
		return false
	}
	l.evicted = true
	jlog.Info("[link] closing viewer %s after %v without a word from it; the socket is open "+
		"but nothing is reading it, so close it and let the page reconnect",
		l.client.ClientID(), silence.Round(time.Second))
	l.client.Close()
	return true
}

// beatIfIdle gives a quiet link something to measure itself by. A link with
// traffic on it already carries that proof, so it is left alone — which is also
// what keeps the beat off the hot path of a streaming turn.
func (l *linkSupervisor) beatIfIdle() {
	if idler, ok := l.client.(outboundIdler); ok && idler.IdleOutbound() < l.srv.beatInterval() {
		return
	}
	l.client.Send(serverBeat)
}
