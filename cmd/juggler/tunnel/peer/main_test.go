//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package peer

import (
	"os"
	"testing"
)

// TestMain answers every offer with no ICE servers. Guest and host share a
// machine, so host candidates are all a link needs, and no test sends to a
// STUN server on the internet, which an offline machine has none of.
func TestMain(m *testing.M) {
	DefaultICEServers = nil
	os.Exit(m.Run())
}
