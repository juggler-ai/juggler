//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// newManagerForTest spins up a SessionManager rooted at a fresh temp project
// dir, seeding an empty session so Load() succeeds. The manager is shut down
// on test cleanup.
func newManagerForTest(t *testing.T) *SessionManager {
	t.Helper()
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	m := startManager(store, dir)
	t.Cleanup(m.Shutdown)
	return m
}

// Window geometry is a per-project session global, not a machine-global file
// that every window would read and fight over (which would land a freshly
// spawned window exactly on top of its sibling). These tests pin the contract:
// geometry round-trips through the project's own session, survives a reload
// from disk, and is independent across projects.
func TestWindowStateRoundTrip(t *testing.T) {
	m := newManagerForTest(t)

	// Absent until first save.
	if _, ok := m.GetWindowState(WindowRoleMain); ok {
		t.Fatalf("expected no saved window state on a fresh session")
	}

	want := WindowState{X: 120, Y: 80, Width: 1024, Height: 768, HasPos: true, Maximised: false, Fullscreen: false}
	if err := m.SetWindowState(WindowRoleMain, want); err != nil {
		t.Fatalf("SetWindowState: %v", err)
	}

	got, ok := m.GetWindowState(WindowRoleMain)
	if !ok {
		t.Fatalf("expected saved window state after SetWindowState")
	}
	if !got.SameFrame(want) {
		t.Fatalf("round-trip mismatch: got %+v want %+v", got, want)
	}
}

func TestWindowStatePersistsToDisk(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	m := startManager(store, dir)
	want := WindowState{X: 5, Y: 6, Width: 800, Height: 600, HasPos: true, Maximised: true}
	if err := m.SetWindowState(WindowRoleMain, want); err != nil {
		t.Fatalf("SetWindowState: %v", err)
	}
	m.Shutdown()

	// Reopen the same project from disk — a new process restoring the window.
	store2, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(store2, dir)
	t.Cleanup(m2.Shutdown)
	got, ok := m2.GetWindowState(WindowRoleMain)
	if !ok {
		t.Fatalf("expected window state to survive reload from %s", filepath.Join(dir, ".juggler", "session.json"))
	}
	if !got.SameFrame(want) {
		t.Fatalf("reloaded mismatch: got %+v want %+v", got, want)
	}
}

func TestWindowStateIndependentPerProject(t *testing.T) {
	a := newManagerForTest(t)
	b := newManagerForTest(t)

	aState := WindowState{X: 10, Y: 10, Width: 1200, Height: 900, HasPos: true}
	bState := WindowState{X: 700, Y: 400, Width: 640, Height: 480, HasPos: true}
	if err := a.SetWindowState(WindowRoleMain, aState); err != nil {
		t.Fatalf("set a: %v", err)
	}
	if err := b.SetWindowState(WindowRoleMain, bState); err != nil {
		t.Fatalf("set b: %v", err)
	}

	gotA, okA := a.GetWindowState(WindowRoleMain)
	gotB, okB := b.GetWindowState(WindowRoleMain)
	if !okA || !okB {
		t.Fatalf("expected both projects to have saved state (a=%v b=%v)", okA, okB)
	}
	if !gotA.SameFrame(aState) {
		t.Fatalf("project a clobbered: got %+v want %+v", gotA, aState)
	}
	if !gotB.SameFrame(bState) {
		t.Fatalf("project b clobbered: got %+v want %+v", gotB, bState)
	}
}

// A project has more than one kind of window — Juggler itself, and a board
// detached from it into a window of its own. They are different shapes, so each
// keeps its own frame; one shared slot had the board writing over the app's
// every time the board closed.
func TestWindowStateIsIndependentPerRole(t *testing.T) {
	m := newManagerForTest(t)

	main := WindowState{X: 0, Y: 0, Width: 1400, Height: 900, HasPos: true}
	board := WindowState{X: 1420, Y: 40, Width: 520, Height: 900, HasPos: true}
	if err := m.SetWindowState(WindowRoleMain, main); err != nil {
		t.Fatalf("set main: %v", err)
	}
	if err := m.SetWindowState(WindowRolePinboard, board); err != nil {
		t.Fatalf("set pinboard: %v", err)
	}

	gotMain, okMain := m.GetWindowState(WindowRoleMain)
	if !okMain || !gotMain.SameFrame(main) {
		t.Fatalf("the board's frame overwrote the window's: got %+v want %+v", gotMain, main)
	}
	gotBoard, okBoard := m.GetWindowState(WindowRolePinboard)
	if !okBoard || !gotBoard.SameFrame(board) {
		t.Fatalf("board frame: got %+v want %+v", gotBoard, board)
	}
}

// A role nothing has ever saved is absent rather than answered with another
// role's frame — a window placed from a guess is worse than a centred default.
func TestWindowStateAnUnsavedRoleIsAbsent(t *testing.T) {
	m := newManagerForTest(t)
	if err := m.SetWindowState(WindowRoleMain, WindowState{X: 1, Y: 2, Width: 3, Height: 4, HasPos: true}); err != nil {
		t.Fatalf("set main: %v", err)
	}
	if _, ok := m.GetWindowState(WindowRolePinboard); ok {
		t.Fatal("a role with no saved frame must not inherit another role's")
	}
	if _, ok := m.GetWindowState("something-else"); ok {
		t.Fatal("nor must a role this build does not have")
	}
}

// A session written before geometry had roles holds one frame, and that frame
// was the main window's — so it becomes the main window's rather than being
// dropped and the window reopening centred.
func TestWindowStateMigratesASingleSavedFrame(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	old := WindowState{X: 300, Y: 200, Width: 1024, Height: 768, HasPos: true}
	session := NewSession()
	session.WindowState = &old
	if err := store.Save(session); err != nil {
		t.Fatalf("seed: %v", err)
	}

	m := startManager(store, dir)
	got, ok := m.GetWindowState(WindowRoleMain)
	if !ok || !got.SameFrame(old) {
		t.Fatalf("an older session's frame is the main window's: got %+v want %+v", got, old)
	}
	if _, ok := m.GetWindowState(WindowRolePinboard); ok {
		t.Fatal("and it says nothing about a board, which that version could not open")
	}

	// Writing another role must not lose it, and the migrated shape must reach
	// disk so the next launch reads it without migrating again.
	if err := m.SetWindowState(WindowRolePinboard, WindowState{X: 9, Y: 9, Width: 400, Height: 800, HasPos: true}); err != nil {
		t.Fatalf("set pinboard: %v", err)
	}
	m.Shutdown()

	store2, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(store2, dir)
	t.Cleanup(m2.Shutdown)
	if got, ok := m2.GetWindowState(WindowRoleMain); !ok || !got.SameFrame(old) {
		t.Fatalf("the migrated frame did not survive the reopen: got %+v want %+v", got, old)
	}
}

// A session that already has a main entry is not overwritten by a leftover
// single frame — the roles are the current truth, the old field only a fallback.
func TestMigrateWindowStatesPrefersWhatIsAlreadyThere(t *testing.T) {
	current := WindowState{X: 1, Y: 1, Width: 100, Height: 100, HasPos: true}
	stale := WindowState{X: 999, Y: 999, Width: 1, Height: 1, HasPos: true}
	s := NewSession()
	s.WindowState = &stale
	s.WindowStates = map[string]WindowState{WindowRoleMain: current}

	s.migrateWindowStates()

	if !s.WindowStates[WindowRoleMain].SameFrame(current) {
		t.Fatalf("a role entry wins over the old single field: got %+v", s.WindowStates[WindowRoleMain])
	}
	if s.WindowState != nil {
		t.Fatal("and the old field is cleared once it has been read")
	}
}

// Clone hands out a private copy: a caller mutating the geometry map it was
// given must never reach the session the actor goroutine owns.
func TestCloneDoesNotShareTheWindowStates(t *testing.T) {
	s := NewSession()
	s.WindowStates = map[string]WindowState{WindowRoleMain: {X: 1, Y: 2, Width: 3, Height: 4}}

	c := s.Clone()
	c.WindowStates[WindowRoleMain] = WindowState{X: 99}
	c.WindowStates[WindowRolePinboard] = WindowState{X: 50}

	if s.WindowStates[WindowRoleMain].X != 1 {
		t.Fatal("a clone's write reached the original")
	}
	if _, ok := s.WindowStates[WindowRolePinboard]; ok {
		t.Fatal("a clone's new role reached the original")
	}
}

// A window slot holds a map of the viewer's UI preferences, and a map inside a
// struct value is copied by reference. So the clone handed to an HTTP handler
// would share it with the live session the actor goroutine owns unless the slot
// is deep-copied — the one place a shallow copy of WindowStates is not enough.
func TestCloneDoesNotShareAWindowsUIPrefs(t *testing.T) {
	s := NewSession()
	s.WindowStates = map[string]WindowState{
		WindowRoleMain: {X: 1, UI: map[string]json.RawMessage{"a": json.RawMessage(`1`)}},
	}
	s.UI = map[string]json.RawMessage{"b": json.RawMessage(`2`)}

	c := s.Clone()
	c.WindowStates[WindowRoleMain].UI["a"] = json.RawMessage(`99`)
	c.UI["b"] = json.RawMessage(`99`)

	if got := string(s.WindowStates[WindowRoleMain].UI["a"]); got != `1` {
		t.Fatalf("a clone's write reached the window's stored preferences: got %s want 1", got)
	}
	if got := string(s.UI["b"]); got != `2` {
		t.Fatalf("a clone's write reached the project's stored preferences: got %s want 2", got)
	}
}
