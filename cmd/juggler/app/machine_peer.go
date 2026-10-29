//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"juggler/cmd/juggler/machineserver"
	"juggler/cmd/juggler/tunnel"
	"juggler/cmd/juggler/tunnel/peer"
)

// machinePeer is what answers a tunnel's WebRTC offers for a machine server
// this process runs: this machine's peer, once a distribution has registered
// a tunnel mode, and otherwise none, so a build with no WAN feature never
// mints a peer identity. Making it reads nothing (peer.New): a process that
// only attaches to a running server, or serves without a tunnel, leaves the
// identity alone.
func machinePeer() machineserver.Peer {
	if len(tunnel.Modes()) == 0 {
		return nil
	}
	return peer.New(peer.IdentityPath())
}
