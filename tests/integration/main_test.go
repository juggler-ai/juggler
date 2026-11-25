//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"io"
	"log"
	"os"
	"testing"

	"juggler/cmd/juggler/core"
)

// TestMain discards the standard logger. The servers and workers these tests
// stand up in-process log every step through it, which would bury a failing
// test's own output. It also keeps their session managers out of the user's
// OS trash (core.DisableOSTrash).
//
// The browser suite is a package of its own (./browser), so that `go test`
// runs it beside these tests rather than after them.
func TestMain(m *testing.M) {
	log.SetOutput(io.Discard)
	core.DisableOSTrash()
	os.Exit(m.Run())
}
