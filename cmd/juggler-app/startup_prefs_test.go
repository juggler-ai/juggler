//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"testing"

	"juggler/cmd/juggler/core"
)

// A window opens wearing what it inherits. These pin the order the two sources
// are consulted in, because getting it wrong is invisible until a relaunch: the
// window comes up in someone else's theme and only corrects itself a frame
// later, if at all.

func TestStartupPrefsPreferTheOpenersHandOff(t *testing.T) {
	theme, mode, zoom := startupPrefs(windowOpts{theme: "light", mode: "system", zoom: 120}, "dark", 100)
	if theme != "light" || mode != "system" || zoom != 120 {
		t.Fatalf("inherited hand-off = %q/%q/%d, want \"light\"/\"system\"/120", theme, mode, zoom)
	}
}

func TestStartupPrefsFallBackToTheAppsLast(t *testing.T) {
	// No opener (Finder, restore): the freshest values any window reported.
	theme, mode, zoom := startupPrefs(windowOpts{}, "dark", 110)
	if theme != "dark" || zoom != 110 {
		t.Fatalf("a launch with no opener = %q/%d, want \"dark\"/110", theme, zoom)
	}
	// The app remembers a painted colour, not the user's selection, so it names
	// no mode: the page reads that from the machine's settings itself.
	if mode != "" {
		t.Fatalf("mode = %q, want empty", mode)
	}
}

// A first-ever launch says nothing, so the page is free to follow the OS and
// open at the default size.
func TestStartupPrefsSayNothingWhenNothingIsKnown(t *testing.T) {
	theme, mode, zoom := startupPrefs(windowOpts{}, "", 0)
	if theme != "" || mode != "" || zoom != 0 {
		t.Fatalf("a launch with nothing to go on = %q/%q/%d, want empty", theme, mode, zoom)
	}
}

// The app names a window's role from the options it opened it with; the server
// keeps that window's geometry and preferences in the slot core names for it
// (core.WindowRoleMain, core.WindowRolePinboard, core.WindowRolePinboardFor),
// and prunes a binned board's slot by that name. Disagree and a board writes into
// one slot and reads back from another.
func TestRolesAgreeWithTheServers(t *testing.T) {
	cases := []struct {
		opts windowOpts
		want string
	}{
		{windowOpts{}, core.WindowRoleMain},
		{windowOpts{view: viewPinboard, board: "board_one"}, core.WindowRolePinboardFor("board_one")},
		{windowOpts{view: viewPinboard, board: core.MainBoardID}, core.WindowRolePinboardFor(core.MainBoardID)},
		{windowOpts{view: viewPinboard}, core.WindowRolePinboard},
		{windowOpts{view: "something-else", board: "board_one"}, core.WindowRoleMain},
	}
	for _, c := range cases {
		// windowOptsFromQuery is what a real window's options come through, so the
		// board id is already normalised by the time role() sees it.
		if got := c.opts.role(); got != c.want {
			t.Errorf("view=%q board=%q: app says %q, server says %q", c.opts.view, c.opts.board, got, c.want)
		}
	}
}
