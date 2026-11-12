//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/apipaths"
	"juggler/internal/lanfind"
)

// Window geometry lives with the session it applies to, server-side: the server
// stores it in the current project's session (via /api/session/window-state), so
// it is per-project and travels with the session. The desktop app is just a
// conduit: it reads the saved frame when opening a window and writes the frame
// back as the user moves/resizes it. That holds for a session on this machine's
// server; a window onto a server by URL keeps its frame on this machine
// (remote_frames.go), and an empty window, on the server's own page, has no
// session to keep one in.
//
// Each window ROLE gets its own slot in that session. A project has never had
// only one window — a second one for the same project already cascades off the
// first — and a board detached into a window of its own is a different shape
// from the app entirely, so one shared frame would have each kind of window
// overwriting the other's on close.

var windowStateHTTP = &http.Client{Timeout: 4 * time.Second}

// windowStateURL addresses one role's saved frame in the server's current
// session.
func windowStateURL(serverURL, role string) string {
	return strings.TrimRight(serverURL, "/") + apipaths.SessionWindowState + "?role=" + url.QueryEscape(role)
}

// fetchWindowState reads the saved geometry for the project the server is
// currently serving. Returns (zero, false) when nothing is saved or the server
// can't be reached — the caller then uses a default placement.
//
// Transport errors are retried briefly, for a server that is not accepting
// yet. A response (even non-200) is authoritative and ends the loop.
//
// serverURL is always one the app owns, from resolveWindow: a session on this
// machine's server, --url, or one the user typed into Connect to Server. A
// control request reaches here by naming a project folder, or — from a window
// on this machine's server, and only after normaliseServerURL — the address the
// user typed (controlSwitchServer).
func fetchWindowState(serverURL, role string) (core.WindowState, bool) {
	ws, ok, _, _ := readWindowState(context.Background(), serverURL, role, localServerTries)
	return ws, ok
}

// localServerTries is how many times fetchWindowState asks a server on this
// machine, which may still be starting, before taking a default placement.
const localServerTries = 30

// untilCtxDone is readWindowState's tries for a caller whose ctx alone says
// when to stop asking.
const untilCtxDone = 0

// remoteReachBudget is how long opening a window onto a server by URL waits for
// that server to answer before showing the unreachable-server page instead. It
// is asked for the whole of it, however quickly each ask fails: just after
// launch macOS refuses this app's connections onto the local network at once,
// with "no route to host", until its Local Network grant applies, and the
// server is there all along. The budget is also what stops a host that never
// answers from costing every retry's own timeout, with no window on screen.
const remoteReachBudget = 5 * time.Second

// askLocalNetwork asks macOS, once per run, to let this app onto the local
// network (lanfind.RequestLocalNetwork), before the first ask of a server by
// URL: the ask starts the grant applying, and brings up the prompt if the user
// has never answered it. A seam: tests ask nothing.
var askLocalNetwork = sync.OnceFunc(lanfind.RequestLocalNetwork)

// remoteAnswer is what a server by URL says when the app asks it about the
// page a window shows there (probeRemote).
type remoteAnswer int

const (
	// remoteSilent: no answer, or a refusal of this computer (403: LAN access
	// off, or a Host it does not take) — the server cannot be reached from here.
	remoteSilent remoteAnswer = iota
	// remoteAnswered: the server answered, and has not said the session is
	// gone. One it still holds (restarting, say) comes back, and a page
	// reconnecting to it is right to wait.
	remoteAnswered
	// remoteForgotten: the server has said it no longer has the session the
	// page shows (sessionMountOf). Its proxy answers 404 where it has no
	// session: one it retired, left with no viewer, or any at all once the
	// server has restarted, since a server's sessions die with it.
	remoteForgotten
)

// probeRemote asks the server by URL a window's page is on, pageURL, about
// that page: the health of the session it shows, or for a page showing none,
// whether the server answers at all.
func probeRemote(ctx context.Context, pageURL string) remoteAnswer {
	_, session := sessionMountOf(pageURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(pageURL, "/")+apipaths.Health, nil) //nolint:gosec // app-owned server URL, see fetchWindowState
	if err != nil {
		return remoteSilent
	}
	resp, err := windowStateHTTP.Do(req) //nolint:gosec // app-owned server URL, see fetchWindowState
	if err != nil {
		return remoteSilent
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusForbidden:
		return remoteSilent
	case session && resp.StatusCode == http.StatusNotFound:
		return remoteForgotten
	default:
		return remoteAnswered
	}
}

// reachRetryPause is the pause after an ask that got no response, before the
// next. A var so tests need not wait it out.
var reachRetryPause = 100 * time.Millisecond

// readWindowState is fetchWindowState that also says whether the server
// answered at all, asking up to tries times (untilCtxDone: until ctx ends), and
// gives up when ctx does. reached is false only when no response came back; a
// response of any status is the server answering; when none did, unreached
// says how the asks went.
func readWindowState(ctx context.Context, serverURL, role string, tries int) (ws core.WindowState, hasState, reached bool, unreached reachFailure) {
	url := windowStateURL(serverURL, role)
	for tries == untilCtxDone || unreached.asked < tries {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil) //nolint:gosec // app-owned server URL, see fetchWindowState
		if err != nil {
			return core.WindowState{}, false, false, reachFailure{lastErr: err}
		}
		unreached.asked++
		resp, err := windowStateHTTP.Do(req) //nolint:gosec // app-owned server URL, see fetchWindowState
		if err != nil {
			// Server not accepting yet, or this machine not letting the ask out —
			// back off and retry, unless the caller has stopped waiting.
			unreached.lastErr = err
			select {
			case <-ctx.Done():
				return core.WindowState{}, false, false, unreached
			case <-time.After(reachRetryPause):
			}
			continue
		}
		ws, ok := decodeWindowState(resp)
		return ws, ok, true, reachFailure{}
	}
	return core.WindowState{}, false, false, unreached
}

// reachFailure is how readWindowState failed to reach a server: how many asks
// went out, and why the last got no response.
type reachFailure struct {
	asked   int
	lastErr error
}

// openingState reads the saved geometry a window onto spec opens with, and
// whether its server answered. A project's session is one this app just opened
// on this machine's server, so it is counted as reached; an empty window has no
// session and opens at the default frame; a server by URL gets
// remoteReachBudget.
//
// A server by URL is still asked, because its answer is what says it is there,
// but what it holds is another machine's frame: the window opens at the one kept
// on this machine instead (see remote_frames.go).
func (a *appState) openingState(spec windowSpec, serverURL, role string) (ws core.WindowState, hasState, reached bool) {
	if spec == (windowSpec{}) {
		return core.WindowState{}, false, true
	}
	if !spec.isURL() {
		ws, hasState = fetchWindowState(serverURL, role)
		return ws, hasState, true
	}
	askLocalNetwork()
	ctx, cancel := context.WithTimeout(context.Background(), remoteReachBudget)
	defer cancel()
	start := time.Now()
	if _, _, reached, failed := readWindowState(ctx, serverURL, role, untilCtxDone); !reached {
		logf("server %s: no answer after %d asks in %v; last: %v",
			serverURL, failed.asked, time.Since(start).Round(time.Millisecond), failed.lastErr)
		return core.WindowState{}, false, false
	}
	ws, hasState = a.remoteFrame(spec, role)
	return ws, hasState, true
}

// Where a window's frame is kept (frameHomeOf).
const (
	frameKeptNowhere = iota
	frameKeptInSession
	frameKeptHere
)

// frameHomeOf is where the frame of a window showing v is kept: in the session
// of a server this app runs, or on this machine for a window onto a server by
// URL, or nowhere.
//
// A window onto a server by URL keeps it on this machine under that server
// (remoteFrameSlot), whichever of its pages it shows, a stand-in included —
// so a window that opens on that server's stand-in at launch opens where the
// window was last left. A local window's stand-in keeps none, as its session
// is not there to keep it; nor does an empty window, which has no session,
// nor a page served from nowhere.
func frameHomeOf(v windowView) int {
	switch {
	case v.spec.isURL():
		return frameKeptHere
	case v.standIn != nil, v.spec == (windowSpec{}), v.serverURL == "":
		return frameKeptNowhere
	default:
		return frameKeptInSession
	}
}

// storeFrame records a window's frame where it is kept (frameHomeOf), giving
// up on a session write when ctx does.
func (a *appState) storeFrame(ctx context.Context, e *winEntry, ws core.WindowState) {
	v := a.viewOf(e)
	switch frameHomeOf(v) {
	case frameKeptHere:
		a.remoteFrames.put(remoteFrameSlot(v.spec), e.role, ws)
	case frameKeptInSession:
		putWindowStateCtx(ctx, v.serverURL, e.role, ws)
	}
}

func decodeWindowState(resp *http.Response) (core.WindowState, bool) {
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return core.WindowState{}, false
	}
	var body struct {
		WindowState core.WindowState `json:"windowState"`
		HasState    bool             `json:"hasState"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return core.WindowState{}, false
	}
	return body.WindowState, body.HasState
}

// putWindowStateCtx persists geometry into the session the server is currently
// serving, giving up when ctx does. Best-effort: errors are ignored (the window
// still works; we just didn't record this frame).
func putWindowStateCtx(ctx context.Context, serverURL, role string, ws core.WindowState) {
	url := windowStateURL(serverURL, role)
	data, err := json.Marshal(ws)
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := windowStateHTTP.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}

// forgetBoard tells the server the board a window held is finished with, which
// drops its tabs and the frame it was in.
//
// Called when a board window is closed on its own, and only then. A board taken
// down with the window that opened it, or with the app, keeps everything: it is
// a window that will be opened again, and what it held is what it opens with.
//
// Best-effort in what it does about a failure, like the geometry writes it sits
// beside: a board that outlives a close it should not have costs the user one
// stale window next launch, which is a great deal better than a race here losing
// an arrangement they still wanted.
//
// Not silent about one, though. This app holds no API token — the token is
// minted in the server and handed only to the page it serves — so the route is
// one the token gate lets through unauthenticated, on the same grounds as the
// geometry writes (see apiAuthExempt). That is a condition on the other side of
// a process boundary, and nothing here would notice it lapsing, so a refusal is
// reported rather than dropped.
func forgetBoard(serverURL, boardID string) {
	if boardID == "" {
		return
	}
	endpoint := strings.TrimRight(serverURL, "/") +
		apipaths.SessionPinboardBoards + "?board=" + url.QueryEscape(boardID)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodDelete, endpoint, nil)
	if err != nil {
		return
	}
	resp, err := windowStateHTTP.Do(req)
	if err != nil {
		logf("could not forget board %s: %v", boardID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		logf("could not forget board %s: the server answered %s", boardID, resp.Status)
	}
}
