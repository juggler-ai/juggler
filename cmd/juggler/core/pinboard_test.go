//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// intPtr is the only way to express "this op names a position" versus "this op
// doesn't care", which PinboardOp.Index distinguishes with a pointer.
func intPtr(i int) *int { return &i }

// pinIDs renders a board as its id order, which is what almost every assertion
// here is actually about.
func pinIDs(pins []Pin) string {
	ids := make([]string, len(pins))
	for i, p := range pins {
		ids[i] = p.ID
	}
	return strings.Join(ids, ",")
}

// addOp builds an add for a file pin, the shape most tests want.
func addOp(id string, index *int) PinboardOp {
	return PinboardOp{Op: pinOpAdd, ID: id, Type: "file", Config: json.RawMessage(`{"path":"a.go"}`), Index: index}
}

func TestApplyPinboardOpsAddRemoveMove(t *testing.T) {
	pins, err := applyPinboardOps(nil, []PinboardOp{addOp("a", nil), addOp("b", nil), addOp("c", nil)})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if got := pinIDs(pins); got != "a,b,c" {
		t.Fatalf("adds append in order: got %q want %q", got, "a,b,c")
	}

	pins, err = applyPinboardOps(pins, []PinboardOp{addOp("d", intPtr(1))})
	if err != nil {
		t.Fatalf("add at index: %v", err)
	}
	if got := pinIDs(pins); got != "a,d,b,c" {
		t.Fatalf("add honours index: got %q want %q", got, "a,d,b,c")
	}

	pins, err = applyPinboardOps(pins, []PinboardOp{{Op: pinOpMove, ID: "c", Index: intPtr(0)}})
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if got := pinIDs(pins); got != "c,a,d,b" {
		t.Fatalf("move to front: got %q want %q", got, "c,a,d,b")
	}

	pins, err = applyPinboardOps(pins, []PinboardOp{{Op: pinOpRemove, ID: "a"}})
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if got := pinIDs(pins); got != "c,d,b" {
		t.Fatalf("remove: got %q want %q", got, "c,d,b")
	}
}

// Every op is idempotent, which is the whole reason a client can retry a request
// whose response it never saw. Without this, a dropped response means either a
// duplicated pin or a user afraid to retry.
func TestApplyPinboardOpsAreIdempotent(t *testing.T) {
	base, err := applyPinboardOps(nil, []PinboardOp{addOp("a", nil), addOp("b", nil)})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	cases := []struct {
		name string
		ops  []PinboardOp
		want string
	}{
		{"re-adding an existing id", []PinboardOp{addOp("a", nil)}, "a,b"},
		{"removing an absent id", []PinboardOp{{Op: pinOpRemove, ID: "gone"}}, "a,b"},
		{"moving an absent id", []PinboardOp{{Op: pinOpMove, ID: "gone", Index: intPtr(0)}}, "a,b"},
		{"updating an absent id", []PinboardOp{{Op: pinOpUpdate, ID: "gone", Config: json.RawMessage(`{}`)}}, "a,b"},
	}
	for _, tc := range cases {
		got, err := applyPinboardOps(append([]Pin(nil), base...), tc.ops)
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", tc.name, err)
		}
		if ids := pinIDs(got); ids != tc.want {
			t.Fatalf("%s: got %q want %q", tc.name, ids, tc.want)
		}
	}
}

// An index is a preference about where a tab lands. Refusing a whole user action
// over one that's off the end would be absurd, so it clamps.
func TestApplyPinboardOpsClampsIndex(t *testing.T) {
	pins, err := applyPinboardOps(nil, []PinboardOp{addOp("a", nil), addOp("b", intPtr(99)), addOp("c", intPtr(-5))})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if got := pinIDs(pins); got != "c,a,b" {
		t.Fatalf("clamped indices: got %q want %q", got, "c,a,b")
	}
}

func TestApplyPinboardOpsUpdateReplacesConfig(t *testing.T) {
	pins, err := applyPinboardOps(nil, []PinboardOp{addOp("a", nil)})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	pins, err = applyPinboardOps(pins, []PinboardOp{
		{Op: pinOpUpdate, ID: "a", Config: json.RawMessage(`{"path":"b.go"}`)},
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got := string(pins[0].Config); got != `{"path":"b.go"}` {
		t.Fatalf("update replaces config: got %s", got)
	}
	if pins[0].Type != "file" {
		t.Fatalf("update must not disturb the type: got %q", pins[0].Type)
	}
}

// The server never reads a config, so a pin belonging to a disabled or unknown
// extension must survive round-tripping through the board byte for byte —
// otherwise re-enabling the extension would restore a broken pin.
func TestApplyPinboardOpsPreservesUnknownProviderConfig(t *testing.T) {
	config := `{"nested":{"deep":[1,2,{"x":null}]},"unknownKey":"kept"}`
	pins, err := applyPinboardOps(nil, []PinboardOp{
		{Op: pinOpAdd, ID: "a", Type: "some-extension/whatever", Config: json.RawMessage(config)},
		addOp("b", nil),
	})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	pins, err = applyPinboardOps(pins, []PinboardOp{{Op: pinOpMove, ID: "b", Index: intPtr(0)}})
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if got := string(pins[1].Config); got != config {
		t.Fatalf("unknown config must round-trip verbatim:\n got %s\nwant %s", got, config)
	}
	if pins[1].Type != "some-extension/whatever" {
		t.Fatalf("unknown type must round-trip: got %q", pins[1].Type)
	}
}

// A malformed batch is refused whole. A batch is one user action; half-applying
// it would leave a board nobody asked for.
func TestApplyPinboardOpsRejectBatchWhole(t *testing.T) {
	base, err := applyPinboardOps(nil, []PinboardOp{addOp("a", nil)})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	cases := []struct {
		name string
		ops  []PinboardOp
	}{
		{"unknown op", []PinboardOp{{Op: "explode", ID: "a"}}},
		{"invalid pin id", []PinboardOp{addOp("has spaces", nil)}},
		{"empty pin id", []PinboardOp{addOp("", nil)}},
		{"add without a type", []PinboardOp{{Op: pinOpAdd, ID: "b"}}},
		{"move without an index", []PinboardOp{{Op: pinOpMove, ID: "a"}}},
		{"config that isn't JSON", []PinboardOp{{Op: pinOpAdd, ID: "b", Type: "file", Config: json.RawMessage(`{oh no`)}}},
		{"config over the size cap", []PinboardOp{{Op: pinOpAdd, ID: "b", Type: "file",
			Config: json.RawMessage(`"` + strings.Repeat("x", MaxPinConfigBytes) + `"`)}}},
		{"a good op followed by a bad one", []PinboardOp{addOp("b", nil), {Op: "explode", ID: "c"}}},
	}
	for _, tc := range cases {
		got, err := applyPinboardOps(append([]Pin(nil), base...), tc.ops)
		if err == nil {
			t.Fatalf("%s: expected an error, got board %q", tc.name, pinIDs(got))
		}
		if got != nil {
			t.Fatalf("%s: a rejected batch must return no board, got %q", tc.name, pinIDs(got))
		}
	}
}

func TestApplyPinboardOpsEnforcesLimits(t *testing.T) {
	var ops []PinboardOp
	for i := 0; i < MaxPinboardOps+1; i++ {
		ops = append(ops, addOp("p", nil))
	}
	if _, err := applyPinboardOps(nil, ops); err == nil {
		t.Fatal("expected an error for an over-long batch")
	}

	// Fill the board to the cap in legal-sized batches, then overflow it.
	var pins []Pin
	for i := 0; i < MaxPins; i++ {
		var err error
		pins, err = applyPinboardOps(pins, []PinboardOp{addOp("pin-"+strconv.Itoa(i), nil)})
		if err != nil {
			t.Fatalf("filling to the cap: %v", err)
		}
	}
	if len(pins) != MaxPins {
		t.Fatalf("expected a full board of %d, got %d", MaxPins, len(pins))
	}
	if _, err := applyPinboardOps(pins, []PinboardOp{addOp("one-too-many", nil)}); err == nil {
		t.Fatal("expected an error when exceeding MaxPins")
	}
}

func TestSessionManagerPinboardRoundTrip(t *testing.T) {
	m := newManagerForTest(t)

	if pins := m.GetPinboard(MainBoardID); len(pins) != 0 {
		t.Fatalf("a fresh session starts with an empty board, got %d pins", len(pins))
	}

	pins, err := m.ApplyPinboardOps(MainBoardID, []PinboardOp{addOp("a", nil), addOp("b", nil)})
	if err != nil {
		t.Fatalf("ApplyPinboardOps: %v", err)
	}
	if got := pinIDs(pins); got != "a,b" {
		t.Fatalf("returned board: got %q want %q", got, "a,b")
	}
	if got := pinIDs(m.GetPinboard(MainBoardID)); got != "a,b" {
		t.Fatalf("GetPinboard: got %q want %q", got, "a,b")
	}
	if pins[0].AddedAt == "" {
		t.Fatal("the server must stamp addedAt on a new pin")
	}
}

// The board is the user's workspace layout; it has to still be there tomorrow.
func TestSessionManagerPinboardPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	m := startManager(store, dir)
	if _, err := m.ApplyPinboardOps(MainBoardID, []PinboardOp{addOp("a", nil), addOp("b", nil)}); err != nil {
		t.Fatalf("ApplyPinboardOps: %v", err)
	}
	m.Shutdown()

	reopened, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(reopened, dir)
	t.Cleanup(m2.Shutdown)
	if got := pinIDs(m2.GetPinboard(MainBoardID)); got != "a,b" {
		t.Fatalf("board after reopen: got %q want %q", got, "a,b")
	}
}

// GetPinboard hands out a copy. Without this, a caller ranging over the result
// while the actor applies an edit is a data race, which is exactly the class of
// bug the actor exists to make structurally impossible.
func TestGetPinboardSnapshotIsolation(t *testing.T) {
	m := newManagerForTest(t)
	if _, err := m.ApplyPinboardOps(MainBoardID, []PinboardOp{addOp("a", nil)}); err != nil {
		t.Fatalf("ApplyPinboardOps: %v", err)
	}

	snapshot := m.GetPinboard(MainBoardID)
	snapshot[0].Type = "vandalised"
	snapshot = append(snapshot, Pin{ID: "ghost", Type: "file"})
	_ = snapshot

	live := m.GetPinboard(MainBoardID)
	if len(live) != 1 || live[0].Type != "file" {
		t.Fatalf("mutating a snapshot leaked into the live board: %+v", live)
	}
}

// Session.Clone underpins every GetSession snapshot; a slice it forgets to copy
// is a race that only shows up under load.
func TestSessionCloneCopiesPinboard(t *testing.T) {
	s := NewSession()
	s.Pinboard = []Pin{{ID: "a", Type: "file"}}
	c := s.Clone()
	c.Pinboard[0].Type = "vandalised"
	c.Pinboard = append(c.Pinboard, Pin{ID: "ghost"})
	if len(s.Pinboard) != 1 || s.Pinboard[0].Type != "file" {
		t.Fatalf("Clone must deep-copy the pinboard, original became %+v", s.Pinboard)
	}
}

// The board map is a map of slices, so Clone has to go two levels down. One
// level would hand every caller the same backing array.
func TestSessionCloneCopiesBoards(t *testing.T) {
	s := NewSession()
	s.Boards = map[string]Board{
		MainBoardID: {ID: MainBoardID, Pins: []Pin{{ID: "a", Type: "file"}}},
	}
	c := s.Clone()
	c.Boards[MainBoardID].Pins[0].Type = "vandalised"
	c.Boards["board_extra"] = Board{ID: "board_extra"}
	if len(s.Boards) != 1 {
		t.Fatalf("Clone must copy the board map, original became %+v", s.Boards)
	}
	if s.Boards[MainBoardID].Pins[0].Type != "file" {
		t.Fatalf("Clone must copy each board's pins, original became %+v", s.Boards[MainBoardID].Pins)
	}
}

// A project pinned before boards existed has its board under the old field. It
// has to come back as the docked one, because that is the only board the version
// that wrote it could have meant.
func TestMigrateBoardsFoldsTheLegacyBoard(t *testing.T) {
	s := NewSession()
	s.Pinboard = []Pin{{ID: "a", Type: "file"}, {ID: "b", Type: "git"}}
	s.migrateBoards()

	if s.Pinboard != nil {
		t.Fatalf("the old field must be given up, still holds %+v", s.Pinboard)
	}
	if got := pinIDs(s.Boards[MainBoardID].Pins); got != "a,b" {
		t.Fatalf("migrated main board: got %q want %q", got, "a,b")
	}
}

// A project that never pinned anything migrates to nothing. Writing an empty
// board into every session.json would be recording an arrangement nobody made.
func TestMigrateBoardsLeavesAnUnusedProjectAlone(t *testing.T) {
	s := NewSession()
	s.migrateBoards()
	if len(s.Boards) != 0 {
		t.Fatalf("an unused project must gain no boards, got %+v", s.Boards)
	}
}

// A session written by a Juggler that already had boards, and which somehow
// still carries the old field, keeps the boards. The old field is a fallback and
// never an override.
func TestMigrateBoardsPrefersAnExistingMainBoard(t *testing.T) {
	s := NewSession()
	s.Pinboard = []Pin{{ID: "stale", Type: "file"}}
	s.Boards = map[string]Board{
		MainBoardID: {ID: MainBoardID, Pins: []Pin{{ID: "current", Type: "file"}}},
	}
	s.migrateBoards()
	if got := pinIDs(s.Boards[MainBoardID].Pins); got != "current" {
		t.Fatalf("the existing board must win: got %q want %q", got, "current")
	}
}

// The whole point of the model: a detached window arranges its own tabs, and
// arranging them does not reach into anybody else's.
func TestBoardsAreEditedIndependently(t *testing.T) {
	m := newManagerForTest(t)

	if _, err := m.CreateBoard("board_one", "conv_1", nil); err != nil {
		t.Fatalf("CreateBoard: %v", err)
	}
	if _, err := m.ApplyPinboardOps(MainBoardID, []PinboardOp{addOp("a", nil)}); err != nil {
		t.Fatalf("edit main: %v", err)
	}
	if _, err := m.ApplyPinboardOps("board_one", []PinboardOp{addOp("b", nil), addOp("c", nil)}); err != nil {
		t.Fatalf("edit detached: %v", err)
	}

	if got := pinIDs(m.GetPinboard(MainBoardID)); got != "a" {
		t.Fatalf("main board: got %q want %q", got, "a")
	}
	if got := pinIDs(m.GetPinboard("board_one")); got != "b,c" {
		t.Fatalf("detached board: got %q want %q", got, "b,c")
	}
	if got := pinIDs(m.GetPinboard("board_never_made")); got != "" {
		t.Fatalf("a board nobody made is empty, got %q", got)
	}
}

// A detach seeds the new window with what the panel was showing, so the window
// opens looking like the panel it came out of.
func TestCreateBoardSeedsAndRefusesTheImpossible(t *testing.T) {
	m := newManagerForTest(t)
	seed := []Pin{{ID: "a", Type: "file"}, {ID: "b", Type: "git"}}

	board, err := m.CreateBoard("board_one", "conv_1", seed)
	if err != nil {
		t.Fatalf("CreateBoard: %v", err)
	}
	if board.Conversation != "conv_1" || pinIDs(board.Pins) != "a,b" {
		t.Fatalf("seeded board: %+v", board)
	}
	if !board.IsDetached() {
		t.Fatal("a board with a conversation is a window")
	}

	// A second detach of the same id is a window that failed to open being asked
	// for again, not an instruction to throw its arrangement away.
	if _, err := m.ApplyPinboardOps("board_one", []PinboardOp{{Op: "remove", ID: "a"}}); err != nil {
		t.Fatalf("edit: %v", err)
	}
	again, err := m.CreateBoard("board_one", "conv_1", seed)
	if err != nil {
		t.Fatalf("CreateBoard again: %v", err)
	}
	if got := pinIDs(again.Pins); got != "b" {
		t.Fatalf("a repeated create must not reseed: got %q want %q", got, "b")
	}

	if _, err := m.CreateBoard(MainBoardID, "conv_1", nil); err == nil {
		t.Fatal("the main board is not a window and cannot be created as one")
	}
	if _, err := m.CreateBoard("board_two", "", nil); err == nil {
		t.Fatal("a detached board without a conversation is not a view of anything")
	}
	if _, err := m.CreateBoard("not a valid id", "conv_1", nil); err == nil {
		t.Fatal("a board id has to survive a URL round trip")
	}
}

// Closing a board window on purpose is the user saying they are done with it —
// the arrangement goes, and so does the frame it was in.
func TestDeleteBoardForgetsTheBoardAndItsFrame(t *testing.T) {
	m := newManagerForTest(t)
	if _, err := m.CreateBoard("board_one", "conv_1", []Pin{{ID: "a", Type: "file"}}); err != nil {
		t.Fatalf("CreateBoard: %v", err)
	}
	if err := m.SetWindowState(WindowRolePinboardFor("board_one"), WindowState{Width: 400, Height: 900}); err != nil {
		t.Fatalf("SetWindowState: %v", err)
	}

	if err := m.DeleteBoard("board_one"); err != nil {
		t.Fatalf("DeleteBoard: %v", err)
	}
	if got := pinIDs(m.GetPinboard("board_one")); got != "" {
		t.Fatalf("the board must be gone, still holds %q", got)
	}
	if _, ok := m.GetWindowState(WindowRolePinboardFor("board_one")); ok {
		t.Fatal("the window's frame must go with the board it held")
	}

	// Both the window closing and the app quitting can reach this, and neither
	// knows what the other has done.
	if err := m.DeleteBoard("board_one"); err != nil {
		t.Fatalf("deleting a board that has gone is not a failure: %v", err)
	}
	if err := m.DeleteBoard(MainBoardID); err == nil {
		t.Fatal("the docked panel cannot be deleted")
	}
}

// Two boards are two windows the user placed. One geometry slot had the second
// opened land on the first, and the last closed decide where both opened next.
func TestBoardsHaveTheirOwnFrames(t *testing.T) {
	m := newManagerForTest(t)
	if err := m.SetWindowState(WindowRolePinboardFor("board_one"), WindowState{Width: 400}); err != nil {
		t.Fatalf("SetWindowState one: %v", err)
	}
	if err := m.SetWindowState(WindowRolePinboardFor("board_two"), WindowState{Width: 900}); err != nil {
		t.Fatalf("SetWindowState two: %v", err)
	}
	one, ok := m.GetWindowState(WindowRolePinboardFor("board_one"))
	if !ok || one.Width != 400 {
		t.Fatalf("first board's frame: %+v ok=%v", one, ok)
	}
	two, ok := m.GetWindowState(WindowRolePinboardFor("board_two"))
	if !ok || two.Width != 900 {
		t.Fatalf("second board's frame: %+v ok=%v", two, ok)
	}
}

// The claim is an instruction to open windows, so exactly one asker may have it.
// Every main window of a project asks, and a project can have several.
func TestClaimDetachedBoardsAnswersOnce(t *testing.T) {
	m := newManagerForTest(t)
	// Real conversations, because a claim hands out only the boards that still
	// have one to be a view of.
	if _, _, err := m.CreateConversation("One", "conv_1"); err != nil {
		t.Fatalf("CreateConversation one: %v", err)
	}
	if _, _, err := m.CreateConversation("Two", "conv_2"); err != nil {
		t.Fatalf("CreateConversation two: %v", err)
	}
	if _, err := m.CreateBoard("board_b", "conv_2", nil); err != nil {
		t.Fatalf("CreateBoard b: %v", err)
	}
	if _, err := m.CreateBoard("board_a", "conv_1", nil); err != nil {
		t.Fatalf("CreateBoard a: %v", err)
	}
	if _, err := m.ApplyPinboardOps(MainBoardID, []PinboardOp{addOp("a", nil)}); err != nil {
		t.Fatalf("edit main: %v", err)
	}

	claimed := m.ClaimDetachedBoards()
	if len(claimed) != 2 {
		t.Fatalf("expected both detached boards, got %+v", claimed)
	}
	// Ordered, so two runs of the same project restore the same way.
	if claimed[0].ID != "board_a" || claimed[1].ID != "board_b" {
		t.Fatalf("boards must be claimed in a settled order, got %s,%s", claimed[0].ID, claimed[1].ID)
	}
	if claimed[0].Conversation != "conv_1" {
		t.Fatalf("a claimed board must name its conversation, got %+v", claimed[0])
	}

	if again := m.ClaimDetachedBoards(); len(again) != 0 {
		t.Fatalf("a second window must be told nothing, got %+v", again)
	}
	// Claiming is about opening windows, not about the boards themselves.
	if got := pinIDs(m.GetPinboard(MainBoardID)); got != "a" {
		t.Fatalf("claiming must not disturb the boards, main holds %q", got)
	}
}

// A board is the window it belongs to; the windows open at quit have to be there
// on the way back in.
func TestDetachedBoardsSurviveReopen(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	m := startManager(store, dir)
	if _, _, err := m.CreateConversation("One", "conv_1"); err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	if _, err := m.CreateBoard("board_one", "conv_1", []Pin{{ID: "a", Type: "file"}}); err != nil {
		t.Fatalf("CreateBoard: %v", err)
	}
	m.Shutdown()

	reopened, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(reopened, dir)
	t.Cleanup(m2.Shutdown)

	claimed := m2.ClaimDetachedBoards()
	if len(claimed) != 1 || claimed[0].ID != "board_one" || claimed[0].Conversation != "conv_1" {
		t.Fatalf("the board must come back with its conversation, got %+v", claimed)
	}
	if got := pinIDs(claimed[0].Pins); got != "a" {
		t.Fatalf("and with its tabs: got %q want %q", got, "a")
	}
}

// A board is a window onto one conversation, so a conversation that goes takes
// its boards with it — otherwise the next run reopens a window over a transcript
// that is not there any more. Binning counts: the bin holds the conversation,
// not the windows that were watching it.
func TestLosingAConversationForgetsItsBoards(t *testing.T) {
	for _, tc := range []struct {
		name   string
		remove func(m *SessionManager, convID string) error
	}{
		{"deleted", func(m *SessionManager, convID string) error { return m.DeleteConversation(convID, true) }},
		{"binned", func(m *SessionManager, convID string) error { return m.BinConversation(convID) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newManagerForTest(t)
			going, _, err := m.CreateConversation("Going")
			if err != nil {
				t.Fatalf("CreateConversation going: %v", err)
			}
			staying, _, err := m.CreateConversation("Staying")
			if err != nil {
				t.Fatalf("CreateConversation staying: %v", err)
			}
			if _, err := m.CreateBoard("board_one", going, []Pin{{ID: "a", Type: "file"}}); err != nil {
				t.Fatalf("CreateBoard one: %v", err)
			}
			if _, err := m.CreateBoard("board_two", staying, []Pin{{ID: "b", Type: "file"}}); err != nil {
				t.Fatalf("CreateBoard two: %v", err)
			}
			if err := m.SetWindowState(WindowRolePinboardFor("board_one"), WindowState{Width: 400, Height: 900}); err != nil {
				t.Fatalf("SetWindowState: %v", err)
			}
			if _, err := m.ApplyPinboardOps(MainBoardID, []PinboardOp{addOp("m", nil)}); err != nil {
				t.Fatalf("edit main: %v", err)
			}

			if err := tc.remove(m, going); err != nil {
				t.Fatalf("remove conversation: %v", err)
			}

			if got := pinIDs(m.GetPinboard("board_one")); got != "" {
				t.Fatalf("the board of a conversation that has gone must go too, still holds %q", got)
			}
			if _, ok := m.GetWindowState(WindowRolePinboardFor("board_one")); ok {
				t.Fatal("and so must the frame of the window that held it")
			}
			if got := pinIDs(m.GetPinboard("board_two")); got != "b" {
				t.Fatalf("a board on another conversation is untouched: got %q want %q", got, "b")
			}
			// The main board names no conversation, so nothing can single it out.
			if got := pinIDs(m.GetPinboard(MainBoardID)); got != "m" {
				t.Fatalf("the docked panel is not a view of one conversation: got %q want %q", got, "m")
			}
			if claimed := m.ClaimDetachedBoards(); len(claimed) != 1 || claimed[0].ID != "board_two" {
				t.Fatalf("only the surviving board is reopened next run, got %+v", claimed)
			}
		})
	}
}

// Forgetting a conversation's boards as it goes covers the conversations that go
// through this server. A folder removed from the project by hand does not, and
// leaves a board that would reopen a window onto nothing. The claim is the last
// point that can catch one, so it does.
func TestClaimDetachedBoardsDropsBoardsWhoseConversationHasGone(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	m := startManager(store, dir)

	living, _, err := m.CreateConversation("Living")
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	if _, err := m.CreateBoard("board_live", living, []Pin{{ID: "a", Type: "file"}}); err != nil {
		t.Fatalf("CreateBoard live: %v", err)
	}
	// Two boards on conversations this project has never heard of: what is left
	// behind by a folder deleted outside Juggler.
	for _, id := range []string{"board_gone_one", "board_gone_two"} {
		if _, err := m.CreateBoard(id, "conv_vanished", []Pin{{ID: "b", Type: "file"}}); err != nil {
			t.Fatalf("CreateBoard %s: %v", id, err)
		}
		if err := m.SetWindowState(WindowRolePinboardFor(id), WindowState{Width: 400, Height: 900}); err != nil {
			t.Fatalf("SetWindowState %s: %v", id, err)
		}
	}

	claimed := m.ClaimDetachedBoards()
	if len(claimed) != 1 || claimed[0].ID != "board_live" {
		t.Fatalf("only a board with a conversation is reopened, got %+v", claimed)
	}
	for _, id := range []string{"board_gone_one", "board_gone_two"} {
		if got := pinIDs(m.GetPinboard(id)); got != "" {
			t.Fatalf("a board answering for nothing must be forgotten, %s still holds %q", id, got)
		}
		if _, ok := m.GetWindowState(WindowRolePinboardFor(id)); ok {
			t.Fatalf("and so must the frame of the window that held it, %s kept one", id)
		}
	}
	if got := pinIDs(m.GetPinboard("board_live")); got != "a" {
		t.Fatalf("the surviving board keeps its tabs: got %q want %q", got, "a")
	}

	// Dropped for good, not just left out of one answer: a claim is spent, so a
	// board that survived on disk would be handed out by the next run instead.
	m.Shutdown()
	reopened, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(reopened, dir)
	t.Cleanup(m2.Shutdown)
	if again := m2.ClaimDetachedBoards(); len(again) != 1 || again[0].ID != "board_live" {
		t.Fatalf("the next run must not be given them either, got %+v", again)
	}
}

// The starting tabs are laid out once. Every main window of a project asks, and
// a project can have several open at once, so the second to ask must be told no
// rather than lay out a second set on top of the first.
func TestClaimBoardSeedAnswersOnce(t *testing.T) {
	m := newManagerForTest(t)

	if !m.ClaimBoardSeed(MainBoardID) {
		t.Fatal("the first viewer of an unused project furnishes its board")
	}
	if m.ClaimBoardSeed(MainBoardID) {
		t.Fatal("the second must be told no, or the board is furnished twice")
	}
	if pins := m.GetPinboard(MainBoardID); len(pins) != 0 {
		t.Fatalf("the claim places no tabs itself, got %d pins", len(pins))
	}
}

// The point of the flag: a board the user has stripped bare stays bare. Without
// it an empty main board is dropped from the session, and being absent is what
// makes a board claimable — so every launch would put the tabs back.
func TestAnEmptiedBoardIsNotFurnishedAgain(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	m := startManager(store, dir)
	if !m.ClaimBoardSeed(MainBoardID) {
		t.Fatal("first claim")
	}
	if _, err := m.ApplyPinboardOps(MainBoardID, []PinboardOp{addOp("a", nil), addOp("b", nil)}); err != nil {
		t.Fatalf("furnish: %v", err)
	}
	ops := []PinboardOp{{Op: pinOpRemove, ID: "a"}, {Op: pinOpRemove, ID: "b"}}
	if _, err := m.ApplyPinboardOps(MainBoardID, ops); err != nil {
		t.Fatalf("empty the board: %v", err)
	}
	m.Shutdown()

	reopened, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(reopened, dir)
	t.Cleanup(m2.Shutdown)
	if m2.ClaimBoardSeed(MainBoardID) {
		t.Fatal("a board the user emptied must stay empty, not be furnished again")
	}
	if pins := m2.GetPinboard(MainBoardID); len(pins) != 0 {
		t.Fatalf("and it must reopen empty, got %d pins", len(pins))
	}
}

// A board written by a Juggler that laid out no starting tabs is an arrangement
// its user made by hand. Furnishing it now would drop a set of tabs into a board
// they had already made their own.
func TestABoardArrangedByHandIsNeverClaimable(t *testing.T) {
	m := newManagerForTest(t)
	if _, err := m.ApplyPinboardOps(MainBoardID, []PinboardOp{addOp("a", nil)}); err != nil {
		t.Fatalf("ApplyPinboardOps: %v", err)
	}
	if m.ClaimBoardSeed(MainBoardID) {
		t.Fatal("a board that already has tabs is nobody's to furnish")
	}
	if got := pinIDs(m.GetPinboard(MainBoardID)); got != "a" {
		t.Fatalf("and it is left exactly as it was: got %q want %q", got, "a")
	}
}

// A detached board opens carrying the tabs of the panel it left, so it is never
// waiting to be furnished. One that is missing has been forgotten, and answering
// yes would put back a conversation-less orphan under its id.
func TestOnlyTheMainBoardIsFurnished(t *testing.T) {
	m := newManagerForTest(t)
	if _, err := m.CreateBoard("board_one", "conv_a", []Pin{{ID: "a", Type: "file"}}); err != nil {
		t.Fatalf("CreateBoard: %v", err)
	}
	if m.ClaimBoardSeed("board_one") {
		t.Fatal("a detached board is furnished by the detach that made it")
	}
	if m.ClaimBoardSeed("board_forgotten") {
		t.Fatal("and a board that has gone must not be conjured back by a claim")
	}
	if pins := m.GetPinboard("board_forgotten"); len(pins) != 0 {
		t.Fatalf("no board should exist under that id, got %d pins", len(pins))
	}
}
