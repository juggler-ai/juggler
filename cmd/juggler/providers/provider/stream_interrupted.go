//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import "time"

// StreamInterruptedError is a stream's terminal error together with how the
// stream had gone until then (utils.StreamSession.Annotate builds it). Its text
// is the cause's plus a note of how long the stream ran and when its last event
// came; LastEvent carries that moment as a value, for the worker's retry
// budget: a stream still delivering events was alive until then, whether or not
// any of them was output a user can see — a reasoning model thinking with no
// summary sends events and nothing visible for minutes.
type StreamInterruptedError struct {
	Err       error
	Text      string    // the full annotated message
	LastEvent time.Time // zero when no event arrived
}

func (e *StreamInterruptedError) Error() string { return e.Text }
func (e *StreamInterruptedError) Unwrap() error { return e.Err }
