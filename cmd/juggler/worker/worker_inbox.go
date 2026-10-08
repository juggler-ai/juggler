//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "juggler/cmd/juggler/mailbox"

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
	// answering is the client ID that originated the message currently being
	// dispatched, or "" for worker-internal messages. Safe without a lock: the
	// run loop dispatches one message at a time on a single goroutine, and
	// replies are sent synchronously within that dispatch.
	answering string
}

// newWorkerInbox builds an empty inbox whose pump lives until done closes.
func newWorkerInbox(done <-chan struct{}) workerInbox {
	q := mailbox.NewQueue[workerMessage](done)
	return workerInbox{intake: q, intakeOut: q.Out()}
}

// push queues msg. Returns after one goroutine hop (or once the worker is
// stopping); never drops.
func (b *workerInbox) push(msg workerMessage) { b.intake.Push(msg) }

// messages is where the run loop receives.
func (b *workerInbox) messages() <-chan workerMessage { return b.intakeOut }

// beginReply records the client a dispatch is answering. Run goroutine only.
func (b *workerInbox) beginReply(clientID string) { b.answering = clientID }

// endReply ends the dispatch beginReply opened.
func (b *workerInbox) endReply() { b.answering = "" }

// origin is the client the current dispatch answers, or "" when the message
// came from inside the worker.
func (b *workerInbox) origin() string { return b.answering }
