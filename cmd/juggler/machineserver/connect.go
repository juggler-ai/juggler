//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"juggler/internal/detach"
	"juggler/internal/logpaths"
	"juggler/internal/userpaths"
)

// Starter starts a machine server in the background and returns its process
// ID and a channel that closes when that process exits.
type Starter func() (pid int, exited <-chan struct{}, err error)

// ConnectOptions says where Connect looks for the machine server, and whether
// it may start one.
type ConnectOptions struct {
	// ConfigDir holds server.lock and server.json; "" is userpaths.ConfigDir().
	ConfigDir string
	// Start, when set, is how Connect starts a server when none is running.
	// Without it, no server running is ErrNoServer.
	Start Starter
}

// connectWaiting is called each time Connect waits for a server that holds
// the lock but does not answer yet. A seam for tests.
var connectWaiting = func() {}

// connectPoll is how often Connect looks again while it waits, and
// statusProbeTimeout how long one status probe may take.
const (
	connectPoll        = 25 * time.Millisecond
	statusProbeTimeout = 2 * time.Second
)

// connectStarts is how many servers one Connect starts before giving up: one
// that loses the lock to a probe (MachineLock.held) is started again, one that
// keeps exiting is not.
const connectStarts = 3

// DetachedStarter is the Starter for bin, this machine's juggler: it runs
// `bin serve --implicit --started-by <pid>` detached (see the detach package), so the server
// outlives whoever started it, with stdio on the null device. Its address is
// read from server.json, never from its output.
func DetachedStarter(bin string) Starter {
	return func() (int, <-chan struct{}, error) {
		cmd, err := detach.Start(detach.Command(bin, "serve", "--implicit", "--started-by", strconv.Itoa(os.Getpid())))
		if err != nil {
			return 0, nil, fmt.Errorf("start the Juggler server: %w", err)
		}
		exited := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(exited)
		}()
		return cmd.Process.Pid, exited, nil
	}
}

// Connect finds this machine's server, or with opts.Start starts one, and
// returns a client of it once it answers. It classifies what server.json and
// the lock say:
//
//   - server.json names an address that answers /api/server/status with its
//     token: that is the server.
//   - The lock is held but nothing answers yet — a server between taking the
//     lock and recording its address, or shutting down: wait for it to answer
//     or to let the lock go, which it does when it exits.
//   - Otherwise there is no server to wait for (server.json is missing, or left
//     by a server that died). Start one, unless one this call started is still
//     on its way up, and wait for it while it lives. Of two clients starting at
//     once, one server wins the lock; the other exits, and its client waits for
//     the winner like any other.
//
// No wait is bounded by a clock: each lasts while the process it waits on
// lives (worthWaiting). Without opts.Start, no server to wait for is
// ErrNoServer.
func Connect(opts ConnectOptions) (*Client, error) {
	dir := opts.ConfigDir
	if dir == "" {
		dir = userpaths.ConfigDir()
	}
	lock := NewMachineLock(dir)
	// The server this call started, and its channel that closes when it exits.
	var oursPID int
	var ours <-chan struct{}
	starts := 0
	for {
		info := lock.readInfo()
		if info != nil && info.Addr != "" {
			if c, pid, ok := probeStatus(info); ok {
				c.Started = oursPID != 0 && pid == oursPID
				return c, nil
			}
		}
		if !worthWaiting(info, lock.probe(), ours) {
			if opts.Start == nil {
				if info != nil && info.Addr != "" {
					return nil, fmt.Errorf("%w (server.json names %s, which is not answering)", ErrNoServer, info.Addr)
				}
				return nil, ErrNoServer
			}
			if starts == connectStarts {
				return nil, fmt.Errorf("the Juggler server did not start (%d attempts); see %s", starts, serveLogPath())
			}
			starts++
			pid, exited, err := opts.Start()
			if err != nil {
				return nil, err
			}
			oursPID, ours = pid, exited
		}
		connectWaiting()
		time.Sleep(connectPoll)
	}
}

// worthWaiting reports whether a server that does not answer yet is on its way
// to answering, or to letting the lock go: the server this Connect started
// (ours, nil for none) has not exited, or the lock is held. A held lock is a
// live holder — the OS lets a lock go with the process that held it — and that
// holder is the process server.json names once it has recorded itself, which
// it does straight after taking the lock. A lock that cannot be probed falls
// back on that record: waited on while the process it names lives.
func worthWaiting(info *ServerInfo, lock lockState, ours <-chan struct{}) bool {
	switch {
	case ours != nil && !closed(ours):
		return true
	case lock == lockHeld:
		return true
	case lock == lockUnknown:
		return info != nil && processAlive(info.PID)
	default:
		return false
	}
}

// closed reports whether ch has been closed.
func closed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// probeStatus asks the server info names for its status, with its token, and
// returns a client of it, and its process ID, when it answers.
func probeStatus(info *ServerInfo) (*Client, int, bool) {
	c := &Client{addr: info.Addr, token: info.Token, http: &http.Client{Timeout: statusProbeTimeout}}
	var st statusResponse
	if err := c.do(http.MethodGet, "/status", nil, &st); err != nil || st.Status != "ok" {
		return nil, 0, false
	}
	c.http = &http.Client{Timeout: cliTimeout}
	// A server from before builds were told apart reports none, and is
	// known by its version alone.
	c.Version, c.Build, c.Implicit, c.PID = st.Version, cmp.Or(st.Build, st.Version), st.Implicit, st.PID
	return c, st.PID, true
}

// serveLogPath is where `juggler serve` logs.
func serveLogPath() string {
	return filepath.Join(logpaths.LogDir(), "serve.log")
}

// Client calls a machine server's control API.
type Client struct {
	addr  string
	token string
	http  *http.Client
	// Version is the server's build version, Implicit whether a client
	// started it on demand (serve --implicit), and PID its process.
	Version string
	// Build is which build of Version the server is (BuildOf): a client uses
	// a server only of its own build.
	Build    string
	Implicit bool
	PID      int
	// Started is whether the Connect that returned this client started the
	// server.
	Started bool
	// beatEvery is how often an attachment of this client beats; zero is
	// attachBeatEvery.
	beatEvery time.Duration
	// beaten, when set, is told each beat the server answered.
	beaten func(id string)
}

// Addr is the server's host:port.
func (c *Client) Addr() string { return c.addr }

// SessionURL is where a session is served on this server.
func (c *Client) SessionURL(id string) string {
	return "http://" + c.addr + "/s/" + id + "/"
}

// OpenSession opens (or finds) the session for project, an absolute folder,
// and returns it once it is running, with whether this call spawned it. A
// spawn already in flight for the project is waited for, and is another
// caller's; a session that is not running then — its spawn failed, or it is
// waiting to restart after a crash — is an error.
//
// The call has no timeout of its own: it lasts while the server works on it,
// which bounds every wait in an open itself (a stopping child's exit, a spawn
// within childStartTimeout). A server that dies meanwhile drops the
// connection, which ends the call as ErrNoServer.
func (c *Client) OpenSession(project string) (sess Session, opened bool, err error) {
	untimed := &http.Client{Transport: c.http.Transport}
	status, err := c.sendWith(untimed, http.MethodPost, "/sessions", map[string]any{"project": project, "wait": true}, &sess)
	if err != nil {
		return Session{}, false, err
	}
	switch sess.State {
	case SessionRunning:
		return sess, status == http.StatusCreated, nil
	case SessionRestarting:
		return sess, false, fmt.Errorf("the session for %s is restarting after a crash (%s); try again shortly", project, sess.Error)
	default:
		if sess.Error != "" {
			return sess, false, errors.New(sess.Error)
		}
		return sess, false, fmt.Errorf("the session for %s is %s", project, sess.State)
	}
}

// StopSession stops the session id.
func (c *Client) StopSession(id string) error {
	return c.do(http.MethodDelete, "/sessions/"+id, nil, nil)
}

// ListSessions returns the sessions the server runs.
func (c *Client) ListSessions() ([]Session, error) {
	var list []Session
	if err := c.do(http.MethodGet, "/sessions", nil, &list); err != nil {
		return nil, err
	}
	return list, nil
}

// Shutdown asks the server to shut down, every session with it. A server
// already gone, or on its way, has done as asked.
func (c *Client) Shutdown() error {
	if err := c.do(http.MethodPost, "/shutdown", nil, nil); err != nil && !ServerGoing(err) {
		return err
	}
	return nil
}

// AwaitGone returns once the server c reaches has stopped answering, after a
// shutdown it was asked for. It follows the server's progress: a server stops
// answering as soon as its drain begins, and Connect then waits out the rest of
// the drain on the lock. A server too slow to answer in time is still there.
func (c *Client) AwaitGone() {
	for {
		err := c.do(http.MethodGet, "/status", nil, nil)
		if err != nil && !errors.Is(err, ErrServerSlow) {
			return
		}
		time.Sleep(connectPoll)
	}
}

// do sends one control-API request and decodes a JSON answer into out (when
// non-nil), as send does.
func (c *Client) do(method, path string, body, out any) error {
	_, err := c.send(method, path, body, out)
	return err
}

// send sends one control-API request, decodes a JSON answer into out (when
// non-nil), and returns the status it was answered with. A server that cannot
// be reached is reported as no server at all, one that did not answer within
// the client's timeout as slow (unanswered), and one that refuses says why
// (*refusalError).
func (c *Client) send(method, path string, body, out any) (int, error) {
	return c.sendWith(c.http, method, path, body, out)
}

// sendWith is send over hc.
func (c *Client) sendWith(hc *http.Client, method, path string, body, out any) (int, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, "http://"+c.addr+"/api/server"+path, rd) //nolint:noctx // bounded by hc's timeout, or by the server's progress (OpenSession)
	if err != nil {
		return 0, err
	}
	req.Header.Set(TokenHeader, c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, unanswered(c.addr, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return resp.StatusCode, responseError(resp)
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if out != nil && len(data) > 0 {
		return resp.StatusCode, json.Unmarshal(data, out)
	}
	return resp.StatusCode, nil
}

// refusalError is a control-API refusal: its status, and what it says. A
// refused conditional shutdown also says what the server holds (occupancy).
type refusalError struct {
	status    int
	text      string
	occupancy *Occupancy
}

func (e *refusalError) Error() string { return e.text }

// responseError is the error a control-API refusal says: the error field of
// its JSON body, or the body itself.
func responseError(resp *http.Response) error {
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var body struct {
		Error     string     `json:"error"`
		Occupancy *Occupancy `json:"occupancy"`
	}
	if json.Unmarshal(data, &body) == nil && body.Error != "" {
		return &refusalError{status: resp.StatusCode, text: body.Error, occupancy: body.Occupancy}
	}
	return &refusalError{status: resp.StatusCode, text: strings.TrimSpace(string(data))}
}

// ErrServerSlow is a call the server did not answer within the client's
// timeout. The server was reached, so it is there, only slow: it is neither
// gone nor going (ServerGoing), and Connect again would find the same one.
var ErrServerSlow = errors.New("the Juggler server did not answer in time")

// unanswered is the error for a request to the server at addr that got no
// answer (err): a timeout is ErrServerSlow; anything else — refused, reset,
// closed — is a server that is not there, ErrNoServer.
func unanswered(addr string, err error) error {
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return fmt.Errorf("%w (the server at %s: %v)", ErrServerSlow, addr, err)
	}
	return fmt.Errorf("%w (server.json names %s, which is not answering)", ErrNoServer, addr)
}

// ServerGoing reports whether err says the server is gone or on its way out:
// it could not be reached (ErrNoServer), or refused because it is shutting
// down (503). Either way, Connect again finds out what is there now. A server
// that was slow to answer (ErrServerSlow) is neither.
func ServerGoing(err error) bool {
	var r *refusalError
	return errors.Is(err, ErrNoServer) || (errors.As(err, &r) && r.status == http.StatusServiceUnavailable)
}
