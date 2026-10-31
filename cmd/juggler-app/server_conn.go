//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"cmp"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
	"juggler/internal/binpath"
)

// The desktop app is a client of this machine's Juggler server, never a server
// itself. At launch it finds the server, or starts one (machineserver.Connect
// with the bundled juggler's serve --implicit, detached), and attaches to it
// for its whole life — whatever its windows show, and whether or not the
// server runs any sessions. A local window is a view onto that server: a
// project's session (/s/<id>/) or, empty, the server's own page.
//
// The attachment is recorded in connState, which one goroutine owns
// (startConn) and every window asks for the server through (serverClient), so
// they all share one connection. That goroutine only reads and records: it
// does no network I/O and waits on nothing, so a quick call — attachedClient,
// sessionsAQuitStops, detachServer — is never held up behind a slow one. The slow
// work on the connection — a Connect, an attach, settling an attachment that
// ended, a restart — is a flight, run on the goroutine that needs it, one at a
// time (claimFlight): callers arriving meanwhile wait for it, off the owning
// goroutine, then look again, so they share one Connect rather than starting
// their own. A flight records what it found only while it is the flight
// running (land).
//
// When the attachment ends, the server either dropped it — it had not heard
// this app's beats, after a sleep or a stall — and is still there, so the app
// attaches again and its windows carry on; or the server has gone, and every
// local window becomes its stand-in at once, whose Try again finds or starts
// a server and reopens the window's session. A server the app did not start —
// run in a terminal — is only looked for again: the app starts its own only
// when the user asks (serverClient).
//
// The app never attaches to a server of another version. One that a client
// started and nothing uses is restarted without asking (shut down, waited
// out, started afresh: machineserver.Client.ReplaceIfIdle); otherwise the
// window that asked says so, with what a restart would stop, and offers to
// restart it (versionMismatchError).

// connState is the app's hold on its server, owned by startConn's goroutine.
type connState struct {
	client *machineserver.Client
	att    *machineserver.Attachment
	// closed is set as the app quits: the attachment ending then is the app
	// letting the server go, not the server going.
	closed bool
	// flight, while a flight runs, closes once it has landed.
	flight chan struct{}
}

// live reports whether st holds an attachment that has not ended.
func (st *connState) live() bool {
	return st.att != nil && !isDone(st.att.Done())
}

// errAppQuitting is serverClient's answer once the app has let its server go.
var errAppQuitting = errors.New("the app is quitting")

// startConn starts the goroutine that owns the app's connection to its server.
func (a *appState) startConn() {
	a.connOps = make(chan func(*connState))
	go func() {
		st := &connState{}
		for op := range a.connOps {
			op(st)
		}
	}()
}

// withConn runs fn against the connection on its owning goroutine and waits
// for it. fn only reads and records — no network I/O, no waiting on anything
// — so no withConn waits long for another's.
func (a *appState) withConn(fn func(*connState)) {
	done := make(chan struct{})
	a.connOps <- func(st *connState) {
		fn(st)
		close(done)
	}
	<-done
}

// claimFlight takes the connection's flight for the caller when needs says
// the connection as it stands calls for one. A flight already running is
// waited for first, on the caller's goroutine, and needs asked again after
// it. It returns the flight taken (nil when needs said no) and the client and
// attachment as they stood. A flight taken must land.
func (a *appState) claimFlight(needs func(*connState) bool) (flight chan struct{}, c *machineserver.Client, att *machineserver.Attachment) {
	for {
		var running chan struct{}
		a.withConn(func(st *connState) {
			flight, c, att = nil, st.client, st.att
			switch {
			case !needs(st):
			case st.flight != nil:
				running = st.flight
			default:
				flight = make(chan struct{})
				st.flight = flight
			}
		})
		if running == nil {
			return flight, c, att
		}
		<-running
	}
}

// land ends flight. record, when set, records on the owning goroutine what
// the flight found — only while flight is the one running, so a result
// cannot overwrite a later flight's.
func (a *appState) land(flight chan struct{}, record func(*connState)) {
	a.withConn(func(st *connState) {
		if st.flight != flight {
			return
		}
		st.flight = nil
		if record != nil {
			record(st)
		}
	})
	close(flight)
}

// landAttached ends flight, recording att, the attachment it found to c's
// server (nil: none), as the app's — unless the app has let its server go
// meanwhile, when the attachment is let go too. It reports whether att was
// kept.
func (a *appState) landAttached(flight chan struct{}, c *machineserver.Client, att *machineserver.Attachment) bool {
	kept := false
	var told func()
	a.land(flight, func(st *connState) {
		if st.closed {
			return
		}
		st.client, st.att = c, att
		kept, told = att != nil, a.onAttached
	})
	switch {
	case kept:
		a.hold(c, att, told)
	case att != nil:
		att.Close()
	}
	return kept
}

// versionMismatchError is a server of another build than this app's
// (wantBuild) that is not to be restarted without asking. app and server are
// the two builds, and occ what a restart would stop, as the user is shown it.
type versionMismatchError struct {
	app, server string
	occ         machineserver.Occupancy
}

func (e *versionMismatchError) Error() string {
	return fmt.Sprintf("the Juggler server running here is %s, and this app is %s", e.server, e.app)
}

// wantBuild is the build of server the app uses (serverBuild): another
// version, or another build of this one, is a mismatch.
func (a *appState) wantBuild() string {
	return cmp.Or(a.serverBuild, core.Version)
}

// connectAttempts bounds how often serverClient connects again to a server it
// caught on its way out.
const connectAttempts = 3

// serverClient returns a client of this machine's server, which the app is
// attached to: the one it holds, or one it finds or (with start) starts now
// and attaches to, as a flight. Without start, no server running is
// machineserver.ErrNoServer. A server of another version that is in use is a
// *versionMismatchError.
func (a *appState) serverClient(start bool) (*machineserver.Client, error) {
	quitting := false
	flight, c, ended := a.claimFlight(func(st *connState) bool {
		quitting = st.closed
		return !st.closed && !st.live()
	})
	switch {
	case quitting:
		return nil, errAppQuitting
	case flight == nil:
		return c, nil
	}
	c, att, err := a.attach(c, ended, start)
	if !a.landAttached(flight, c, att) && err == nil {
		return nil, errAppQuitting
	}
	return c, err
}

// attachedClient returns the client of the server the app is attached to now,
// or nil when it is attached to none. It connects to nothing.
func (a *appState) attachedClient() *machineserver.Client {
	var c *machineserver.Client
	a.withConn(func(st *connState) {
		if st.live() {
			c = st.client
		}
	})
	return c
}

// attach is serverClient's flight, on its caller's goroutine. An attachment
// that ended (ended, to prev's server) is settled first; then, with none, it
// finds or (with start) starts a server and attaches to it. A server of
// another build is replaced if it is idle — once: one found after that is the
// user's.
func (a *appState) attach(prev *machineserver.Client, ended *machineserver.Attachment, start bool) (*machineserver.Client, *machineserver.Attachment, error) {
	if ended != nil {
		if c, att := a.settle(prev); att != nil {
			return c, att, nil
		}
	}
	opts := a.connectOpts
	if !start {
		opts.Start = nil
	}
	restarted := false
	for attempt := 1; ; attempt++ {
		c, err := machineserver.Connect(opts)
		if err != nil {
			return nil, nil, err
		}
		if c.Build != a.wantBuild() {
			var replaced bool
			var occ machineserver.Occupancy
			if restarted {
				occ, err = c.Occupancy()
			} else {
				replaced, occ, err = c.ReplaceIfIdle()
			}
			switch {
			case err != nil && machineserver.ServerGoing(err) && attempt < connectAttempts:
				continue
			case err != nil:
				return nil, nil, err
			case !replaced:
				return nil, nil, &versionMismatchError{app: a.wantBuild(), server: c.Build, occ: occ}
			}
			logf("server: %s at %s was another build and idle; restarted it", c.Build, c.Addr())
			restarted = true
			continue
		}
		att, err := c.Attach()
		if err != nil {
			if machineserver.ServerGoing(err) && attempt < connectAttempts {
				continue
			}
			return nil, nil, err
		}
		return c, att, nil
	}
}

// hold logs att, the app's attachment to c's server now, tells told, and
// watches for the attachment to end.
func (a *appState) hold(c *machineserver.Client, att *machineserver.Attachment, told func()) {
	logf("server: attached to %s (%s, pid %d)", c.Addr(), c.Version, c.PID)
	go func() {
		<-att.Done()
		a.attachmentEnded(att)
	}()
	if told != nil {
		told()
	}
}

// attachmentEnded settles att, the app's attachment, which has ended, as a
// flight — unless the app is quitting, or another flight has settled it
// already.
func (a *appState) attachmentEnded(att *machineserver.Attachment) {
	flight, c, _ := a.claimFlight(func(st *connState) bool {
		return !st.closed && st.att == att
	})
	if flight == nil {
		return
	}
	again, next := a.settle(c)
	a.landAttached(flight, again, next)
}

// serverProc is one process of this machine's server: its address and its
// process ID. The address alone is not enough — a server started after
// another has gone takes the same port — so a window records the process it
// was opened on (winEntry.server).
type serverProc struct {
	addr string
	pid  int
	// appStarted is whether this app (or an earlier run of it) started the
	// process (machineserver.Client.AppStarted), rather than someone at a
	// terminal. Read with the process, so it never tells apart two that addr
	// and pid do not.
	appStarted bool
}

// procOf is the server process c reaches.
func procOf(c *machineserver.Client) serverProc {
	return serverProc{addr: c.Addr(), pid: c.PID, appStarted: c.AppStarted}
}

// settle handles the end of the app's attachment to the server c reached, on
// a flight. A server still there — the same process at the same address,
// which dropped the attachment — is attached to again, and that attachment
// returned. A server that has gone, or is on its way out
// (machineserver.ServerGoing), takes its sessions with it, so every window
// onto it becomes its stand-in. One that is still there but did not take the
// attachment again keeps its windows, whose pages go on reaching it; the next
// serverClient tries again. Either way settle returns none.
func (a *appState) settle(c *machineserver.Client) (*machineserver.Client, *machineserver.Attachment) {
	again, err := machineserver.Connect(machineserver.ConnectOptions{ConfigDir: a.connectOpts.ConfigDir})
	if err == nil && procOf(again) == procOf(c) {
		next, err := again.Attach()
		if err == nil {
			logf("server: %s dropped this app's attachment; attached again", c.Addr())
			return again, next
		}
		if !machineserver.ServerGoing(err) {
			logf("server: %s dropped this app's attachment and did not take it again: %v", c.Addr(), err)
			return nil, nil
		}
	} else if err != nil && !machineserver.ServerGoing(err) {
		logf("server: %s dropped this app's attachment, and finding it again failed: %v", c.Addr(), err)
		return nil, nil
	}
	logf("server: %s (pid %d) has gone", c.Addr(), c.PID)
	a.serverLost(procOf(c))
	return nil, nil
}

// detachServer lets the server go, as the app quits. It waits for no flight:
// one landing afterwards lets go of what it found.
func (a *appState) detachServer() {
	var att *machineserver.Attachment
	a.withConn(func(st *connState) {
		st.closed = true
		att = st.att
	})
	if att != nil {
		att.Close()
	}
}

// awaitServerGone waits, on the caller's goroutine, for the server c reaches —
// caught on its way out — to end the app's attachment, or for the app to let
// it go. The next serverClient settles that attachment, or waits for the
// flight settling it, and so finds whatever is there now.
func (a *appState) awaitServerGone(c *machineserver.Client) {
	var att *machineserver.Attachment
	a.withConn(func(st *connState) {
		if st.client == c {
			att = st.att
		}
	})
	if att != nil {
		<-att.Done()
	}
}

// restartServer stops the server of another version running here, every
// session with it, and waits for it to go, as a flight — provided it holds no
// more than shown said it would stop, which is what the user agreed to. One
// that holds more is left running, and is a *versionMismatchError saying what
// it holds now. The window that asked then opens as usual, on the server
// serverClient starts in its place.
func (a *appState) restartServer(shown *versionMismatchError) error {
	flight, _, _ := a.claimFlight(func(*connState) bool { return true })
	defer a.land(flight, nil)
	c, err := machineserver.Connect(machineserver.ConnectOptions{ConfigDir: a.connectOpts.ConfigDir})
	if errors.Is(err, machineserver.ErrNoServer) {
		return nil
	}
	if err != nil || c.Build == a.wantBuild() {
		return err
	}
	logf("server: restarting %s at %s at the user's word", c.Build, c.Addr())
	err = c.RestartAsAgreed(shown.occ)
	var busy *machineserver.OccupiedError
	if errors.As(err, &busy) {
		logf("server: %s holds more than the user was shown; left running", c.Addr())
		return &versionMismatchError{app: a.wantBuild(), server: c.Build, occ: busy.Now}
	}
	return err
}

// sessionsAQuitStops is how many sessions running a turn a quit or an update
// restart would stop. Letting the server go stops it, and every session on
// it, only when a client started it on demand and this app is the last local
// client holding it up. A server started by hand, or held by another client —
// a terminal's juggler, another app — goes on, and its sessions run their
// turns to the end with no viewer, so a quit stops none. Read from one status
// and one sessions list; none when the app is attached to no server, or it
// does not answer.
func (a *appState) sessionsAQuitStops() int {
	c := a.attachedClient()
	if c == nil {
		return 0
	}
	occ, err := c.Occupancy()
	if err != nil || occ.HandStarted || occ.Clients > 1 {
		return 0
	}
	n := 0
	for _, s := range occ.Sessions {
		if s.Busy {
			n++
		}
	}
	return n
}

// serverLost replaces every main window onto proc, a server process that has
// gone, with its stand-in. A window opened on a later server at the same
// address is not proc's, and stays. A board goes with the window that opened
// it.
func (a *appState) serverLost(proc serverProc) {
	type lostWindow struct {
		id, theme string
		spec      windowSpec
	}
	var lost []lostWindow
	a.reg(func(st *regState) {
		if st.quitting {
			return
		}
		for _, w := range sortedWindows(st) {
			if w.server == proc && !isBoardRole(w.role) && !w.spec.isURL() && claimReplacementLocked(st, w) {
				lost = append(lost, lostWindow{id: w.id, theme: w.currentTheme, spec: w.spec})
			}
		}
	})
	for _, w := range lost {
		logf("window %s: its server %s (pid %d) has gone; opening its stand-in", w.id, proc.addr, proc.pid)
		openLostServerStandIn(a, w.spec, lostServerStandInFor(proc), windowOpts{theme: w.theme, replaces: w.id})
	}
}

// claimReplacement claims e to be replaced by its stand-in, and reports
// whether the caller has it: false for a window already a stand-in, already
// claimed, or no longer open. Whoever has it opens the one stand-in.
func (a *appState) claimReplacement(e *winEntry) bool {
	claimed := false
	a.reg(func(st *regState) { claimed = claimReplacementLocked(st, e) })
	return claimed
}

// claimReplacementLocked is claimReplacement on the registry goroutine.
func claimReplacementLocked(st *regState, e *winEntry) bool {
	if st.windows[e.id] != e || e.standIn != nil || e.replacing {
		return false
	}
	e.replacing = true
	return true
}

// isDone reports whether ch has been closed.
func isDone(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// startServer is how the app starts this machine's server when none is
// running: the bundled juggler's serve --implicit, detached, so it outlives
// the app (machineserver.DetachedStarter).
func startServer() (int, <-chan struct{}, error) {
	bin, err := serverBinPath()
	if err != nil {
		return 0, nil, err
	}
	return machineserver.DetachedStarter(bin)()
}

// bundledServerBuild is the build of the server this app starts
// (machineserver.BuildOf), or "" — its own version — when it has none to
// start.
func bundledServerBuild() string {
	bin, err := serverBinPath()
	if err != nil {
		return ""
	}
	return machineserver.BuildOf(bin)
}

// serverBinPath locates the juggler binary the app starts the server from:
//   - $JUGGLER_SERVER_BIN if set (explicit override, used in dev/tests),
//   - a sibling "juggler" next to this executable (the bundled layout),
//   - else "juggler" on PATH.
func serverBinPath() (string, error) {
	if env := os.Getenv("JUGGLER_SERVER_BIN"); env != "" {
		return env, nil
	}
	name := "juggler"
	if runtime.GOOS == "windows" {
		name = "juggler.exe"
	}
	if exe, err := os.Executable(); err == nil {
		if cand, ok := binpath.Sibling(exe, name); ok {
			return cand, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("could not locate the juggler server binary; set JUGGLER_SERVER_BIN")
}
