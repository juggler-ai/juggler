//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/msg"
)

// ExtraRoutes registers a distribution's own routes on the machine server
// (ServeOptions.ExtraRoutes). api is the control API's router, /api/server:
// what is registered there is matched after every built-in route, so it
// shadows none, and is behind everything the control API is — the tunnel and
// LAN gates, the host and origin guards, and the control token (tokenGuard).
// host is what the machine server lends those routes.
type ExtraRoutes func(api *mux.Router, host Host)

// Host is what the machine server lends a distribution's routes
// (ExtraRoutes): the sessions it supervises, and its own rule for who may act.
type Host interface {
	// OpenSession spawns or reuses project's session child, as POST
	// /api/server/sessions with wait does — so an open records project in the
	// recents, as any open does — and returns it held: it is not retired for
	// want of a viewer until Release. project is an absolute folder, or one
	// starting with ~/. ctx bounds the wait for the child to start.
	OpenSession(ctx context.Context, project string) (*HeldSession, error)
	// LocalOnly refuses next to callers not on this machine, as the switches
	// for LAN access and tunnels are refused (localOnly).
	LocalOnly(next http.HandlerFunc) http.HandlerFunc
	// WriteMessageError answers with the control API's error envelope,
	// {"error": English, "message": m}, which the sessions page draws
	// translated (serverText) and the CLI prints.
	WriteMessageError(w http.ResponseWriter, status int, m msg.Message)
}

// HeldSession is a session child Host.OpenSession opened, held for its caller:
// it counts as one viewer of the session (holdViewer) until Release, so a
// session no one has opened in a window is not retired from under the work
// done with it.
type HeldSession struct {
	s        *Server
	id       string
	release  func()
	released atomic.Bool
}

// Do sends a request for path (from the root: "/api/…") to the session's
// child, with the API token minted for it — what calls the child's API as its
// spawner — and returns the child's response, which the caller closes. It
// goes to the child running the session when it is called, so a child
// restarted since the open is the one asked. It fails, sending nothing, once
// the session is no longer running, and after Release.
func (h *HeldSession) Do(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("session request path %q is not from the root", path)
	}
	c, ok := h.s.reg.runningChild(h.id)
	if !ok || h.released.Load() {
		return nil, errHeldSessionGone
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://"+c.addr+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set(TokenHeader, c.apiToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return sessionHTTP.Do(req)
}

// Release lets the session go: it no longer counts as viewed, and retires once
// it has had no viewer for the grace, as any session does. Idempotent.
func (h *HeldSession) Release() {
	if h.released.CompareAndSwap(false, true) {
		h.release()
	}
}

// errHeldSessionGone is HeldSession.Do's error for a session that is not
// running, or that its holder has released.
var errHeldSessionGone = errors.New("the session is no longer running")

// sessionHTTP sends HeldSession.Do's requests. No timeout of its own: each
// request's context bounds it, as its caller decides.
var sessionHTTP = &http.Client{}

// openHoldAttempts is how many times OpenSession opens a session that leaves
// running before it can be held — retired or stopped in the moment between —
// before it gives up. Each further open waits for that stop to finish
// (openSession), so a retry is never a spin.
const openHoldAttempts = 3

// serverHost is the Host a Server lends its ExtraRoutes.
type serverHost struct{ s *Server }

// OpenSession implements Host.
func (h serverHost) OpenSession(ctx context.Context, project string) (*HeldSession, error) {
	project, err := resolveProject(project)
	if err != nil {
		return nil, err
	}
	for range openHoldAttempts {
		res := h.s.openSession(ctx, project, true)
		switch {
		case res.status == 0:
			return nil, ctx.Err()
		case res.refusal != nil:
			return nil, &msg.Error{Message: *res.refusal}
		case res.sess.State != SessionRunning:
			return nil, fmt.Errorf("the session for %s did not start: %s", project, res.sess.Error)
		}
		if release, ok := h.s.reg.holdViewer(res.sess.ID); ok {
			return &HeldSession{s: h.s, id: res.sess.ID, release: release}, nil
		}
	}
	return nil, fmt.Errorf("the session for %s kept stopping before it could be held (%d attempts)", project, openHoldAttempts)
}

// LocalOnly implements Host.
func (h serverHost) LocalOnly(next http.HandlerFunc) http.HandlerFunc {
	return h.s.localOnly(next)
}

// WriteMessageError implements Host.
func (serverHost) WriteMessageError(w http.ResponseWriter, status int, m msg.Message) {
	writeMessageError(w, status, m)
}

// runningChild is the child running session id, if it is running.
func (r *registry) runningChild(id string) (c *child, ok bool) {
	r.do(func(m map[string]*sessionEntry) {
		if e := m[id]; e != nil && e.State == SessionRunning && e.child != nil {
			c, ok = e.child, true
		}
	})
	return c, ok
}
