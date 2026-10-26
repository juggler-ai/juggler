//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"testing"
	"time"
)

// A burst of inventory changes is published once, and a change after that
// publish publishes again.
func TestProcessesCoalesceBursts(t *testing.T) {
	published := make(chan struct{}, 16)
	changed := coalesce(500*time.Millisecond, func() { published <- struct{}{} })

	for range 5 {
		changed()
	}
	select {
	case <-published:
	case <-time.After(5 * time.Second):
		t.Fatal("a burst of changes published nothing")
	}
	select {
	case <-published:
		t.Fatal("a burst of changes was published more than once")
	case <-time.After(700 * time.Millisecond):
	}

	changed()
	select {
	case <-published:
	case <-time.After(5 * time.Second):
		t.Fatal("a change after the burst published nothing")
	}
}
