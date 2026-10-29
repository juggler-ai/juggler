//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package portbind

import (
	"context"
	"net"
	"time"
)

// KeepAlive is how a listener that serves viewers probes its idle
// connections: idle 30s, then 9 probes 10s apart, so a connection whose peer
// vanished is declared dead about two minutes later, for two packets a minute
// on a live idle one.
//
// The period is explicit so a peer whose host simply vanished — a suspended
// laptop, a dropped tunnel, a killed VM — is reaped by the kernel instead of
// lingering as a half-open connection holding an fd and a registered viewer.
// Nothing above the transport can notice such a peer on its own: it never
// sends, so no read fails, and a write to it only fails if there is something
// to send. Probes are the only thing that detects a silent idle client that is
// already gone.
//
// The machine server listens with it: it is the one server a remote viewer's
// host connects to, so its listener is where a vanished host is found. A
// session child needs none of it — it binds loopback, and a loopback peer
// cannot go half-open without its process dying, which closes its sockets.
var KeepAlive = net.KeepAliveConfig{
	Enable:   true,
	Idle:     30 * time.Second,
	Interval: 10 * time.Second,
	Count:    9,
}

// Listen listens on addr over TCP with KeepAlive.
func Listen(addr string) (net.Listener, error) {
	lc := net.ListenConfig{KeepAliveConfig: KeepAlive}
	return lc.Listen(context.Background(), "tcp", addr)
}
