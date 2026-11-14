//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"testing"
	"time"
)

func derefPct(p *float64) float64 {
	if p == nil {
		return -1
	}
	return *p
}

func TestUsageStatsIgnoresWorkspaceTrustWarningOnStderr(t *testing.T) {
	resetLoginState(t, loginUnknown, false)
	installFakeClaude(t, fakeModeUsage, "usage-session")

	stats, err := (&Client{workingDir: t.TempDir()}).UsageStats(context.Background())
	if err != nil {
		t.Fatalf("UsageStats: %v", err)
	}
	if len(stats.Stats) != 1 {
		t.Fatalf("got %d stats, want 1: %+v", len(stats.Stats), stats.Stats)
	}
	if got := derefPct(stats.Stats[0].UsedPercent); got != 42 {
		t.Fatalf("used percent = %v, want 42", got)
	}
}

func TestParseUsageText(t *testing.T) {
	now := time.Date(2026, time.June, 12, 10, 0, 0, 0, time.UTC)
	stats := parseUsageText(`You are currently using your subscription to power your Claude Code usage

Current session: 21% used · resets Jun 12 at 11:50am (Europe/London)
Current week (all models): 2% used · resets Jun 18 at 9pm (Europe/London)
Current week (Sonnet only): 0% used`, now)

	if !stats.UpdatedAt.Equal(now) {
		t.Fatalf("unexpected header: %+v", stats)
	}
	if len(stats.Stats) != 3 {
		t.Fatalf("got %d stats, want 3: %+v", len(stats.Stats), stats.Stats)
	}
	assert := func(i int, name, category string, pct float64, windowSecs int, hasReset bool) {
		t.Helper()
		st := stats.Stats[i]
		if st.Name != name || st.Category != category || derefPct(st.UsedPercent) != pct || st.WindowSecs != windowSecs {
			t.Fatalf("stat[%d] = %+v", i, st)
		}
		if (st.ResetsAt != nil) != hasReset {
			t.Fatalf("stat[%d].ResetsAt presence = %v, want %v", i, st.ResetsAt != nil, hasReset)
		}
	}
	assert(0, "Session (5h)", "primary", 21, 5*60*60, true)
	assert(1, "Week (all models)", "weekly", 2, 7*24*60*60, true)
	assert(2, "Week (Sonnet only)", "model", 0, 7*24*60*60, false)
}

func TestParseUsageTextDecimalAndNoTimezone(t *testing.T) {
	now := time.Date(2026, time.June, 12, 10, 0, 0, 0, time.Local)
	stats := parseUsageText(`Current session: 15.5% used · resets Jun 12 at 11am`, now)
	if len(stats.Stats) != 1 {
		t.Fatalf("got %d stats, want 1", len(stats.Stats))
	}
	if derefPct(stats.Stats[0].UsedPercent) != 15.5 {
		t.Fatalf("pct = %v", stats.Stats[0].UsedPercent)
	}
	if stats.Stats[0].ResetsAt == nil {
		t.Fatal("expected reset time")
	}
}

// Verbatim /usage result captured on Windows: comma date/time separator and no
// "at", which earlier dropped every reset to nil while percentages still parsed.
func TestParseUsageTextWindows(t *testing.T) {
	now := time.Date(2026, time.June, 14, 10, 0, 0, 0, time.UTC)
	stats := parseUsageText(`You are currently using your subscription to power your Claude Code usage

Current session: 42% used · resets Jun 14, 5:50pm (Europe/London)
Current week (all models): 29% used · resets Jun 18, 9pm (Europe/London)
Current week (Sonnet only): 4% used · resets Jun 18, 9pm (Europe/London)`, now)

	if len(stats.Stats) != 3 {
		t.Fatalf("got %d stats, want 3: %+v", len(stats.Stats), stats.Stats)
	}
	for i, st := range stats.Stats {
		if st.ResetsAt == nil {
			t.Fatalf("stat[%d] (%s) ResetsAt = nil, want a reset time", i, st.Name)
		}
	}
	// Jun 14 5:50pm Europe/London (BST, UTC+1) == 16:50 UTC.
	wantSession := time.Date(2026, time.June, 14, 16, 50, 0, 0, time.UTC)
	if !stats.Stats[0].ResetsAt.Equal(wantSession) {
		t.Fatalf("session reset = %v, want %v", stats.Stats[0].ResetsAt.UTC(), wantSession)
	}
}

// The claude CLI prints the reset time using the host's locale conventions, so
// the clock (11:50am vs 13:50) and date word-order (Jun 12 vs 12 Jun) vary by
// machine — a 24-hour Windows box emits no am/pm. parseUsageReset must accept
// every shape, not just the 12-hour US-order one macOS happens to produce.
func TestParseUsageResetLocaleVariants(t *testing.T) {
	now := time.Date(2026, time.June, 12, 10, 0, 0, 0, time.Local)
	want := time.Date(2026, time.June, 12, 13, 50, 0, 0, time.Local).UTC()
	cases := []struct {
		name  string
		reset string
	}{
		{"12h at-separator (macOS)", "Jun 12 at 1:50pm"},
		{"12h comma-separator (Windows)", "Jun 12, 1:50pm"},
		{"24h at-separator", "Jun 12 at 13:50"},
		{"24h comma-separator", "Jun 12, 13:50"},
		{"12h day-first", "12 Jun at 1:50pm"},
		{"24h day-first", "12 Jun at 13:50"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stats := parseUsageText("Current session: 21% used · resets "+tc.reset, now)
			if len(stats.Stats) != 1 {
				t.Fatalf("got %d stats, want 1", len(stats.Stats))
			}
			got := stats.Stats[0].ResetsAt
			if got == nil {
				t.Fatalf("expected reset time for %q, got nil", tc.reset)
			}
			if !got.Equal(want) {
				t.Fatalf("reset for %q = %v, want %v", tc.reset, got.UTC(), want)
			}
		})
	}
}
