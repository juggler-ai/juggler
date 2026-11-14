//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"errors"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestClassifyClaudeAuthFailure pins what counts as an authentication problem.
// The false cases matter as much as the true ones: classifying an ordinary
// failure as an auth failure marks the sign-in expired, which takes the
// provider away from a user whose credentials were fine.
func TestClassifyClaudeAuthFailure(t *testing.T) {
	tests := []struct {
		name   string
		status int
		text   string
		want   bool
	}{
		{
			name:   "the 401 a user actually reported",
			status: 401,
			text:   "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
			want:   true,
		},
		{
			name:   "401 with no text at all",
			status: 401,
			want:   true,
		},
		{
			// The CLI answers this way when it knows up front it has no
			// credential: bare text, no API call, so no status to key on.
			name: "never signed in, reported without a status",
			text: "Not logged in · Please run /login",
			want: true,
		},
		{
			name: "expired login reported without a status",
			text: "Login expired · Please run /login",
			want: true,
		},
		{
			name: "oauth session could not be refreshed",
			text: "Failed to authenticate: OAuth session expired and could not be refreshed",
			want: true,
		},
		{
			name:   "revoked token",
			status: 401,
			text:   "OAuth token revoked",
			want:   true,
		},
		{
			name: "matching is case-insensitive",
			text: "NOT LOGGED IN",
			want: true,
		},
		{
			name:   "a bad request is not an auth failure",
			status: 400,
			text:   "API Error: 400 invalid request: messages must not be empty",
			want:   false,
		},
		{
			name:   "an unknown model is not an auth failure",
			status: 404,
			text:   "There's an issue with the selected model",
			want:   false,
		},
		{
			name:   "an overload is not an auth failure",
			status: 529,
			text:   "API Error: 529 overloaded",
			want:   false,
		},
		{
			// "auth" appears inside plenty of unrelated failures; only whole
			// phrases the CLI actually emits may match.
			name: "the bare word does not match",
			text: "could not authorize the request",
			want: false,
		},
		{
			name: "empty",
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyClaudeAuthFailure(account{}, tt.status, tt.text)
			if (got != nil) != tt.want {
				t.Fatalf("classifyClaudeAuthFailure(account{}, %d, %q) = %v, want auth-failure=%v", tt.status, tt.text, got, tt.want)
			}
			if got == nil {
				return
			}
			if got.Provider != "claudecode" {
				t.Errorf("Provider = %q, want %q", got.Provider, "claudecode")
			}
			if got.Status != tt.status {
				t.Errorf("Status = %d, want %d", got.Status, tt.status)
			}
			if got.Hint != claudeSignInHint.English() {
				t.Errorf("Hint = %q, want the single shared hint", got.Hint)
			}
			// The CLI's own words are the only diagnosable part; dropping them
			// leaves a user with nothing to search for.
			if tt.text != "" && got.Message != tt.text {
				t.Errorf("Message = %q, want the provider text verbatim %q", got.Message, tt.text)
			}
		})
	}
}

// TestResultEventAuthFailureIsTyped drives the real parser over the exact
// stream-json line the CLI emits on an expired login. Note subtype stays
// "success" — the CLI's own distinction is "the CLI ran" vs "the call within it
// worked" — so is_error is what makes this a failure at all.
func TestResultEventAuthFailureIsTyped(t *testing.T) {
	resetLoginState(t, loginUnknown, false)

	const line = `{"type":"result","subtype":"success","is_error":true,"api_error_status":401,` +
		`"result":"Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue."}`

	_, _, _, _, err := feedLines(t, &Client{}, []string{line})
	if err == nil {
		t.Fatal("expected the auth failure to surface as an error")
	}

	var authErr *provider.AuthError
	if !errors.As(err, &authErr) {
		t.Fatalf("error was not a provider.AuthError: %#v", err)
	}
	if authErr.Status != 401 {
		t.Errorf("Status = %d, want 401", authErr.Status)
	}
	if authErr.Hint != claudeSignInHint.English() {
		t.Errorf("Hint = %q, want the sign-in hint", authErr.Hint)
	}
	// The remediation is useless if the underlying text is thrown away.
	if want := "OAuth access token has expired"; !strings.Contains(authErr.Message, want) {
		t.Errorf("Message = %q, want it to still contain %q", authErr.Message, want)
	}
	if got := currentClaudeLoginState(defaultAccountID); got != loginExpired {
		t.Errorf("login state = %v, want loginExpired", got)
	}
}

// TestErrorEventAuthFailureIsTyped covers the sibling subtype="error" arm, and
// the case with no api_error_status at all — a CLI that never made the call
// because it had nothing to make it with.
func TestErrorEventAuthFailureIsTyped(t *testing.T) {
	resetLoginState(t, loginUnknown, false)

	const line = `{"type":"result","subtype":"error","result":"Not logged in · Please run /login"}`

	_, _, _, _, err := feedLines(t, &Client{}, []string{line})
	if err == nil {
		t.Fatal("expected the auth failure to surface as an error")
	}
	var authErr *provider.AuthError
	if !errors.As(err, &authErr) {
		t.Fatalf("error was not a provider.AuthError: %#v", err)
	}
	if authErr.Status != 0 {
		t.Errorf("Status = %d, want 0 for a failure reported without one", authErr.Status)
	}
	if got := currentClaudeLoginState(defaultAccountID); got != loginExpired {
		t.Errorf("login state = %v, want loginExpired", got)
	}
}

// TestNonAuthResultErrorStaysGeneric is the guard against over-claiming. A
// bad-request failure must keep its existing shape and, critically, must not
// mark the sign-in expired — that would disable a provider whose credentials
// are perfectly good.
func TestNonAuthResultErrorStaysGeneric(t *testing.T) {
	resetLoginState(t, loginConfirmed, true)

	const line = `{"type":"result","subtype":"success","is_error":true,"api_error_status":400,` +
		`"result":"API Error: 400 invalid request: messages must not be empty"}`

	_, _, _, _, err := feedLines(t, &Client{}, []string{line})
	if err == nil {
		t.Fatal("expected the failure to surface as an error")
	}
	var authErr *provider.AuthError
	if errors.As(err, &authErr) {
		t.Fatalf("a bad request was misclassified as an auth failure: %#v", authErr)
	}
	if got := currentClaudeLoginState(defaultAccountID); got != loginConfirmed {
		t.Errorf("login state = %v, want the confirmed sign-in left alone", got)
	}
}

// TestCleanResultClearsExpiry proves the recovery path: after an expiry has been
// recorded, one successful turn is enough to put the provider back, with no
// restart and no visit to settings.
func TestCleanResultClearsExpiry(t *testing.T) {
	resetLoginState(t, loginExpired, true)

	const line = `{"type":"result","subtype":"success","result":"done"}`

	if _, _, _, _, err := feedLines(t, &Client{}, []string{line}); err != nil {
		t.Fatalf("clean result returned an error: %v", err)
	}
	if got := currentClaudeLoginState(defaultAccountID); got != loginConfirmed {
		t.Errorf("login state = %v, want loginConfirmed", got)
	}
}
