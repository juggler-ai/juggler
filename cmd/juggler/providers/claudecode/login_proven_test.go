//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// resetLoginState gives the default account a fresh login record pinned to
// state (and, when probed, a passive probe just taken), and puts the old record
// back on cleanup, so ordering with other tests can't leak process-lifetime
// state.
func resetLoginState(t *testing.T, state loginState, probed bool) {
	t.Helper()
	prev, had := loginRecords.Load(defaultAccountID)
	r := &loginRecord{}
	r.state.Store(int32(state))
	if probed {
		r.usageProbeAt.Store(usageProbeNow().UnixNano())
	}
	loginRecords.Store(defaultAccountID, r)
	t.Cleanup(func() {
		if had {
			loginRecords.Store(defaultAccountID, prev)
		} else {
			loginRecords.Delete(defaultAccountID)
		}
	})
}

// pinUsageProbeClock replaces the clock the probe latch ages against, so a test
// can step over usageProbeRetryInterval instead of waiting five minutes.
func pinUsageProbeClock(t *testing.T, start time.Time) func(time.Duration) {
	t.Helper()
	prev := usageProbeNow
	now := start
	usageProbeNow = func() time.Time { return now }
	t.Cleanup(func() { usageProbeNow = prev })
	return func(d time.Duration) { now = now.Add(d) }
}

// TestUsagePollAllowsOneProbeBeforeLogin verifies a logged-out CLI is spawned at
// most once. Before any sign-in is confirmed, the FIRST poll is permitted (so
// usage lights up for an already-signed-in user on startup) but every subsequent
// poll is skipped WITHOUT spawning `claude`.
// The binary path is pinned to a non-existent file, so a probe that does reach a
// spawn fails on the missing binary rather than the skip guard.
func TestUsagePollAllowsOneProbeBeforeLogin(t *testing.T) {
	resetLoginState(t, loginUnknown, false)
	restore := SetBinaryPathForTesting(filepath.Join(t.TempDir(), "does-not-exist-claude"))
	t.Cleanup(restore)

	// First probe: allowed past the guard, so it fails on the missing binary.
	_, err := (&Client{}).UsageStats(context.Background())
	if err == nil {
		t.Fatalf("expected the first probe to reach the (missing) binary")
	}
	if strings.Contains(err.Error(), "poll skipped") {
		t.Fatalf("first probe should not be skipped, got %v", err)
	}

	// Second probe: latched off, so it bails before any spawn.
	_, err = (&Client{}).UsageStats(context.Background())
	if err == nil || !strings.Contains(err.Error(), "poll skipped") {
		t.Fatalf("expected the second probe to be skipped, got %v", err)
	}
}

// TestUsagePollRearmsAfterRetryInterval verifies the probe latch ages instead of
// holding for the life of the process: a probe the CLI was too slow or too busy
// to answer blocks the ticks that follow it, but once the retry interval is up
// the next poll is allowed through. Without this, one unlucky probe at startup
// leaves usage blank until the user happens to send a message.
func TestUsagePollRearmsAfterRetryInterval(t *testing.T) {
	advance := pinUsageProbeClock(t, time.Now())
	resetLoginState(t, loginUnknown, false)

	if !claudeUsagePollAllowed(defaultAccountID) {
		t.Fatalf("the first probe must be allowed")
	}
	advance(usageProbeRetryInterval - time.Second)
	if claudeUsagePollAllowed(defaultAccountID) {
		t.Fatalf("a probe inside the retry interval must stay latched off")
	}
	advance(2 * time.Second)
	if !claudeUsagePollAllowed(defaultAccountID) {
		t.Fatalf("the latch must re-arm once the retry interval has elapsed")
	}
	if claudeUsagePollAllowed(defaultAccountID) {
		t.Fatalf("the re-armed probe must latch off again immediately")
	}
}

// TestUsagePollStaysBlockedWhileExpiredAfterInterval verifies the re-arm applies
// only to an unknown sign-in: once a real turn has proved the CLI is logged out,
// no amount of elapsed time earns another spawn.
func TestUsagePollStaysBlockedWhileExpiredAfterInterval(t *testing.T) {
	advance := pinUsageProbeClock(t, time.Now())
	resetLoginState(t, loginExpired, false)

	advance(10 * usageProbeRetryInterval)
	if claudeUsagePollAllowed(defaultAccountID) {
		t.Fatalf("an expired sign-in must block the poll however long has passed")
	}
}

// TestUsagePollAlwaysAllowedAfterLogin verifies a confirmed sign-in re-enables
// the poll unconditionally: UsageStats proceeds past the guard (and then fails
// only for the pinned-missing binary, proving it got that far) on every call.
func TestUsagePollAlwaysAllowedAfterLogin(t *testing.T) {
	resetLoginState(t, loginUnknown, true) // already probed once, but not confirmed
	markClaudeLoginConfirmed(defaultAccountID)
	restore := SetBinaryPathForTesting(filepath.Join(t.TempDir(), "does-not-exist-claude"))
	t.Cleanup(restore)

	for i := 0; i < 2; i++ {
		_, err := (&Client{}).UsageStats(context.Background())
		if err == nil {
			t.Fatalf("expected an error from the missing binary")
		}
		if strings.Contains(err.Error(), "poll skipped") {
			t.Fatalf("guard should stay unlocked after a confirmed login, got %v", err)
		}
	}
}

// TestUsagePollBlockedWhileExpired verifies a known-expired sign-in stops the
// poll outright, including the one probe an unknown state would have allowed.
// We already know what spawning would achieve, and repeating it every tick
// against a CLI that cannot serve is exactly the behaviour the guard exists to
// prevent.
func TestUsagePollBlockedWhileExpired(t *testing.T) {
	resetLoginState(t, loginExpired, false) // not yet probed, but known expired
	restore := SetBinaryPathForTesting(filepath.Join(t.TempDir(), "does-not-exist-claude"))
	t.Cleanup(restore)

	_, err := (&Client{}).UsageStats(context.Background())
	if err == nil || !strings.Contains(err.Error(), "poll skipped") {
		t.Fatalf("expected the probe to be skipped while expired, got %v", err)
	}
}

// TestLoginStateTransitions covers the state machine directly: an expiry is
// recorded from a failed turn, a later successful turn clears it (so signing
// back in restores the provider without a restart), and the re-check drops an
// expiry to unknown rather than claiming a confirmation nothing has earned.
func TestLoginStateTransitions(t *testing.T) {
	resetLoginState(t, loginUnknown, false)

	if got := currentClaudeLoginState(defaultAccountID); got != loginUnknown {
		t.Fatalf("initial state = %v, want loginUnknown", got)
	}

	markClaudeLoginExpired(defaultAccountID)
	if got := currentClaudeLoginState(defaultAccountID); got != loginExpired {
		t.Fatalf("after markClaudeLoginExpired state = %v, want loginExpired", got)
	}

	// A real turn succeeding is the strongest evidence there is, and must beat
	// a previously recorded expiry.
	markClaudeLoginConfirmed(defaultAccountID)
	if got := currentClaudeLoginState(defaultAccountID); got != loginConfirmed {
		t.Fatalf("after markClaudeLoginConfirmed state = %v, want loginConfirmed", got)
	}

	// The re-check must not demote a confirmed sign-in.
	clearClaudeLoginExpired(defaultAccountID)
	if got := currentClaudeLoginState(defaultAccountID); got != loginConfirmed {
		t.Fatalf("clearClaudeLoginExpired touched a confirmed state: %v", got)
	}

	markClaudeLoginExpired(defaultAccountID)
	clearClaudeLoginExpired(defaultAccountID)
	if got := currentClaudeLoginState(defaultAccountID); got != loginUnknown {
		t.Fatalf("after clearing an expiry state = %v, want loginUnknown", got)
	}
}
