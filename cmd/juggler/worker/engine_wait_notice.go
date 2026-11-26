//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"time"

	"juggler/cmd/juggler/msg"
)

// A turn's wait for its context and tools is bounded by the engine staying
// attached, not by a span of time (ContextTimeout), so on an engine buried
// under load it can run for minutes. All that time the user would otherwise see
// "Preparing request" and nothing else, which reads exactly like a wedge. The
// engine says when it picks a request up and, every few seconds after, that it
// is still working on it (request-recv, request-working); from those and the
// time waited, the status line says which of three things is happening.

// engineWaitStage is what the preparing status says about the engine.
type engineWaitStage int

const (
	// engineWaitPlain: too soon to say anything; "Preparing request".
	engineWaitPlain engineWaitStage = iota
	// engineWaitUnclaimed: the engine has not picked the request up. Its realm
	// is too busy to reach the message at all.
	engineWaitUnclaimed
	// engineWaitWorking: the engine has the request and keeps saying so.
	engineWaitWorking
	// engineWaitQuiet: the engine had the request and has stopped saying so.
	engineWaitQuiet
)

// engineWaitStageAt decides the stage after waited, with lastWord the moment
// the engine last spoke about the request (zero if it never has).
func engineWaitStageAt(waited time.Duration, lastWord, now time.Time, slowAfter, quietAfter time.Duration) engineWaitStage {
	switch {
	case waited < slowAfter:
		return engineWaitPlain
	case lastWord.IsZero():
		return engineWaitUnclaimed
	case now.Sub(lastWord) >= quietAfter:
		return engineWaitQuiet
	default:
		return engineWaitWorking
	}
}

// message is the stage's status line, or false for the plain one.
func (s engineWaitStage) message() (msg.Message, bool) {
	switch s {
	case engineWaitUnclaimed:
		return msg.New("Engine is busy — it hasn't picked up the request yet"), true
	case engineWaitWorking:
		return msg.New("Engine is slow — still preparing the request"), true
	case engineWaitQuiet:
		return msg.New("Engine has gone quiet — still waiting for it"), true
	default:
		return msg.Message{}, false
	}
}

// engineWaitNotice keeps a turn's preparing status in step with the engine.
// Owned by the turn goroutine doing the wait; a nil notice says nothing, for a
// wait whose run is showing some other status (a compaction's).
type engineWaitNotice struct {
	r                     *run
	started, lastWord     time.Time
	slowAfter, quietAfter time.Duration
	shown                 engineWaitStage
}

// newEngineWaitNotice is the notice for a wait that began at started, or nil —
// saying nothing — on a worker with no thresholds set.
func (r *run) newEngineWaitNotice(started time.Time) *engineWaitNotice {
	if r.slowEngineAfter <= 0 || r.quietEngineAfter <= 0 {
		return nil
	}
	return &engineWaitNotice{r: r, started: started, slowAfter: r.slowEngineAfter, quietAfter: r.quietEngineAfter}
}

// heard records that the engine spoke about the request at now.
func (n *engineWaitNotice) heard(now time.Time) {
	if n != nil {
		n.lastWord = now
	}
}

// update shows the stage for now if it is not the one already showing.
func (n *engineWaitNotice) update(now time.Time) {
	if n == nil {
		return
	}
	stage := engineWaitStageAt(now.Sub(n.started), n.lastWord, now, n.slowAfter, n.quietAfter)
	if stage == n.shown {
		return
	}
	n.shown = stage
	if m, ok := stage.message(); ok {
		n.r.sendStatusText(string(statusPreparing), m)
	} else {
		n.r.sendStatus(string(statusPreparing), "")
	}
}

// answered puts the status back to plain "Preparing request" once the engine
// has answered, so a notice about it cannot outlive the wait it described.
func (n *engineWaitNotice) answered() {
	if n == nil || n.shown == engineWaitPlain {
		return
	}
	n.shown = engineWaitPlain
	n.r.sendStatus(string(statusPreparing), "")
}

// tick is how often the wait re-reads the stage between the engine's words:
// often enough to catch the slow threshold and a quiet engine promptly.
func (n *engineWaitNotice) tick() time.Duration {
	if n == nil {
		return 0
	}
	return min(n.slowAfter, n.quietAfter) / 2
}
