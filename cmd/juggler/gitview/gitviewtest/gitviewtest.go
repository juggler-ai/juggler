//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package gitviewtest provides the single test helper for taking gitview's git
// clocks out of what a test measures. It lives apart from gitview so that only
// tests carry it.
package gitviewtest

import (
	"time"

	"juggler/cmd/juggler/gitview/internal/clocks"
)

// LendClocks replaces every git clock — the card's, the review's and the
// diff's — with perCmd for one command and budget for a whole request, and
// returns the func that puts the shipped values back. A test asking what git
// reports over a fixture of a handful of files is not asking how fast a loaded
// machine runs git, and the shipped seconds would make it measure the second.
// Not safe to call while a read is in flight.
func LendClocks(perCmd, budget time.Duration) (restore func()) {
	status, review, diff := clocks.Status, clocks.Review, clocks.Diff
	lent := clocks.Clock{PerCmd: perCmd, Budget: budget}
	clocks.Status, clocks.Review, clocks.Diff = lent, lent, lent
	return func() {
		clocks.Status, clocks.Review, clocks.Diff = status, review, diff
	}
}
