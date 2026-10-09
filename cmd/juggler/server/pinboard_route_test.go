//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/workspace"
)

// The pinboard is the project's shared workspace composition — which panels are
// pinned, in what order. Unlike ui-zoom and ui-theme it is NOT a per-device
// preference, so its write route is deliberately not gated to the local viewer: a
// phone editing the board over the LAN is editing the same board, which is the
// point. These tests pin that, the operation semantics as seen through the route,
// and the broadcast that lets a second viewer converge.

// recordingBroadcaster captures the pinboard broadcasts a request produces,
// each with the board it was about.
type recordingBroadcaster struct {
	boards     [][]core.Pin
	names      []string
	reveals    []pinboardReveal
	workspaces [][]workspace.Row
}

type pinboardReveal struct {
	board string
	pin   string
	from  string
}

func (b *recordingBroadcaster) BroadcastSessionChanged()                          {}
func (b *recordingBroadcaster) BroadcastSessionMetadataChanged(map[string]any)    {}
func (b *recordingBroadcaster) BroadcastConversationsChanged(op, id, name string) {}
func (b *recordingBroadcaster) BroadcastConversationsReordered([]string)          {}
func (b *recordingBroadcaster) BroadcastConversationFocus(id, from string)        {}
func (b *recordingBroadcaster) BroadcastWorkspacesChanged(workspaces []workspace.Row) {
	b.workspaces = append(b.workspaces, workspaces)
}
func (b *recordingBroadcaster) BroadcastPinboardChanged(board string, pins []core.Pin) {
	b.boards = append(b.boards, pins)
	b.names = append(b.names, board)
}
func (b *recordingBroadcaster) BroadcastPinboardReveal(board, pin, from string) {
	b.reveals = append(b.reveals, pinboardReveal{board: board, pin: pin, from: from})
}

// newPinboardTestServer wires the real session routes over a real (temp-dir)
// session manager, so these tests exercise the registered route rather than
// calling the handler directly.
func newPinboardTestServer(t *testing.T) (*Server, *recordingBroadcaster) {
	t.Helper()
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	bc := &recordingBroadcaster{}
	s := &Server{router: mux.NewRouter()}
	s.setupSessionRoutes(handlers.NewSessionAPI(
		func() *core.SessionManager { return mgr }, nil, bc, nil, nil))
	return s, bc
}

// pinboardRequest issues one request against the real router.
func pinboardRequest(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:54321"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)
	return rec
}

// decodePins reads the `pins` array out of a pinboard response.
func decodePins(t *testing.T, rec *httptest.ResponseRecorder) []core.Pin {
	t.Helper()
	var body struct {
		Pins []core.Pin `json:"pins"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode pins from %q: %v", rec.Body.String(), err)
	}
	return body.Pins
}

// pinOrder renders a board as its id order.
func pinOrder(pins []core.Pin) string {
	ids := make([]string, len(pins))
	for i, p := range pins {
		ids[i] = p.ID
	}
	return strings.Join(ids, ",")
}

func TestPinboardGetStartsEmpty(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	rec := pinboardRequest(t, s, http.MethodGet, "/api/session/pinboard", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET pinboard: got %d, want 200", rec.Code)
	}
	// An empty board must serialize as [], not null: the client sanitizes a
	// non-array to nothing, and "no pins yet" should not look like a fault.
	if !strings.Contains(rec.Body.String(), `"pins":[]`) {
		t.Fatalf("an empty board must be [], got %s", rec.Body.String())
	}
}

func TestPinboardOperationsApplyAndBroadcast(t *testing.T) {
	s, bc := newPinboardTestServer(t)

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations",
		`{"operations":[
			{"op":"add","id":"pin_a","type":"file","config":{"path":"a.go"}},
			{"op":"add","id":"pin_b","type":"file","config":{"path":"b.go"}}
		]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST operations: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if got := pinOrder(decodePins(t, rec)); got != "pin_a,pin_b" {
		t.Fatalf("response board: got %q want %q", got, "pin_a,pin_b")
	}

	// The board the caller is told about and the board every other viewer is told
	// about have to be the same board.
	if len(bc.boards) != 1 {
		t.Fatalf("expected exactly one broadcast, got %d", len(bc.boards))
	}
	if got := pinOrder(bc.boards[0]); got != "pin_a,pin_b" {
		t.Fatalf("broadcast board: got %q want %q", got, "pin_a,pin_b")
	}

	rec = pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations",
		`{"operations":[{"op":"move","id":"pin_b","index":0}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST move: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if got := pinOrder(decodePins(t, rec)); got != "pin_b,pin_a" {
		t.Fatalf("after move: got %q want %q", got, "pin_b,pin_a")
	}

	// A second viewer reading the board sees what the first one did.
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/pinboard", "")
	if got := pinOrder(decodePins(t, rec)); got != "pin_b,pin_a" {
		t.Fatalf("GET after edits: got %q want %q", got, "pin_b,pin_a")
	}
}

func TestPinboardOperationsBroadcastRequestedReveal(t *testing.T) {
	s, bc := newPinboardTestServer(t)

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations",
		`{"operations":[{"op":"add","id":"pin_report","type":"file","config":{"path":"report.html"}}],"reveal":{"pin":"pin_report","from":"conversation-one"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST operations: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if len(bc.reveals) != 1 {
		t.Fatalf("expected exactly one reveal broadcast, got %d", len(bc.reveals))
	}
	if got := bc.reveals[0]; got != (pinboardReveal{board: core.MainBoardID, pin: "pin_report", from: "conversation-one"}) {
		t.Fatalf("reveal broadcast: got %+v", got)
	}
}

// Two viewers editing at once is not a conflict to arbitrate: each op names its
// pin, so both land. This is what buys the protocol its freedom from revisions.
func TestPinboardConcurrentViewersBothLand(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations",
		`{"operations":[{"op":"add","id":"pin_a","type":"file"},{"op":"add","id":"pin_b","type":"file"}]}`)

	// Viewer one reorders. Viewer two, which never saw that reorder and would
	// have sent a stale whole-board write, adds a pin instead.
	pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations",
		`{"operations":[{"op":"move","id":"pin_b","index":0}]}`)
	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations",
		`{"operations":[{"op":"add","id":"pin_c","type":"file"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("second viewer's add: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if got := pinOrder(decodePins(t, rec)); got != "pin_b,pin_a,pin_c" {
		t.Fatalf("both edits must survive: got %q want %q", got, "pin_b,pin_a,pin_c")
	}
}

// A retry after a response the client never saw must not duplicate the pin.
func TestPinboardRetriedAddIsIdempotent(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	body := `{"operations":[{"op":"add","id":"pin_a","type":"file","config":{"path":"a.go"}}]}`
	pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations", body)
	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations", body)
	if got := pinOrder(decodePins(t, rec)); got != "pin_a" {
		t.Fatalf("a retried add must not duplicate: got %q", got)
	}
}

func TestPinboardOperationsRejectBadRequests(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"no operations key", `{}`},
		{"empty operations", `{"operations":[]}`},
		{"unknown op", `{"operations":[{"op":"explode","id":"pin_a"}]}`},
		{"add without a type", `{"operations":[{"op":"add","id":"pin_a"}]}`},
		{"illegal pin id", `{"operations":[{"op":"add","id":"../etc","type":"file"}]}`},
		{"malformed json", `{"operations":`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, bc := newPinboardTestServer(t)
			rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("got %d (%s), want 400", rec.Code, rec.Body.String())
			}
			// A refused edit must not tell every viewer the board changed.
			if len(bc.boards) != 0 {
				t.Fatalf("a rejected batch must not broadcast, got %d broadcasts", len(bc.boards))
			}
		})
	}
}

// A rejected batch leaves the board exactly as it was — a batch is one user
// action, and half of one is a board nobody asked for.
func TestPinboardRejectedBatchLeavesBoardUntouched(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations",
		`{"operations":[{"op":"add","id":"pin_a","type":"file"}]}`)
	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations",
		`{"operations":[{"op":"add","id":"pin_b","type":"file"},{"op":"explode","id":"pin_c"}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rec.Code)
	}

	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/pinboard", "")
	if got := pinOrder(decodePins(t, rec)); got != "pin_a" {
		t.Fatalf("board after a rejected batch: got %q want %q", got, "pin_a")
	}
}

// A board detached into a window is its own arrangement. Editing it must not
// reach the panel it came out of, which is the whole reason boards are named.
func TestPinboardBoardsAreEditedIndependently(t *testing.T) {
	s, bc := newPinboardTestServer(t)

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/boards",
		`{"id":"board_one","conversation":"conv_1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST boards: got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations",
		`{"operations":[{"op":"add","id":"pin_a","type":"file"}]}`)
	pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations?board=board_one",
		`{"operations":[{"op":"add","id":"pin_b","type":"file"}]}`)

	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/pinboard", "")
	if got := pinOrder(decodePins(t, rec)); got != "pin_a" {
		t.Fatalf("the docked panel: got %q want %q", got, "pin_a")
	}
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/pinboard?board=board_one", "")
	if got := pinOrder(decodePins(t, rec)); got != "pin_b" {
		t.Fatalf("the detached board: got %q want %q", got, "pin_b")
	}

	// A viewer reads one board, so a broadcast has to say which one it is about.
	if len(bc.names) != 2 || bc.names[0] != core.MainBoardID || bc.names[1] != "board_one" {
		t.Fatalf("broadcasts must name their board, got %v", bc.names)
	}
}

// A detach seeds the window with what the panel it came out of was showing.
func TestPinboardCreateBoardSeedsItsPins(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/boards",
		`{"id":"board_one","conversation":"conv_1","pins":[
			{"id":"pin_a","type":"file"},{"id":"pin_b","type":"git"}
		]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST boards: got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/pinboard?board=board_one", "")
	if got := pinOrder(decodePins(t, rec)); got != "pin_a,pin_b" {
		t.Fatalf("seeded board: got %q want %q", got, "pin_a,pin_b")
	}
	// Seeding a window is not pinning anything to the panel it came from.
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/pinboard", "")
	if got := pinOrder(decodePins(t, rec)); got != "" {
		t.Fatalf("the docked panel must be untouched, got %q", got)
	}
}

// Closing a board window on purpose is the user saying they are done with it.
func TestPinboardDeleteBoard(t *testing.T) {
	s, _ := newPinboardTestServer(t)
	pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/boards",
		`{"id":"board_one","conversation":"conv_1","pins":[{"id":"pin_a","type":"file"}]}`)

	rec := pinboardRequest(t, s, http.MethodDelete, "/api/session/pinboard/boards?board=board_one", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE board: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/pinboard?board=board_one", "")
	if got := pinOrder(decodePins(t, rec)); got != "" {
		t.Fatalf("the board must be gone, still holds %q", got)
	}

	// The docked panel is not a window and has no closing.
	rec = pinboardRequest(t, s, http.MethodDelete, "/api/session/pinboard/boards", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("deleting the main board: got %d, want 400", rec.Code)
	}
}

// The restore answer is an instruction to open windows, so exactly one asker may
// have it — every main window of a project asks, and there can be several.
func TestPinboardRestoreIsClaimedOnce(t *testing.T) {
	s, _ := newPinboardTestServer(t)
	// A real conversation, because a board with none left to be a view of is
	// dropped by the claim rather than handed out.
	if rec := pinboardRequest(t, s, http.MethodPost, "/api/conversations",
		`{"name":"One","id":"conv_1"}`); rec.Code != http.StatusCreated {
		t.Fatalf("create conversation: got %d (%s), want 201", rec.Code, rec.Body.String())
	}
	pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/boards",
		`{"id":"board_one","conversation":"conv_1","pins":[{"id":"pin_a","type":"file"}]}`)

	decodeBoards := func(rec *httptest.ResponseRecorder) []core.Board {
		t.Helper()
		var body struct {
			Boards []core.Board `json:"boards"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode boards from %q: %v", rec.Body.String(), err)
		}
		return body.Boards
	}

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/boards/restore", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST restore: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	boards := decodeBoards(rec)
	if len(boards) != 1 || boards[0].ID != "board_one" || boards[0].Conversation != "conv_1" {
		t.Fatalf("restore must name the board and its conversation, got %+v", boards)
	}
	if got := pinOrder(boards[0].Pins); got != "pin_a" {
		t.Fatalf("and its tabs: got %q want %q", got, "pin_a")
	}

	rec = pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/boards/restore", "")
	if boards := decodeBoards(rec); len(boards) != 0 {
		t.Fatalf("a second window must be told nothing, got %+v", boards)
	}
}

// A board id travels in a window's URL. One that arrives misspelt is a bug at
// the other end, and silently editing the docked panel instead would answer it
// by rearranging the panel the user was looking at.
func TestPinboardRejectsAMalformedBoardID(t *testing.T) {
	s, bc := newPinboardTestServer(t)

	for _, path := range []string{
		"/api/session/pinboard?board=../etc",
		"/api/session/pinboard/operations?board=../etc",
		"/api/session/pinboard/boards?board=../etc",
	} {
		method := http.MethodGet
		body := ""
		switch {
		case strings.Contains(path, "operations"):
			method = http.MethodPost
			body = `{"operations":[{"op":"add","id":"pin_a","type":"file"}]}`
		case strings.Contains(path, "boards"):
			method = http.MethodDelete
		}
		rec := pinboardRequest(t, s, method, path, body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s %s: got %d (%s), want 400", method, path, rec.Code, rec.Body.String())
		}
	}
	if len(bc.boards) != 0 {
		t.Fatalf("a refused request must not broadcast, got %d", len(bc.boards))
	}
}

// The seed claim through the real router: the first window to ask is told to lay
// out the starting tabs, and every window after it is told the board is already
// somebody's arrangement.
func TestPinboardSeedIsClaimedOnce(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	seeded := func() bool {
		t.Helper()
		rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/seed", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("POST seed: got %d, want 200 (%s)", rec.Code, rec.Body.String())
		}
		var body struct {
			Board string `json:"board"`
			Seed  bool   `json:"seed"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode seed from %q: %v", rec.Body.String(), err)
		}
		if body.Board != core.MainBoardID {
			t.Fatalf("a request naming no board is about the panel: got %q", body.Board)
		}
		return body.Seed
	}

	if !seeded() {
		t.Fatal("the first window to ask lays out the starting tabs")
	}
	if seeded() {
		t.Fatal("the second must be told no, or every window lays them out again")
	}
}

// A board that already has tabs is an arrangement somebody made, and is never
// handed to a viewer to furnish.
func TestPinboardSeedRefusedOnAnArrangedBoard(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	ops := `{"operations":[{"op":"add","id":"a","type":"file","config":{"path":"a.go"}}]}`
	if rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/operations", ops); rec.Code != http.StatusOK {
		t.Fatalf("seed a pin: got %d (%s)", rec.Code, rec.Body.String())
	}

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/seed", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST seed: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"seed":true`) {
		t.Fatalf("a board with tabs on it is nobody's to furnish: %s", rec.Body.String())
	}
}

// A misspelt board id is refused here as everywhere else under the pinboard,
// rather than quietly spending the panel's claim instead.
func TestPinboardSeedRefusesABadBoardID(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/seed?board=not%20valid", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST seed with a bad board id: got %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
}
