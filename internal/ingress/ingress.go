//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package ingress names the caller-identity handshake between a machine server
// (`juggler serve`) and the session children it proxies to.
//
// Every proxied request reaches a child from its supervisor over loopback, so
// by address alone the child would take every caller for a local one. The
// supervisor therefore spawns each child with a fresh secret in SecretEnv and,
// on a request whose caller it did not see on loopback, sends Header carrying
// that secret. The child tags such a request as remote ingress
// (server.MarkRemoteIngress) and ignores the header in every other form.
//
// The process that spawns a session child also mints the child's API token and
// hands it over in TokenEnv, so that the spawner can call the child's API
// without reading the token back from the page the child serves.
//
// Both halves live in one binary, but they meet only across a process
// boundary, so the names are spelled here once.
package ingress

import (
	"crypto/rand"
	"encoding/hex"
	"os"
)

// Header carries the child's secret on a request its supervisor forwards from
// a caller off loopback.
const Header = "X-Juggler-Ingress"

// KindHeader names, alongside Header, the transport a remote caller reached
// the supervisor by: KindLAN, KindProxy, or a tunnel's mode. The child
// believes it only with the secret.
const KindHeader = "X-Juggler-Ingress-Kind"

// AddrHeader carries, alongside Header, the remote caller's address as the
// supervisor saw it ("ip:port"). The child believes it only with the secret.
const AddrHeader = "X-Juggler-Ingress-Addr"

// UserHeader carries, alongside Header, who the remote caller is as the
// transport it arrived by names it: tunnel.CallerIdentity in JSON. Absent for
// a caller no transport names. The child believes it only with the secret, and
// shows it; it grants nothing.
const UserHeader = "X-Juggler-Ingress-User"

// KindLAN is the KindHeader value for a caller that reached the supervisor
// directly over the network, on its own listening socket.
const KindLAN = "lan"

// KindProxy is the KindHeader value for a caller that reached the supervisor
// over loopback through a reverse proxy the user configured — a request on a
// loopback connection naming one of the server's allowed hosts. Its socket is
// local but its caller is not.
const KindProxy = "proxy"

// SecretEnv is the environment variable a session child finds its secret in.
const SecretEnv = "JUGGLER_INGRESS_SECRET"

// NewSecret returns a fresh random secret for one child.
func NewSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// A guessable secret would let anything on loopback pass for the
		// supervisor, so refuse to spawn rather than hand one out.
		panic("ingress.NewSecret: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// TokenEnv is the environment variable a session child finds its API token in.
const TokenEnv = "JUGGLER_SESSION_TOKEN"

// SupervisorAddrEnv and SupervisorTokenEnv are where a session child a machine
// server spawned finds that server's loopback address and control-API token.
// LAN access and tunnels are the machine server's, and a session's viewer
// switches them from the session, through its child. SupervisorSessionEnv is
// the session's id there, by which the child asks for the links that open it
// (its /s/<id>/). A child with no machine server (`juggler run`'s, the test
// harness) finds none of them.
const (
	SupervisorAddrEnv    = "JUGGLER_SUPERVISOR_ADDR"
	SupervisorTokenEnv   = "JUGGLER_SUPERVISOR_TOKEN"
	SupervisorSessionEnv = "JUGGLER_SUPERVISOR_SESSION"
)

// TakeSupervisor returns the machine server's address and control token, and
// this child's session id there, from SupervisorAddrEnv, SupervisorTokenEnv
// and SupervisorSessionEnv, and removes them from this process's environment,
// for the same reason as TakeSecret.
func TakeSupervisor() (addr, token, session string) {
	return take(SupervisorAddrEnv), take(SupervisorTokenEnv), take(SupervisorSessionEnv)
}

// TakeSecret returns the secret in SecretEnv and removes it from this process's
// environment, so nothing the process goes on to spawn — a tool's shell
// included — inherits it.
func TakeSecret() string { return take(SecretEnv) }

// TakeToken returns the API token in TokenEnv and removes it from this
// process's environment, for the same reason as TakeSecret.
func TakeToken() string { return take(TokenEnv) }

func take(name string) string {
	v := os.Getenv(name)
	_ = os.Unsetenv(name)
	return v
}
