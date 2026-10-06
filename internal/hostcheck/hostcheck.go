//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package hostcheck is the DNS-rebinding defence's one rule: which Host header
// values can only name this machine. A rebinding attacker points a domain they
// control at this machine's address, so the victim's browser sends that domain
// as Host — and, being same-origin with itself, as Origin too, which is why an
// Origin check alone does not stop it. A Host that is not a DNS name the
// attacker could own is the one thing such a page cannot forge.
//
// Both the per-project server (its /api surface) and the machine server
// (everything it serves) apply it, so it is spelled here once.
package hostcheck

import (
	"fmt"
	"net"
	"net/netip"
	"strings"
)

// NamesThisMachine reports whether a Host header value (with or without a port)
// can only name this machine: "localhost", a name under the reserved
// .localhost TLD, or an IP address literal (loopback or a LAN address the
// server is reachable on). Any other DNS name is refused.
func NamesThisMachine(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	// RFC 6761 reserves .localhost and requires it to resolve to loopback, so a
	// per-instance hostname like myproject.localhost names this machine as surely
	// as "localhost" does and an attacker cannot point a domain they control at
	// such a label. Admitting the suffix (and nothing broader) keeps the
	// rebinding defense intact: a served page hands its API token to any host
	// that can load it, so a general DNS name must still be refused.
	// Hostnames are case-insensitive, so fold before matching (but parse the
	// address form below unfolded: an IPv6 zone such as %en0 is not).
	if name := strings.ToLower(host); name == "localhost" || strings.HasSuffix(name, ".localhost") {
		return true
	}
	// netip.ParseAddr (unlike net.ParseIP) accepts a zoned IPv6 literal such as
	// fe80::1%en0 — the form a same-subnet client sends over a link-local
	// address. It still rejects DNS names, so the rebinding defense holds.
	_, err := netip.ParseAddr(host)
	return err == nil
}

// RefusalMessage is the body a 403 carries when NamesThisMachine refused the
// request's Host. It names the hostname that was refused — the one piece of
// information that identifies the actual mistake, and one the user typed into
// their address bar — states which names are served, gives the reason (so the
// rule reads as a defence rather than a bug), and closes on the remedy for the
// common case, a caller reaching a server by hostname over the LAN.
//
// Deliberately no "Forbidden:" prefix: the HTTP layer adds its own status
// alongside this body, so the two together would read "HTTP 403: Forbidden: …".
// Shared from here because the rule is spelled once (see the package doc), so
// its refusal should not be re-worded at each of the three sites that apply it.
//
// The values are quoted rather than wrapped in code formatting: this is
// text/plain and is also read by JS, which folds it into its own error
// message, and %q escapes a hostile hostname for that reader.
func RefusalMessage(host string) string {
	return fmt.Sprintf(
		"Refused the hostname %q. This server only answers to localhost, "+
			"a *.localhost name, or an IP address — any other hostname could "+
			"be pointed at this machine by a site you visit. Open it by IP "+
			"address instead.", host)
}
