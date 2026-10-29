//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"testing"
	"time"
)

// TestRateLimitLatch_LiftsItselfWhenTheResetPasses: nothing re-tickles the
// reducer when a cap expires, so the latch may only ever be a refusal that is
// still true. A hold read after its reset is not a hold.
func TestRateLimitLatch_LiftsItselfWhenTheResetPasses(t *testing.T) {
	w := NewConversationWorker("test-rate-limit-expiry", "user:test")
	defer w.doc.Destroy()

	w.latchRateLimit("test", time.Now().Add(-time.Second))
	if until := w.rateLimitedUntil("test"); !until.IsZero() {
		t.Fatalf("rateLimitedUntil = %v, want zero — a reset already in the past holds nothing", until)
	}

	w.latchRateLimit("test", time.Now().Add(time.Hour))
	if w.rateLimitedUntil("test").IsZero() {
		t.Fatal("a cap an hour out must stand")
	}
	if w.latchRateLimit("test", time.Now().Add(time.Hour)) {
		t.Fatal("a second thread meeting a cap already standing is not its discoverer — only one report reaches the user")
	}

	// The user asked us to try anyway.
	w.clearRateLimit("test")
	if until := w.rateLimitedUntil("test"); !until.IsZero() {
		t.Fatalf("rateLimitedUntil = %v, want zero after the user sent into the conversation", until)
	}
}

// errorItems returns every error item in the conversation's top-level flow.
func errorItems(w *ConversationWorker) []ConversationItem {
	var found []ConversationItem
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeError {
			found = append(found, item)
		}
	}
	return found
}

func TestRateLimitReport_Wording(t *testing.T) {
	now := time.Date(2026, 9, 10, 19, 58, 0, 0, time.UTC)
	tests := []struct {
		name  string
		until time.Time
		want  string
	}{
		{name: "hours away", until: now.Add(4*time.Hour + 76*time.Second), want: "in about 4 hours, at 23:59"},
		{name: "minutes away", until: now.Add(25 * time.Minute), want: "in about 25 minutes, at 20:23"},
		{name: "seconds away", until: now.Add(30 * time.Second), want: "in under a minute, at 19:58"},
		{name: "tomorrow", until: now.Add(8 * time.Hour), want: "in about 8 hours, tomorrow at 03:58"},
		{name: "next week", until: now.Add(8 * 24 * time.Hour), want: "in about 8 days, on 18 Sep at 19:58"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := rateLimitReport("openaicodex", tt.until, now, "429 Too Many Requests").English()
			if !strings.Contains(got, tt.want) {
				t.Fatalf("report = %q, want it to contain %q", got, tt.want)
			}
		})
	}
}
