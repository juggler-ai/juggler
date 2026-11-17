//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"errors"
	"testing"

	"juggler/cmd/juggler/gitcmd"
)

// A network write that failed because nobody signed in — the question was
// declined, the answer was wrong, ssh had no key the remote would take, or the
// host was not trusted — is an AuthError, told from git's own words under
// LC_ALL=C. Anything else stays git's failure as it was.
func TestAuthFailureFromGitsWords(t *testing.T) {
	cases := []struct {
		stderr string
		auth   bool
	}{
		{"fatal: could not read Username for 'https://example.com': terminal prompts disabled\n", true},
		{"fatal: could not read Password for 'https://jules@example.com': terminal prompts disabled\n", true},
		{"remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.com/r.git/'\n", true},
		{"git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n", true},
		{"Host key verification failed.\nfatal: Could not read from remote repository.\n", true},
		{"fatal: unable to access 'https://example.invalid/r.git/': Could not resolve host: example.invalid\n", false},
		{"fatal: repository 'https://example.com/gone.git/' not found\n", false},
		{"fatal: Could not read from remote repository.\n", false},
		{"fatal: unable to access 'https://example.com/r.git/': The requested URL returned error: 403\n", false},
	}
	for _, c := range cases {
		err := authFailure(&gitcmd.Error{Args: []string{"fetch"}, Code: 128, Stderr: c.stderr, Output: c.stderr})
		var auth *AuthError
		if got := errors.As(err, &auth); got != c.auth {
			t.Errorf("authFailure(%q) is an AuthError: %v, want %v", c.stderr, got, c.auth)
		}
	}
	cancelled := &gitcmd.Error{Code: -1, Stderr: "fatal: could not read Username for 'x': terminal prompts disabled", Cancelled: true}
	if err := authFailure(cancelled); err != error(cancelled) {
		t.Errorf("a cancelled write became %v, want it left as the cancel", err)
	}
	other := errors.New("not git's")
	if err := authFailure(other); err != other {
		t.Errorf("an error that is not git's became %v", err)
	}
}
