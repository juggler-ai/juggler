//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"errors"
	"net/http"
	"slices"
	"strings"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/tunnel"
)

// A client never uses a server of another build than its own (BuildOf). What
// it does about one is decided here, for every client — the desktop app and
// bare juggler alike:
//
//   - A server a client started on demand that nothing is using (Idle) is
//     replaced without asking: shut down, waited out, and started afresh.
//   - Any other is the user's to decide, told everything a restart would stop
//     (Stops). A server someone started by hand is never replaced silently,
//     but may be at the user's word.
//
// Either way the shutdown is conditional (Client.ShutdownIf): the server
// itself decides, in one step on its registry, whether it still holds no more
// than the client looked at, so a session opened, or a client attached, after
// the look is never stopped by it.

// Occupancy is what stopping a machine server would end, beyond the server
// itself.
type Occupancy struct {
	// Sessions are the sessions it runs, and every turn running in them.
	Sessions []Session `json:"sessions"`
	// Clients counts the local clients attached to it — desktop apps and
	// terminal jugglers — and the client that started it until that client
	// attaches.
	Clients int `json:"clients"`
	// LAN is LAN access on: devices on the network may be using it.
	LAN bool `json:"lan,omitempty"`
	// Tunnel is the mode of the running tunnel, if any: whoever holds its link
	// may be using it.
	Tunnel string `json:"tunnel,omitempty"`
	// TunnelTitle is that mode's title (tunnel.ModeSpec.Title), as the server
	// knows it: a client process may have no modes registered. Nil names the
	// tunnel by its mode. Covers ignores it.
	TunnelTitle *msg.Message `json:"tunnelTitle,omitempty"`
	// HandStarted is a server started by hand (`juggler serve`) rather than on
	// demand by a client: someone's terminal is running it.
	HandStarted bool `json:"handStarted,omitempty"`
}

// Idle reports whether replacing the server stops nothing anyone is using:
// a client started it, and it has no sessions, no clients and no way in open.
// Only an idle server is replaced without asking.
func (o Occupancy) Idle() bool {
	return len(o.Sessions) == 0 && o.Clients == 0 && !o.LAN && o.Tunnel == "" && !o.HandStarted
}

// Covers reports whether now holds nothing o does not: each of its sessions is
// one of o's, it has no more clients, and it has a way in open, or was started
// by hand, only where o did too. A shutdown the user agreed to on seeing o is
// still the one they agreed to while o covers what the server holds.
func (o Occupancy) Covers(now Occupancy) bool {
	for _, s := range now.Sessions {
		if !slices.ContainsFunc(o.Sessions, func(seen Session) bool { return seen.ID == s.ID }) {
			return false
		}
	}
	return now.Clients <= o.Clients &&
		(!now.LAN || o.LAN) &&
		(now.Tunnel == "" || now.Tunnel == o.Tunnel) &&
		(!now.HandStarted || o.HandStarted)
}

// Stops says what a restart would stop, one message for each thing, for the
// user asked to agree to it. An idle server's says nothing.
func (o Occupancy) Stops() []msg.Message {
	var out []msg.Message
	if n := len(o.Sessions); n > 0 {
		projects := make([]string, 0, n)
		for _, s := range o.Sessions {
			projects = append(projects, s.Project)
		}
		out = append(out, msg.New("{count, plural, one {# session, and any work running in it:} other {# sessions, and any work running in them:}}\n{projects}",
			"count", n, "projects", strings.Join(projects, "\n")))
	}
	if o.Clients > 0 {
		out = append(out, msg.New("{count, plural, one {# other app or terminal using it} other {# other apps or terminals using it}}", "count", o.Clients))
	}
	if o.LAN {
		out = append(out, msg.New("LAN access, and any device on the network using it"))
	}
	if o.Tunnel != "" {
		// The mode's title, as a message translated with this one (msg.Format).
		var name any = o.Tunnel
		if title := o.tunnelTitle(); title != nil {
			name = *title
		}
		out = append(out, msg.New("The {tunnel} link, and anyone using it", "tunnel", name))
	}
	if o.HandStarted {
		out = append(out, msg.New("A server started by hand (juggler serve), whose terminal is still running it"))
	}
	return out
}

// tunnelTitle is the running tunnel's title: the one the server sent, or the
// mode's as registered in this process; nil when neither has one.
func (o Occupancy) tunnelTitle() *msg.Message {
	if o.TunnelTitle != nil && !o.TunnelTitle.IsZero() {
		return o.TunnelTitle
	}
	return modeTitle(o.Tunnel)
}

// modeTitle is the title registered for mode (tunnel.ModeSpec.Title), or nil.
func modeTitle(mode string) *msg.Message {
	if spec, ok := tunnel.Find(tunnel.Mode(mode)); ok && !spec.Title.IsZero() {
		return &spec.Title
	}
	return nil
}

// OccupiedError is a conditional shutdown refused: the server holds more than
// the caller allowed for, and Now is what it holds.
type OccupiedError struct {
	Now Occupancy
}

func (e *OccupiedError) Error() string {
	return "the Juggler server is in use, so it was not stopped"
}

// shutdownRequest is the body of POST /api/server/shutdown: with Expect, a
// shutdown only if the server holds no more than it (Occupancy.Covers); with
// none, a shutdown whatever it holds.
type shutdownRequest struct {
	Expect *Occupancy `json:"expect,omitempty"`
}

// Occupancy reads what stopping the server would end. It is a look, not a
// promise: ShutdownIf is what holds the server to it.
func (c *Client) Occupancy() (Occupancy, error) {
	var st statusResponse
	if err := c.do(http.MethodGet, "/status", nil, &st); err != nil {
		return Occupancy{}, err
	}
	list, err := c.ListSessions()
	if err != nil {
		return Occupancy{}, err
	}
	o := Occupancy{Sessions: list, Clients: st.Attached, LAN: st.LAN, Tunnel: st.Tunnel, TunnelTitle: st.TunnelTitle, HandStarted: !st.Implicit}
	if st.AwaitingStarter {
		o.Clients++
	}
	return o, nil
}

// ShutdownIf asks the server to shut down, every session with it, provided it
// holds no more than expect (Occupancy.Covers): the zero Occupancy is a
// shutdown only if idle. A server holding more refuses, as an *OccupiedError
// saying what it holds. A server already gone, or on its way, has done as
// asked.
func (c *Client) ShutdownIf(expect Occupancy) error {
	status, err := c.send(http.MethodPost, "/shutdown", shutdownRequest{Expect: &expect}, nil)
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

// ReplaceIfIdle shuts the server down if it is idle (Occupancy.Idle), and
// waits for it to go: the silent replacement of a server of another build.
// Otherwise it stops nothing and returns what a restart would stop, for the
// user to be asked; so it does too when the server stopped being idle between
// the look and the shutdown.
func (c *Client) ReplaceIfIdle() (replaced bool, occ Occupancy, err error) {
	occ, err = c.Occupancy()
	if err != nil {
		return false, Occupancy{}, err
	}
	if !occ.Idle() {
		return false, occ, nil
	}
	var busy *OccupiedError
	switch err := c.ShutdownIf(Occupancy{}); {
	case errors.As(err, &busy):
		return false, busy.Now, nil
	case err != nil:
		return false, occ, err
	}
	c.AwaitGone()
	return true, occ, nil
}

// RestartAsAgreed shuts the server down at the user's word, provided it holds
// no more than shown, what the user was told it would stop, and waits for it
// to go. A server holding more is left running, and the *OccupiedError says
// what it holds now, for the user to be asked again.
func (c *Client) RestartAsAgreed(shown Occupancy) error {
	if err := c.ShutdownIf(shown); err != nil {
		return err
	}
	c.AwaitGone()
	return nil
}
