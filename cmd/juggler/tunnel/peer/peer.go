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

// gatherLimit bounds ICE gathering before a partial answer is returned.
const gatherLimit = 5 * time.Second

// Accept answers one offer and returns the local answer, its candidates
// gathered (non-trickle). The data channel the offer opens — the one labelled
// "juggler" — carries traffic to the server dial reaches, every request naming
// host, until life ends, the channel closes or the connection fails. ctx
// bounds only the setup.
func (p *Peer) Accept(ctx, life context.Context, offer tunnel.SessionDescription, ice []tunnel.ICEServer,
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
	pc, err := webrtc.NewPeerConnection(cfg)
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
	go func() {
		<-link.Done()
		startup.Stop()
		_ = pc.Close()
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

	gathered := webrtc.GatheringCompletePromise(pc)
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
	select {
	case <-gathered:
	case <-ctx.Done():
		return fail(ctx.Err())
	case <-time.After(gatherLimit):
		jlog.Info("WebRTC: ICE gathering timed out; returning a partial answer")
	}
	local := pc.LocalDescription()
	if local == nil {
		return fail(errors.New("missing local description"))
	}
	return tunnel.SessionDescription{Type: local.Type.String(), SDP: local.SDP}, nil
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
