//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

import "encoding/json"

// injectReply is the test-only uncorrelated answer (see inject). accepted is
// closed once the registry has taken it: handed to a registration, or made the
// one injection held for the next registration. Later injections wait unaccepted
// behind that one, so a feeder looping on inject runs one reply ahead and no more.
type injectReply struct {
	payload  json.RawMessage
	abort    <-chan struct{}
	accepted chan struct{}
}

// countReplies asks the registry how many accepted replies it holds (see held).
type countReplies struct {
	result chan int
}

// replyInjections is the registry's queue of injected answers, owned by its
// goroutine like the rest of its state.
type replyInjections struct {
	queue []injectReply
}

// settle drops queued injections whose feeder has given up and accepts
// whichever is now at the head. Only the head is ever accepted.
func (q *replyInjections) settle() {
	for len(q.queue) > 0 && closed(q.queue[0].abort) {
		q.queue = q.queue[1:]
	}
	if len(q.queue) > 0 && !closed(q.queue[0].accepted) {
		close(q.queue[0].accepted)
	}
}

// take hands a new registration the held injection, if there is one.
func (q *replyInjections) take() (json.RawMessage, bool) {
	q.settle()
	if len(q.queue) == 0 {
		return nil, false
	}
	payload := q.queue[0].payload
	q.queue = q.queue[1:]
	q.settle()
	return payload, true
}

// handle runs the registry's test-only commands, reporting whether command was
// one of them.
func (q *replyInjections) handle(command any, pending map[string]pendingReply, registrationOrder []string) bool {
	switch command := command.(type) {
	case injectReply:
		if closed(command.abort) {
			return true
		}
		if len(q.queue) == 0 {
			for _, requestID := range registrationOrder {
				current, ok := pending[requestID]
				if !ok || current.answered {
					continue
				}
				current.answered = true
				pending[requestID] = current
				current.response <- command.payload
				close(command.accepted)
				return true
			}
		}
		q.queue = append(q.queue, command)
		q.settle()
		return true
	case countReplies:
		count := 0
		for _, current := range pending {
			count += len(current.response)
		}
		command.result <- count
		return true
	}
	return false
}

// closed reports whether ch has been closed. A nil channel never is.
func closed[T any](ch <-chan T) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}
