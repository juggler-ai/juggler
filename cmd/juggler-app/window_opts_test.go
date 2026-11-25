//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/url"
	"strconv"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const testCtl = "http://127.0.0.1:5000/win/w1"

// query returns the page URL's parameters, so a case asserts what the page will
// read rather than how the string was spelled.
func query(t *testing.T, opts windowOpts) url.Values {
	t.Helper()
	u, err := url.Parse(windowPageURL("http://127.0.0.1:8080/", testCtl, opts))
	if err != nil {
		t.Fatalf("window page URL does not parse: %v", err)
	}
	return u.Query()
}

// An ordinary window carries nothing about a board, so the app's URL is exactly
// what it was before detaching existed.
func TestWindowPageURLLeavesAnOrdinaryWindowAlone(t *testing.T) {
	got := windowPageURL("http://127.0.0.1:8080/", testCtl, windowOpts{theme: "dark", mode: "system", zoom: 110})
	want := "http://127.0.0.1:8080/?window=1&nativeCtl=" + url.QueryEscape(testCtl) +
		windowHostQuery() + "&theme=dark&mode=system&zoom=110"
	if got != want {
		t.Fatalf("ordinary window URL changed:\n got %s\nwant %s", got, want)
	}
	if strings.Contains(got, "view=") {
		t.Fatal("a window that is not a board must not claim to be one")
	}
}

// The host query names the corner radius only where the window has one, and
// as a whole number the page's pre-paint block can read.
func TestHostQueryCarriesTheCornerRadius(t *testing.T) {
	base := "&ctlProtocol=" + strconv.Itoa(windowProtocol) + "&appVersion=" + url.QueryEscape(core.Version)
	if got := hostQuery(0); got != base {
		t.Errorf("square corners: got %q, want %q", got, base)
	}
	if got, want := hostQuery(16), base+"&corner=16"; got != want {
		t.Errorf("rounded corners: got %q, want %q", got, want)
	}
}

// A board detached from a bordered window opens bordered, and only a board is
// handed the opener's border: every other window starts without one.
func TestWindowBorderSeedsOnlyADetachedBoard(t *testing.T) {
	board := windowOptsFromQuery(url.Values{"view": {viewPinboard}, "board": {"board_one"}, "border": {"1"}})
	if !board.border {
		t.Fatal("a board detached from a bordered window must be handed its border")
	}
	if q := query(t, board); q.Get("border") != "1" {
		t.Errorf("border = %q in the board's URL, want 1", q.Get("border"))
	}
	if main := windowOptsFromQuery(url.Values{"border": {"1"}}); main.border {
		t.Error("a new main window starts without a border")
	}
	if q := query(t, windowOpts{view: viewPinboard, board: "board_one"}); q.Has("border") {
		t.Error("a board from an unbordered window carries no border hint")
	}
}

// A hint nobody supplied is not sent at all: the page has its own precedence,
// and a first-ever launch with nothing to inherit must be allowed to use it.
func TestWindowPageURLOmitsWhatItWasNotGiven(t *testing.T) {
	q := query(t, windowOpts{})
	for _, key := range []string{"theme", "mode", "zoom", "view", "owner", "pin", "conversation"} {
		if q.Has(key) {
			t.Errorf("%s was sent with no value to send", key)
		}
	}
	if q.Get("window") != "1" {
		t.Error("every window is a window")
	}
}

// The board's four parameters are what the detached shell reads (see
// web/js/utils/view-mode.js), so they have to arrive under those names. The
// conversation is the one that decides what the window shows: without it the
// board comes up as a view of nothing.
func TestWindowPageURLCarriesTheBoard(t *testing.T) {
	q := query(t, windowOpts{view: viewPinboard, owner: "v_abc", pin: "pin_42", conversation: "conv_9", theme: "light"})
	if q.Get("view") != "pinboard" {
		t.Errorf("view = %q", q.Get("view"))
	}
	if q.Get("owner") != "v_abc" {
		t.Errorf("owner = %q", q.Get("owner"))
	}
	if q.Get("pin") != "pin_42" {
		t.Errorf("pin = %q", q.Get("pin"))
	}
	if q.Get("conversation") != "conv_9" {
		t.Errorf("conversation = %q", q.Get("conversation"))
	}
	if q.Get("theme") != "light" {
		t.Error("a board inherits its opener's first-frame colour like any other window")
	}
}

// A board opened on no particular pin is a board on whichever tab comes first,
// which is a different thing from a board on a pin named "".
func TestWindowPageURLOmitsAnUnnamedPin(t *testing.T) {
	q := query(t, windowOpts{view: viewPinboard, owner: "v_abc"})
	if q.Has("pin") {
		t.Error("an unnamed pin must not be sent as an empty one")
	}
}

// The control endpoint is loopback, which any process on this machine can reach.
// Everything it is told is therefore validated before it is baked into a child
// window's URL.
func TestWindowOptsFromQueryRefusesWhatIsNotAnID(t *testing.T) {
	cases := []struct {
		name  string
		owner string
		pin   string
		conv  string
		wantO string
		wantP string
		wantC string
	}{
		{"the ids Juggler mints", "v_0123456789abcdef", "pin_a-b_c", "conv_5rugm67jf", "v_0123456789abcdef", "pin_a-b_c", "conv_5rugm67jf"},
		{"a space is not an id", "v abc", "pin 1", "conv 1", "", "", ""},
		{"nor is a path", "../etc", "..%2Fetc", "../etc", "", "", ""},
		{"nor a query of its own", "v_a&b=c", "p?x", "c?x", "", "", ""},
		{"nor an empty one", "", "", "", "", "", ""},
		{"nor one past the server's limit", strings.Repeat("v", 65), strings.Repeat("p", 65), strings.Repeat("c", 65), "", "", ""},
		{"and one at the limit is fine", strings.Repeat("v", 64), strings.Repeat("p", 64), strings.Repeat("c", 64), strings.Repeat("v", 64), strings.Repeat("p", 64), strings.Repeat("c", 64)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := windowOptsFromQuery(url.Values{
				"view":         {"pinboard"},
				"owner":        {tc.owner},
				"pin":          {tc.pin},
				"conversation": {tc.conv},
			})
			if opts.owner != tc.wantO {
				t.Errorf("owner = %q, want %q", opts.owner, tc.wantO)
			}
			if opts.pin != tc.wantP {
				t.Errorf("pin = %q, want %q", opts.pin, tc.wantP)
			}
			if opts.conversation != tc.wantC {
				t.Errorf("conversation = %q, want %q", opts.conversation, tc.wantC)
			}
		})
	}
}

// A view this build does not have is the ordinary app, not a window showing
// nothing.
func TestWindowOptsFromQueryIgnoresAnUnknownView(t *testing.T) {
	opts := windowOptsFromQuery(url.Values{"view": {"something-else"}, "owner": {"v_abc"}})
	if opts.isPinboard() {
		t.Error("only the view this build knows makes a board")
	}
	if opts.owner != "" {
		t.Error("a window that is not a board follows nobody")
	}
	if opts.role() != roleMain {
		t.Errorf("role = %q, want %q", opts.role(), roleMain)
	}
}

// The role is what keeps two kinds of window out of each other's saved frame,
// and what keeps a board out of the restored workspace file.
func TestWindowOptsRole(t *testing.T) {
	if (windowOpts{}).role() != roleMain {
		t.Error("a window with no view is the app")
	}
	if (windowOpts{view: viewPinboard}).role() != rolePinboard {
		t.Error("a detached board has a slot of its own")
	}
}

// Two boards are two windows the user placed somewhere on purpose. One shared
// slot had the second one opened land on top of the first, and the last one
// closed decide where every board opened next time.
func TestWindowOptsRoleIsPerBoard(t *testing.T) {
	one := (windowOpts{view: viewPinboard, board: "board_one"}).role()
	two := (windowOpts{view: viewPinboard, board: "board_two"}).role()
	if one == two {
		t.Fatalf("each board needs its own frame, both got %q", one)
	}
	if one != rolePinboardFor("board_one") {
		t.Errorf("role = %q, want %q", one, rolePinboardFor("board_one"))
	}
	// Everything that asks about a board asks about boards in general.
	for _, role := range []string{one, two, rolePinboard} {
		if !isBoardRole(role) {
			t.Errorf("%q must read as a board", role)
		}
	}
	if isBoardRole(roleMain) {
		t.Error("the app is not a board")
	}
}

// The board rides in the URL like every other part of a window's address, and
// is held to the same alphabet: it comes back as a query parameter on every
// request that window makes about its own composition.
func TestWindowOptsCarriesTheBoard(t *testing.T) {
	opts := windowOptsFromQuery(url.Values{
		"view":  {"pinboard"},
		"board": {"board_one"},
	})
	if opts.board != "board_one" {
		t.Fatalf("board = %q, want %q", opts.board, "board_one")
	}
	if bad := windowOptsFromQuery(url.Values{"view": {"pinboard"}, "board": {"../etc"}}); bad.board != "" {
		t.Errorf("a board id that is not one yields nothing, got %q", bad.board)
	}

	u := windowPageURL("http://127.0.0.1:1234", "http://127.0.0.1:9999", opts)
	if !strings.Contains(u, "board=board_one") {
		t.Errorf("the page has to be told which board it is, got %q", u)
	}
	// A page cannot name a window other than its own, so the opener is filled in
	// by the endpoint that knows which window asked — never read from the query.
	if from := windowOptsFromQuery(url.Values{"view": {"pinboard"}, "openedBy": {"win_9"}}); from.openedBy != "" {
		t.Errorf("openedBy must not come off the wire, got %q", from.openedBy)
	}
}

// A board pops out of a panel the user is looking at, so the page sends where
// that panel is. Six numbers, because a rect without the page it was measured in
// cannot be turned into a place on a screen.
func TestWindowOptsFromQueryTakesThePanelItPoppedOutOf(t *testing.T) {
	opts := windowOptsFromQuery(url.Values{
		"view":   {"pinboard"},
		"panelX": {"656"}, "panelY": {"0"}, "panelW": {"544"}, "panelH": {"800"},
		"pageW": {"1200"}, "pageH": {"800"},
	})
	if !opts.hasPanel {
		t.Fatal("a fully measured panel is a panel")
	}
	want := panelRect{x: 656, y: 0, w: 544, h: 800, pageW: 1200, pageH: 800}
	if opts.panel != want {
		t.Errorf("panel = %+v, want %+v", opts.panel, want)
	}
}

// The endpoint is loopback, which any process on this machine can reach, so a
// measurement is held to the same standard as an id: it either describes
// something or it is not used.
func TestWindowOptsFromQueryRefusesAPanelThatMeasuresNothing(t *testing.T) {
	full := func() url.Values {
		return url.Values{
			"view":   {"pinboard"},
			"panelX": {"10"}, "panelY": {"20"}, "panelW": {"544"}, "panelH": {"800"},
			"pageW": {"1200"}, "pageH": {"800"},
		}
	}
	cases := []struct {
		name string
		key  string
		val  string
	}{
		{"a panel with no width places nothing", "panelW", "0"},
		{"nor one with a negative height", "panelH", "-800"},
		{"nor one measured in a page of no size", "pageW", "0"},
		{"nor one whose page has no height", "pageH", "0"},
		{"a number that is not one says nothing", "panelX", "over there"},
		{"nor does a missing one", "panelY", ""},
		{"and nothing may name a coordinate this far out", "panelX", "99999999"},
		{"in either direction", "panelY", "-99999999"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := full()
			if tc.val == "" {
				q.Del(tc.key)
			} else {
				q.Set(tc.key, tc.val)
			}
			if opts := windowOptsFromQuery(q); opts.hasPanel {
				t.Errorf("%s=%q was taken as a panel: %+v", tc.key, tc.val, opts.panel)
			}
		})
	}
	if opts := windowOptsFromQuery(url.Values{"view": {"pinboard"}}); opts.hasPanel {
		t.Error("a request that measured nothing has no panel")
	}
	// Only a board is opened out of a panel. An ordinary new window is opened
	// from a menu, and has nothing on screen to come out of.
	ordinary := full()
	ordinary.Del("view")
	if opts := windowOptsFromQuery(ordinary); opts.hasPanel {
		t.Error("a window that is not a board pops out of nothing")
	}
}

// The panel places the window. It is not a hint the page reads back, and a child
// that was told where it came from would have a second opinion about where it is.
func TestWindowPageURLKeepsThePanelToItself(t *testing.T) {
	opts := windowOpts{
		view:     viewPinboard,
		board:    "board_one",
		panel:    panelRect{x: 656, y: 0, w: 544, h: 800, pageW: 1200, pageH: 800},
		hasPanel: true,
	}
	q := query(t, opts)
	for _, key := range []string{"panelX", "panelY", "panelW", "panelH", "pageW", "pageH"} {
		if q.Has(key) {
			t.Errorf("%s is for placing the window, not for the page to read", key)
		}
	}
	if q.Get("board") != "board_one" {
		t.Error("the board still travels")
	}
}

// A popped-out board should read as the panel leaving the window: same size,
// same place, moved clear of where it was.
func TestFrameFromPanelPlacesTheWindowOverThePanel(t *testing.T) {
	opener := core.WindowState{X: 100, Y: 50, Width: 1200, Height: 800, HasPos: true}
	panel := panelRect{x: 656, y: 0, w: 900, h: 780, pageW: 1200, pageH: 800}
	got, ok := frameFromPanel(panel, opener)
	if !ok {
		t.Fatal("a measured panel inside a window this app has the frame of can be placed")
	}
	want := core.WindowState{
		X:      100 + 656 + popOutOffset,
		Y:      50 + 0 + popOutOffset,
		Width:  900,
		Height: 780,
		HasPos: true,
	}
	if !got.SameFrame(want) {
		t.Fatalf("frame = %+v, want %+v", got, want)
	}
}

// The page's numbers are the page's own. What turns them into the screen's is
// the window they were measured in, which is the one thing this side knows for
// certain — so a zoomed page, a scaled display and a title bar all come out in
// the wash rather than each needing to be known about.
func TestFrameFromPanelFollowsTheWindowItWasMeasuredIn(t *testing.T) {
	t.Run("a page drawn at twice the size", func(t *testing.T) {
		opener := core.WindowState{X: 0, Y: 0, Width: 2400, Height: 1600, HasPos: true}
		panel := panelRect{x: 656, y: 10, w: 900, h: 700, pageW: 1200, pageH: 800}
		got, ok := frameFromPanel(panel, opener)
		if !ok {
			t.Fatal("a scaled page is still a page")
		}
		if got.X != 1312+popOutOffset || got.Y != 20+popOutOffset {
			t.Errorf("origin = %d,%d, want %d,%d", got.X, got.Y, 1312+popOutOffset, 20+popOutOffset)
		}
		if got.Width != 1800 || got.Height != 1400 {
			t.Errorf("size = %dx%d, want 1800x1400", got.Width, got.Height)
		}
	})

	t.Run("a window with chrome above its page", func(t *testing.T) {
		opener := core.WindowState{X: 0, Y: 100, Width: 1200, Height: 828, HasPos: true}
		panel := panelRect{x: 0, y: 0, w: 1000, h: 800, pageW: 1200, pageH: 800}
		got, _ := frameFromPanel(panel, opener)
		if got.Y != 100+28+popOutOffset {
			t.Errorf("y = %d, want %d — the page starts below the title bar", got.Y, 100+28+popOutOffset)
		}
	})

	t.Run("a window on the display left of the primary", func(t *testing.T) {
		opener := core.WindowState{X: -1800, Y: -200, Width: 1200, Height: 800, HasPos: true}
		panel := panelRect{x: 300, y: 100, w: 900, h: 700, pageW: 1200, pageH: 800}
		got, _ := frameFromPanel(panel, opener)
		if got.X != -1800+300+popOutOffset || got.Y != -200+100+popOutOffset {
			t.Errorf("origin = %d,%d — a negative coordinate is a real place", got.X, got.Y)
		}
	})
}

// The panel is narrower than a window is allowed to be, so copying its width
// exactly would ask for a window nothing can honour.
func TestFrameFromPanelIsNeverSmallerThanAWindowMayBe(t *testing.T) {
	opener := core.WindowState{X: 0, Y: 0, Width: 1200, Height: 800, HasPos: true}
	got, _ := frameFromPanel(panelRect{x: 656, y: 0, w: 544, h: 400, pageW: 1200, pageH: 800}, opener)
	if got.Width != minWindowWidth || got.Height != minWindowHeight {
		t.Errorf("size = %dx%d, want the minimum %dx%d", got.Width, got.Height, minWindowWidth, minWindowHeight)
	}
}

// Anything that does not add up leaves the window to be placed the way a window
// with nothing to go on is placed, which is a centred default rather than a guess.
func TestFrameFromPanelDeclinesWhatItCannotPlace(t *testing.T) {
	panel := panelRect{x: 656, y: 0, w: 544, h: 800, pageW: 1200, pageH: 800}
	cases := []struct {
		name   string
		opener core.WindowState
	}{
		{"a window not yet built has no frame to work from", core.WindowState{HasPos: true}},
		{"nor has one already gone", core.WindowState{}},
		{"a page nothing like the window it claims to be in is not a measurement", core.WindowState{X: 0, Y: 0, Width: 12000, Height: 800, HasPos: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := frameFromPanel(panel, tc.opener); ok {
				t.Error("this should not have placed a window")
			}
		})
	}
}

// Which of the three answers about where a window goes wins: what this board was
// last left in, where it was popped out of, or nothing at all.
func TestOpeningFrameFollowsThePanelOnlyWhenNothingIsRemembered(t *testing.T) {
	screens := []*application.Screen{
		{IsPrimary: true, WorkArea: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040}},
	}
	opener := core.WindowState{X: 0, Y: 0, Width: 1200, Height: 800, HasPos: true}
	popped := windowOpts{
		view:     viewPinboard,
		panel:    panelRect{x: 656, y: 0, w: 544, h: 800, pageW: 1200, pageH: 800},
		hasPanel: true,
	}

	// A board that has been open before comes back where the user put it. Where
	// it was popped out of is a year out of date by then.
	saved := core.WindowState{X: 500, Y: 400, Width: 1000, Height: 700, HasPos: true}
	if got := openingFrame(saved, true, popped, opener, screens); !got.SameFrame(saved) {
		t.Errorf("frame = %+v, want the saved one %+v", got, saved)
	}

	// The first time, it opens over the panel it came out of, moved clear of it.
	got := openingFrame(core.WindowState{}, false, popped, opener, screens)
	want := core.WindowState{X: 656 + popOutOffset, Y: popOutOffset, Width: minWindowWidth, Height: 800, HasPos: true}
	if !got.SameFrame(want) {
		t.Errorf("frame = %+v, want %+v", got, want)
	}

	// And not off the edge of the screen: the panel is against the right of a
	// window that is itself against the right of the display.
	edge := openingFrame(core.WindowState{}, false, popped, core.WindowState{X: 1000, Y: 0, Width: 1200, Height: 800, HasPos: true}, screens)
	if edge.X+edge.Width > 1920 {
		t.Errorf("frame = %+v runs off the display it was opened on", edge)
	}

	// Nothing to go on is the centred default, which is what a zero frame asks
	// for — never a frame invented out of half a measurement.
	for _, tc := range []struct {
		name   string
		opts   windowOpts
		opener core.WindowState
	}{
		{"a window opened from a menu came out of nothing", windowOpts{view: viewPinboard}, opener},
		{"nor is there anything to measure against once the opener has gone", popped, core.WindowState{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := openingFrame(core.WindowState{}, false, tc.opts, tc.opener, screens); !got.SameFrame(core.WindowState{}) {
				t.Errorf("frame = %+v, want the centred default", got)
			}
		})
	}
}

// The runtime reads these with GetFlag("system.resizeHandleWidth"), which is one
// lookup in the flag map and not a walk down a dotted path — so a nested
// {"system": {...}} value is never found, and the band silently stays at the
// 5px fallback. That is not a hypothetical: it is what Wails' own Windows
// GetFlags does, which is why the only platform that ever populated these got
// the fallback too. Nothing downstream reports a flag that was never read, so
// the mistake is invisible from the outside — hence a test on the shape.
func TestResizeHandleFlagsAreFlatKeys(t *testing.T) {
	flags := resizeHandleFlags()
	for _, key := range []string{"system.resizeHandleWidth", "system.resizeHandleHeight", "resizeCornerExtra"} {
		if _, ok := flags[key]; !ok {
			t.Errorf("%q is the name the runtime looks up; flags = %v", key, flags)
		}
	}
	if _, nested := flags["system"]; nested {
		t.Error(`a "system" sub-map is never read: the keys are flat`)
	}
}

// Publishing the band is only worth doing if it is bigger than the fallback it
// replaces. A frameless window has no native resize border, so this is the whole
// of what there is to grab: at the default 5px, against a layout whose content
// runs to the last pixel, the bottom-right corner is about a pixel of target.
func TestResizeHandleFlagsBeatTheRuntimeFallback(t *testing.T) {
	// The fallbacks in the runtime's own hit-test (drag.ts): 5px edges, +10px at
	// the corners. Ours must improve on the edge, which is the hard one to hit.
	const runtimeEdgeFallback = 5
	if resizeHandleEdgePx <= runtimeEdgeFallback {
		t.Errorf("edge band = %dpx, which is no better than the %dpx fallback it overrides",
			resizeHandleEdgePx, runtimeEdgeFallback)
	}
	flags := resizeHandleFlags()
	if flags["system.resizeHandleWidth"] != resizeHandleEdgePx || flags["system.resizeHandleHeight"] != resizeHandleEdgePx {
		t.Errorf("the published band must be the one the constants describe, got %v", flags)
	}
}

// The theme/mode/zoom hand-off is read exactly as it was before the struct
// existed, so an opener that has always sent them keeps working.
func TestWindowOptsFromQueryReadsTheInheritedTrio(t *testing.T) {
	opts := windowOptsFromQuery(url.Values{"theme": {"dark"}, "mode": {"system"}, "zoom": {"125"}})
	if opts.theme != "dark" || opts.mode != "system" || opts.zoom != 125 {
		t.Fatalf("inherited trio = %q/%q/%d", opts.theme, opts.mode, opts.zoom)
	}
	if bad := windowOptsFromQuery(url.Values{"zoom": {"not a number"}}); bad.zoom != 0 {
		t.Errorf("an unreadable zoom is no zoom, got %d", bad.zoom)
	}
}
