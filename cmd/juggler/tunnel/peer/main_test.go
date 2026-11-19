//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package peer

import (
	"os"
	"testing"
)

// TestMain answers every offer with no ICE servers. Guest and host share
// loopback, so host candidates are all a link needs, and gathering then ends
// as soon as they are in. A public STUN server would make every answer wait
// on a reply from the internet, which a loaded machine or an offline one turns
// into a partial answer.
func TestMain(m *testing.M) {
	DefaultICEServers = nil
	os.Exit(m.Run())
}
