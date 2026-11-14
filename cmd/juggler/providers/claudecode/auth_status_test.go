//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"testing"
)

// TestParseClaudeAuthStatus covers every shape the probe's stdout can take.
// The unknown cases are the ones that matter: each of them, misread as "signed
// out", would disable the provider for a user whose sign-in is fine.
func TestParseClaudeAuthStatus(t *testing.T) {
	tests := []struct {
		name   string
		stdout string
		want   authProbeVerdict
	}{
		{
			// The real output of `claude auth status` on a signed-in machine,
			// pretty-printed exactly as the CLI emits it.
			name: "signed in",
			stdout: `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "subscriptionType": "max"
}`,
			want: authProbeSignedIn,
		},
		{
			name:   "signed out",
			stdout: `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}`,
			want:   authProbeSignedOut,
		},
		{
			// An older CLI has no `auth status` subcommand and answers with a
			// suggestion instead. Not JSON, so not an answer.
			name:   "subcommand does not exist",
			stdout: "Unknown command: auth\nDid you mean: agents?\n",
			want:   authProbeUnknown,
		},
		{
			// Valid JSON that simply doesn't carry the field. Decoding into a
			// plain bool would read this as "signed out".
			name:   "json without the field",
			stdout: `{"version": "2.1.239"}`,
			want:   authProbeUnknown,
		},
		{
			name:   "empty output",
			stdout: "",
			want:   authProbeUnknown,
		},
		{
			name:   "truncated json",
			stdout: `{"loggedIn": tr`,
			want:   authProbeUnknown,
		},
		{
			name:   "surrounding whitespace is tolerated",
			stdout: "\n  {\"loggedIn\": true}  \n",
			want:   authProbeSignedIn,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseClaudeAuthStatus([]byte(tt.stdout)); got != tt.want {
				t.Errorf("parseClaudeAuthStatus(%q) = %v, want %v", tt.stdout, got, tt.want)
			}
		})
	}
}

// stubAuthProbe pins the probe's verdict for a test and counts calls, so tests
// can assert both the decision and whether a spawn would have happened at all.
func stubAuthProbe(t *testing.T, verdict authProbeVerdict) *int {
	t.Helper()
	calls := 0
	prev := authStatusProbe
	authStatusProbe = func(context.Context, string) authProbeResult {
		calls++
		return authProbeResult{verdict: verdict}
	}
	t.Cleanup(func() { authStatusProbe = prev })
	return &calls
}

// stubCLIInstalled pins whether the claude CLI can be located, so readiness
// tests don't depend on what this machine has installed.
func stubCLIInstalled(t *testing.T, installed bool) {
	t.Helper()
	prev := claudeCLIInstalled
	claudeCLIInstalled = func() bool { return installed }
	t.Cleanup(func() { claudeCLIInstalled = prev })
}

// TestReadinessRefusesWhenCLIMissing covers a provider switched on in settings
// on a machine without the CLI. Counted as available, it became the default
// model and hid the setup wizard, and every turn then failed; not-ready greys
// its models out with a hint that says what is missing instead.
func TestReadinessRefusesWhenCLIMissing(t *testing.T) {
	for _, state := range []loginState{loginUnknown, loginConfirmed, loginExpired} {
		resetLoginState(t, state, false)
		resetAuthProbeThrottle(t)
		stubCLIInstalled(t, false)
		calls := stubAuthProbe(t, authProbeSignedIn)

		ready, hint := readinessOf(account{})
		if ready {
			t.Errorf("state %v: ready = true, want false with no CLI to run", state)
		}
		if hint.Key != claudeNotInstalledHint.Key {
			t.Errorf("state %v: hint = %q, want the not-installed hint", state, hint)
		}
		if *calls != 0 {
			t.Errorf("state %v: probe ran %d times, want 0 — there is nothing to spawn", state, *calls)
		}
	}
}

// resetAuthProbeThrottle clears the rate limiter so a test's probe is due.
func resetAuthProbeThrottle(t *testing.T) {
	t.Helper()
	probeAt := &loginFor(defaultAccountID).authProbeAt
	prev := probeAt.Load()
	probeAt.Store(0)
	t.Cleanup(func() { probeAt.Store(prev) })
}

// TestReadinessNeverProbesWhenNotExpired is the cost guard. Readiness is
// recomputed on every provider refresh, so spawning a process from the common
// path would be a process per refresh, forever, for nothing.
func TestReadinessNeverProbesWhenNotExpired(t *testing.T) {
	for _, state := range []loginState{loginUnknown, loginConfirmed} {
		resetLoginState(t, state, false)
		resetAuthProbeThrottle(t)
		stubCLIInstalled(t, true)
		calls := stubAuthProbe(t, authProbeSignedOut)

		ready, hint := readinessOf(account{})
		if !ready {
			t.Errorf("state %v: ready = false, want true — only a failed turn may disable the provider", state)
		}
		if !hint.IsZero() {
			t.Errorf("state %v: hint = %q, want empty", state, hint)
		}
		if *calls != 0 {
			t.Errorf("state %v: probe ran %d times, want 0", state, *calls)
		}
	}
}

// TestReadinessRefusesWhenProbeConfirmsSignedOut is the working case: a turn
// failed, the CLI agrees it is signed out, so the provider stays down with a
// hint that says what to do.
func TestReadinessRefusesWhenProbeConfirmsSignedOut(t *testing.T) {
	resetLoginState(t, loginExpired, false)
	resetAuthProbeThrottle(t)
	stubCLIInstalled(t, true)
	stubAuthProbe(t, authProbeSignedOut)

	ready, hint := readinessOf(account{})
	if ready {
		t.Error("ready = true, want false")
	}
	if hint.Key != claudeSignInHint.Key {
		t.Errorf("hint = %q, want the sign-in hint", hint)
	}
	if got := currentClaudeLoginState(defaultAccountID); got != loginExpired {
		t.Errorf("login state = %v, want it left expired", got)
	}
}

// TestReadinessRecoversWhenProbeSaysSignedIn covers the user signing back in:
// the next refresh re-enables the provider without a restart and without
// needing a turn to succeed first.
func TestReadinessRecoversWhenProbeSaysSignedIn(t *testing.T) {
	resetLoginState(t, loginExpired, false)
	resetAuthProbeThrottle(t)
	stubCLIInstalled(t, true)
	stubAuthProbe(t, authProbeSignedIn)

	ready, hint := readinessOf(account{})
	if !ready {
		t.Error("ready = false, want true after the CLI reports a sign-in")
	}
	if !hint.IsZero() {
		t.Errorf("hint = %q, want empty", hint)
	}
	if got := currentClaudeLoginState(defaultAccountID); got != loginUnknown {
		t.Errorf("login state = %v, want loginUnknown — a probe is not a served turn", got)
	}
}

// TestReadinessFailsOpenWhenProbeCannotAnswer guards the deadlock. On a CLI too
// old to have `auth status` the probe can never say anything, and if that left
// the provider disabled the user would have no way back: the expiry is otherwise
// cleared only by a successful turn, which a disabled provider cannot run.
func TestReadinessFailsOpenWhenProbeCannotAnswer(t *testing.T) {
	resetLoginState(t, loginExpired, false)
	resetAuthProbeThrottle(t)
	stubCLIInstalled(t, true)
	stubAuthProbe(t, authProbeUnknown)

	ready, hint := readinessOf(account{})
	if !ready {
		t.Error("ready = false, want true — an unanswerable probe must not hold the provider down")
	}
	if !hint.IsZero() {
		t.Errorf("hint = %q, want empty", hint)
	}
	if got := currentClaudeLoginState(defaultAccountID); got != loginUnknown {
		t.Errorf("login state = %v, want loginUnknown", got)
	}
}

// TestReadinessThrottlesTheProbe verifies the rate limit. Several unrelated
// things queue a provider refresh, and while expired each one would otherwise
// spawn the CLI.
func TestReadinessThrottlesTheProbe(t *testing.T) {
	resetLoginState(t, loginExpired, false)
	resetAuthProbeThrottle(t)
	stubCLIInstalled(t, true)
	calls := stubAuthProbe(t, authProbeSignedOut)

	for i := 0; i < 5; i++ {
		ready, hint := readinessOf(account{})
		if ready {
			t.Fatalf("call %d: ready = true, want false", i)
		}
		// The throttled calls must still report the hint, or the status line
		// would blank out between probes.
		if hint.Key != claudeSignInHint.Key {
			t.Fatalf("call %d: hint = %q, want the sign-in hint", i, hint)
		}
	}
	if *calls != 1 {
		t.Errorf("probe ran %d times across 5 refreshes, want 1", *calls)
	}
}
