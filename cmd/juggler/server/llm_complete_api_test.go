//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"testing"
	"time"
)

// TestClampCompleteTimeout pins how a caller-supplied wall-clock bound is
// treated. Out-of-band completions are asked for by plugin code, so the value
// arrives untrusted: an absent one must mean "no preference" rather than "no
// time at all", and an over-patient one must not be able to hold one of the four
// shared pool slots indefinitely.
func TestClampCompleteTimeout(t *testing.T) {
	tests := []struct {
		name string
		ms   int64
		want time.Duration
	}{
		{"absent means the default", 0, llmCompleteDefaultTimeout},
		{"negative means the default", -1, llmCompleteDefaultTimeout},
		{"honoured inside the band", 5000, 5 * time.Second},
		{"a too-eager bound is floored", 10, llmCompleteMinTimeout},
		{"an over-patient bound is capped", int64(llmCompleteMaxTimeout/time.Millisecond) + 60_000, llmCompleteMaxTimeout},
		// The clamp must survive a value that would overflow the multiply into a
		// negative Duration — which context.WithTimeout treats as already expired,
		// so an absurd request would otherwise fail instantly instead of waiting.
		{"an absurd bound cannot overflow into an expired context", math.MaxInt64, llmCompleteMaxTimeout},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := clampCompleteTimeout(tc.ms)
			if got != tc.want {
				t.Fatalf("clampCompleteTimeout(%d) = %v, want %v", tc.ms, got, tc.want)
			}
			if got <= 0 {
				t.Fatalf("clampCompleteTimeout(%d) = %v: a non-positive bound expires immediately", tc.ms, got)
			}
		})
	}
}

// TestCompleteErrorStatus pins the status each failure is reported under. The
// status is the contract a client classifies on — the message is prose written
// for a human and is free to change — and these three need entirely different
// responses: wait a moment, try again more patiently, or stop. Collapsing the
// first two into 502 is what left the auto-approve reviewer unable to tell a
// slow model from a dead credential.
func TestCompleteErrorStatus(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{"a saturated pool is retryable", ErrQuickCompleteBusy, http.StatusTooManyRequests},
		{"wrapped, still retryable", fmt.Errorf("quick complete: %w", ErrQuickCompleteBusy), http.StatusTooManyRequests},
		{"our own bound elapsing is a gateway timeout", ErrQuickCompleteTimeout, http.StatusGatewayTimeout},
		{"wrapped, still a timeout", fmt.Errorf("submit: %w", ErrQuickCompleteTimeout), http.StatusGatewayTimeout},
		{"anything else is a bad gateway", errors.New("provider returned 500"), http.StatusBadGateway},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			status, msg := completeErrorStatus(tc.err)
			if status != tc.want {
				t.Fatalf("completeErrorStatus(%v) status = %d, want %d", tc.err, status, tc.want)
			}
			if msg == "" {
				t.Fatalf("completeErrorStatus(%v) returned an empty message", tc.err)
			}
		})
	}

	// An unclassified failure must keep its own text: that text is the only thing
	// telling the user a credential died rather than the model being slow.
	if _, msg := completeErrorStatus(errors.New("provider \"openai\" unavailable: no credential")); msg != "provider \"openai\" unavailable: no credential" {
		t.Fatalf("an unclassified failure must surface verbatim, got %q", msg)
	}
}

// TestQuickCompleteTimeoutUnwrapsToDeadlineExceeded pins that the timeout
// sentinel still unwraps to context.DeadlineExceeded. The auto-namer's retry
// classification (autoNameTransient) keys on exactly that, so a sentinel that
// stopped unwrapping would silently stop it re-attempting a slow completion.
func TestQuickCompleteTimeoutUnwrapsToDeadlineExceeded(t *testing.T) {
	if !errors.Is(ErrQuickCompleteTimeout, context.DeadlineExceeded) {
		t.Fatal("ErrQuickCompleteTimeout must unwrap to context.DeadlineExceeded")
	}
	if !autoNameTransient(context.Background(), ErrQuickCompleteTimeout) {
		t.Fatal("a per-call timeout must still read as transient to the auto-namer")
	}
	// The caller's own budget expiring is a different thing and stays fatal.
	dead, cancel := context.WithCancel(context.Background())
	cancel()
	if autoNameTransient(dead, ErrQuickCompleteTimeout) {
		t.Fatal("an expired parent budget must never be retryable")
	}
}
