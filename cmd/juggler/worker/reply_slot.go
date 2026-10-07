//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "encoding/json"

// A replySlot is the worker's request-id-keyed end of one kind of client
// round-trip. More than one request of the same kind may be outstanding; each
// registration owns its own one-deep answer channel.
//
// Requests are broadcast, so several clients may answer one id. The registry
// marks an id answered before handing its first reply to the waiter and refuses
// every later answer. An answer for another id is never a duplicate: it belongs
// to another thread's request and is routed only to that request's channel.
//
// The registry goroutine is the sole owner of the pending map. Callers and
// inbound dispatch communicate with it through channels, preserving the worker's
// actor architecture without adding a mutex.
type replySlot struct {
	name     string
	commands chan any
	done     <-chan struct{}
}

type replyRegistration struct {
	requestID string
	response  chan json.RawMessage
	cancel    chan struct{}
}

type registerReply struct {
	requestID string
	result    chan replyRegistration
}

type unregisterReply struct {
	requestID string
	cancel    chan struct{}
}

type deliverReply struct {
	payload json.RawMessage
}

// injectReply is the test-only uncorrelated answer (see inject). accepted is
// closed once the registry has taken it: handed to a registration, or made the
// one injection held for the next registration. Later injections wait unaccepted
// behind that one, so a feeder looping on inject runs one reply ahead and no more.
type injectReply struct {
	payload  json.RawMessage
	abort    <-chan struct{}
	accepted chan struct{}
}

type countReplies struct {
	result chan int
}

// newReplySlot builds and starts the registry for a named request type. It
// stops when done closes.
func newReplySlot(name string, done <-chan struct{}) *replySlot {
	s := &replySlot{name: name, commands: make(chan any), done: done}
	go s.run()
	return s
}

func (s *replySlot) run() {
	type pendingReply struct {
		response chan json.RawMessage
		cancel   chan struct{}
		answered bool
	}
	pending := make(map[string]pendingReply)
	var registrationOrder []string
	var injections []injectReply

	// settleInjections drops queued injections whose feeder has given up and
	// accepts whichever is now at the head. Only the head is ever accepted.
	settleInjections := func() {
		for len(injections) > 0 && closed(injections[0].abort) {
			injections = injections[1:]
		}
		if len(injections) > 0 && !closed(injections[0].accepted) {
			close(injections[0].accepted)
		}
	}

	for {
		var command any
		select {
		case command = <-s.commands:
		case <-s.done:
			return
		}
		switch command := command.(type) {
		case registerReply:
			response := make(chan json.RawMessage, 1)
			cancel := make(chan struct{})
			entry := pendingReply{response: response, cancel: cancel}
			settleInjections()
			if len(injections) > 0 {
				entry.answered = true
				response <- injections[0].payload
				injections = injections[1:]
				settleInjections()
			}
			pending[command.requestID] = entry
			registrationOrder = append(registrationOrder, command.requestID)
			command.result <- replyRegistration{requestID: command.requestID, response: response, cancel: cancel}
		case unregisterReply:
			if current, ok := pending[command.requestID]; ok && current.cancel == command.cancel {
				delete(pending, command.requestID)
				for i, requestID := range registrationOrder {
					if requestID == command.requestID {
						registrationOrder = append(registrationOrder[:i], registrationOrder[i+1:]...)
						break
					}
				}
			}
		case deliverReply:
			var head struct {
				RequestID string `json:"requestId"`
			}
			if json.Unmarshal(command.payload, &head) != nil || head.RequestID == "" {
				continue
			}
			current, ok := pending[head.RequestID]
			if !ok {
				// Nothing is waiting on this id: the request either timed out —
				// failing its turn — or was cancelled, and its registration is
				// gone. The answer is useless now, but its stamps are the only
				// surviving account of where the budget went, so they are worth
				// a line before it is dropped.
				reportDroppedReply(s.name, command.payload)
				continue
			}
			if current.answered {
				// A second client answering a broadcast request. Routine.
				continue
			}
			current.answered = true
			pending[head.RequestID] = current
			current.response <- command.payload
		case injectReply:
			if closed(command.abort) {
				continue
			}
			injected := false
			if len(injections) == 0 {
				for _, requestID := range registrationOrder {
					current, ok := pending[requestID]
					if !ok || current.answered {
						continue
					}
					current.answered = true
					pending[requestID] = current
					current.response <- command.payload
					close(command.accepted)
					injected = true
					break
				}
			}
			if !injected {
				injections = append(injections, command)
				settleInjections()
			}
		case countReplies:
			count := 0
			for _, current := range pending {
				count += len(current.response)
			}
			command.result <- count
		}
	}
}

// register opens one request id and returns its private answer channel plus an
// unregister function. The unregister is identity-checked, so a late cleanup
// cannot remove a newer registration that happens to reuse an id.
func (s *replySlot) register(requestID string) (<-chan json.RawMessage, func()) {
	result := make(chan replyRegistration)
	select {
	case s.commands <- registerReply{requestID: requestID, result: result}:
	case <-s.done:
		return nil, func() {}
	}
	var registration replyRegistration
	select {
	case registration = <-result:
	case <-s.done:
		return nil, func() {}
	}
	return registration.response, func() {
		select {
		case s.commands <- unregisterReply{requestID: registration.requestID, cancel: registration.cancel}:
		case <-s.done:
		}
	}
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

// deliver routes an inbound reply to the registration named by requestId. The
// registry accepts exactly one answer per id and silently drops malformed,
// unknown, late, and duplicate replies.
func (s *replySlot) deliver(payload json.RawMessage) {
	select {
	case s.commands <- deliverReply{payload: payload}:
	case <-s.done:
	}
}
