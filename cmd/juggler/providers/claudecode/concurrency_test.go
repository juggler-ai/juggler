//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"errors"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// setCLIConcurrency swaps the process-wide turn throttle for one of capacity n
// for the duration of a test, restoring the original on cleanup. Safe because
// the claudecode package tests run sequentially (no t.Parallel).
func setCLIConcurrency(t *testing.T, n int) {
	t.Helper()
	old := cliTurnSlots
	cliTurnSlots = newTurnSemaphore(n)
	t.Cleanup(func() { cliTurnSlots = old })
}

func TestResolveCLIMaxConcurrency(t *testing.T) {
	cases := []struct {
		env  string
		want int
	}{
		{"", defaultCLIMaxConcurrency},
		{"  ", defaultCLIMaxConcurrency}, // unparseable → default
		{"0", defaultCLIMaxConcurrency},  // non-positive → default
		{"-3", defaultCLIMaxConcurrency},
		{"x", defaultCLIMaxConcurrency},
		{"1", 1},
		{"12", 12},
	}
	for _, tc := range cases {
		if got := resolveCLIMaxConcurrency(tc.env); got != tc.want {
			t.Errorf("resolveCLIMaxConcurrency(%q) = %d, want %d", tc.env, got, tc.want)
		}
	}
}

// TestTurnSemaphore_BoundsAndUnblocks: a sem of capacity 2 admits two holders,
// blocks the third, and admits it the moment a holder releases.
func TestTurnSemaphore_BoundsAndUnblocks(t *testing.T) {
	sem := newTurnSemaphore(2)
	ctx := context.Background()

	r1, err := sem.acquire(ctx)
	if err != nil {
		t.Fatalf("acquire 1: %v", err)
	}
	r2, err := sem.acquire(ctx)
	if err != nil {
		t.Fatalf("acquire 2: %v", err)
	}
	if sem.inFlight() != 2 {
		t.Fatalf("inFlight = %d, want 2", sem.inFlight())
	}

	// Third acquire must block while the sem is full.
	got := make(chan func(), 1)
	go func() {
		r, _ := sem.acquire(ctx)
		got <- r
	}()
	select {
	case <-got:
		t.Fatal("third acquire succeeded past capacity 2")
	case <-time.After(50 * time.Millisecond):
	}

	// Releasing a slot must unblock the waiter promptly.
	r1()
	select {
	case r3 := <-got:
		r3()
	case <-time.After(time.Second):
		t.Fatal("release did not unblock the queued acquire")
	}
	r2()

	// Idempotent release: a second call must not over-free a slot.
	r1()
	if sem.inFlight() != 0 {
		t.Fatalf("after releases inFlight = %d, want 0 (double-release over-freed)", sem.inFlight())
	}
}

// TestTurnSemaphore_CancelWhileQueuedDoesNotHang is the deadlock-safety escape
// hatch: a turn cancelled while queued for a slot returns ctx.Err() instead of
// hanging — so even a cap of 1 can never wedge a cancellable turn.
func TestTurnSemaphore_CancelWhileQueuedDoesNotHang(t *testing.T) {
	sem := newTurnSemaphore(1)
	hold, err := sem.acquire(context.Background())
	if err != nil {
		t.Fatalf("initial acquire: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := sem.acquire(ctx)
		errc <- err
	}()

	// Confirm it is genuinely blocked, then cancel.
	select {
	case <-errc:
		t.Fatal("acquire succeeded despite a full semaphore")
	case <-time.After(50 * time.Millisecond):
	}
	cancel()

	select {
	case err := <-errc:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("queued acquire returned %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not unblock the queued acquire — would hang")
	}
	hold()
}

// TestTurnSemaphore_PausedTurnHoldsNoSlot is the load-bearing end-to-end
// property: a turn that pauses at a tool_use boundary (the shape of a turn
// that spawned subthreads and is awaiting their results) must release its slot
// when streamMessage returns — otherwise a parent could hold a slot its
// children need and deadlock under a small cap. With a cap of 1 we run such a
// turn and assert the sole slot is free afterwards.
func TestTurnSemaphore_PausedTurnHoldsNoSlot(t *testing.T) {
	setCLIConcurrency(t, 1)
	installFakeClaude(t, fakeModeToolUse, "uuid-park")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-park"

	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("do a tool")},
	}, nopCallback())
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if res.StopReason != "tool_use" {
		t.Fatalf("StopReason = %q, want tool_use", res.StopReason)
	}

	// The CLI is still alive and parked inside the tool call, but the turn
	// returned — so its slot must be free for the next (sub)conversation.
	if got := cliTurnSlots.inFlight(); got != 0 {
		t.Fatalf("slot still held after the turn paused (inFlight=%d) — a parked parent would block its subthreads", got)
	}

	c.dropSession(convID) // tears down the parked CLI
}

// TestQueuedTurnNeitherHoldsASlotNorDeafensCancel reproduces how one wedged
// claudecode turn took the whole provider down in production. Each retry of the
// stuck conversation queued behind the stuck turn on its session — holding one
// of the process-wide CLI turn slots while it waited, deaf to its own cancel,
// and having replaced the stuck turn's interrupt with its own. Four such turns
// and no conversation anywhere could start one; Stop reached none of them.
//
// A turn queued on its session must hold no slot, must leave when its context
// is cancelled, and must not stop cancelSession from interrupting the turn that
// is actually running.
func TestQueuedTurnNeitherHoldsASlotNorDeafensCancel(t *testing.T) {
	setCLIConcurrency(t, 2)
	tracePath := installFakeClaude(t, fakeModeNoResult, "uuid-queued")
	c := mkClient(t, "claude-sonnet-4-6")
	req := provider.MessageRequest{
		ConversationID: "conv-queued", SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}

	// Turn A: in flight, and stays so (fakeModeNoResult never answers).
	ctxA, cancelA := context.WithCancel(context.Background())
	t.Cleanup(cancelA) // runs before mkClient's closeSession, so a failed run still unwinds
	doneA := make(chan struct{})
	go func() {
		defer close(doneA)
		_, _ = c.streamMessage(ctxA, req, nopCallback())
	}()
	waitForFakeCLIUp(t, tracePath)

	// Turn B: the retry, queued behind A on the same session.
	ctxB, cancelB := context.WithCancel(context.Background())
	t.Cleanup(cancelB)
	doneB := make(chan error, 1)
	go func() {
		_, err := c.streamMessage(ctxB, req, nopCallback())
		doneB <- err
	}()

	// B must not take a slot while it waits. Nothing signals that B has reached
	// its wait, so watch long enough for a slot grab to show.
	for deadline := time.Now().Add(300 * time.Millisecond); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if n := cliTurnSlots.inFlight(); n > 1 {
			t.Fatalf("a turn queued behind another on its session holds a CLI turn slot (inFlight=%d)", n)
		}
	}

	cancelB()
	select {
	case err := <-doneB:
		if err == nil {
			t.Fatal("the queued turn returned no error after its context was cancelled")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a turn queued on its session ignored its own cancel")
	}

	// Stop must still reach the turn that is running.
	cancelled := make(chan struct{})
	go func() {
		c.cancelSession()
		close(cancelled)
	}()
	for _, ch := range []chan struct{}{doneA, cancelled} {
		select {
		case <-ch:
		case <-time.After(15 * time.Second):
			t.Fatal("cancelSession did not end the running turn — the queued turn's interrupt displaced it")
		}
	}
}
