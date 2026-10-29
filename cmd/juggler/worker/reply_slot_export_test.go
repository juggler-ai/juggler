//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

import "encoding/json"

// inject queues a test-only answer for the next registration. Production has no
// uncorrelated route into a reply registry; older worker harnesses intentionally
// use this bypass because they prepare replies before observing request ids.
//
// It returns true once the registry has taken the payload: handed it to the
// oldest unanswered registration, or held it as the one answer waiting for the
// next. While an answer is already held it blocks, so a feeder looping on inject
// runs exactly one reply ahead per slot instead of spinning and queueing without
// bound. One held answer per slot is enough for a caller that queues a context
// and a tools reply serially before dispatching the turn. It returns false if
// abort or the worker's done closes first.
func (s *replySlot) inject(abort <-chan struct{}, payload json.RawMessage) bool {
	command := injectReply{payload: payload, abort: abort, accepted: make(chan struct{})}
	select {
	case s.commands <- command:
	case <-abort:
		return false
	case <-s.done:
		return false
	}
	select {
	case <-command.accepted:
		return true
	case <-abort:
		return false
	case <-s.done:
		return false
	}
}

// held reports the number of accepted replies currently buffered across all
// registrations.
func (s *replySlot) held() int {
	result := make(chan int)
	s.commands <- countReplies{result: result}
	return <-result
}
