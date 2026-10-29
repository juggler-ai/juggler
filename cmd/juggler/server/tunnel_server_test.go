//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const remoteEdgeAddr = "203.0.113.7:54321" // non-loopback, simulates a remote client

// withRemoteIngress tags a request as having arrived over an explicitly-granted
// remote transport, exactly as the http-over-DC dispatcher and a tunnel
// forwarder hop do.
func withRemoteIngress(r *http.Request) *http.Request {
	return MarkRemoteIngress(r, "test-transport")
}

// TestEngineRoleRejectsRemoteIngress is the security guard for remote
// transports: their requests reach the server looking loopback (an http-over-DC
// dispatch or a forwarder hop), so the engine WS role must be gated on the
// remote-ingress tag (and loopback), not loopback alone — otherwise a remote
// guest could overwrite the in-process engine.
func TestEngineRoleRejectsRemoteIngress(t *testing.T) {
	// Loopback, untagged → allowed (the in-process engine WebView).
	loopback := httptest.NewRequest(http.MethodGet, "/ws?role=engine", nil)
	loopback.RemoteAddr = "127.0.0.1:5000"
	if !engineRoleAllowed(loopback) {
		t.Fatal("loopback non-remote-ingress request should be allowed the engine role")
	}

	// Loopback BUT remote ingress → refused, despite looking loopback.
	tagged := withRemoteIngress(loopback)
	if engineRoleAllowed(tagged) {
		t.Fatal("remote ingress must NOT be allowed the engine role even though it is loopback")
	}

	// Non-loopback → refused regardless.
	remote := httptest.NewRequest(http.MethodGet, "/ws?role=engine", nil)
	remote.RemoteAddr = remoteEdgeAddr
	if engineRoleAllowed(remote) {
		t.Fatal("non-loopback request must not be allowed the engine role")
	}
}
