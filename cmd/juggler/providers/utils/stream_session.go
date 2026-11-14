//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"context"
	"fmt"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// StreamSession is the scaffolding every SDK-streaming provider arms around its
// event loop: a cancellable context derived from the caller's, the idle
// watchdog that cancels it when the upstream goes silent, the throttled
// progress emitter that drives the UI's live output-token count, and the
// stall-versus-cancel classification the resulting stream error needs.
//
// It owns only what was byte-identical at every arm site. Decoding SDK events,
// accumulating blocks, capturing usage and building the result stay
// provider-local, because those genuinely differ — anthropic runs a block state
// machine and reports cache-write tokens, gemini never accumulates output text,
// and the two openai paths key their tool accumulators differently.
//
// Typical use:
//
//	sess, streamCtx := utils.NewStreamSession(ctx, "anthropic", callback)
//	defer sess.Close()
//	stream := sdk.NewStreaming(streamCtx, params)
//	for stream.Next() {
//	    sess.Reset()
//	    // … decode the event, sess.Progress(delta) on streamed content …
//	}
//	if err := stream.Err(); err != nil {
//	    if stall := sess.StallError(); stall != nil {
//	        return nil, stall
//	    }
//	    return nil, sess.Annotate(err)
//	}
//
// A session belongs to one goroutine for the life of one stream attempt, and
// every SDK provider arms exactly one: retries belong to the worker's turn
// loop, where the wait is visible and interruptible. So a reported idle window
// is always the one that actually elapsed.
type StreamSession struct {
	name     string
	parent   context.Context
	cancel   context.CancelFunc
	idle     *IdleWatchdog
	timeout  time.Duration
	progress *provider.ProgressEmitter

	// started and lastEvent are the stream's history, kept so a failure can say
	// how the stream had gone (Annotate). lastEvent is zero until the first
	// event. Only the owning goroutine touches them — Reset and Annotate — so
	// they need no synchronisation.
	started   time.Time
	lastEvent time.Time
}

// NewStreamSession arms a session for one stream and returns it alongside the
// context to hand the SDK. providerName is the lowercase registry id used to
// label a stall ("anthropic", "gemini", "zai"); callback may be nil, in which
// case Progress is a no-op.
//
// The idle window is resolved once here and reused for both the watchdog and
// the stall message, so the reported timeout is the one that fired.
func NewStreamSession(ctx context.Context, providerName string, callback provider.StructuredStreamCallback) (*StreamSession, context.Context) {
	streamCtx, cancel := context.WithCancel(ctx)
	timeout := EffectiveStreamIdleTimeout()
	return &StreamSession{
		name:     providerName,
		parent:   ctx,
		cancel:   cancel,
		idle:     NewIdleWatchdog(timeout, cancel),
		timeout:  timeout,
		progress: provider.NewProgressEmitter(callback),
		started:  time.Now(),
	}, streamCtx
}

// Reset restarts the idle window. Call it on every received stream event.
func (s *StreamSession) Reset() {
	s.idle.Reset()
	s.lastEvent = time.Now()
}

// Progress feeds streamed content (text deltas, thinking deltas, tool-input
// JSON fragments) to the throttled output-token estimate behind the UI spinner.
func (s *StreamSession) Progress(text string) {
	s.progress.Add(text)
}

// StallError returns the canonical transient stall error when the watchdog
// fired while the caller's context was still alive — the stream went silent,
// rather than the caller cancelling it. It returns nil otherwise, so a stream
// error is classified with `if stall := sess.StallError(); stall != nil` instead
// of each provider re-deriving the predicate and remembering which timeout to
// report. Getting that wrong in either direction is costly: a missed stall
// parks the turn, and a misclassified caller cancel makes the worker auto-retry
// a deliberate interrupt.
func (s *StreamSession) StallError() error {
	if s.idle.Fired() && s.parent.Err() == nil {
		return StallError(s.name, s.timeout)
	}
	return nil
}

// Annotate wraps a stream's terminal error with how the stream had gone until
// then — how long it ran, and how long before the failure its last event came.
// The provider's error text cannot say this, and it is the one fact that tells a
// server cutting off a long, healthy response from one that never produced
// anything; providers trace only the event types they ignore, so without it
// neither the log nor the error item records which it was. The cause stays
// wrapped (%w), so errors.As/Is are unaffected.
//
// An error with no type the classifier recognises is classified by its text
// (provider.ClassifyFailureText), and this suffix becomes part of it, so its
// wording is constrained: no counts (the text rules match any "429"), only
// durations rounded to 100ms (which cannot spell one), and neither "in " nor
// "after " (the worker's parseRetryWaitFromMsg reads a number of seconds
// following either as a server-stated wait).
//
// The result is a *provider.StreamInterruptedError, which also carries the last
// event's time for the worker's retry budget.
//
// A caller's own cancel is returned untouched: it is not a stream failure, and
// callers compare it against context.Canceled. So is a watchdog stall, which
// StallError reports in its own words.
func (s *StreamSession) Annotate(err error) error {
	if err == nil || s.parent.Err() != nil || s.idle.Fired() {
		return err
	}
	elapsed := time.Since(s.started).Round(100 * time.Millisecond)
	if s.lastEvent.IsZero() {
		return &provider.StreamInterruptedError{
			Err:  err,
			Text: fmt.Sprintf("%v (no event arrived; the stream ran for %s)", err, elapsed),
		}
	}
	gap := time.Since(s.lastEvent).Round(100 * time.Millisecond)
	return &provider.StreamInterruptedError{
		Err:       err,
		Text:      fmt.Sprintf("%v (the stream ran for %s; its last event came %s before the failure)", err, elapsed, gap),
		LastEvent: s.lastEvent,
	}
}

// Close stops the watchdog and releases the derived context, in that order.
// Idempotent; defer it immediately after NewStreamSession.
func (s *StreamSession) Close() {
	s.idle.Stop()
	s.cancel()
}
