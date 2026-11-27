//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package tunnel

import (
	"context"

	"juggler/cmd/juggler/msg"
)

// A LAN announcer tells a third party where this server is on its network, so
// a browser on the same network can list it and open its plain LAN address.
// It lets nobody in by itself: whoever opens the address meets the LAN access
// gate, as when the address is typed. A distribution registers at most one.
// The machine server runs it exactly while LAN access is on and the user has
// made the server findable (connectivity.lanFindable), a switch that exists
// only once one is registered. A build that registers none announces nothing
// and shows no such switch.

// LANAnnouncerSpec describes the registered LAN announcer.
type LANAnnouncerSpec struct {
	// Name names the third party in what the server logs, e.g. "juggler.studio".
	Name string
	// Label is the switch's label in Settings → Connectivity and on the
	// sessions page, e.g. "Also findable from {url}" with url set to PageURL.
	Label msg.Message
	// PageURL is the third party's page that lists findable servers, e.g.
	// "https://juggler.studio/sessions". The switch draws its label's {url}
	// placeholder as a link to it.
	PageURL string
	// Description says what being findable tells the third party.
	Description msg.Message
	// New makes the announcer for one stretch of being findable.
	New func(host LANAnnounceHost) LANAnnouncer
}

// LANAnnouncer is one stretch of a LAN announcer running.
type LANAnnouncer interface {
	// Run announces the server until ctx ends, which it does when LAN access
	// or the switch goes off, or the server stops. Retrying is its own affair:
	// the server runs it once per stretch, and an error it returns is logged
	// and ends it until the next. Once ctx ends it may say a last word (that
	// the server is no longer findable) before it returns, in a few seconds
	// at most: a stopping server waits up to ten for it, then exits without it.
	Run(ctx context.Context) error
}

// LANAnnounceHost is what a LAN announcer gets from the machine server.
type LANAnnounceHost interface {
	// Announcement is what to announce, read afresh: the machine's addresses
	// change as it moves between networks.
	Announcement() LANAnnouncement
}

// LANAnnouncement is where this server is on its network right now.
type LANAnnouncement struct {
	// Name is this machine's name, as it is announced over mDNS.
	Name string
	// URLs are the server's root on each of this machine's addresses
	// ("http://192.168.1.20:3939/"), IPv4 first: the addresses LAN access
	// shows, tailnet ones included.
	URLs []string
	// Port is the server's TCP port.
	Port int
	// Version is the server's version.
	Version string
}

// lanAnnouncer is the registered LAN announcer, if any. Like registry, it is
// written only before Seal.
var lanAnnouncer *LANAnnouncerSpec

// RegisterLANAnnouncer registers the LAN announcer. Call it during process
// startup, before the server is created — from a distribution's main before
// app.Run. Panics on a registration after Seal, a spec with no New, and a
// second registration: each is a programming error in the distribution.
func RegisterLANAnnouncer(spec LANAnnouncerSpec) {
	if sealed.Load() {
		panic("tunnel.RegisterLANAnnouncer: registered after the server was created; register it before app.Run")
	}
	if spec.New == nil {
		panic("tunnel.RegisterLANAnnouncer: spec needs a New factory")
	}
	if lanAnnouncer != nil {
		panic("tunnel.RegisterLANAnnouncer: a LAN announcer is already registered")
	}
	lanAnnouncer = &spec
}

// FindLANAnnouncer returns the registered LAN announcer, if any.
func FindLANAnnouncer() (LANAnnouncerSpec, bool) {
	if lanAnnouncer == nil {
		return LANAnnouncerSpec{}, false
	}
	return *lanAnnouncer, true
}
