//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"errors"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// The texts are the CLI's own: "You've hit your <limit> · resets <time>", the
// time in en-US 12-hour form with the zone in parentheses, a date before it
// only when the reset is more than a day away, and a year only when it is not
// this one.
func TestUsageLimitErrorReadsTheStatedReset(t *testing.T) {
	// 27 Oct 2026 is after the clocks went back, so London is on UTC.
	now := time.Date(2026, time.October, 27, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		text string
		want time.Time
	}{
		{"session limit, later today", "You've hit your session limit · resets 3pm (Europe/London)",
			time.Date(2026, time.October, 27, 15, 0, 0, 0, time.UTC)},
		{"minutes and a trailing clause", "You've hit your session limit · resets 3:30pm (Europe/London) · progress saved",
			time.Date(2026, time.October, 27, 15, 30, 0, 0, time.UTC)},
		{"a clock already past today is tomorrow's", "You've hit your session limit · resets 9am (Europe/London)",
			time.Date(2026, time.October, 28, 9, 0, 0, 0, time.UTC)},
		{"a dated weekly reset", "You've hit your weekly limit · resets Oct 30, 9am (Europe/London)",
			time.Date(2026, time.October, 30, 9, 0, 0, 0, time.UTC)},
		{"a reset in another year", "You've hit your usage limit · resets Jan 2, 2027, 5pm (America/New_York)",
			time.Date(2027, time.January, 2, 22, 0, 0, 0, time.UTC)},
		{"a typographic apostrophe", "You’ve hit your Opus limit · resets 4pm (Europe/London)",
			time.Date(2026, time.October, 27, 16, 0, 0, 0, time.UTC)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			limited := usageLimitError(tt.text, nil, now)
			if limited == nil {
				t.Fatalf("usageLimitError(%q) = nil, want a rate limit lifting at %v", tt.text, tt.want)
			}
			if got := now.Add(limited.RetryAfter); !got.Equal(tt.want) {
				t.Fatalf("reset = %v, want %v", got.UTC(), tt.want)
			}
			if limited.Message != tt.text {
				t.Fatalf("Message = %q, want the CLI's text verbatim", limited.Message)
			}
		})
	}
}

func TestUsageLimitErrorIgnoresTextWithNoReset(t *testing.T) {
	now := time.Date(2026, time.October, 27, 12, 0, 0, 0, time.UTC)
	for _, text := range []string{
		"You've hit your session limit",
		"rate limit exceeded",
		"You've hit your monthly spend limit · resets $",
		"",
	} {
		if limited := usageLimitError(text, nil, now); limited != nil {
			t.Errorf("usageLimitError(%q) = %+v, want nil: nothing here states when it lifts", text, limited)
		}
	}
}

// A capped CLI turn must reach the worker as a dated rate limit — that is what
// latches the cap and lets the error row offer to continue when it lifts.
func TestCLIAPIErrorTypesAUsageLimitWithItsReset(t *testing.T) {
	reset := time.Now().UTC().Add(3 * time.Hour).Truncate(time.Hour)
	text := "You've hit your session limit · resets " + reset.Format("Jan 2, 2006, 3pm") + " (UTC)"
	for _, status := range []int{0, 429} {
		err := cliAPIError(status, text)
		var limited *provider.RateLimitedError
		if !errors.As(err, &limited) {
			t.Fatalf("status %d: error = %T %v, want a RateLimitedError", status, err, err)
		}
		if got := time.Now().Add(limited.RetryAfter); got.Sub(reset).Abs() > time.Minute {
			t.Fatalf("status %d: reset = %v, want %v", status, got, reset)
		}
		if f := provider.ClassifyFailure(err); f.Kind != provider.FailureRateLimited || f.RetryAfter != limited.RetryAfter {
			t.Fatalf("status %d: classified as %v (RetryAfter %v), want rate-limited with the stated wait", status, f.Kind, f.RetryAfter)
		}
	}
}
