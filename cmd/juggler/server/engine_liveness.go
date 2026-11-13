//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/osactivity"
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
//
// Silence is counted in served time, not wall time. The engine's page is
// hidden, and WebKit runs a hidden page's web process at the darwin background
// tier (scheduler priority 4) — the throttling engine_lifecycle.go chooses. A
// saturated Mac barely runs that tier at all, since every thread at default
// priority comes first, so a realm that is perfectly healthy can go a minute
// without one turn of its event loop. Condemning it for that is not harmless:
// the reload that follows an eviction destroys the realm, and with it every
// running tool's in-flight state, so the reloaded engine runs those tools again.
// So a stretch of silence counts only as far as a thread of the server's own,
// held at that same tier, was being run in it (osactivity.BackgroundTierClock):
// an engine that was given the chance to speak and said nothing has been
// silent; one that was never run has not. Where nothing measures the tier,
// silence is wall time.
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

// engineSilence reports how long the engine has been silent, in served time.
// Zero when no engine is registered (the caller checks registration first).
func (s *Server) engineSilence() time.Duration {
	return s.engineSilenceAt(time.Now(), false)
}

// engineSilenceAt is engineSilence with the clock supplied. commit records the
// reading, which only the supervisor's tick does; any other caller peeks.
func (s *Server) engineSilenceAt(now time.Time, commit bool) time.Duration {
	last := s.engineHeartbeatAt.Load()
	if last == 0 {
		return 0
	}
	return s.engineQuiet.silence.count(last, now, s.engineTierClock(), commit)
}

// setEngineTier installs the reader of the engine's scheduling-tier clock.
func (s *Server) setEngineTier(served func() time.Duration) {
	s.engineTier.Store(&served)
}

// engineTierClock is the installed tier clock, or nil.
func (s *Server) engineTierClock() func() time.Duration {
	if p := s.engineTier.Load(); p != nil {
		return *p
	}
	return nil
}

// engineQuietClock holds the served-time counts for the two waits the
// supervisor makes on the engine.
type engineQuietClock struct {
	// silence counts from the engine's last word.
	silence quietCount
	// grace counts from an eviction, a reload, or the reloaded engine's last
	// step further in its boot.
	grace quietCount
}

// quietCount is one served-time count. The supervisor's tick is its only
// writer, publishing each reading whole; any other caller works from the last
// one published and records nothing.
type quietCount struct{ last atomic.Pointer[quietSpan] }

// count returns the time since the moment from, up to now, in served time,
// publishing the reading when commit is set.
func (c *quietCount) count(from int64, now time.Time, tier func() time.Duration, commit bool) time.Duration {
	var prev quietSpan
	if p := c.last.Load(); p != nil {
		prev = *p
	}
	next := prev.through(from, now, tier)
	if commit {
		c.last.Store(&next)
	}
	return next.served
}

// quietSpan is a reading of the time since a moment, counting only the time in
// which the engine's scheduling tier was being run.
type quietSpan struct {
	from   int64         // the moment counted from, unix nanoseconds
	at     time.Time     // when the reading was taken
	tier   time.Duration // the tier clock's reading then
	served time.Duration // the count as of at
}

// through brings the reading up to now for the moment from.
//
// The first look at a moment counts the wall time since it: there is no
// earlier reading of the tier to measure against. The supervisor looks once a
// tick, so that is at most a tick's worth. After that, each stretch counts as
// its wall time or as the time the tier was run in it, whichever is less. A
// nil tier counts wall time throughout.
func (sp quietSpan) through(from int64, now time.Time, tier func() time.Duration) quietSpan {
	var reading time.Duration
	if tier != nil {
		reading = tier()
	}
	served := now.Sub(time.Unix(0, from))
	if from == sp.from && !sp.at.IsZero() {
		stretch := now.Sub(sp.at)
		if tier != nil {
			stretch = min(stretch, reading-sp.tier)
		}
		served = sp.served + max(stretch, 0)
	}
	return quietSpan{from: from, at: now, tier: reading, served: max(served, 0)}
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
	// its own before the recovery hook is called, in served time like its
	// silence. The client reconnects on a 1s tiered backoff, so this is many
	// attempts' worth: if a realm that was run for this long has not returned,
	// the realm itself is gone rather than the link.
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
	if tier := osactivity.BackgroundTierClock(); tier != nil {
		s.setEngineTier(tier)
	}
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
	s.superviseEngineAt(time.Now())
}

// superviseEngineAt is superviseEngine with the clock supplied, so a test can
// lay out a reconnect grace without sleeping through one.
func (s *Server) superviseEngineAt(now time.Time) {
	if s.engineClient.Load() != nil {
		silence := s.engineSilenceAt(now, true)
		if silence <= s.livenessWindow() {
			// Healthy: forget any eviction we were tracking.
			s.engineEvictedAt.Store(0)
			s.engineRecoveries.Store(0)
			s.noteTestEngineQuiet(silence > s.livenessWindow()/2)
			return
		}
		s.evictSilentEngine(now, silence)
		return
	}

	// No engine attached. Only act on one WE evicted: an engine that has never
	// connected is startEngineHost's business, and a normal disconnect during
	// shutdown is nobody's.
	// The grace runs from the eviction or last reload, or from the reloaded
	// engine's last step further, whichever came last: a reload's boot is as
	// long as the machine is slow, and a reload on a wall-time grace cuts off
	// the boot of the one before it. It is counted in served time, as silence
	// is: an evicted realm the tier was not run for has had no chance to
	// reconnect, and reloading it destroys the tools it is running.
	evictedAt := s.engineEvictedAt.Load()
	if evictedAt == 0 {
		return
	}
	quietSince := time.Unix(0, evictedAt)
	if step := s.engineBootStepAt(); step.After(quietSince) {
		quietSince = step
	}
	waited := s.engineQuiet.grace.count(quietSince.UnixNano(), now, s.engineTierClock(), true)
	if waited < engineReconnectGrace {
		return
	}

	if n := s.engineRecoveries.Add(1); n > maxEngineRecoveries {
		s.engineEvictedAt.Store(0)
		jlog.Error("[engine] gave up reviving the engine after %d attempts — tools cannot run in this session", maxEngineRecoveries)
		return
	}
	g := s.engineRecovery.Load()
	if g == nil {
		s.engineEvictedAt.Store(0)
		jlog.Error("[engine] evicted engine did not reconnect within %v and no recovery hook is installed", engineReconnectGrace)
		return
	}
	// Stays armed from the reload: one that brings nothing back is met with
	// the next after the same grace, up to the cap. An engine that does return
	// clears it on the first tick that finds it live.
	s.engineEvictedAt.Store(now.UnixNano())
	jlog.Info("[engine] engine neither reconnected nor got further in its boot for %v since its eviction or last reload — reloading it (attempt %d of %d)",
		engineReconnectGrace, s.engineRecoveries.Load(), maxEngineRecoveries)
	(*g)()
}

// evictSilentEngine closes a wedged engine's socket. Closing is what makes the
// rest of the system honest: the read loop unblocks, ClearEngineClient runs, and
// the worker's engineAttached — which gates every tool-command dispatch — stops
// claiming an engine that cannot act. The client's own reconnect backoff brings
// a live realm straight back.
func (s *Server) evictSilentEngine(now time.Time, silence time.Duration) {
	client := s.engineClient.Load()
	if client == nil {
		return
	}
	if s.engineEvictedAt.Load() != 0 {
		return // already evicted this one; waiting out the reconnect grace
	}
	s.engineEvictedAt.Store(now.UnixNano())
	jlog.Error("[engine] evicting a silent engine after %v with no word from its realm, counted while its "+
		"scheduling tier was run (%v by the clock; client=%s, queued writes: %d); closing the socket so it reconnects",
		silence.Round(time.Second), now.Sub(time.Unix(0, s.engineHeartbeatAt.Load())).Round(time.Second),
		client.ClientID(), client.QueuedWrites())
	client.Close()
}
