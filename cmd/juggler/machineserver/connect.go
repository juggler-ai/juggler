//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
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
	// Without it, no server running is errNoServer.
	Start Starter
}

// connectWaiting is called each time Connect waits for a server that holds
// the lock but does not answer yet. A seam for tests.
var connectWaiting = func() {}

// connectTimeout is Connect's outer guard. A wait ends as the holder makes
// progress — it records its address and answers, or lets the lock go — so
// this bounds only a holder that keeps the lock and never answers. It covers
// a server's slowest legitimate silence: a shutdown draining its listener
// (10s) and then its children (childStopGrace twice).
const connectTimeout = childStartTimeout

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
// `bin serve --implicit` detached (see the detach package), so the server
// outlives whoever started it, with stdio on the null device. Its address is
// read from server.json, never from its output.
func DetachedStarter(bin string) Starter {
	return func() (int, <-chan struct{}, error) {
		cmd, err := detach.Start(detach.Command(bin, "serve", "--implicit"))
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
//     or to let the lock go.
//   - The lock is free (server.json is missing, or left by a server that
//     died): no server. Start one, unless one this call started is still on
//     its way up, and wait for it. Of two clients starting at once, one
//     server wins the lock; the other exits, and its client waits for the
//     winner like any other.
//
// Without opts.Start a free lock is errNoServer.
func Connect(opts ConnectOptions) (*Client, error) {
	dir := opts.ConfigDir
	if dir == "" {
		dir = userpaths.ConfigDir()
	}
	lock := NewMachineLock(dir)
	deadline := time.Now().Add(connectTimeout)
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
		if !lock.held() && (ours == nil || closed(ours)) {
			if opts.Start == nil {
				if info != nil && info.Addr != "" {
					return nil, fmt.Errorf("%w (server.json names %s, which is not answering)", errNoServer, info.Addr)
				}
				return nil, errNoServer
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
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("the Juggler server holding %s did not answer within %s", lock.lockPath, connectTimeout)
		}
		connectWaiting()
		time.Sleep(connectPoll)
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
	c.Version, c.Implicit = st.Version, st.Implicit
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
	// Version is the server's build version, and Implicit whether a client
	// started it on demand (serve --implicit).
	Version  string
	Implicit bool
	// Started is whether the Connect that returned this client started the
	// server.
	Started bool
}

// Addr is the server's host:port.
func (c *Client) Addr() string { return c.addr }

// SessionURL is where a session is served on this server.
func (c *Client) SessionURL(id string) string {
	return "http://" + c.addr + "/s/" + id + "/"
}

// OpenSession opens (or finds) the session for project, an absolute folder,
// and returns it once it is running. A spawn already in flight for the
// project is waited for; a session that is not running then — its spawn
// failed, or it is waiting to restart after a crash — is an error.
func (c *Client) OpenSession(project string) (Session, error) {
	var sess Session
	if err := c.do(http.MethodPost, "/sessions", map[string]any{"project": project, "wait": true}, &sess); err != nil {
		return Session{}, err
	}
	switch sess.State {
	case SessionRunning:
		return sess, nil
	case SessionRestarting:
		return sess, fmt.Errorf("the session for %s is restarting after a crash (%s); try again shortly", project, sess.Error)
	default:
		if sess.Error != "" {
			return sess, errors.New(sess.Error)
		}
		return sess, fmt.Errorf("the session for %s is %s", project, sess.State)
	}
}

// do sends one control-API request and decodes a JSON answer into out (when
// non-nil). A server that does not answer is reported as no server at all;
// one that refuses says why.
func (c *Client) do(method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, "http://"+c.addr+"/api/server"+path, rd) //nolint:noctx // bounded by the client's timeout
	if err != nil {
		return err
	}
	req.Header.Set(TokenHeader, c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w (server.json names %s, which is not answering)", errNoServer, c.addr)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return responseError(resp)
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// responseError is the error a control-API refusal says: the error field of
// its JSON body, or the body itself.
func responseError(resp *http.Response) error {
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var sess Session
	if json.Unmarshal(data, &sess) == nil && sess.Error != "" {
		return errors.New(sess.Error)
	}
	return errors.New(strings.TrimSpace(string(data)))
}
