//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"fmt"
	"net/http"
	"slices"

	"github.com/pion/webrtc/v4"
)

// TunnelHost is the capability surface the server hands to a tunnel-mode
// provider factory (TunnelModeSpec.New). It is everything a WAN transport
// needs from the server, and nothing more, so providers can live outside this
// package — including outside this repository — without reaching into server
// internals.
type TunnelHost interface {
	// AcceptWebRTCOffer answers one SDP offer using the server's shared WebRTC
	// core (DataChannel realtime client + http-over-DC dispatch). iceServers
	// configures the peer connection; nil/empty selects the server's default.
	AcceptWebRTCOffer(ctx context.Context, offer webrtc.SessionDescription, iceServers []webrtc.ICEServer) (*webrtc.SessionDescription, error)
	// NewIngressHTTPServer returns an http.Server with the same handler and
	// timeouts as the LAN listener, tagging every request as remote ingress of
	// the given kind (see MarkRemoteIngress). Transports that forward guest
	// traffic to a private loopback listener serve it with this, so the LAN
	// gate admits their traffic while the engine WS role still refuses it.
	NewIngressHTTPServer(kind string) *http.Server
	// PeerIdentityFingerprint returns the SHA-256 DTLS fingerprint of the
	// server's persistent WebRTC identity, and true when one is available. It is
	// stable across restarts (see webrtc_identity.go), so a provider that mints a
	// shareable link — e.g. a Direct P2P rendezvous URL — can derive a stable
	// address from it (or have the remote client pin it), keeping the same link
	// valid after the server is stopped and started again. Returns "", false
	// when the server is using ephemeral per-connection certificates.
	PeerIdentityFingerprint() (string, bool)
}

// tunnelHost adapts *Server to the TunnelHost capability interface. A separate
// type (rather than methods on Server) keeps the exported Server surface free
// of provider-only capabilities.
type tunnelHost struct{ s *Server }

func (h tunnelHost) AcceptWebRTCOffer(ctx context.Context, offer webrtc.SessionDescription, iceServers []webrtc.ICEServer) (*webrtc.SessionDescription, error) {
	if len(iceServers) == 0 {
		return h.s.acceptWebRTCOffer(ctx, offer)
	}
	return h.s.acceptWebRTCOfferWithICEConfig(ctx, offer, webrtcICEConfig{Servers: iceServers})
}

func (h tunnelHost) NewIngressHTTPServer(kind string) *http.Server {
	srv := h.s.newHTTPServer()
	inner := srv.Handler
	srv.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inner.ServeHTTP(w, MarkRemoteIngress(r, kind))
	})
	return srv
}

func (h tunnelHost) PeerIdentityFingerprint() (string, bool) {
	return h.s.PeerIdentityFingerprint()
}

// TunnelModeSpec describes one registrable WAN tunnel mode: its identity, the
// presentation strings the web UI and terminal derive their controls from, an
// availability probe, and the provider factory. A distribution registers its
// modes with RegisterTunnelMode before the server starts; a build that
// registers none simply has no WAN feature (no API modes, no flags, no keys).
type TunnelModeSpec struct {
	// Mode is the wire identifier (POST /api/connectivity/tunnel {"mode": ...}).
	Mode TunnelMode

	// Web UI presentation, served verbatim by GET /api/connectivity:
	Title           string // short mode name, e.g. "Direct P2P"
	Description     string // one-paragraph explanation of the trade-offs
	StartLabel      string // start-button label, e.g. "Start Direct P2P"
	RelayNote       string // optional note shown while active, e.g. that traffic is proxied
	UnavailableHint string // shown instead of the start button when unavailable

	// Terminal UX, consumed by cmd/juggler/app:
	FlagName           string // startup flag name, e.g. "tunnel" ("" = no flag)
	FlagUsage          string // usage string for FlagName
	ToggleKey          string // single interactive toggle key, e.g. "t" ("" = no key)
	ToggleHelp         string // help line for ToggleKey, e.g. "Start/stop Direct P2P WAN tunnel"
	ConnectingMessage  string // status line printed while the tunnel starts
	UnavailableMessage string // printed when the key/flag is used but Available() is false
	StatusTitle        string // prominent-box title once up, e.g. "WAN ACCESS ACTIVE"
	StatusNote         string // prominent-box note under the guest URL

	// Available reports whether the mode can start on this machine (e.g. a
	// required helper binary is installed). nil means always available.
	Available func() bool

	// New builds a single-use provider for one tunnel session.
	New func(host TunnelHost) TunnelProvider
}

// IsAvailable reports whether the mode can start on this machine.
func (spec TunnelModeSpec) IsAvailable() bool {
	return spec.Available == nil || spec.Available()
}

// tunnelModeRegistry holds the registered specs in registration order. No
// mutex: registration is a startup-time, single-goroutine affair (see
// RegisterTunnelMode), and the slice is read-only afterwards.
var tunnelModeRegistry []TunnelModeSpec

// RegisterTunnelMode adds a WAN tunnel mode to the registry. It must be called
// during process startup, before the server begins serving — typically from a
// distribution's main before app.Run — because the registry is read without
// synchronization afterwards. Panics on an invalid or duplicate spec: a bad
// registration is a programming error in the distribution, best failed loudly
// at startup.
func RegisterTunnelMode(spec TunnelModeSpec) {
	if spec.Mode == "" || spec.New == nil {
		panic("RegisterTunnelMode: spec needs a Mode and a New factory")
	}
	for _, existing := range tunnelModeRegistry {
		if existing.Mode == spec.Mode {
			panic(fmt.Sprintf("RegisterTunnelMode: mode %q already registered", spec.Mode))
		}
	}
	tunnelModeRegistry = append(tunnelModeRegistry, spec)
}

// TunnelModes returns the registered tunnel-mode specs in registration order.
func TunnelModes() []TunnelModeSpec {
	return slices.Clone(tunnelModeRegistry)
}

// findTunnelMode returns the spec registered for mode, if any.
func findTunnelMode(mode TunnelMode) (TunnelModeSpec, bool) {
	for _, spec := range tunnelModeRegistry {
		if spec.Mode == mode {
			return spec, true
		}
	}
	return TunnelModeSpec{}, false
}
