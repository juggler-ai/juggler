//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package tunnel is the seam for WAN exposure: the registry of tunnel modes a
// distribution registers before the server starts, and the capability (Host)
// the machine server hands each mode's provider. A build that registers no
// mode has no WAN feature.
//
// The package carries no transport code of its own, so a binary that only
// reads the registry (the desktop app links the machine server) links no
// WebRTC stack; the WebRTC core is tunnel/peer.
package tunnel

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"

	"juggler/cmd/juggler/msg"
)

// Mode names one WAN-exposure mechanism, and is the ingress kind a caller
// arriving through it is tagged with.
type Mode string

// Info describes a running tunnel.
type Info struct {
	// URL is the link a remote caller opens: the server's root through the
	// tunnel (see ModeSpec.PageURL).
	URL string
	// Relay reports that the tunnel's traffic passes through a third party.
	Relay bool
}

// Provider is one WAN-exposure mechanism. An instance is single-use.
type Provider interface {
	// Start brings the tunnel up and returns its public URL once known.
	// Long-lived servicing (reconnect loops, child supervision) runs in
	// background goroutines bounded by ctx; Start returns promptly once the URL
	// is available, or an error if startup fails.
	Start(ctx context.Context) (Info, error)
	// Done is closed when servicing has permanently stopped (a fatal signalling
	// condition, a helper process exiting), so the server can forget the
	// tunnel. A provider that only stops through Stop or ctx closes it then.
	Done() <-chan struct{}
	// Stop tears the tunnel down and releases its resources. Idempotent.
	Stop()
}

// SessionDescription is one SDP offer or answer, as WebRTC's JSON spells it.
type SessionDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

// ICEServer is one STUN or TURN server, as WebRTC's JSON spells it.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// CallerIdentity is who a remote caller is, as named by the transport that
// vouches for it, with the offer it relays (OfferOptions.Caller). The zero
// value is an anonymous caller — every caller whose transport names no one.
// Nothing in the core verifies it or grants anything on it: the transport
// that supplies it has verified it, and it is shown, not trusted.
type CallerIdentity struct {
	// Issuer is who vouches, e.g. the origin of a service the caller signed in to.
	Issuer string `json:"issuer,omitempty"`
	// Subject is the caller's opaque, stable id at Issuer.
	Subject string `json:"subject,omitempty"`
	// Name is for display only.
	Name string `json:"name,omitempty"`
}

// IsZero reports whether the identity names no one.
func (c CallerIdentity) IsZero() bool { return c == CallerIdentity{} }

// OfferOptions configures one answered offer.
type OfferOptions struct {
	// ICEServers configure the peer connection; empty selects the default.
	ICEServers []ICEServer
	// Caller is who the transport says sent the offer; zero is anonymous.
	Caller CallerIdentity
}

// Host is everything a tunnel provider gets from the server it exposes, and
// nothing more, so providers can live outside this repository without
// reaching into server internals. Each tunnel's provider is handed its own
// Host, and everything arriving through it is tagged as that tunnel's mode:
// a remote caller, which never takes the engine slot or passes for a viewer
// on this machine.
type Host interface {
	// AcceptWebRTCOffer answers one SDP offer. The data channel it opens
	// carries HTTP requests and one WebSocket into the server, ending when the
	// tunnel stops.
	AcceptWebRTCOffer(ctx context.Context, offer SessionDescription, opts OfferOptions) (SessionDescription, error)
	// NewIngressHTTPServer returns an http.Server serving the server's own
	// handler, for a transport that forwards guest traffic to a private
	// loopback listener. Its callers are anonymous.
	NewIngressHTTPServer() *http.Server
}

// RendezvousProtocolVersion is the version of the protocol a rendezvous
// bootstrap page speaks over the data channel. A provider that relays offers
// refuses a rendezvous of another version, and the bootstrap refuses a server
// of another (GET /api/version).
const RendezvousProtocolVersion = 3

// ModeSpec describes one registrable tunnel mode: its identity, the copy a
// session's Settings → Connectivity shows for it, an availability probe and the
// provider factory.
type ModeSpec struct {
	// Mode is the wire identifier, and the ingress kind of its callers.
	Mode Mode

	// Settings → Connectivity copy. Write each as a msg.New literal so
	// `scripts/i18n extract` catalogues it.
	Title           msg.Message // short mode name, e.g. "Direct P2P"
	Description     msg.Message // one-paragraph explanation of the trade-offs
	StartLabel      msg.Message // start-button label, e.g. "Start Direct P2P"
	RelayNote       msg.Message // optional note shown while running, e.g. that traffic is proxied
	UnavailableHint msg.Message // shown instead of the start button when unavailable

	// Available reports whether the mode can start on this machine (e.g. a
	// required helper binary is installed). nil means always available.
	Available func() bool

	// PageURL is the address of the server's page at path ("/s/<id>/")
	// through a tunnel whose link (Info.URL) opens the server's root. nil
	// means the link's own origin serves the server's paths, so the path is
	// joined to it. A mode whose link is a bootstrap that loads the server's
	// pages some other way (a rendezvous's /c/<id>#/path) says how here.
	PageURL func(link, path string) string

	// New builds a single-use provider for one tunnel.
	New func(host Host) Provider
}

// IsAvailable reports whether the mode can start on this machine.
func (spec ModeSpec) IsAvailable() bool {
	return spec.Available == nil || spec.Available()
}

// LinkTo is the address of the server's page at path, a rooted path, through
// a tunnel of this mode whose link is link (PageURL).
func (spec ModeSpec) LinkTo(link, path string) string {
	if spec.PageURL != nil {
		return spec.PageURL(link, path)
	}
	return strings.TrimSuffix(link, "/") + path
}

// registry holds the registered specs in registration order. No lock:
// registration is a startup-time, single-goroutine affair, and the slice is
// read-only once sealed (see RegisterMode).
var registry []ModeSpec

// sealed is set once a server reads the registry, after which it is read
// without synchronization and RegisterMode refuses.
var sealed atomic.Bool

// Seal ends registration. A server calls it before it first reads the
// registry from more than one goroutine.
func Seal() { sealed.Store(true) }

// RegisterMode adds a tunnel mode to the registry. Call it during process
// startup, before the server is created — from a distribution's main before
// app.Run — because the registry is read without synchronization afterwards.
// Panics on a registration after Seal, and on an invalid or duplicate spec:
// each is a programming error in the distribution, best failed loudly.
func RegisterMode(spec ModeSpec) {
	if sealed.Load() {
		panic(fmt.Sprintf("tunnel.RegisterMode: mode %q registered after the server was created; register modes before app.Run", spec.Mode))
	}
	if spec.Mode == "" || spec.New == nil {
		panic("tunnel.RegisterMode: spec needs a Mode and a New factory")
	}
	for _, existing := range registry {
		if existing.Mode == spec.Mode {
			panic(fmt.Sprintf("tunnel.RegisterMode: mode %q already registered", spec.Mode))
		}
	}
	registry = append(registry, spec)
}

// Modes returns the registered specs in registration order.
func Modes() []ModeSpec { return slices.Clone(registry) }

// Find returns the spec registered for mode, if any.
func Find(mode Mode) (ModeSpec, bool) {
	for _, spec := range registry {
		if spec.Mode == mode {
			return spec, true
		}
	}
	return ModeSpec{}, false
}
