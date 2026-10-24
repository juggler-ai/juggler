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
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/apipaths"
)

// Window geometry lives with the session it applies to, server-side: the server
// stores it in the current project's session (via /api/session/window-state), so
// it is per-project and travels with the session. The desktop app is just a
// conduit: it reads the saved frame when opening a window and writes the frame
// back as the user moves/resizes it. That holds for a server this app runs; a
// window onto a server by URL keeps its frame on this machine (remote_frames.go).
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
// A freshly spawned server prints its address before it starts accepting
// connections, so the first few requests can fail on connection refused; we
// retry transport errors briefly. A response (even non-200) is authoritative
// and ends the loop.
//
// serverURL is always one the app owns, from windowSpec.resolve: the address a
// server it spawned printed, a verified instance lock's, --url, or one the user
// typed into Connect to Server. A control request reaches here by naming a
// project folder, or — from a window on a server this app resolved itself, and
// only after normaliseServerURL — the address the user typed (controlConnect).
func fetchWindowState(serverURL, role string) (core.WindowState, bool) {
	ws, ok, _ := readWindowState(context.Background(), serverURL, role)
	return ws, ok
}

// remoteReachBudget is how long opening a window onto a server by URL waits for
// that server to answer before showing the unreachable-server page instead. A
// server by URL is already running or it is not — the retries in
// readWindowState are for a local server still starting — and the budget is
// what stops a host that never answers from costing every retry's own timeout,
// with no window on screen.
const remoteReachBudget = 5 * time.Second

// readWindowState is fetchWindowState that also says whether the server
// answered at all, and gives up when ctx does. reached is false only when no
// response came back; a response of any status is the server answering.
func readWindowState(ctx context.Context, serverURL, role string) (ws core.WindowState, hasState, reached bool) {
	url := windowStateURL(serverURL, role)
	const attempts = 30
	for i := 0; i < attempts; i++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil) //nolint:gosec // app-owned server URL, see fetchWindowState
		if err != nil {
			return core.WindowState{}, false, false
		}
		resp, err := windowStateHTTP.Do(req) //nolint:gosec // app-owned server URL, see fetchWindowState
		if err != nil {
			// Server not accepting yet — back off and retry, unless the caller has
			// stopped waiting.
			select {
			case <-ctx.Done():
				return core.WindowState{}, false, false
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		ws, ok := decodeWindowState(resp)
		return ws, ok, true
	}
	return core.WindowState{}, false, false
}

// openingState reads the saved geometry a window onto spec opens with, and
// whether its server answered. A project's server is one this app just resolved
// (spawned, or found by its lock), so it is waited for as long as a start takes
// and counted as reached; a server by URL gets remoteReachBudget.
//
// A server by URL is still asked, because its answer is what says it is there,
// but what it holds is another machine's frame: the window opens at the one kept
// on this machine instead (see remote_frames.go).
func (a *appState) openingState(spec windowSpec, serverURL, role string) (ws core.WindowState, hasState, reached bool) {
	if !spec.isURL() {
		ws, hasState = fetchWindowState(serverURL, role)
		return ws, hasState, true
	}
	ctx, cancel := context.WithTimeout(context.Background(), remoteReachBudget)
	defer cancel()
	if _, _, reached = readWindowState(ctx, serverURL, role); !reached {
		return core.WindowState{}, false, false
	}
	ws, hasState = a.remoteFrames.get(serverURL, role)
	return ws, hasState, true
}

// storeFrame records a window's frame where it belongs: in the session of a
// server this app runs, or on this machine for a window onto a server by URL.
// Gives up on a session write when ctx does.
func (a *appState) storeFrame(ctx context.Context, e *winEntry, ws core.WindowState) {
	if e.spec.isURL() {
		a.remoteFrames.put(e.serverURL, e.role, ws)
		return
	}
	putWindowStateCtx(ctx, e.serverURL, e.role, ws)
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
