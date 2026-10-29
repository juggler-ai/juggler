//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"testing"
)

// A window's slot holds its frame and the UI preferences the viewer keeps for
// it. These pin how the two share it: none of the preferences is lost by the
// geometry write that lands every time a window is dragged, and a slot holding
// only preferences is not mistaken for a frame.

// The frame is captured from the live native window, which knows nothing about
// the viewer's preferences, and it is written on every move and resize.
// Dragging a window must not therefore strip the UI preferences the viewer keeps
// in the same slot.
func TestGeometryWritesKeepTheWindowsUIPrefs(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	if err := m.MergeWindowUIPrefs(board, uiPatch(t, `{"juggler-column-width":"31.5"}`)); err != nil {
		t.Fatalf("set ui prefs: %v", err)
	}
	frame := WindowState{X: 1420, Y: 40, Width: 520, Height: 900, HasPos: true}
	if err := m.SetWindowState(board, frame); err != nil {
		t.Fatalf("SetWindowState: %v", err)
	}

	got, ok := m.GetWindowState(board)
	if !ok {
		t.Fatal("expected the board's slot after a geometry write")
	}
	if !got.SameFrame(frame) {
		t.Fatalf("the frame has to be the one written: got %+v want %+v", got, frame)
	}
	if want := `"31.5"`; string(m.GetWindowUIPrefs(board)["juggler-column-width"]) != want {
		t.Fatalf("a drag wiped the window's UI preferences: got %s want %s",
			m.GetWindowUIPrefs(board)["juggler-column-width"], want)
	}
}

// A window told only a UI preference has a slot with no frame in it. That must
// read as "no saved geometry" — the window is placed by the centred default, not
// at 0,0.
func TestAPrefsOnlySlotIsNotGeometry(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	if err := m.MergeWindowUIPrefs(board, uiPatch(t, `{"juggler-column-width":"31.5"}`)); err != nil {
		t.Fatalf("set ui prefs: %v", err)
	}
	got, _ := m.GetWindowState(board)
	if got.HasPos || got.Width != 0 || got.Height != 0 {
		t.Fatalf("a preferences-only slot must carry no frame: got %+v", got)
	}
}
