//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"sync"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/mailbox"
)

// workerInbox is the worker's intake: the queue every message arrives on, and
// the client that sent the one being dispatched, which is who a request-scoped
// reply goes back to.
//
// Where an outbound message goes is the callback registry's business (see
// callback_registry.go); this type only says who asked. Every field is read and
// written only by the methods in this file (TestWorkerSeamsOwnTheirState).
type workerInbox struct {
	// intake is an unbounded FIFO, so a send never drops and never blocks on
	// worker processing. Any goroutine may push.
	intake *mailbox.Queue[workerMessage]
	// intakeOut is intake's consumer end. The run loop is its sole reader.
	intakeOut <-chan workerMessage
	// backlog counts what has been pushed and not yet taken, by sender.
	backlog *inboxBacklog
	// answering is the client ID that originated the message currently being
	// dispatched, or "" for worker-internal messages. Safe without a lock: the
	// run loop dispatches one message at a time on a single goroutine, and
	// replies are sent synchronously within that dispatch.
	answering string
	// byAck is whether the message being dispatched carries an ack channel —
	// a request from inside the server, whose caller waits on that channel
	// rather than on anything sent over the wire. Same goroutine rule.
	byAck bool
}

// inboxBacklog is the count of messages queued and not yet taken by the run
// loop, in total and per sending client. It is how the worker knows it is behind:
// the engine answers a tool command within milliseconds, but the answer reaches
// the worker only when the loop gets to it, so "no answer yet" means silence
// only once nothing from the engine is still waiting (pendingFrom). Pushes come
// from any goroutine and takes from the run loop, so the counts are atomic.
type inboxBacklog struct {
	total atomic.Int64
	// byOrigin maps a client ID to its *atomic.Int64 count. An entry is kept at
	// zero rather than deleted, since a delete racing a push would lose the
	// push's count; there is one per client that has ever sent to this worker.
	byOrigin sync.Map
}

// newWorkerInbox builds an empty inbox whose pump lives until done closes.
func newWorkerInbox(done <-chan struct{}) workerInbox {
	q := mailbox.NewQueue[workerMessage](done)
	return workerInbox{intake: q, intakeOut: q.Out(), backlog: &inboxBacklog{}}
}

// originCount returns clientID's backlog counter, creating it if absent.
func (b *workerInbox) originCount(clientID string) *atomic.Int64 {
	if c, ok := b.backlog.byOrigin.Load(clientID); ok {
		return c.(*atomic.Int64)
	}
	c, _ := b.backlog.byOrigin.LoadOrStore(clientID, new(atomic.Int64))
	return c.(*atomic.Int64)
}

// push stamps msg with its enqueue time and queues it. Returns after one
// goroutine hop (or once the worker is stopping); never drops. The backlog is
// counted before the push, so a message is never taken before it is counted.
func (b *workerInbox) push(msg workerMessage) {
	msg.EnqueuedAt = time.Now()
	b.backlog.total.Add(1)
	b.originCount(msg.OriginClient).Add(1)
	b.intake.Push(msg)
}

// messages is where the run loop receives. Every message received from it must
// be passed to taken.
func (b *workerInbox) messages() <-chan workerMessage { return b.intakeOut }

// taken records that the run loop has received msg, so it no longer counts as
// waiting. Run goroutine only.
func (b *workerInbox) taken(msg workerMessage) {
	b.backlog.total.Add(-1)
	b.originCount(msg.OriginClient).Add(-1)
}

// depth is how many messages are queued and not yet taken.
func (b *workerInbox) depth() int { return int(b.backlog.total.Load()) }

// pendingFrom is how many messages from clientID are queued and not yet taken.
func (b *workerInbox) pendingFrom(clientID string) int {
	if c, ok := b.backlog.byOrigin.Load(clientID); ok {
		return int(c.(*atomic.Int64).Load())
	}
	return 0
}

// beginReply records the client a dispatch is answering. Run goroutine only.
func (b *workerInbox) beginReply(clientID string) { b.answering = clientID }

// answerByAck marks the dispatch beginReply opened as one whose caller waits
// on its ack channel. Run goroutine only.
func (b *workerInbox) answerByAck() { b.byAck = true }

// endReply ends the dispatch beginReply opened.
func (b *workerInbox) endReply() { b.answering, b.byAck = "", false }

// origin is the client the current dispatch answers, or "" when the message
// came from inside the worker.
func (b *workerInbox) origin() string { return b.answering }

// answeredByAckAlone reports whether the current dispatch has no client to
// answer on the wire: a request from inside the server, answered when its ack
// channel is.
func (b *workerInbox) answeredByAckAlone() bool { return b.answering == "" && b.byAck }
