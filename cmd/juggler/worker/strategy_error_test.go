//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"testing"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	providerutils "juggler/cmd/juggler/providers/utils"
)

func TestCallLLMPreservesTypedProviderError(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	want := &provider.ContextLimitExceededError{
		EstimatedInputTokens: 200,
		OutputReserveTokens:  50,
		ContextWindowTokens:  128,
	}
	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		return nil, want
	})

	_, err := w.currentRun().callLLM(nil)
	var got *provider.ContextLimitExceededError
	if !errors.As(err, &got) {
		t.Fatalf("callLLM error = %T %v, want ContextLimitExceededError", err, err)
	}
	if got != want {
		t.Fatalf("errors.As returned %p, want original error %p", got, want)
	}
}

func TestCallLLMWithRetryDoesNotRetryContextLimitError(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	calls := 0
	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		calls++
		return nil, &provider.ContextLimitExceededError{
			EstimatedInputTokens: 200,
			OutputReserveTokens:  50,
			ContextWindowTokens:  128,
		}
	})

	_, err := w.currentRun().callLLMWithRetry(nil)
	var exceeded *provider.ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("callLLMWithRetry error = %T %v, want ContextLimitExceededError", err, err)
	}
	if calls != 1 {
		t.Fatalf("provider calls = %d, want 1", calls)
	}
}

// fastRetries takes the backoff out of w's retry sequences, so a test can drive
// a whole one without sleeping through it. The attempts are the real policy's.
func fastRetries(w *ConversationWorker) {
	w.retryBackoffLimit = 0
}

// failing builds the turn loop's error for a provider failure of kind.
func failing(kind provider.FailureKind, message string) *LLMError {
	return &LLMError{Failure: provider.Failure{Kind: kind}, Message: "LLM error: " + message}
}

// TestCallLLMWithRetryFollowsThePolicy drives each shape of provider failure
// through the turn loop against a provider that never recovers, and counts the
// calls. A retryable kind makes as many as its retryPolicy row allows; a
// terminal one makes exactly one. The errors are what the providers actually
// return, not the worker's own types, so the classification is under test too.
func TestCallLLMWithRetryFollowsThePolicy(t *testing.T) {
	attempts := func(kind provider.FailureKind) int {
		rule, ok := retryRuleFor(kind)
		if !ok {
			t.Fatalf("%v has no retry rule", kind)
		}
		return rule.attempts
	}
	tests := []struct {
		name string
		err  error
		want int
	}{
		// The reported case: a stream that died mid-body.
		{"unexpected EOF mid-stream", fmt.Errorf("anthropic streaming error: %w (the stream ran for 41.2s; its last event came 0.3s before the failure)", io.ErrUnexpectedEOF), attempts(provider.FailureConnectionDropped)},
		{"connection reset", &net.OpError{Op: "read", Net: "tcp", Err: os.NewSyscallError("read", syscall.ECONNRESET)}, attempts(provider.FailureConnectionDropped)},
		{"stall", providerutils.StallError("anthropic", 90*time.Second), attempts(provider.FailureStalled)},
		{"truncated stream", provider.NewFailureError(provider.FailureTruncated, "stream ended before message_stop", nil), attempts(provider.FailureTruncated)},
		{"500", &provider.APIError{Provider: "anthropic", Status: 500, Type: "api_error", Message: "Internal server error"}, attempts(provider.FailureServerError)},
		{"529", &provider.APIError{Provider: "anthropic", Status: 529, Type: "overloaded_error", Message: "Overloaded"}, attempts(provider.FailureOverloaded)},
		{"refused dial", &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}, attempts(provider.FailureUnreachable)},
		{"unusable output", &provider.UnusableOutputError{Message: "no usable tool call"}, attempts(provider.FailureUnusableOutput)},
		{"unrecognised", errors.New("something odd happened"), attempts(provider.FailureUnknown)},
		{"rate limit with a stated wait", &provider.RateLimitedError{RetryAfter: time.Nanosecond, Message: "429"}, attempts(provider.FailureRateLimited)},

		{"bad request", &provider.APIError{Provider: "openai", Status: 400, Message: "max_tokens too large"}, 1},
		{"out of credit", &provider.APIError{Provider: "openai", Status: 429, Type: "insufficient_quota"}, 1},
		{"server says do not retry", &provider.APIError{Provider: "anthropic", Status: 500, ShouldRetry: new(bool)}, 1},
		{"safety refusal", errors.New("gemini blocked response due to safety filters"), 1},
		{"certificate", &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}, 1},
		{"provider already retried", &provider.FailureError{Failure: provider.Failure{Kind: provider.FailureOverloaded, ProviderRetried: true}, Message: "ladder exhausted"}, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			fastRetries(w)
			calls := 0
			w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
				calls++
				return nil, tt.err
			})
			if _, err := w.currentRun().callLLMWithRetry(nil); err == nil {
				t.Fatal("callLLMWithRetry succeeded against a provider that always fails")
			} else if !errors.Is(err, tt.err) {
				t.Errorf("surfaced error %v does not wrap the provider's %v", err, tt.err)
			}
			if calls != tt.want {
				t.Fatalf("provider calls = %d, want %d", calls, tt.want)
			}
		})
	}
}

// TestRetryBackoffGrows pins the backoff curve: doubling from the base, capped
// at the ceiling, with no more than a quarter added as jitter.
func TestRetryBackoffGrows(t *testing.T) {
	rule := retryRule{base: 2 * time.Second, ceiling: 30 * time.Second}
	for _, tc := range []struct {
		retry int
		want  time.Duration
	}{{1, 2 * time.Second}, {2, 4 * time.Second}, {3, 8 * time.Second}, {4, 16 * time.Second}, {5, 30 * time.Second}, {12, 30 * time.Second}} {
		for range 20 {
			if got := rule.backoff(tc.retry); got < tc.want || got > tc.want+tc.want/4 {
				t.Fatalf("backoff(%d) = %v, want %v plus at most a quarter", tc.retry, got, tc.want)
			}
		}
	}
}

// TestRetryPlanPrefersTheStatedWait: a provider that said how long to wait is
// believed over the backoff curve.
func TestRetryPlanPrefersTheStatedWait(t *testing.T) {
	err := &LLMError{Failure: provider.Failure{Kind: provider.FailureOverloaded, RetryAfter: 7 * time.Second}}
	// A limit far below the stated wait: the limit governs only computed waits.
	if wait, _, ok := err.retryPlan(1, time.Millisecond); !ok || wait != 7*time.Second {
		t.Fatalf("retryPlan(1) = %v, %v; want the stated 7s", wait, ok)
	}
}

// TestCallLLMSurfacesARacedCancelAsCancellation: the provider can report the
// user's cancel (context.Canceled) before the cancel reaches the wait. That is
// the Stop the user asked for, not an error to show them.
func TestCallLLMSurfacesARacedCancelAsCancellation(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	r := w.currentRun()
	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		r.storeState(StateCancelling)
		return nil, fmt.Errorf("anthropic streaming error: %w", context.Canceled)
	})
	if _, err := r.callLLMWithRetry(nil); !errors.Is(err, ErrCancelled) {
		t.Fatalf("error = %v, want ErrCancelled", err)
	}
}

func TestCallLLMWithRetryRetriesRateAndTransientErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{name: "rate limit", err: &RateLimitError{Wait: time.Nanosecond, Message: "rate limited in 0.001s"}},
		{name: "transient", err: failing(provider.FailureConnectionDropped, "connection dropped")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			fastRetries(w)
			calls := 0
			w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
				calls++
				if calls == 1 {
					return nil, test.err
				}
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered"}}}, nil
			})

			response, err := w.currentRun().callLLMWithRetry(nil)
			if err != nil {
				t.Fatalf("callLLMWithRetry: %v", err)
			}
			if calls != 2 {
				t.Fatalf("provider calls = %d, want 2", calls)
			}
			if len(response.Blocks) != 1 || response.Blocks[0].Content != "recovered" {
				t.Fatalf("response = %+v, want recovered response", response)
			}
		})
	}
}

// TestCallLLMWithRetryResendsUnusableOutput: a provider that abandoned a turn
// because the model's output could not be acted on gets the same request again,
// and the fresh attempt's answer is the turn's result.
func TestCallLLMWithRetryResendsUnusableOutput(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	fastRetries(w)

	calls := 0
	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		calls++
		if calls == 1 {
			return nil, &provider.UnusableOutputError{Message: "model called tools by names the session does not serve"}
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered"}}}, nil
	})

	response, err := w.currentRun().callLLMWithRetry(nil)
	if err != nil {
		t.Fatalf("callLLMWithRetry: %v", err)
	}
	if calls != 2 {
		t.Fatalf("provider calls = %d, want 2", calls)
	}
	if len(response.Blocks) != 1 || response.Blocks[0].Content != "recovered" {
		t.Fatalf("response = %+v, want recovered response", response)
	}
}

// TestCallLLMWithRetryStopsWhenRetryBudgetSpent: retries are bounded by
// wall-clock as well as by count. When a single attempt is expensive — a
// provider CLI that runs its own internal backoff ladder against an overloaded
// upstream before reporting anything — MaxLLMRetries alone bounds nothing, and
// three attempts become a quarter-hour of silence.
func TestCallLLMWithRetryStopsWhenRetryBudgetSpent(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	calls := 0
	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		calls++
		return nil, failing(provider.FailureOverloaded, "overloaded")
	})

	// Earlier attempts in this sequence already used the whole allowance.
	w.turn.retrySpent = MaxLLMRetryWindow

	_, err := w.currentRun().callLLMWithRetry(nil)
	if err == nil {
		t.Fatal("expected the transient error to surface once the retry budget was spent")
	}
	if calls != 1 {
		t.Fatalf("provider calls = %d, want 1 — an exhausted budget must not buy another attempt", calls)
	}
	if w.turn.retrySpent != 0 {
		t.Fatalf("turn.retrySpent = %v, want 0 — the budget must reset when the sequence ends", w.turn.retrySpent)
	}
}

// TestCallLLMWithRetryChargesOnlyTheSilentTail: an attempt that streamed real
// content for a long time and was then cut off by the server failed only from
// its last content onwards. Charging its whole duration let a single upstream
// reset after a long productive stream exhaust the budget on its own, so the
// one error that most deserved a fresh attempt never got one.
func TestCallLLMWithRetryChargesOnlyTheSilentTail(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	fastRetries(w)

	// Less budget left than the first attempt spends streaming.
	const streaming = 2 * time.Second
	w.turn.retrySpent = MaxLLMRetryWindow - 500*time.Millisecond

	calls := 0
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		calls++
		if calls == 1 {
			time.Sleep(streaming)
			sink(StreamChunk{Type: provider.ContentBlockTypeThinking, Content: "still working"})
			return nil, errors.New("stream error: stream ID 5; INTERNAL_ERROR; received from peer")
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered"}}}, nil
	})

	if _, err := w.currentRun().callLLMWithRetry(nil); err != nil {
		t.Fatalf("callLLMWithRetry: %v — the attempt was charged for the time it spent streaming", err)
	}
	if calls != 2 {
		t.Fatalf("provider calls = %d, want 2", calls)
	}
}

// TestCallLLMWithRetryChargesSilentAttemptInFull: the other half — an attempt
// that produced nothing but status chunks spent its whole duration failing.
// Liveness is not progress.
func TestCallLLMWithRetryChargesSilentAttemptInFull(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.turn.retrySpent = MaxLLMRetryWindow - 50*time.Millisecond

	calls := 0
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		calls++
		time.Sleep(100 * time.Millisecond)
		sink(StreamChunk{Type: provider.ContentBlockTypeStatus, Content: "Waiting for response"})
		return nil, failing(provider.FailureOverloaded, "overloaded")
	})

	if _, err := w.currentRun().callLLMWithRetry(nil); err == nil {
		t.Fatal("expected the transient error to surface once the silent attempt spent the budget")
	}
	if calls != 1 {
		t.Fatalf("provider calls = %d, want 1 — a status chunk must not count as progress", calls)
	}
}

// TestCallLLMWithRetryChargesFromTheStreamsLastEvent: a reasoning model
// thinking with no summary streams events but no output a chunk carries, for
// minutes. When the server then resets the stream, the attempt was alive until
// its last event; charging it from its last visible output instead let one
// cut-off of a long silent think spend the budget and surface unretried.
func TestCallLLMWithRetryChargesFromTheStreamsLastEvent(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	fastRetries(w)

	// Less budget left than the first attempt spends thinking.
	const thinking = 2 * time.Second
	w.turn.retrySpent = MaxLLMRetryWindow - 500*time.Millisecond

	calls := 0
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		if calls == 1 {
			time.Sleep(thinking)
			return nil, &provider.StreamInterruptedError{
				Err:       errors.New("stream error: stream ID 263; INTERNAL_ERROR; received from peer"),
				Text:      "stream error: stream ID 263; INTERNAL_ERROR; received from peer (the stream ran for 2s; its last event came 0s before the failure)",
				LastEvent: time.Now(),
			}
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered"}}}, nil
	})

	if _, err := w.currentRun().callLLMWithRetry(nil); err != nil {
		t.Fatalf("callLLMWithRetry: %v — the attempt was charged for the time it spent thinking", err)
	}
	if calls != 2 {
		t.Fatalf("provider calls = %d, want 2", calls)
	}
}

// TestRetryingStatusClearedOnlyByContent: the "retrying" spinner must survive
// into the next attempt and be cleared only by real content. Clearing it on
// anything weaker is what let the UI report "Receiving" for minutes while the
// fresh attempt was still silently backing off.
func TestRetryingStatusClearedOnlyByContent(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.currentRun().sendRetryingStatus(msg.New("Rate limited, retrying (1/3)"))
	if !w.turn.retryStatusActive {
		t.Fatal("sendRetryingStatus must latch the retrying label")
	}

	// A provider phase label is liveness, not progress.
	w.currentRun().processStreamChunk(StreamChunk{Type: provider.ContentBlockTypeStatus, Content: "Waiting for response"})
	if !w.turn.retryStatusActive {
		t.Fatal("a status chunk cleared the retrying label — only real content may")
	}

	w.currentRun().processStreamChunk(StreamChunk{Type: provider.ContentBlockTypeText, Content: "hello"})
	if w.turn.retryStatusActive {
		t.Fatal("real content must clear the retrying label")
	}
}

func TestClassifyLLMErrorPreservesTypedCause(t *testing.T) {
	tests := []struct {
		name string
		msg  string
		want provider.FailureKind
	}{
		{name: "rate limit", msg: "HTTP 429 rate limited", want: provider.FailureRateLimited},
		{name: "stall", msg: providerutils.StallMarker, want: provider.FailureStalled},
		{name: "upstream overload", msg: `{"type":"service_unavailable_error","code":"server_is_overloaded"}`, want: provider.FailureOverloaded},
		{name: "unexpected eof", msg: "unexpected EOF", want: provider.FailureConnectionDropped},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cause := fmt.Errorf("%s", tt.msg)
			err := classifyLLMError(tt.msg, cause)
			if !errors.Is(err, cause) {
				t.Fatalf("classified error %v does not preserve cause", err)
			}
			if tt.want == provider.FailureRateLimited {
				var got *RateLimitError
				if !errors.As(err, &got) {
					t.Fatalf("error = %T %v, want RateLimitError", err, err)
				}
				return
			}
			var got *LLMError
			if !errors.As(err, &got) || got.Failure.Kind != tt.want {
				t.Fatalf("error = %T %v, want an LLMError of kind %v", err, err, tt.want)
			}
		})
	}
}

// codexUsageLimitBody is the body a ChatGPT-subscription account's hard usage
// cap returns with its 429: not a per-minute throttle but "come back in four
// hours". The delay is stated as a field, and reading it is the difference
// between resting once and every thread finding out for itself.
const codexUsageLimitBody = `{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1789081159,"resets_in_seconds":14476}`

func TestClassifyLLMErrorReadsUsageLimitResetFromBody(t *testing.T) {
	msg := `POST "https://chatgpt.com/backend-api/codex/responses": 429 Too Many Requests ` + codexUsageLimitBody

	err := classifyLLMError(msg, nil)
	var rateLimit *RateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("error = %T %v, want RateLimitError", err, err)
	}
	if want := 14476 * time.Second; rateLimit.Wait != want {
		t.Fatalf("Wait = %v, want %v — the cap states its own reset, so nothing may guess", rateLimit.Wait, want)
	}
	if rateLimit.ResetAt.IsZero() {
		t.Fatal("ResetAt is zero — a stated reset must arrive as a wall-clock time, since that is what stands over the conversation")
	}
}

// TestCallLLMWithRetryDoesNotRetryPastTheReset: three attempts two seconds apart
// buy nothing against a cap that lifts in four hours; they only spend the
// account's next window. A hint the budget cannot cover is terminal on the spot.
func TestCallLLMWithRetryDoesNotRetryPastTheReset(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	calls := 0
	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		calls++
		return nil, &RateLimitError{Wait: 5 * time.Second, Message: "usage limit reached"}
	})

	// Leaves a second of the allowance — far less than the wait the provider asked for.
	w.turn.retrySpent = MaxLLMRetryWindow - time.Second

	_, err := w.currentRun().callLLMWithRetry(nil)
	var rateLimit *RateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("error = %T %v, want the rate limit to surface", err, err)
	}
	if calls != 1 {
		t.Fatalf("provider calls = %d, want 1 — a wait past the budget must not buy another attempt", calls)
	}
}

func TestClassifyLLMResponseErrorCompatibility(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Error: "HTTP 429 rate limited"}, nil
	})

	_, err := w.currentRun().callLLM(nil)
	var rateLimit *RateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("callLLM error = %T %v, want RateLimitError", err, err)
	}
}
