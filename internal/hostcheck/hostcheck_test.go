//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package hostcheck

import (
	"strings"
	"testing"
)

// TestRefusalMessageNamesTheHostAndTheRule covers the one thing a user hitting
// this 403 cannot work out unaided: which hostname was refused (the thing they
// typed into their address bar), what is served instead, why, and what to do.
func TestRefusalMessageNamesTheHostAndTheRule(t *testing.T) {
	msg := RefusalMessage("mymac.local:8317")

	for _, want := range []string{
		`"mymac.local:8317"`, // the refused hostname itself
		"localhost",          // and the names that are served
		"IP address",         // including the remedy for the LAN case
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("RefusalMessage = %q, missing %q", msg, want)
		}
	}
}

// TestRefusalMessageEscapesTheHost pins the quoting: a hostile or malformed
// Host arrives here from a rebinding page, and this body is read by the viewer's
// JS as well as by a human, so nothing the caller controls may break out of the
// quoted value or smuggle a newline into the message.
func TestRefusalMessageEscapesTheHost(t *testing.T) {
	msg := RefusalMessage("evil.com\r\nX-Injected: 1")

	if strings.ContainsAny(msg, "\r\n") {
		t.Errorf("RefusalMessage carried a line break: %q", msg)
	}
	// %q escapes the host's content but still delimits it with real quotes, so
	// what pins the escaping is the control characters surviving only as
	// backslash sequences — the text a reader sees, not one that would break.
	if !strings.Contains(msg, `evil.com\r\nX-Injected: 1`) {
		t.Errorf("RefusalMessage did not escape the host: %q", msg)
	}
}
