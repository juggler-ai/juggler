//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package peer is the WebRTC core behind tunnel.Host.AcceptWebRTCOffer: this
// machine's peer identity, and the data channel that carries a remote
// browser's HTTP requests and its one WebSocket into the server.
//
// A link is a bridge, not a server: each request it carries is made afresh
// over Link.Dial, so it reaches the server's handler exactly as a caller on
// any other transport does, guards and session proxy included.
package peer

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"juggler/cmd/juggler/tunnel"
	"juggler/internal/jlog"
)

// DefaultICEServers answer an offer whose transport names none.
var DefaultICEServers = []tunnel.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}

// Peer answers WebRTC offers for this machine, presenting its identity.
type Peer struct {
	// identity loads the certificate New was given the path of, once, the
	// first time the peer is asked for it; nil when it can be neither read
	// nor written.
	identity func() *webrtc.Certificate
}

// New is this machine's peer, whose identity is kept at path. Making one
// reads nothing: the identity is loaded, or minted, the first time the peer
// is asked for its fingerprint or answers an offer, so a process that makes a
// peer and never opens a tunnel leaves the file alone. When it can be neither
// read nor written, the peer presents an ephemeral certificate per connection
// and has no fingerprint, which costs a remote client only the ability to
// pin it.
func New(path string) *Peer {
	return &Peer{identity: sync.OnceValue(func() *webrtc.Certificate {
		cert, err := loadOrCreateCertificate(path)
		if err != nil {
			jlog.Error("WebRTC identity: %v; peer connections get an ephemeral identity", err)
			return nil
		}
		return cert
	})}
}

// Fingerprint is the SHA-256 DTLS fingerprint the peer presents, or "" when
// it has no lasting identity.
func (p *Peer) Fingerprint() string { return fingerprint(p.identity()) }

// target is where a data channel's traffic goes.
type target struct {
	// dial opens one connection to the server the link serves.
	dial func(ctx context.Context) (net.Conn, error)
	// host is the Host every request names, and the origin of the WebSocket.
	host string
}

// startupLimit bounds a peer connection whose data channel never opens.
const startupLimit = 2 * time.Minute

// stunGatherLimit is how long pion waits for a STUN server's reply before it
// gathers without that server's reflexive candidate. Nothing waits on
// gathering to answer, so it decides only when the far end hears that there
// are no more candidates. A variable so a test can hold gathering open.
var stunGatherLimit = 3 * time.Second

// newAPI makes a peer connection's API, with pion's defaults but for its STUN
// wait.
func newAPI() *webrtc.API {
	var se webrtc.SettingEngine
	se.SetSTUNGatherTimeout(stunGatherLimit)
	return webrtc.NewAPI(webrtc.WithSettingEngine(se))
}

// Accept answers one offer at once, without waiting for ICE gathering: its
// candidates go out through trickle.Local as they are gathered, and the
// offerer's are added from trickle.Remote as they arrive (tunnel.Trickle). The
// data channel the offer opens — the one labelled "juggler" — carries traffic
// to the server dial reaches, every request naming host, until life ends, the
// channel closes or the connection fails. ctx bounds only the setup.
func (p *Peer) Accept(ctx, life context.Context, offer tunnel.SessionDescription, ice []tunnel.ICEServer, trickle tunnel.Trickle,
	dial func(context.Context) (net.Conn, error), host string) (tunnel.SessionDescription, error) {
	if offer.Type != "offer" || offer.SDP == "" {
		return tunnel.SessionDescription{}, errors.New("missing WebRTC offer")
	}
	if len(ice) == 0 {
		ice = DefaultICEServers
	}
	cfg := webrtc.Configuration{ICEServers: pionICEServers(ice)}
	if cert := p.identity(); cert != nil {
		cfg.Certificates = []webrtc.Certificate{*cert}
	}
	pc, err := newAPI().NewPeerConnection(cfg)
	if err != nil {
		return tunnel.SessionDescription{}, fmt.Errorf("create peer connection: %w", err)
	}

	// The link's own life: it ends when the link does — the connection fails
	// or closes, its channel closes, its setup fails or never finishes — or
	// when the tunnel stops, since a link outliving its tunnel would keep a
	// remote caller in after the owner turned the tunnel off. Everything the
	// link holds is let go then, and not before.
	link, endLink := context.WithCancel(life)
	startup := time.AfterFunc(startupLimit, endLink)
	local := localCandidates(trickle.Local)
	go func() {
		<-link.Done()
		startup.Stop()
		_ = pc.Close()
		local(nil)
	}()
	fail := func(err error) (tunnel.SessionDescription, error) {
		endLink()
		return tunnel.SessionDescription{}, err
	}
	var opened atomic.Bool
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		// One bridge per connection: a second channel would be a second
		// WebSocket on a link that has room for one.
		if dc.Label() != "juggler" || !opened.CompareAndSwap(false, true) {
			_ = dc.Close()
			return
		}
		newBridge(link, endLink, pc, dc, target{dial: dial, host: host}, startup.Stop)
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		// Only Failed and Closed are terminal. Disconnected is transient — ICE
		// enters it after a few missed consent checks (a Wi-Fi blip, a NAT
		// rebind, a CPU stall) and recovers on its own, or escalates to Failed
		// if the path is really gone; tearing down on it kills links that
		// would have lived, worse over a relay-less path.
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			endLink()
		}
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			local(nil)
			return
		}
		init := c.ToJSON()
		local(&tunnel.ICECandidate{Candidate: init.Candidate, SDPMid: init.SDPMid, SDPMLineIndex: init.SDPMLineIndex, UsernameFragment: init.UsernameFragment})
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		return fail(fmt.Errorf("set remote description: %w", err))
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return fail(fmt.Errorf("create answer: %w", err))
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		return fail(fmt.Errorf("set local description: %w", err))
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	desc := pc.LocalDescription()
	if desc == nil {
		return fail(errors.New("missing local description"))
	}
	if trickle.Remote != nil {
		go addRemoteCandidates(link, pc, trickle.Remote)
	}
	return tunnel.SessionDescription{Type: desc.Type.String(), SDP: desc.SDP}, nil
}

// localCandidates is to, called as tunnel.Trickle.Local promises: one call at
// a time, in order, and never after the nil that ends the candidates, which
// only the first nil is. The goroutine that makes the calls exits on that
// nil, which the link's end sends if gathering has not. A nil to drops them
// all.
func localCandidates(to func(*tunnel.ICECandidate)) func(*tunnel.ICECandidate) {
	if to == nil {
		return func(*tunnel.ICECandidate) {}
	}
	in := make(chan *tunnel.ICECandidate)
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		for c := range in {
			to(c)
			if c == nil {
				return
			}
		}
	}()
	return func(c *tunnel.ICECandidate) {
		select {
		case in <- c:
		case <-ended:
		}
	}
}

// addRemoteCandidates adds the offerer's candidates to pc as they arrive on
// remote, until it closes or the link ends. One pion refuses is let go: the
// candidates that remain may still make a path.
func addRemoteCandidates(link context.Context, pc *webrtc.PeerConnection, remote <-chan tunnel.ICECandidate) {
	for {
		select {
		case <-link.Done():
			return
		case c, ok := <-remote:
			if !ok {
				return
			}
			init := webrtc.ICECandidateInit{Candidate: c.Candidate, SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex, UsernameFragment: c.UsernameFragment}
			if err := pc.AddICECandidate(init); err != nil {
				jlog.Debug("WebRTC: ignoring a remote candidate: %v", err)
			}
		}
	}
}

func pionICEServers(in []tunnel.ICEServer) []webrtc.ICEServer {
	out := make([]webrtc.ICEServer, 0, len(in))
	for _, s := range in {
		srv := webrtc.ICEServer{URLs: s.URLs, Username: s.Username}
		if s.Credential != "" {
			srv.Credential = s.Credential
		}
		out = append(out, srv)
	}
	return out
}
