//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/url"
	"strconv"
	"strings"

	"juggler/cmd/juggler/msg"
)

// A server by its address: the sessions page's server chooser switches its
// window to the address typed there, or to that of a server it lists as found
// on the network (discover.go), through switch-server (framed_view.go). The
// window is then a connected one (see windowSpec), so it is part of the
// workspace set and reopens at every launch until it is closed or switched
// back.
//
// A server by address can be down when the app starts, and a window onto it
// would then be a blank page with nothing in it to act on. So a window whose
// server does not answer shows a stand-in for it instead (stand_in.go),
// saying so, with a way to try again and a way out to a local window — which is
// also how a connected server that is gone for good stops being reopened.

var (
	unreachableWindowTitle = msg.New("Server unreachable — Juggler")
	unreachablePageTitle   = msg.New("Can't reach the server")
	unreachableRetry       = msg.New("Try again")
	unreachableTrying      = msg.New("Trying…")
	unreachableOpenLocal   = msg.New("Open a local window instead")

	// connectFromURLWindowRefusal is why a page a server by URL sent cannot
	// switch its window to another server, or list them (windowActions).
	connectFromURLWindowRefusal = msg.New("This window shows a server on another computer, so it cannot connect to a different one. Open a new window and connect from there.")
	connectBadAddress           = msg.New("That is not a server address. Enter one like http://devbox:3939.")
)

// unreachableMessage explains the unreachable-server page, naming the server.
func unreachableMessage(serverURL string) msg.Message {
	return msg.New("Juggler could not connect to {url}.\n\n"+
		"Check that the server is running and that this computer can reach it. "+
		"A server answers only on its own machine until LAN access is turned on for it.",
		"url", serverURL)
}

// normaliseServerURL turns what someone typed as a server's address into the
// origin a window is opened on, or reports that it is not one. A bare host:port
// is taken as http. Only the scheme, host and port are kept: a server is served
// from its root, so a path or query typed with it names nothing extra. Anything
// but http(s), a missing host, a port that is not one, and credentials in the
// address are all refused — the address becomes a window's URL, and the
// control endpoint's frame secret goes with it. So is an IPv6 address with a
// zone ("%25en0"): a web view's URL has no zone syntax and will not open one.
func normaliseServerURL(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", false
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", false
	}
	if u.User != nil || u.Hostname() == "" || strings.Contains(u.Hostname(), "%") {
		return "", false
	}
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			return "", false
		}
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), true
}
