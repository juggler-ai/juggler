//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// hookRec captures a run-strategy-hook the worker dispatched to the engine.
type hookRec struct {
	hook       string
	strategyID string
	threadID   string
	prev       string
	reqID      string
}

// drainHooks collects up to n hook records within the deadline.
func drainHooks(t *testing.T, ch chan hookRec, n int) []hookRec {
	t.Helper()
	var got []hookRec
	deadline := time.After(5 * time.Second)
	for len(got) < n {
		select {
		case rec := <-ch:
			got = append(got, rec)
		case <-deadline:
			return got
		}
	}
	return got
}
