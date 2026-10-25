//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/internal/windowgeom"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// What a window is for. The role keys the geometry it is placed from — each
// role has its own saved frame in the session — and decides what the workspace
// restores.
//
// A detached board is not in the workspace file, which remembers a window as the
// project it views: two boards on two conversations of one project would be one
// entry, and neither of them is the board it is. A board is restored from the
// project's session instead, where the board itself lives, by the window that
// reopens it — see SessionManager.ClaimDetachedBoards.
//
// Every board is its own role, because every board is a window the user placed:
// see rolePinboardFor.
const (
	roleMain     = "main"
	rolePinboard = "pinboard"
)

// rolePinboardFor names one board's geometry slot. Mirrors
// core.WindowRolePinboardFor, which is what reads the other end of it.
func rolePinboardFor(boardID string) string {
	if boardID == "" {
		return rolePinboard
	}
	return rolePinboard + ":" + boardID
}

// isBoardRole reports whether a role belongs to a detached board, whichever
// board it is. Everything that asks is asking about boards in general — whether
// to skip one when focusing, whether to let one close, whether to remember one —
// and none of it cares which.
func isBoardRole(role string) bool {
	return role == rolePinboard || strings.HasPrefix(role, rolePinboard+":")
}

// viewPinboard is the page's own name for the reduced shell, matching
// web/js/utils/view-mode.js. An empty view is the ordinary app.
const viewPinboard = "pinboard"

// idPattern is the alphabet the server accepts for a viewer id (see
// sanitiseViewerID in cmd/juggler/server/network.go), applied to the ids handed
// to a window here so a junk one yields nothing rather than something nothing
// can reach.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// windowOpts is everything a new window inherits from whatever opened it.
//
// Three of these travelled as positional arguments through openWindowForProject,
// openWindow and buildWindow, which was tolerable at three and is not at six.
// The struct is what stops the next one being threaded through four signatures
// by hand — and what stops a caller passing theme where mode was meant.
type windowOpts struct {
	// theme is the concrete first-frame colour the page paints before it reads
	// its own preference; mode is the opener's *selected* mode, carried so a
	// 'system' parent hands 'system' to its child rather than collapsing to
	// whatever it currently resolves to.
	theme string
	mode  string

	// zoom is the opener's root font-size percentage. It only seeds a child on a
	// machine with no stored zoom — the page gives the machine's priority (see
	// web/js/utils/zoom-manager.js).
	zoom int

	// view names the shell the page builds: empty for the app, viewPinboard for
	// a board detached into a window of its own. board is the composition that
	// window is — its own tabs, arranged its own way — and conversation is the
	// one it is a view of; together they are the whole of what makes two boards
	// show different things. pin is the tab it opens on. owner is the viewer a
	// reveal from the board is sent to, which is the window it was detached from.
	view         string
	board        string
	owner        string
	pin          string
	conversation string

	// openedBy is the id of the window that asked for this one. It is not read
	// from the query — a page cannot name a window other than its own — but
	// filled in by the control endpoint, which knows which window the request
	// arrived on. Only a detached board carries one: it is how the app knows
	// which boards go with a window when it closes.
	openedBy string

	// external marks a window onto a server this app did not start (--url).
	// Like openedBy it never comes off the wire: buildWindow sets it from the
	// window's spec. The page reads it to keep project switches in place, since
	// the paths that server offers belong to its machine, not this one.
	external bool

	// replaces is the id of a window this one takes the place of: it is closed
	// once this one is up, never before, so the app is not left with no window
	// (which quits it). Set by the control endpoint, never off the wire — the
	// empty window a server was connected from, or an unreachable-server page
	// being retried or traded for a local window.
	replaces string

	// standIn makes the window a stand-in for the one its spec names, which
	// cannot be shown (stand_in.go): its page is an empty window's, told so by
	// ?standIn=. Set by buildStandInWindow, never off the wire.
	standIn *standIn

	// panel is where the board was on screen in the window that asked, so the
	// new window can open over it: a pop-out is the panel leaving the window,
	// and a window that appeared somewhere else entirely would be a new one.
	// Only consulted for a board that has no frame of its own yet — see
	// buildWindow.
	panel    panelRect
	hasPanel bool
}

// panelRect is where a page said the thing a window is being opened from sits:
// its rect in that page, and the size of the page itself, all in CSS pixels.
//
// The page size travels with the rect because it is the scale for the rest. A
// page may be drawn at any size relative to the window holding it — a zoom, a
// scaled display — and only the window's own frame, which this side knows,
// turns one into the other.
//
// A page names no screen coordinates. It cannot see the screen, and this
// endpoint is loopback, which any process on this machine can reach: everything
// here is relative to a window the app already has the frame of.
type panelRect struct {
	x, y, w, h   int
	pageW, pageH int
}

// maxPanelDimension bounds every number a page may send. Well past any display
// this will meet, and short of the point where placing a window overflows.
const maxPanelDimension = 32000

// panelKeys are the six values, in the order they are read. All or nothing:
// five of them place nothing.
var panelKeys = [6]string{"panelX", "panelY", "panelW", "panelH", "pageW", "pageH"}

// panelRectFromQuery reads a panel measurement, or reports that there is none.
// Held to the same standard as the ids beside it: a number that is not one, is
// missing, or is out past any real display yields no rect at all rather than a
// window placed somewhere nobody asked for.
func panelRectFromQuery(q url.Values) (panelRect, bool) {
	var n [6]int
	for i, key := range panelKeys {
		v, err := strconv.Atoi(q.Get(key))
		if err != nil || v < -maxPanelDimension || v > maxPanelDimension {
			return panelRect{}, false
		}
		n[i] = v
	}
	p := panelRect{x: n[0], y: n[1], w: n[2], h: n[3], pageW: n[4], pageH: n[5]}
	// A rect or a page with no size is not a measurement of anything. Position
	// is free to be negative: a display left of the primary is a real place.
	if p.w <= 0 || p.h <= 0 || p.pageW <= 0 || p.pageH <= 0 {
		return panelRect{}, false
	}
	return p, true
}

// popOutOffset is how far a window opened from a panel is moved clear of the
// panel it came out of, in the screen's own units.
//
// Not zero, because a window landing exactly over what it came from looks like
// nothing happening; and small, because the point of the offset is to show that
// the thing moved, not to throw it across the desk. The user popped the panel
// out to put it somewhere, and where is theirs to say.
const popOutOffset = 40

// panelScaleRange is how far a page may plausibly be drawn from its window's own
// size. Outside it the two numbers are not describing the same window, and a
// frame computed from them would be arithmetic rather than a placement.
const (
	minPanelScale = 0.2
	maxPanelScale = 5.0
)

// frameFromPanel turns a panel measured in a page into a frame on the screen,
// using the frame of the window that page is in.
//
// The scale comes out of the two widths rather than being asked for. The window
// knows how wide it is and the page knows how wide it is; their ratio is every
// difference between the two — zoom, display scaling, the units each platform
// counts in — without this having to know which of them applied. The same trick
// gives the chrome above the page: whatever height the window has that the page
// does not is the title bar.
//
// Reports false for anything it cannot place, which leaves the window to open
// the way a window with nothing to go on opens.
func frameFromPanel(p panelRect, opener core.WindowState) (core.WindowState, bool) {
	if opener.Width <= 0 || opener.Height <= 0 || p.pageW <= 0 || p.pageH <= 0 {
		return core.WindowState{}, false
	}
	scale := float64(opener.Width) / float64(p.pageW)
	if scale < minPanelScale || scale > maxPanelScale {
		return core.WindowState{}, false
	}
	// Whatever the window has above its page. Zero on a frameless window and on
	// macOS, where the page is drawn under the title bar.
	chrome := opener.Height - scaled(p.pageH, scale)
	if chrome < 0 {
		chrome = 0
	}
	return core.WindowState{
		X:      opener.X + scaled(p.x, scale) + popOutOffset,
		Y:      opener.Y + chrome + scaled(p.y, scale) + popOutOffset,
		Width:  max(scaled(p.w, scale), minWindowWidth),
		Height: max(scaled(p.h, scale), minWindowHeight),
		HasPos: true,
	}, true
}

// scaled converts one of the page's numbers into the screen's.
func scaled(v int, scale float64) int {
	return int(math.Round(float64(v) * scale))
}

// openingFrame decides the frame a window is built at, from the three things
// that can have an opinion — in order.
//
// The frame this window's role was last left in wins. A board that has been open
// before is a window the user put somewhere, and where it was popped out of is
// long out of date by then.
//
// Failing that, a board opened out of a panel opens over that panel, moved clear
// of it — the panel leaving the window rather than a window arriving from
// nowhere. It is fitted to the display it lands on, since a frame this side
// worked out is arithmetic and can run off an edge, unlike one a user dragged.
//
// Failing that, the zero frame, which is the centred default. It is also what
// anything that does not add up falls back to: a window placed by a guess is
// worse than one placed the way every first window is.
func openingFrame(saved core.WindowState, hasSaved bool, opts windowOpts, opener core.WindowState, screens []*application.Screen) core.WindowState {
	if hasSaved {
		return saved
	}
	if !opts.hasPanel {
		return core.WindowState{}
	}
	frame, ok := frameFromPanel(opts.panel, opener)
	if !ok {
		return core.WindowState{}
	}
	return windowgeom.FitOnScreen(frame, screens)
}

// role reports which geometry slot and which restore rules this window follows.
//
// Each board has a slot of its own. Two boards are two windows the user placed
// somewhere on purpose, and one shared slot had the second one opened land on
// top of the first, and the last one closed decide where every board opened
// next time.
func (o windowOpts) role() string {
	if o.view == viewPinboard {
		return rolePinboardFor(o.board)
	}
	return roleMain
}

// isPinboard reports whether this window is a detached board rather than the app.
func (o windowOpts) isPinboard() bool { return o.view == viewPinboard }

// windowOptsFromQuery reads the hand-off a page POSTed to /win/<id>/new. Every
// field is validated here rather than trusted: the request arrives over a
// loopback listener that any same-host process can reach, and an unvalidated
// view or id would be baked straight into the child's URL.
func windowOptsFromQuery(q url.Values) windowOpts {
	zoom, _ := strconv.Atoi(q.Get("zoom"))
	opts := windowOpts{
		theme: q.Get("theme"),
		mode:  q.Get("mode"),
		zoom:  zoom,
	}
	if q.Get("view") == viewPinboard {
		opts.view = viewPinboard
		opts.board = normaliseID(q.Get("board"))
		opts.owner = normaliseID(q.Get("owner"))
		opts.pin = normaliseID(q.Get("pin"))
		opts.conversation = normaliseID(q.Get("conversation"))
		// Only a board is opened out of something on screen. Every other window
		// is opened from a menu, with nothing to come out of.
		opts.panel, opts.hasPanel = panelRectFromQuery(q)
	}
	return opts
}

// normaliseID accepts an id the page supplied, or returns empty for anything
// that is not one.
func normaliseID(id string) string {
	if idPattern.MatchString(id) {
		return id
	}
	return ""
}

// windowPageURL is the page a window opens on: the server it views, the loopback
// control endpoint addressed to this window, and the hand-off hints. Only
// non-empty hints are sent, so a first-ever launch with nothing to inherit still
// lets the page follow its own precedence.
//
// Pure, so the query it builds can be asserted without a native window.
func windowPageURL(serverURL, nativeCtl string, opts windowOpts) string {
	u := strings.TrimRight(serverURL, "/") + "/?window=1&nativeCtl=" + url.QueryEscape(nativeCtl)
	if opts.theme != "" {
		u += "&theme=" + url.QueryEscape(opts.theme)
	}
	if opts.mode != "" {
		u += "&mode=" + url.QueryEscape(opts.mode)
	}
	if opts.zoom > 0 {
		u += "&zoom=" + strconv.Itoa(opts.zoom)
	}
	if opts.external {
		u += "&external=1"
	}
	if opts.standIn != nil {
		u += "&standIn=" + url.QueryEscape(opts.standIn.kind)
	}
	if opts.view != "" {
		u += "&view=" + url.QueryEscape(opts.view)
		if opts.board != "" {
			u += "&board=" + url.QueryEscape(opts.board)
		}
		if opts.owner != "" {
			u += "&owner=" + url.QueryEscape(opts.owner)
		}
		if opts.pin != "" {
			u += "&pin=" + url.QueryEscape(opts.pin)
		}
		if opts.conversation != "" {
			u += "&conversation=" + url.QueryEscape(opts.conversation)
		}
	}
	return u
}
