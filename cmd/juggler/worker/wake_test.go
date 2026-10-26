//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// wakeBudget bounds how long the stub provider below sits on a ctx nobody
// cancelled. A test-local patience limit, not a product constant: the interrupt
// it waits for is a handful of goroutine handoffs away, so a passing run spends
// none of it, and on a CI box running every package's tests at once under -race,
// losing those goroutines the CPU for several seconds is ordinary.
//
// It is what lets the wake be asserted through the error the turn carries rather
// than through elapsed time. The product's own backstop is the 30-minute
// LLMTimeout, and a stub that waited for it to prove the interrupt never arrived
// would outlast the package's `-timeout 5m`, reporting a killed package with no
// named failure in place of this test.
const wakeBudget = 20 * time.Second

// TestSystemWakeInterruptsInFlightLLM verifies the recovery path for a
// request orphaned by a system sleep: when the OS reports the system woke,
// an in-flight LLM call is cancelled immediately (rather than waiting out
// the LLMTimeout backstop) and the turn fails with a clear, retryable
// message. Models the real failure: the provider's connection is dropped
// across sleep, so the call would otherwise block forever on a read.
func TestSystemWakeInterruptsInFlightLLM(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	providerStarted := make(chan struct{})
	// A provider whose connection died across sleep: it blocks until the
	// per-turn ctx is cancelled, then returns ctx.Err() — exactly what the
	// claudecode read loop does on ctx.Done(). An interrupt that never lands
	// leaves it holding a ctx that is never cancelled, so it gives up by itself
	// and says so: the turn then carries that text instead of the wake's, which
	// is what the assertion below reads.
	w.SetLLMCaller(func(ctx context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		close(providerStarted)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wakeBudget):
			return nil, errors.New("the per-turn ctx was never cancelled")
		}
	})

	go func() {
		<-providerStarted
		w.currentRun().interruptInFlightLLMForWake()
	}()

	_, err := w.currentRun().callLLM(nil)

	if err == nil {
		t.Fatal("expected callLLM to return an error after a system-wake interrupt, got nil")
	}
	// The message carries the whole verdict, and it cannot be produced by a slow
	// runner: only an interrupt that reached the in-flight call and unblocked it
	// names the sleep. A wake that never arrived leaves the stub's own text here,
	// and one that arrived too late to be the reason cannot beat the stub to it.
	low := strings.ToLower(err.Error())
	if !strings.Contains(low, "sleep") && !strings.Contains(low, "wake") {
		t.Errorf("expected a sleep/wake interruption message, got: %v", err)
	}
}

// TestLLMTimeoutCancelsTheCall: when the LLMTimeout backstop gives up on a call,
// the call must be cancelled too. Abandoning only the wait left the provider
// running on a live context until the server shut down — in the claudecode
// provider, holding its session and a process-wide CLI turn slot for hours
// while each retry queued behind it.
func TestLLMTimeoutCancelsTheCall(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.llmTimeout = 100 * time.Millisecond

	callCancelled := make(chan struct{})
	w.SetLLMCaller(func(ctx context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		select {
		case <-ctx.Done():
			close(callCancelled)
			return nil, ctx.Err()
		case <-time.After(wakeBudget):
			return nil, errors.New("the call's ctx was never cancelled")
		}
	})

	if _, err := w.currentRun().callLLM(nil); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("callLLM = %v, want the LLMTimeout error", err)
	}
	select {
	case <-callCancelled:
	case <-time.After(wakeBudget):
		t.Fatal("the timed-out call was left running: its context was never cancelled")
	}
}

// TestManagerSystemDidWakeFansOut verifies the Manager forwards a system-wake
// notification to every worker it owns, cancelling each worker's in-flight
// LLM context. Asserts the manager→worker plumbing independent of provider
// details by installing a sentinel cancel func.
func TestManagerSystemDidWakeFansOut(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown()

	w := manager.GetOrCreate("conv-wake", "user:test")

	cancelled := make(chan struct{})
	var cf context.CancelFunc = func() { close(cancelled) }
	w.turn.cancelLLM.Store(&cf)

	manager.SystemDidWake()

	select {
	case <-cancelled:
		// Manager reached the worker and invoked its in-flight cancel.
	case <-time.After(2 * time.Second):
		t.Fatal("Manager.SystemDidWake did not cancel the worker's in-flight LLM context")
	}
}
