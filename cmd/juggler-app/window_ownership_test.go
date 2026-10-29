//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"sync"
	"testing"
)

// A detached board belongs to the window it was detached from. It is opened on
// that window's server, it is recorded as that window's board, and it goes when
// that window goes — a view of a conversation whose window has gone has nothing
// left to reveal into.
//
// Going with a window is not the same as being finished with. A board taken down
// alongside its owner keeps its tabs and its frame and comes back with it; only
// a board closed on its own is discarded. That distinction is what these pin,
// along with the one thing a board still does differently: it stays out of the
// workspace file (it is restored from its project's session instead).

// registerBoard adds a detached-board entry viewing a server, with a board of its
// own and no owner.
func registerBoard(a *appState, id, serverURL string) *winEntry {
	e := &winEntry{id: id, role: rolePinboardFor("board_" + id), board: "board_" + id, serverURL: serverURL}
	a.reg(func(st *regState) { st.windows[id] = e })
	return e
}

// registerBoardOf adds a detached-board entry opened from a named window.
func registerBoardOf(a *appState, id, serverURL, openedBy string) *winEntry {
	e := registerBoard(a, id, serverURL)
	a.reg(func(st *regState) { st.windows[id].openedBy = openedBy })
	return e
}

// registerWindowOn adds an ordinary window viewing a server.
func registerWindowOn(a *appState, id, serverURL string) *winEntry {
	e := &winEntry{id: id, role: roleMain, serverURL: serverURL}
	a.reg(func(st *regState) { st.windows[id] = e })
	return e
}

// The teardown claim: exactly one caller may tear a window down, however many
// arrive at once.
func TestOnlyOneCloserTearsAWindowDown(t *testing.T) {
	a := newTestAppState(t)
	window := registerWindowOn(a, "w1", "http://localhost:1234")

	var wg sync.WaitGroup
	claims := make(chan bool, 8)
	for range cap(claims) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claims <- a.claimClose(window)
		}()
	}
	wg.Wait()
	close(claims)

	won := 0
	for c := range claims {
		if c {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("exactly one closer tears a window down, got %d", won)
	}
}

// The workspace file remembers a window as the project it views, which is not
// what a board is: two boards on two conversations of one project would be one
// entry, and neither of them the board it is. So a board is never in that file —
// it is reopened from its project's session, by the window that comes back.
func TestABoardIsNeverPartOfTheRestoredWorkspace(t *testing.T) {
	a := newTestAppState(t)
	a.reg(func(st *regState) {
		st.windows["w1"] = &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/tmp/one"}}
		st.windows["w2"] = &winEntry{
			id: "w2", role: rolePinboardFor("board_one"), board: "board_one",
			spec: windowSpec{project: "/tmp/one"},
		}
		st.windows["w3"] = &winEntry{id: "w3", role: roleMain, spec: windowSpec{url: "http://elsewhere"}}
		st.windows["w4"] = &winEntry{id: "w4", role: roleMain, spec: windowSpec{project: "/tmp/two"}}
	})

	var specs []windowSpec
	a.reg(func(st *regState) { specs = restorableSpecs(st) })

	if len(specs) != 2 {
		t.Fatalf("only the two project windows are restorable, got %v", specs)
	}
	if specs[0].project != "/tmp/one" || specs[1].project != "/tmp/two" {
		t.Fatalf("and in the order they were opened, got %v", specs)
	}
}

// A view of a conversation whose window has gone has nothing left to reveal
// into, so a board goes with the window it was detached from — and keeps
// everything, because it is being put away rather than dismissed.
func TestAWindowTakesItsBoardsWithIt(t *testing.T) {
	a := newTestAppState(t)
	window := registerWindowOn(a, "w1", "http://localhost:1234")
	mine := registerBoardOf(a, "w2", "http://localhost:1234", "w1")
	theirs := registerBoardOf(a, "w3", "http://localhost:1234", "w9")

	var boards []*winEntry
	a.reg(func(st *regState) { boards = markBoardsClosingWith(st, window) })

	if a.boardFinishedWith(window) {
		t.Error("an ordinary window is not a board being finished with")
	}
	if len(boards) != 1 || boards[0] != mine {
		t.Fatalf("only this window's own boards go with it, got %v", boards)
	}
	if !mine.retainBoard {
		t.Error("a board going with its window keeps what it holds, so it comes back with it")
	}
	if theirs.retainBoard {
		t.Error("another window's board is left alone: two main windows on one project share a server, so only the opener can say")
	}
}

// The board that was taken down knows it, which is the whole difference between
// a board that comes back and one that is finished with.
func TestABoardTakenDownWithItsWindowIsMarkedAsKept(t *testing.T) {
	a := newTestAppState(t)
	window := registerWindowOn(a, "w1", "http://localhost:1234")
	board := registerBoardOf(a, "w2", "http://localhost:1234", "w1")

	a.reg(func(st *regState) { markBoardsClosingWith(st, window) })

	if a.boardFinishedWith(board) {
		t.Fatal("the board must know it was put away rather than closed on its own")
	}

	// A board nobody took down is one the user closed, and is discarded.
	alone := registerBoard(a, "w4", "http://localhost:1234")
	if !a.boardFinishedWith(alone) {
		t.Fatal("a board closed on its own is finished with")
	}

	// Nothing is finished with at quit: every window is going, and a board taken
	// down by whichever closed first would be indistinguishable from one closed
	// on purpose.
	a.reg(func(st *regState) { st.quitting = true })
	if a.boardFinishedWith(alone) {
		t.Fatal("a quit discards no board")
	}
}

// A window that is not a board has no board to be finished with, however it
// closes — the forget is keyed on the board a window holds, and an ordinary
// window holds none.
func TestAnOrdinaryWindowIsNeverFinishedWith(t *testing.T) {
	a := newTestAppState(t)
	window := registerWindowOn(a, "w1", "http://localhost:1234")

	if a.boardFinishedWith(window) {
		t.Fatal("a main window is not a board")
	}
	if a.boardFinishedWith(nil) {
		t.Fatal("and neither is nothing at all")
	}
}

// At quit every window is going anyway, and the teardowns race the process — so
// a board taken down by whichever window closed first would be impossible to
// tell from one the user closed. Nothing is touched, and everything comes back.
func TestQuittingTakesNoBoardsDown(t *testing.T) {
	a := newTestAppState(t)
	window := registerWindowOn(a, "w1", "http://localhost:1234")
	board := registerBoardOf(a, "w2", "http://localhost:1234", "w1")
	a.reg(func(st *regState) { st.quitting = true })

	var boards []*winEntry
	a.reg(func(st *regState) { boards = markBoardsClosingWith(st, window) })

	if len(boards) != 0 {
		t.Fatalf("a quit closes the windows itself, got %v", boards)
	}
	if board.retainBoard {
		t.Error("and marks nothing, because there is nothing to tell apart")
	}
}

// Each board is a window the user placed somewhere. One shared slot had the
// second board opened land on top of the first, and the last one closed decide
// where every board opened next time.
func TestEachBoardHasItsOwnFrame(t *testing.T) {
	a := newTestAppState(t)
	one := registerBoard(a, "w2", "http://localhost:1234")
	two := registerBoard(a, "w3", "http://localhost:1234")

	if one.role == two.role {
		t.Fatalf("two boards must not share a frame, both are %q", one.role)
	}
	if !isBoardRole(one.role) || !isBoardRole(two.role) {
		t.Fatalf("and both must still read as boards, got %q and %q", one.role, two.role)
	}
}
