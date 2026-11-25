//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"testing"
)

// TestMain keeps every test in the package out of the user's OS trash: binning,
// emptying and deleting conversations all end in trashOrRemove, which then
// takes its permanent-delete fallback, so every such test exercises that.
func TestMain(m *testing.M) {
	DisableOSTrash()
	os.Exit(m.Run())
}
