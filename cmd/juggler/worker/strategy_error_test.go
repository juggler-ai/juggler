//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
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
	w.llmCallFunc = func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		return nil, want
	}

	_, err := w.callLLM(nil)
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
	w.llmCallFunc = func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		calls++
		return nil, &provider.ContextLimitExceededError{
			EstimatedInputTokens: 200,
			OutputReserveTokens:  50,
			ContextWindowTokens:  128,
		}
	}

	_, err := w.callLLMWithRetry(nil)
	var exceeded *provider.ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("callLLMWithRetry error = %T %v, want ContextLimitExceededError", err, err)
	}
	if calls != 1 {
		t.Fatalf("provider calls = %d, want 1", calls)
	}
}

func TestCallLLMWithRetryRetriesRateAndTransientErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{name: "rate limit", err: &RateLimitError{Wait: time.Nanosecond, Message: "rate limited in 0.001s"}},
		{name: "transient", err: &TransientError{Wait: time.Nanosecond, Message: "connection dropped"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			calls := 0
			w.llmCallFunc = func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
				calls++
				if calls == 1 {
					return nil, test.err
				}
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered"}}}, nil
			}

			response, err := w.callLLMWithRetry(nil)
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

func TestClassifyLLMErrorPreservesTypedCause(t *testing.T) {
	tests := []struct {
		name string
		msg  string
		want any
	}{
		{name: "rate limit", msg: "HTTP 429 rate limited", want: (*RateLimitError)(nil)},
		{name: "transient", msg: providerutils.StallMarker, want: (*TransientError)(nil)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cause := fmt.Errorf("%s", tt.msg)
			err := classifyLLMError(tt.msg, cause)
			if !errors.Is(err, cause) {
				t.Fatalf("classified error %v does not preserve cause", err)
			}
			switch tt.want.(type) {
			case *RateLimitError:
				var got *RateLimitError
				if !errors.As(err, &got) {
					t.Fatalf("error = %T %v, want RateLimitError", err, err)
				}
			case *TransientError:
				var got *TransientError
				if !errors.As(err, &got) {
					t.Fatalf("error = %T %v, want TransientError", err, err)
				}
			}
		})
	}
}

func TestClassifyLLMResponseErrorCompatibility(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.llmCallFunc = func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Error: "HTTP 429 rate limited"}, nil
	}

	_, err := w.callLLM(nil)
	var rateLimit *RateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("callLLM error = %T %v, want RateLimitError", err, err)
	}
}
