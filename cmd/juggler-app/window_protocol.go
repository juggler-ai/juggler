//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/url"
	"strconv"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
)

// A page posts to the app hosting it (windowActions), and the page is its
// server's build, not this app's: a window on another computer's server can
// pair any app with any server. Each side states the window-control protocol
// it speaks (machineserver.WindowProtocol), so the newer one can tell the user
// the two do not fit. This app hands its protocol and version to every page it
// loads (windowHostQuery), which is all an older app's page could never ask
// for; and it reads a server's before it shows that server's page
// (serverFit), which is all an older server's page could never say.

// windowProtocol is the window-control protocol this app speaks.
const windowProtocol = machineserver.WindowProtocol

// minServerWindowProtocol is the oldest server protocol this app shows the
// pages of. A server of protocol 1 names no project link, and attachRemote
// moves its window to /s/<id> instead (remoteSessionPath).
const minServerWindowProtocol = 1

// windowHostQuery is what a page is told of the app hosting it, as query
// parameters to follow its ?nativeCtl=: the app's window-control protocol and
// its version, which the page reads (web/sdk/lib/window-control.js) to fall
// back on what an older app can do, and to say which app it is in.
func windowHostQuery() string {
	return "&ctlProtocol=" + strconv.Itoa(windowProtocol) + "&appVersion=" + url.QueryEscape(core.Version)
}
