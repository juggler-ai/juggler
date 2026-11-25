//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/tunnel"
	"juggler/internal/binwatch"
	"juggler/internal/jlog"
)

// Relaunching: the machine server stops, as a shutdown stops it — every
// session with it — and the process that ran it is replaced by one from the
// binary now at its path, run as it was (relaunchArgs). That is how a server
// run in a terminal, or by hand, takes up a build installed under it: a rebuild,
// or an update the desktop app installed. On Unix the new process is the same
// one (exec), so the terminal, and anything waiting on the process, keep it; on
// Windows, which has no exec, it is a child the old process waits for and exits
// with.
//
// The server watches its binary for such a build (watchInstalledBuild) and
// says so in its status and events (installedBuild), for whoever offers the
// relaunch.

// ErrRelaunch is Serve's answer once it has stopped to be relaunched, as a
// *relaunchError that errors.Is it, saying what the server had open. Its caller
// relaunches the process (relaunch) when Serve's deferred work — the machine
// lock above all — is done.
var ErrRelaunch = errors.New("the machine server stopped to be relaunched")

// handoff is what a server that stopped to be relaunched hands on to the one
// that replaces it, which takes up where it left off rather than where its
// flags and settings, true of the process's start and not of its end, say:
//
//   - LAN and Tunnel are what it had open (launchExposure). Switching LAN
//     access or a tunnel while it ran is never saved. TunnelResume is what
//     served the tunnel's link (tunnel.Resumable), so the new one opens it
//     under the same link (startTunnelFrom); it may be the link's whole
//     capability, which the environment it travels in keeps to this user.
//   - Holders are the processes of the clients attached to it, which hold the
//     new server up until each has attached to it or exited (holdFor), as a
//     starter does: an implicit server with no client yet stops at its first
//     check, sooner than a client following the relaunch reaches it.
//   - AppStarted is that the desktop app started it (statusResponse.AppStarted),
//     which the new one, run without --started-by, says too.
type handoff struct {
	LAN          bool        `json:"lan"`
	Tunnel       tunnel.Mode `json:"tunnel,omitempty"`
	TunnelResume string      `json:"tunnelResume,omitempty"`
	Holders      []int       `json:"holders,omitempty"`
	AppStarted   bool        `json:"appStarted,omitempty"`
}

// ending is what a server's shutdown has been decided to be: nothing yet, a
// relaunch, or a stop. A stop is final — a relaunch asked for after it is
// refused — and wins over a relaunch decided on but not yet carried out, as a
// signal or a stop request during a relaunch's drain does.
type ending struct{ v atomic.Int32 }

const (
	endingNone int32 = iota
	endingRelaunch
	endingStop
)

// relaunch decides on a relaunch, unless a stop has been decided on, and
// reports whether the shutdown is a relaunch.
func (e *ending) relaunch() bool {
	return e.v.CompareAndSwap(endingNone, endingRelaunch) || e.v.Load() == endingRelaunch
}

// stop decides on a stop, over a relaunch decided on before.
func (e *ending) stop() { e.v.Store(endingStop) }

// settle decides on a stop if nothing has been decided, for a shutdown that
// is beginning, and reports whether it is a relaunch.
func (e *ending) settle() bool {
	e.v.CompareAndSwap(endingNone, endingStop)
	return e.v.Load() == endingRelaunch
}

// relaunching is whether the shutdown is a relaunch, as decided now.
func (e *ending) relaunching() bool { return e.v.Load() == endingRelaunch }

// stopping is whether the shutdown is a stop.
func (e *ending) stopping() bool { return e.v.Load() == endingStop }

// decided is whether the shutdown has been decided on, either way.
func (e *ending) decided() bool { return e.v.Load() != endingNone }

// relaunchHandoffEnv is where a relaunching process puts its handoff for the
// one replacing it, which takes it out of its environment before it spawns
// anything (takeRelaunchHandoff).
const relaunchHandoffEnv = "JUGGLER_RELAUNCH_HANDOFF"

// relaunchError is ErrRelaunch with the server's handoff.
type relaunchError struct{ handoff handoff }

func (e *relaunchError) Error() string        { return ErrRelaunch.Error() }
func (e *relaunchError) Is(target error) bool { return target == ErrRelaunch }

// relaunchHandoff is the handoff of the server that ended with err, or nil
// when err is no relaunch.
func relaunchHandoff(err error) *handoff {
	var re *relaunchError
	if errors.As(err, &re) {
		return &re.handoff
	}
	return nil
}

// takeRelaunchHandoff returns the handoff of the server this process
// replaces, or nil for a start that is no relaunch, and removes it from the
// environment, so nothing this process spawns inherits it.
func takeRelaunchHandoff() *handoff {
	v, ok := os.LookupEnv(relaunchHandoffEnv)
	if !ok {
		return nil
	}
	_ = os.Unsetenv(relaunchHandoffEnv)
	var h handoff
	if err := json.Unmarshal([]byte(v), &h); err != nil {
		// Not the value: it may hold a tunnel link's whole capability.
		jlog.Error("[machineserver] ignoring what the relaunched server handed on (%d bytes): %v", len(v), err)
		return nil
	}
	return &h
}

// processHandoff is this process's handoff (takeRelaunchHandoff), taken out of
// the environment once, by whichever comes first: TakeRelaunchHandoff, or Serve.
var processHandoff = sync.OnceValue(takeRelaunchHandoff)

// TakeRelaunchHandoff takes the handoff of the server this process replaces,
// if it is a relaunch, out of its environment, for Serve. A `juggler serve`
// launch calls it before it runs anything — the login-shell probe that repairs
// PATH included — since the handoff may carry a tunnel link's whole
// capability; Serve takes it itself otherwise.
func TakeRelaunchHandoff() { processHandoff() }

// handoff is what this server would hand on to a relaunch as it stands: what
// it has open, and who holds it up. handOff takes it for a relaunch.
func (s *Server) handoff() handoff {
	h := handoff{LAN: s.lan.Load(), AppStarted: s.startedByApp()}
	if t := s.tunnel.Load(); t != nil {
		h.Tunnel = t.mode
	}
	// Whoever holds this server up now holds the next one: its attached
	// clients, a starter not yet attached, and clients of the server before it
	// still awaited.
	seen := map[int]bool{}
	add := func(pid int) {
		if pid > 0 && !seen[pid] {
			seen[pid] = true
			h.Holders = append(h.Holders, pid)
		}
	}
	s.attachments.Range(func(_, v any) bool {
		add(v.(*attachment).pid)
		return true
	})
	if s.starter > 0 && !s.starterGone.Load() {
		add(s.starter)
	}
	s.holders.Range(func(k, _ any) bool {
		add(k.(int))
		return true
	})
	return h
}

// handOff is the handoff of a server stopping to be relaunched, its tunnel
// released for the next process (releaseTunnel). Call it once no client can
// attach any more (closing), before the lifetime ends.
func (s *Server) handOff() handoff {
	mode, resume := s.releaseTunnel()
	h := s.handoff()
	h.Tunnel, h.TunnelResume = mode, resume
	return h
}

// stopToRelaunch begins a relaunch's shutdown and returns what the server
// hands on. It takes the handoff after no client can attach any more
// (closing), so every one is among its holders, and no session can open
// (endSessions) — but before the lifetime ends, which would end every
// attachment and close the tunnel at once rather than release its link. It
// ends the lifetime once it has the handoff.
func (s *Server) stopToRelaunch() handoff {
	s.closing.Store(true)
	s.endSessions()
	h := s.handOff()
	s.endLifetime()
	return h
}

// releaseHolder lets pid's hold go, if it holds the server (holdFor): it has
// attached, or exited.
func (s *Server) releaseHolder(pid int) {
	if _, held := s.holders.LoadAndDelete(pid); held {
		s.holding.Add(-1)
	}
}

// releaseExitedHolders lets go of the holds of holders that have exited.
func (s *Server) releaseExitedHolders() {
	s.holders.Range(func(k, _ any) bool {
		if pid := k.(int); !processAlive(pid) {
			s.releaseHolder(pid)
		}
		return true
	})
}

// holdFor holds the server up for pids, the clients of the server it
// replaced, until each has attached or exited.
func (s *Server) holdFor(pids []int) {
	for _, pid := range pids {
		if pid <= 0 {
			continue
		}
		if _, dup := s.holders.LoadOrStore(pid, struct{}{}); !dup {
			s.holding.Add(1)
		}
	}
}

// holdRequest names the process a client asks the server to hold itself up
// for (handleHold).
type holdRequest struct {
	PID int `json:"pid"`
}

// handleHold holds the server up for a process of this machine until it
// attaches or exits (holdFor), as for a client of the server a relaunch
// replaced: the next launch of a client that relaunches itself, which asks
// this before it exits, so the server is held for one or the other throughout.
// POST /api/server/hold {"pid": N}.
func (s *Server) handleHold(w http.ResponseWriter, r *http.Request) {
	var req holdRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil || req.PID <= 0 {
		writeMessageError(w, http.StatusBadRequest, msg.New("invalid request body: {error}", "error", "a pid is needed"))
		return
	}
	if !processAlive(req.PID) {
		writeMessageError(w, http.StatusBadRequest, msg.New("invalid request body: {error}", "error", "no such process"))
		return
	}
	s.holdFor([]int{req.PID})
	w.WriteHeader(http.StatusNoContent)
}

// HoldFor asks the server to hold itself up for the process pid until it
// attaches or exits (handleHold).
func (c *Client) HoldFor(pid int) error {
	_, err := c.send(http.MethodPost, "/hold", holdRequest{PID: pid}, nil)
	return err
}

// installedBuildPoll is how often the server looks at its binary. A file
// counts as installed once two looks in a row find it unchanged
// (binwatch.Watcher.Poll), so this is how soon a build is noticed, not a bound
// on how long installing it may take.
const installedBuildPoll = 2 * time.Second

// watchInstalledBuild looks at the server's binary until its lifetime ends,
// and records the build there (installedBuild) while it is another than the
// one running, telling the sessions page's events stream when that changes.
func (s *Server) watchInstalledBuild() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	var w *binwatch.Watcher
	if s.childBuild != "" && filepath.Clean(s.childBin) == filepath.Clean(exe) {
		w = binwatch.NewFrom(exe, s.childBuild)
	} else if w, err = binwatch.New(exe); err != nil {
		jlog.Debug("[machineserver] not watching %s for another build: %v", exe, err)
		return
	}
	life := s.lifetime()
	tick := time.NewTicker(installedBuildPoll)
	defer tick.Stop()
	for {
		select {
		case <-life.Done():
			return
		case <-tick.C:
		}
		now := ""
		if b := w.Poll(); b != nil {
			now = installedBuildName(exe, b)
		}
		if prev := s.installed.Swap(&now); prev == nil && now == "" || prev != nil && *prev == now {
			continue
		}
		if now != "" {
			jlog.Info("[machineserver] another build is installed at %s (%s); a relaunch takes it up", exe, now)
			if s.notice != nil {
				fmt.Fprintf(s.notice, "Juggler %s is installed in place of this server's build. The server relaunches into it once nothing is running in it, or now with `juggler server relaunch`.\n", now)
			}
		}
		s.reg.touch()
	}
}

// installedBuildName names b, the build installed at exe, as BuildOf names a
// build: a release by the version stamped into it, and a build from source by
// its version and when its binary was made. A binary with no version stamped
// is named by its build ID.
func installedBuildName(exe string, b *binwatch.Build) string {
	switch {
	case b.Version == "":
		return "build " + b.ID
	case core.IsDevVersion(b.Version):
		if st, err := os.Stat(exe); err == nil {
			return b.Version + " (built " + st.ModTime().Format("2006-01-02 15:04:05") + ")"
		}
	}
	return b.Version
}

// InstalledBuild is the build installed at the server's path while it is
// another than the one running (statusResponse.InstalledBuild), or "" — for a
// client offering the relaunch that takes it up.
func (c *Client) InstalledBuild() (string, error) {
	var st statusResponse
	err := c.do(http.MethodGet, "/status", nil, &st)
	return st.InstalledBuild, err
}

// installedBuild is the build installed at the server's path (BuildOf), while
// it is another than the one running, or "".
func (s *Server) installedBuild() string {
	if p := s.installed.Load(); p != nil {
		return *p
	}
	return ""
}

// relaunchRequest is the body of POST /api/server/relaunch: with Expect, a
// relaunch only if the server holds no more than it, as a shutdown's; with
// Quiet, only if no session runs a turn or a background task
// (relaunchIfQuiet); with neither, a relaunch whatever runs.
type relaunchRequest struct {
	Expect *Occupancy `json:"expect,omitempty"`
	Quiet  bool       `json:"quiet,omitempty"`
}

// handleRelaunch stops the server to be relaunched (ErrRelaunch), as
// handleShutdown stops it, with or without "expect"; the answer is the same,
// and a 409 for a server that holds more than expected. With "quiet" it is a
// 409 saying what runs ("running", relaunchBusy) for a server with work
// running.
// POST /api/server/relaunch [{"expect": Occupancy} | {"quiet": true}].
func (s *Server) handleRelaunch(w http.ResponseWriter, r *http.Request) {
	var req relaunchRequest
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			writeMessageError(w, http.StatusBadRequest, msg.New("invalid request body: {error}", "error", err.Error()))
			return
		}
	}
	if s.ending.stopping() {
		writeMessageError(w, http.StatusServiceUnavailable, msg.New("the machine server is shutting down"))
		return
	}
	if err := relaunchable(); err != nil {
		jlog.Error("[machineserver] not relaunching: %v", err)
		writeMessageError(w, http.StatusConflict, msg.New("The Juggler server can't relaunch: the program at its path is not a complete Juggler build. Try again once it has finished installing."))
		return
	}
	if req.Quiet {
		busy, ok := s.relaunchIfQuiet(false)
		if !ok {
			m := msg.New("the Juggler server is in use, so it was not relaunched")
			writeJSON(w, http.StatusConflict, relaunchBusy{errorBody: errorBody{Error: m.English(), Message: &m}, Running: busy})
			return
		}
		w.WriteHeader(http.StatusAccepted)
		jlog.Info("[machineserver] quiet relaunch requested via control API")
		return
	}
	if req.Expect != nil {
		if now, ok := s.endIf(*req.Expect, true); !ok {
			m := msg.New("the Juggler server is in use, so it was not relaunched")
			writeJSON(w, http.StatusConflict, shutdownRefusal{errorBody: errorBody{Error: m.English(), Message: &m}, Occupancy: now})
			return
		}
		w.WriteHeader(http.StatusAccepted)
		jlog.Info("[machineserver] conditional relaunch requested via control API")
		return
	}
	if !s.ending.relaunch() {
		writeMessageError(w, http.StatusServiceUnavailable, msg.New("the machine server is shutting down"))
		return
	}
	w.WriteHeader(http.StatusAccepted)
	jlog.Info("[machineserver] relaunch requested via control API")
	s.requestShutdown()
}

// relaunchable fails unless the binary at this process's path is a complete
// Go binary, which a relaunch can start: one still being written, or moved
// away, would leave nothing running once the server had stopped every session
// to relaunch. A variable so tests can stand in for a binary being installed.
var relaunchable = func() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	_, err = binwatch.Read(exe)
	return err
}

// startable fails unless the binary at this process's path runs: asked for its
// version, it answers. An automatic relaunch asks before it stops anything, so
// a build that is complete but does not start — built for another machine, or
// refused by the system — never leaves the user with no server unasked. ctx is
// the server's lifetime: the answer is waited for, not timed. A variable so
// tests can stand in for it.
var startable = func(ctx context.Context) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	return exec.CommandContext(ctx, exe, "--version").Run() //nolint:gosec // this process's own path, a fixed flag
}

// BusyWork is the work running in a server's sessions, which relaunching it
// stops: the conversations running a turn, and the background tasks.
type BusyWork struct {
	Conversations int `json:"conversations"`
	Tasks         int `json:"tasks"`
}

// Quiet is whether no work runs.
func (b BusyWork) Quiet() bool { return b.Conversations == 0 && b.Tasks == 0 }

// refreshActivity asks every running session's child now whether it runs a
// turn or a task, and records the answers, so a decision taken next reads
// what runs now, not what the last poll found. A child that does not answer
// keeps what it was last seen to be, as a poll leaves it.
func (s *Server) refreshActivity() {
	var wg sync.WaitGroup
	for id, c := range s.reg.runningChildren() {
		wg.Go(func() {
			if activity, err := childActivity(c); err == nil {
				s.reg.setActivity(id, c, activity, time.Now())
			}
		})
	}
	wg.Wait()
}

// relaunchIfQuiet begins a relaunch if no session runs a turn or a background
// task, and returns the work that runs otherwise. It asks the children first
// (refreshActivity); the decision and the end of sessionLife are then one step
// on the registry actor, as endIf's are. Clients attached to the server hold
// nothing up: they follow it (attachEnd), and the handoff holds the new server
// for them. A relaunch already decided on is reported as begun; once a stop is
// decided on, nothing is. auto marks the relaunch as the server's own
// (autoRelaunching).
func (s *Server) relaunchIfQuiet(auto bool) (BusyWork, bool) {
	s.refreshActivity()
	var busy BusyWork
	ok := false
	s.reg.do(func(m map[string]*sessionEntry) {
		if s.ending.decided() {
			ok = s.ending.relaunching()
			return
		}
		if busy = busyWork(m); !busy.Quiet() {
			return
		}
		s.closing.Store(true)
		s.autoRelaunching.Store(auto)
		s.ending.relaunch()
		s.endSessions()
		ok = true
	})
	if ok {
		s.requestShutdown()
	}
	return busy, ok
}

// NoAutoRelaunchEnv, set, keeps a server from relaunching into a build
// installed under it by itself (autoRelaunch), for a test of what a server
// that has not yet done so does.
const NoAutoRelaunchEnv = "JUGGLER_NO_AUTO_RELAUNCH"

// autoRelaunch relaunches the server into a build installed at its path once
// nothing would be lost by it: no session runs a turn or a background task
// (relaunchIfQuiet). A server with work running waits — it looks again at each
// change of its sessions, which the activity polls make as the work ends — and
// says so meanwhile (installedBuild), for whoever offers the relaunch.
//
// What is installed has settled before it is seen (watchInstalledBuild): a
// build still being written changes between two looks. Each build is tried
// once: one that is not complete (relaunchable) or does not start (startable)
// is left alone until another is installed, so a broken install neither stops
// the sessions nor has the server try it over and over. Once a stop is decided
// on, nothing is tried; and the new process, built from what it relaunched
// into, sees no other build until the file changes again.
//
// A server the desktop app started (startedByApp) never relaunches by itself:
// the app offers the relaunch from installedBuild and relaunches itself with
// it when the user asks, and a server gone ahead alone would leave the app
// running the old build, waiting on that same button.
func (s *Server) autoRelaunch() {
	if os.Getenv(NoAutoRelaunchEnv) != "" || s.startedByApp() {
		return
	}
	life := s.lifetime()
	refused, startsOK := "", ""
	for {
		// Watched before reading, so a change between the two is not missed.
		changed := s.reg.changes()
		build := s.installedBuild()
		if build != "" && build != refused && !s.ending.decided() && s.quietAsPolled() {
			err := relaunchable()
			if err == nil && build != startsOK {
				if err = startable(life); err == nil {
					startsOK = build
				}
			}
			switch {
			case err != nil:
				refused = build
				jlog.Error("[machineserver] not relaunching into %s by itself: %v", build, err)
			default:
				if _, ok := s.relaunchIfQuiet(true); ok {
					jlog.Info("[machineserver] relaunching into %s by itself: nothing is running", build)
				}
			}
		}
		if s.autoRelaunchLooked != nil {
			s.autoRelaunchLooked()
		}
		select {
		case <-life.Done():
			return
		case <-changed:
		}
	}
}

// startedByApp is whether the desktop app started this server: with
// --started-by, or as the relaunch of one it started (handoff.AppStarted).
func (s *Server) startedByApp() bool { return s.starter > 0 || s.appStarted }

// quietAsPolled is whether the latest polls found no work running: the
// registry's own view, which costs no child a call.
func (s *Server) quietAsPolled() bool {
	quiet := false
	s.reg.do(func(m map[string]*sessionEntry) { quiet = busyWork(m).Quiet() })
	return quiet
}

// relaunchBusy is the 409 answer to a quiet relaunch refused: the work that
// runs, which a relaunch would stop.
type relaunchBusy struct {
	errorBody
	Running BusyWork `json:"running"`
}

// RelaunchIfQuiet asks the server to relaunch, provided no session runs a
// turn or a background task. It reports whether the relaunch has begun, and
// otherwise the work that runs, to ask the user about; AwaitRelaunched waits
// for a server that has begun to answer again.
func (c *Client) RelaunchIfQuiet() (relaunched bool, busy BusyWork, err error) {
	status, err := c.send(http.MethodPost, "/relaunch", relaunchRequest{Quiet: true}, nil)
	var r *refusalError
	switch {
	case err == nil, ServerGoing(err):
		return true, BusyWork{}, nil
	case status == http.StatusConflict && errors.As(err, &r) && r.busy != nil:
		return false, *r.busy, nil
	default:
		return false, BusyWork{}, err
	}
}

// attachEnd is the line an attachment's response ends with when the server
// ends it to relaunch, so its client can follow the server to the new process.
type attachEnd struct {
	Relaunching bool `json:"relaunching"`
}

// RelaunchIf asks the server to relaunch, provided it holds no more than
// expect, as ShutdownIf asks it to stop; a server holding more refuses as an
// *OccupiedError. It returns once the server has begun; AwaitRelaunched waits
// for it to answer again.
func (c *Client) RelaunchIf(expect Occupancy) error {
	status, err := c.send(http.MethodPost, "/relaunch", relaunchRequest{Expect: &expect}, nil)
	var r *refusalError
	switch {
	case err == nil, ServerGoing(err):
		return nil
	case status == http.StatusConflict && errors.As(err, &r) && r.occupancy != nil:
		return &OccupiedError{Now: *r.occupancy}
	default:
		return err
	}
}

// AwaitRelaunched waits for the server c reached, which is relaunching, to
// answer again — a server process other than c's (SameServer) — and returns a
// client of it. It waits while the process that served c lives (on Unix the
// relaunch is that process; on Windows it waits for the one that replaced it)
// or while the machine lock is held (Connect), and reports false once neither
// is so and no server has come back.
func (c *Client) AwaitRelaunched(opts ConnectOptions) (*Client, bool) {
	opts.Start = nil
	for {
		next, err := Connect(opts)
		switch {
		case err == nil && !next.SameServer(c):
			return next, true
		case err != nil && !errors.Is(err, ErrNoServer):
			return nil, false
		}
		if !processAlive(c.PID) {
			return nil, false
		}
		time.Sleep(connectPoll)
	}
}

// SameServer is whether c and o reach one server process: the same address,
// pid and control token, which every start mints afresh — so a relaunch that
// is the same process (exec) on the same port is another server all the same.
func (c *Client) SameServer(o *Client) bool {
	return c.addr == o.addr && c.PID == o.PID && c.token == o.token
}

// relaunchArgs is the arguments the relaunched process runs with: this
// process's, without --started-by. A starter that has not attached yet is
// among the holders the handoff carries (handoff), which hold the new server
// up as the flag would, so the hold travels one way only.
func relaunchArgs(args []string) []string {
	var out []string
	for i := 0; i < len(args); i++ {
		name, _, hasValue := strings.Cut(strings.TrimLeft(args[i], "-"), "=")
		if strings.HasPrefix(args[i], "-") && name == "started-by" {
			if !hasValue {
				i++
			}
			continue
		}
		out = append(out, args[i])
	}
	return out
}

// relaunch replaces this process with one from the binary now at its path,
// run with relaunchArgs, and returns the exit code to leave with: on Unix only
// when the exec failed, on Windows the new process's once it has exited.
// exitWithParent is serve --exit-with-parent, which on Windows the waiting
// process keeps for the new one, since the new one's parent is that process.
// h is this process's server's handoff, for the new one; nil for a process
// that followed another's server rather than ran one.
func relaunch(stderr io.Writer, exitWithParent bool, h *handoff) int {
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(stderr, "juggler: relaunching: %v\n", err)
		return 1
	}
	if h != nil {
		if b, err := json.Marshal(h); err == nil {
			_ = os.Setenv(relaunchHandoffEnv, string(b))
		}
	}
	jlog.Info("[machineserver] relaunching from %s", exe)
	return execSelf(exe, relaunchArgs(os.Args[1:]), stderr, exitWithParent)
}
