//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"strings"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
)

// claudeSignInHint is the remediation for every Claude Code auth failure, and
// the single place it is worded. The CLI owns its own OAuth, so the fix is
// always performed in the CLI and never in Juggler's settings: there is no key
// to paste and no button we could offer that would do it.
//
// It names the interactive `/login` rather than the `claude auth login`
// subcommand deliberately — `auth login` has been observed reporting success
// while persisting nothing, whereas the in-session `/login` is what the CLI's
// own error text tells people to run.
var claudeSignInHint = msg.New("Claude Code isn't signed in. Run claude in a terminal and use /login.")

// authFailureMarkers identify a CLI failure as an authentication problem from
// its text alone. Needed alongside the HTTP status because the CLI reports the
// same underlying condition several ways: a rejected API call carries
// api_error_status 401, but a CLI that knows up front it has no usable
// credential answers with bare text and no status at all.
//
// Matched case-insensitively as substrings, and deliberately specific: each of
// these is a whole phrase the CLI emits, not a word like "auth" that ordinary
// failures also contain.
var authFailureMarkers = []string{
	"oauth access token has expired",
	"oauth token has expired",
	"oauth token revoked",
	"oauth session expired",
	"re-authenticate to continue",
	"invalid authentication credentials",
	"failed to authenticate",
	"not logged in",
	"please run /login",
	"login expired",
}

// classifyClaudeAuthFailure reports a CLI failure as an authentication problem,
// or returns nil when it is anything else.
//
// A non-nil result claims the user's credential is at fault, which costs them
// the provider until they act, so the evidence has to be explicit: either the
// API answered 401, or the CLI said in its own words that it is not
// authenticated. Everything else — including every other HTTP status — stays a
// generic terminal error.
func classifyClaudeAuthFailure(a account, status int, text string) *provider.AuthError {
	if status != 401 && !matchesAuthFailure(text) {
		return nil
	}
	return &provider.AuthError{
		Provider: a.id(),
		Status:   status,
		Message:  strings.TrimSpace(text),
		Hint:     signInHintFor(a).English(),
	}
}

// matchesAuthFailure reports whether text carries one of the CLI's own
// not-authenticated phrases.
func matchesAuthFailure(text string) bool {
	lower := strings.ToLower(text)
	for _, marker := range authFailureMarkers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
