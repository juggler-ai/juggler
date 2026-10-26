//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Native claudecode implementation of provider.Conversation.
//
// PER-THREAD SESSIONS: a conversation runs many threads (root + sub-threads),
// and each thread gets its OWN claude session — its own --resume UUID, warm
// prompt cache, and live CLI subprocess — so switching threads never thrashes a
// shared session's cache. The handle therefore owns a registry of per-thread
// *Client sessions keyed by the turn's MessageRequest.ThreadID ("" = root). A
// single goroutine owns that map (no mutex, per the project concurrency rule)
// and also runs the idle reaper that bounds live subprocesses. All of this is
// internal to the provider: the only thread-awareness that crosses the boundary
// is MessageRequest.ThreadID, the natural sibling of ConversationID.

package claudecode

import (
	"context"
	"os"
	"strconv"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// cliReapSweepInterval is how often a conversation sweeps its per-thread
// sessions for idle CLIs. defaultCLIReapIdleTimeout is how long a session must
// be idle before its live subprocess is freed (the resumable record survives,
// so a reopened thread --resumes warm). Generous by default ("don't be too
// eager" — threads are often reopened); override via JUGGLER_CLI_IDLE_MS.
//
// defaultCLIReapParkedTimeout is the much longer ceiling that applies while a
// session is parked on tool results. A parked CLI is blocked on stdin for
// however long the tool takes, so the idle timeout would reap it mid-tool —
// sub-agent tools and long bash commands routinely run past ten minutes, and a
// reap there strands the parked call and costs the next turn its warm resume.
// An hour clears the longest tool juggler runs to completion by a wide margin
// (a bash/monitor timeout caps at 20 minutes) while still reclaiming the
// subprocess of a park nobody is coming back to: a wedged tool, an approval
// prompt left unanswered, an abandoned window. Override via
// JUGGLER_CLI_PARKED_MS.
const (
	cliReapSweepInterval        = 60 * time.Second
	defaultCLIReapIdleTimeout   = 10 * time.Minute
	defaultCLIReapParkedTimeout = 1 * time.Hour
)

func cliReapIdleTimeout() time.Duration {
	if v := os.Getenv("JUGGLER_CLI_IDLE_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return defaultCLIReapIdleTimeout
}

func cliReapParkedTimeout() time.Duration {
	if v := os.Getenv("JUGGLER_CLI_PARKED_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return defaultCLIReapParkedTimeout
}

// conversation is the per-conversation handle returned by OpenConversation. It
// owns a registry of per-thread sessions (see file header) behind a single
// goroutine.
type conversation struct {
	base   *Client // config template; also serves as the root-thread ("") session
	convID string
	ops    chan convOp
}

type convOpKind int

const (
	convGetSession convOpKind = iota
	convCancelThread
	convCancelAll
	convCloseAll
)

type convOp struct {
	kind     convOpKind
	threadID string
	resp     chan *Client
	done     chan struct{}
}

func newConversation(base *Client, convID string) *conversation {
	cv := &conversation{base: base, convID: convID, ops: make(chan convOp)}
	go cv.run()
	return cv
}

// run owns the per-thread session map and the idle-reaper ticker, so neither
// needs a mutex. A lookup returns the session's *Client to the caller, which
// then streams on its own goroutine — only the (fast) map access is serialised
// here; the slow teardown in cancel/close runs here too, but per-conversation,
// so it only ever delays this conversation's own ops (matching prior behaviour).
func (cv *conversation) run() {
	sessions := map[string]*Client{"": cv.base} // root thread is the base Client
	reap := time.NewTicker(cliReapSweepInterval)
	defer reap.Stop()
	for {
		select {
		case op := <-cv.ops:
			switch op.kind {
			case convGetSession:
				s := sessions[op.threadID]
				if s == nil {
					s = cv.base.newThreadSession(op.threadID)
					sessions[op.threadID] = s
				}
				op.resp <- s
			case convCancelThread:
				// Only a session that exists: creating one to cancel it would spawn
				// a thread session for a thread that never ran.
				if s := sessions[op.threadID]; s != nil {
					s.cancelSession()
				}
				op.done <- struct{}{}
			case convCancelAll:
				for _, s := range sessions {
					s.cancelSession()
				}
				op.done <- struct{}{}
			case convCloseAll:
				for _, s := range sessions {
					s.closeSession()
				}
				op.done <- struct{}{}
				return
			}
		case <-reap.C:
			// Free idle live CLIs across this conversation's threads; the
			// resumable record survives so a reopened thread --resumes warm.
			for _, s := range sessions {
				s.reapIdleCLI(cliReapIdleTimeout(), cliReapParkedTimeout())
			}
		}
	}
}

// session returns (creating on first use) the per-thread session for threadID.
func (cv *conversation) session(threadID string) *Client {
	resp := make(chan *Client, 1)
	cv.ops <- convOp{kind: convGetSession, threadID: threadID, resp: resp}
	return <-resp
}

// Submit drives one solicited LLM turn on the request's thread. The thread's
// session classifier picks fresh-start vs resume-with-delta vs continueSession
// from req.Messages. Autonomous turns surface via the Subscribe sink, not here.
func (cv *conversation) Submit(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	if req.ConversationID == "" {
		req.ConversationID = cv.convID
	}
	return cv.session(req.ThreadID).streamMessage(ctx, req, callback)
}

// Subscribe registers the worker's sink for autonomous turns (scheduled wake /
// monitor turns the persistent CLI emits with no Submit in flight). These are a
// root-thread concern, so the sink attaches to the root session only. Passing
// nil detaches.
func (cv *conversation) Subscribe(sink provider.TurnSink) {
	cv.base.subscribeTurns(sink)
}

// CacheTTL reports how long the CLI's saved session keeps prompt cache warm.
func (cv *conversation) CacheTTL() time.Duration {
	return upstreamCacheTTL
}

// Cancel releases in-flight/parked work for ONE of the conversation's thread
// sessions — or all of them, for provider.CancelAllThreads: it tears down the
// live/parked CLI but preserves the resume anchor (sessionUUID/sentCount/
// sentHash and the on-disk sidecar) so the next turn resumes cache-warm. A
// cancel is an interrupt, not a session invalidation.
//
// Per-thread matters here: each thread owns its own CLI subprocess, so a cancel
// aimed at one thread must not kill the subprocess another thread is streaming
// through. cancelSession is written to run alongside another thread's turn.
func (cv *conversation) Cancel(threadItemID string) {
	done := make(chan struct{}, 1)
	kind := convCancelThread
	if threadItemID == provider.CancelAllThreads {
		kind = convCancelAll
	}
	cv.ops <- convOp{kind: kind, threadID: threadItemID, done: done}
	<-done
}

// Close releases the handle: tears down every thread's live CLI and drops the
// in-memory sessions, but KEEPS the on-disk sidecar (root thread) so a later
// reopen --resumes warm. Eviction/shutdown ≠ conversation deletion. After Close
// the handle isn't used again.
func (cv *conversation) Close() error {
	done := make(chan struct{}, 1)
	cv.ops <- convOp{kind: convCloseAll, done: done}
	<-done
	return nil
}

// cancelSession tears down in-flight/parked work for ONE thread session as the
// SOLE owner of its activeSession. It may run while a turn streams on another
// goroutine, so it must not touch activeSession concurrently: it (1) interrupts
// any in-flight turn so the owning goroutine unwinds and releases the ownership
// token, then (2) takes the token itself before tearing down. With no turn in
// flight the token is already free and step 2 is immediate. A turn that does
// not unwind in time keeps its session (see acquireOwnershipAfterInterrupt):
// the cancel is logged and abandoned rather than allowed to hang the
// conversation's ops goroutine.
//
// The teardown keeps the persisted request projection. It is already honest at
// this point because every real request path advances it immediately after the
// complete stdin write; synthetic continuation nudges never claim messages.
// The next turn resumes only when canResumeWithDelta finds compatible history.
func (c *Client) cancelSession() {
	release, ok := c.acquireOwnershipAfterInterrupt()
	if !ok {
		return
	}
	defer release()
	if s := c.activeSession; s != nil {
		s.tearDownLiveCLI()
		s.pendingTools = nil
	}
}

// closeSession is the per-thread teardown for handle release: interrupt any
// in-flight turn so it releases the ownership token, then take the token and
// release the session — KEEPING the sidecar (root thread) for warm resume.
func (c *Client) closeSession() {
	release, ok := c.acquireOwnershipAfterInterrupt()
	if !ok {
		return
	}
	defer release()
	c.releaseSession()
}
