//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"testing"
	"time"
)

// TestYcrdtWatchdogRunsWhileAWorkerDoes pins the stall watchdog's lifetime to
// the workers'. It samples the doc lock on a ticker, which is worth paying for
// only while something is taking the lock in earnest: a process importing this
// package for anything else — a CLI subcommand, another package's tests — must
// not carry a ticker and a goroutine it never stops. So each running worker
// holds the watchdog, the first starts it and the last stops it.
//
// Other tests in this package can leave workers running, so the count is read
// relative to where this test found it rather than from zero.
func TestYcrdtWatchdogRunsWhileAWorkerDoes(t *testing.T) {
	before, _ := ycrdtWatchdogState()

	release := holdYcrdtWatchdog()
	if holders, running := ycrdtWatchdogState(); holders != before+1 || !running {
		t.Fatalf("held: holders=%d running=%v, want %d and running", holders, running, before+1)
	}
	release()
	release() // idempotent: a holder releases once however often it is told to
	if holders, running := ycrdtWatchdogState(); holders != before || running != (before > 0) {
		t.Fatalf("released: holders=%d running=%v, want %d and running=%v", holders, running, before, before > 0)
	}

	w := NewConversationWorker("conv-watchdog", "user:test")
	defer w.doc.Destroy()
	w.Start(context.Background())
	deadline := time.Now().Add(5 * time.Second)
	for {
		if holders, running := ycrdtWatchdogState(); holders == before+1 && running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a running worker does not hold the watchdog")
		}
		time.Sleep(time.Millisecond)
	}
	w.Stop()
	if holders, running := ycrdtWatchdogState(); holders != before || running != (before > 0) {
		t.Fatalf("after Stop: holders=%d running=%v, want %d and running=%v", holders, running, before, before > 0)
	}
}

// ycrdtWatchdogState reports how many holders the watchdog has and whether it
// is running.
func ycrdtWatchdogState() (holders int, running bool) {
	g := &ycrdtWatchdog
	g.lock <- struct{}{}
	defer func() { <-g.lock }()
	return g.holders, g.stop != nil
}
