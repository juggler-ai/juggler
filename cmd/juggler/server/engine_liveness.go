//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"time"

	"juggler/internal/jlog"
)

// Engine liveness: proof that the engine's JS realm is still running, as
// distinct from proof that its socket is still open.
//
// The engine is the only thing that executes tools, and the worker's
// tool-command driver acts only while the server reports an engine attached. A
// presence check is not enough to carry that weight. The engine runs in a hidden
// WebView whose realm can stop — suspended while backgrounded, wedged, or killed
// and reloaded underneath us — and in WebKit the WebSocket lives in the network
// process, so the transport keeps completing handshakes and answering control
// frames long after the realm above it has gone quiet. A ping-based keepalive
// therefore proves the wrong thing: it can be answered by a machine whose engine
// is dead.
//
// So the engine proves itself the only way that cannot be faked from below: it
// sends an engine-heartbeat from inside its module worker (see
// web/js/engine-app.js), the realm that would have to be running for a tool to
// execute at all. The stamp is refreshed by that heartbeat and by nearly every
// other message the engine sends, since traffic is proof of the same thing.
//
// What this measures, precisely, is that the engine's event loop is turning. It
// does NOT measure that any particular piece of work is progressing, and it must
// not be stretched to: a tool wedged on a promise that never settles leaves the
// loop free, so the realm is genuinely alive and evicting it would close the
// socket for every other conversation to punish one stuck tool. Progress of an
// individual tool is a separate question with a separate ladder — the engine's
// own overdue-execution watchdog (web/js/services/action-executor.js) and the
// worker's tool-command escalation (worker/tool_commands.go).
const (
	// engineHeartbeatInterval is how often the engine announces itself. Kept well
	// inside engineLivenessWindow so an ordinary scheduling hiccup, a slow
	// reconnect, or one dropped beat never reads as death.
	engineHeartbeatInterval = 5 * time.Second

	// engineLivenessWindow is how long the engine may stay silent before it stops
	// counting as attached. Six missed beats, which is deliberately generous: a
	// machine under enough load to starve the engine's worker for half a minute
	// is not a machine that should also be told its engine is dead, and the
	// worker holds an unproven tool for engineUnprovenHold anyway — so nothing is
	// gained by condemning faster, and a false eviction costs a real reconnect.
	engineLivenessWindow = 30 * time.Second
)

// engineTrafficProvesLiveness reports whether an inbound engine message is
// admissible evidence that the engine's realm is running.
//
// Almost everything is. The exception is the tool-execution report: it is
// emitted by a timer whose only precondition is that the executor's running set
// is non-empty (web/js/services/worker-manager-protocols.js), so a tool that
// claimed `running` and then hung inside execute() keeps that timer arriving
// every few seconds for as long as the wedge lasts. Accepting it would make the
// report the loudest witness for precisely the engine that has stopped getting
// anywhere — liveness by traffic rather than by progress.
//
// Excluding it costs no coverage. The heartbeat is sent from the same realm on
// the same kind of timer, is unconditional once the engine has connected, and is
// the message designed to carry this meaning; anything that stops the reports
// from being composed stops the heartbeat too.
func engineTrafficProvesLiveness(generic GenericWSMessage) bool {
	return generic.WorkerMsgType != "tool-execution-report"
}

// noteEngineAlive stamps the moment the engine last proved its realm is running.
// Called on engine registration (a fresh connection has, by definition, just run
// the code that opened it) and on every admissible inbound engine message.
func (s *Server) noteEngineAlive() {
	s.engineHeartbeatAt.Store(time.Now().UnixNano())
}

// livenessWindow is engineLivenessWindow unless a test has shortened it.
func (s *Server) livenessWindow() time.Duration {
	if override := s.engineLivenessWindowNs.Load(); override > 0 {
		return time.Duration(override)
	}
	return engineLivenessWindow
}

// engineSilence reports how long the engine has been silent. Zero when no engine
// is registered (the caller checks registration first).
func (s *Server) engineSilence() time.Duration {
	last := s.engineHeartbeatAt.Load()
	if last == 0 {
		return 0
	}
	return time.Since(time.Unix(0, last))
}

// engineLive reports whether a registered engine has proved itself within the
// liveness window. This is the predicate behind IsEngineConnected: everything
// gating a turn on "is there an engine" means "is there an engine that can still
// execute a tool", and a socket alone does not answer that.
func (s *Server) engineLive() bool {
	if s.engineClient.Load() == nil {
		return false
	}
	return s.engineSilence() <= s.livenessWindow()
}

const (
	// engineFlapWindow is how far back the reconnect count looks. Long enough
	// that a genuine restart — evict, grace, reload — cannot fill it, short
	// enough that a loop trips it in seconds.
	engineFlapWindow = 60 * time.Second

	// maxEngineAttachesPerWindow is how many connections in that window still
	// count as recovery rather than a loop. A healthy session connects once and
	// stays; a link that blips a few times over a minute is ordinary. Five is
	// past both and short of the dozens per minute a real loop produces, since
	// the client's own backoff settles at one attempt a second.
	maxEngineAttachesPerWindow = 5
)

// noteEngineAttached records an engine connection and reports whether this one
// is the moment the pattern becomes a loop.
//
// The gap this fills: the supervisor's escalation ladder only ever advances
// through evictSilentEngine, which fires for an engine whose socket stayed open
// while its realm went quiet. An engine that dies loudly and reconnects cleanly
// never touches it, so without this a die/reconnect/die loop would run forever
// with nothing in the log but the raw transport errors it produced — which is
// exactly the failure a message too large for the client to accept causes.
//
// It deliberately does NOT escalate to the recovery hook. Reloading the engine
// cannot fix a message it will refuse again on the next attempt, and the node
// host's hook takes the whole server down with it: the useful act is to name
// what is happening, once, beside the errors that say why.
func (s *Server) noteEngineAttached() {
	s.noteEngineAttachedAt(time.Now())
}

// noteEngineAttachedAt is noteEngineAttached with the clock supplied, so a test
// can lay out a flap without sleeping through one. Returns true on the single
// attach that trips the report.
//
// A fixed window — when the run began, and how many have landed since — rather
// than a rolling history of timestamps. One engine connects at a time, so that
// pair is the whole shape of what is being measured, and it holds in two
// atomics where a list would need a lock. The cost is coarseness at the edge: a
// loop that straddles a boundary is reported in the following window instead of
// this one, which for a condition that persists until someone intervenes is no
// cost at all.
func (s *Server) noteEngineAttachedAt(now time.Time) bool {
	start := s.engineFlapWindowStart.Load()
	if start == 0 || now.Sub(time.Unix(0, start)) > engineFlapWindow {
		// A fresh window. Re-arm the report with it, so a loop later in the
		// session is named too rather than being silenced by an earlier one.
		s.engineFlapWindowStart.Store(now.UnixNano())
		s.engineAttachCount.Store(1)
		s.engineFlapReported.Store(false)
		return false
	}

	count := s.engineAttachCount.Add(1)
	if count <= maxEngineAttachesPerWindow {
		return false
	}
	if s.engineFlapReported.Swap(true) {
		return false
	}
	jlog.Error("[engine] the engine has connected %d times in the last %v — it is looping, not recovering. "+
		"Tools cannot run while this lasts; the write errors above say what each connection died on",
		count, engineFlapWindow)
	return true
}

// engineWentQuiet is the one-shot log line for an engine crossing from live to
// silent. Rate-limited to the transition so a wedged engine costs one line, not
// one per poll.
func (s *Server) reportEngineSilence() {
	if s.engineSilenceReported.Swap(true) {
		return
	}
	queued := 0
	if c := s.engineClient.Load(); c != nil {
		queued = c.QueuedWrites()
	}
	jlog.Error("[engine] silent for %v (queued writes: %d) — the engine socket is still open but its realm "+
		"has stopped answering; tools cannot execute until it returns",
		s.engineSilence().Round(time.Second), queued)
}

// EngineRecovery brings a dead engine back. The server can close a wedged
// engine's socket, but it cannot reload the WebView that hosts it — that needs
// the native window, which lives in the app layer. startEngineHost installs this
// hook; without one, recovery stops at eviction.
type EngineRecovery func()

// SetEngineRecovery installs the hook used when a silent engine fails to
// reconnect on its own. Optional: with no hook the server still evicts, which is
// enough whenever the realm is alive and only the link had wedged.
func (s *Server) SetEngineRecovery(fn EngineRecovery) {
	if fn == nil {
		s.engineRecovery.Store(nil)
		return
	}
	s.engineRecovery.Store(&fn)
}

const (
	// engineReconnectGrace is how long an evicted engine is given to come back on
	// its own before the recovery hook is called. The client reconnects on a 1s
	// tiered backoff, so this is many attempts' worth: if it has not returned by
	// now, the realm itself is gone rather than the link.
	engineReconnectGrace = 20 * time.Second

	// maxEngineRecoveries caps how many times the recovery hook fires before the
	// server stops trying. An engine that cannot be revived is a broken install or
	// a broken WebKit, and hammering it helps nobody; turns fail with a clear
	// engine-unavailable error either way, which beats a reload loop.
	maxEngineRecoveries = 3
)

// startEngineSupervisor watches the engine link for the failure no other check
// can see: a socket that stays open while the realm behind it has stopped.
//
// The escalation is deliberately gentle, because each step costs more than the
// last. First evict — close the socket, which the client answers with a
// reconnect, healing the common case (a wedged or half-open link over a healthy
// realm) in about a second and costing nothing else. Only if nothing comes back
// is the realm itself presumed dead and the recovery hook called to reload it.
func (s *Server) startEngineSupervisor() {
	go func() {
		tick := time.NewTicker(engineHeartbeatInterval)
		defer tick.Stop()
		for {
			select {
			case <-s.shutdownChan:
				return
			case <-tick.C:
				s.superviseEngine()
			}
		}
	}()
}

// superviseEngine is one supervision tick. Split out so a test can step it
// without waiting on the ticker.
func (s *Server) superviseEngine() {
	if s.engineClient.Load() != nil {
		if s.engineLive() {
			// Healthy: forget any eviction we were tracking.
			s.engineEvictedAt.Store(0)
			s.engineRecoveries.Store(0)
			return
		}
		s.evictSilentEngine()
		return
	}

	// No engine attached. Only act on one WE evicted: an engine that has never
	// connected is startEngineHost's business, and a normal disconnect during
	// shutdown is nobody's.
	evictedAt := s.engineEvictedAt.Load()
	if evictedAt == 0 || time.Since(time.Unix(0, evictedAt)) < engineReconnectGrace {
		return
	}
	s.engineEvictedAt.Store(0)

	if n := s.engineRecoveries.Add(1); n > maxEngineRecoveries {
		jlog.Error("[engine] gave up reviving the engine after %d attempts — tools cannot run in this session", maxEngineRecoveries)
		return
	}
	g := s.engineRecovery.Load()
	if g == nil {
		jlog.Error("[engine] evicted engine did not reconnect within %v and no recovery hook is installed", engineReconnectGrace)
		return
	}
	jlog.Info("[engine] evicted engine did not reconnect within %v — reloading it", engineReconnectGrace)
	(*g)()
}

// evictSilentEngine closes a wedged engine's socket. Closing is what makes the
// rest of the system honest: the read loop unblocks, ClearEngineClient runs, and
// the worker's engineAttached — which gates every tool-command dispatch — stops
// claiming an engine that cannot act. The client's own reconnect backoff brings
// a live realm straight back.
func (s *Server) evictSilentEngine() {
	client := s.engineClient.Load()
	if client == nil {
		return
	}
	if s.engineEvictedAt.Load() != 0 {
		return // already evicted this one; waiting out the reconnect grace
	}
	s.engineEvictedAt.Store(time.Now().UnixNano())
	jlog.Error("[engine] evicting a silent engine after %v with no word from its realm "+
		"(client=%s, queued writes: %d); closing the socket so it reconnects",
		s.engineSilence().Round(time.Second), client.ClientID(), client.QueuedWrites())
	client.Close()
}
