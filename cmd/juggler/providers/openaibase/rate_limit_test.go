//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openai/openai-go/v3"

	"juggler/cmd/juggler/providers/provider"
)

// A 429 recognised from the message text alone — the shape a codex usage cap
// arrives in, since the SDK folds the response body into its error string.
// enhanceError must produce the typed refusal carrying the stated wait: as bare
// text the wait has to be guessed downstream, and the guess is two seconds
// against a limit that lasts four hours.
func TestEnhanceErrorCarriesTheStatedWait(t *testing.T) {
	c := &Client{}
	raw := fmt.Errorf(`POST "https://chatgpt.com/backend-api/codex/responses": 429 Too Many Requests ` +
		`{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_in_seconds":14476}`)

	err := c.enhanceError(raw)

	var limited *provider.RateLimitedError
	if !errors.As(err, &limited) {
		t.Fatalf("enhanceError returned %T, want RateLimitedError", err)
	}
	if want := 14476 * time.Second; limited.RetryAfter != want {
		t.Fatalf("RetryAfter = %v, want %v", limited.RetryAfter, want)
	}
	if !errors.Is(err, raw) {
		t.Fatal("the provider's own error must survive as the cause")
	}
	if !strings.Contains(limited.Message, "hint: rate limit reached") {
		t.Fatalf("Message = %q, want the hint the transcript summary carries", limited.Message)
	}
	if !strings.Contains(limited.Message, "usage limit has been reached") {
		t.Fatalf("Message = %q, want the provider's own text intact", limited.Message)
	}
}

// A throttle that states nothing is still typed, with RetryAfter left at 0 —
// "unstated", which the caller must not read as "retry shortly" on its own
// authority.
func TestEnhanceErrorRateLimitWithoutAStatedWait(t *testing.T) {
	c := &Client{}

	err := c.enhanceError(fmt.Errorf("429 Too Many Requests"))

	var limited *provider.RateLimitedError
	if !errors.As(err, &limited) {
		t.Fatalf("enhanceError returned %T, want RateLimitedError", err)
	}
	if limited.RetryAfter != 0 {
		t.Fatalf("RetryAfter = %v, want 0 — nothing stated a wait, and inventing one is what this type exists to stop", limited.RetryAfter)
	}
}

// Every other hint enhanceError adds is untyped text, and stays that way: only
// the rate limit carries a number anything downstream acts on.
func TestEnhanceErrorLeavesOtherHintsUntyped(t *testing.T) {
	c := &Client{}
	for _, msg := range []string{"401 Unauthorized", "insufficient_quota", "the model does not exist"} {
		err := c.enhanceError(fmt.Errorf("%s", msg))
		var limited *provider.RateLimitedError
		if errors.As(err, &limited) {
			t.Fatalf("%q was classified as a rate limit", msg)
		}
		if !strings.Contains(err.Error(), "hint: ") {
			t.Fatalf("%q lost its hint: %v", msg, err)
		}
	}
}

// A 401 carries the client's hint whether the SDK typed the error or only its
// text says so.
func TestEnhanceErrorUnauthorizedHint(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://example.test/responses", nil)
	typed := &openai.Error{
		StatusCode: http.StatusUnauthorized,
		Request:    req,
		Response:   &http.Response{StatusCode: http.StatusUnauthorized, Request: req, Header: http.Header{}},
	}
	for name, err := range map[string]error{"typed": typed, "text": errors.New("401 Unauthorized")} {
		t.Run(name, func(t *testing.T) {
			c := &Client{unauthorizedHint: "run `codex login`"}
			if got := c.enhanceError(err).Error(); !strings.Contains(got, "hint: run `codex login`") {
				t.Fatalf("error = %q, want the client's hint", got)
			}
		})
	}
}
