//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package clocks holds the git clocks of gitview's three surfaces — the status
// card, the review and the diff — each a clock for one git command and one for
// the whole request.
//
// They are vars rather than consts, and live here rather than in gitview, so
// that gitview/gitviewtest can lend a test more of them. A test that means to
// check what git reports over a fixture of a handful of files is not asking how
// fast this machine's git is, and on a loaded runner those are different
// questions with the same answer. Being internal to gitview, nothing outside it
// and its test helper can move them.
package clocks

import "time"

// Clock is one surface's clocks.
type Clock struct {
	PerCmd time.Duration // one git command's clock
	Budget time.Duration // the whole request's, across all of them
}

var (
	// Status is the card's. It is the shortest of the three, which is right for
	// a number in the corner of a window and is why it is the first to run out
	// anywhere else.
	Status = Clock{PerCmd: 3 * time.Second, Budget: 6 * time.Second}

	// Review is the review's. Its budget is longer than the card's, because the
	// card can shrug at a repository it did not reach in time and a review
	// cannot. So is its per-command clock: a read cut off early is a repository
	// reported as unreadable, and a review that calls a slow machine a broken one
	// has failed at the only thing it claims to do.
	Review = Clock{PerCmd: 10 * time.Second, Budget: 30 * time.Second}

	// Diff is the diff's, which is not the card's either. A card is polled in
	// the background and settles for the cheap answer, so it gives up quickly; a
	// diff is asked for once, by somebody waiting to look at it, and the patch it
	// is allowed to return runs to eight megabytes. Git reads the file for the
	// metadata pass, again for the patch and again for the tally behind a
	// truncated one, and on a loaded machine those reads take seconds rather than
	// milliseconds. Refusing a diff that another few seconds would have produced
	// is the worse answer.
	Diff = Clock{PerCmd: 10 * time.Second, Budget: 30 * time.Second}
)
