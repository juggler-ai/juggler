//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"

	"juggler/cmd/juggler/server"
	"juggler/internal/ingress"
)

// spawnerEnv is what a session child's spawner hands it in its environment
// (internal/ingress): the ingress secret, the API token it minted, and — for a
// machine server's child — that server's address, control token and the
// session's id there.
type spawnerEnv struct {
	// ingressSecret is handed to the server as Config.IngressSecret.
	ingressSecret string
	// apiToken is handed to the server as Config.APIToken; empty, the server
	// mints its own.
	apiToken string
	// supervisor is handed to the server as Config.Supervisor; zero for a
	// child with no machine server.
	supervisor server.Supervisor
}

// takeSpawnerEnv takes every spawner variable out of this process's
// environment, so nothing the process goes on to spawn — a tool's shell, a
// login-shell probe — inherits them. Every launch calls it, before it spawns
// anything; keep decides what the launch holds on to.
func takeSpawnerEnv() spawnerEnv {
	e := spawnerEnv{ingressSecret: ingress.TakeSecret(), apiToken: ingress.TakeToken()}
	if addr, token, session := ingress.TakeSupervisor(); addr != "" && token != "" {
		e.supervisor = server.Supervisor{Addr: addr, Token: token, Session: session}
	}
	return e
}

// keep returns what a launch holds on to: all of e for a session child, which
// is refused without a token since nothing could call its API, and nothing for
// any other launch.
func (e spawnerEnv) keep(sessionChild bool) (spawnerEnv, error) {
	if !sessionChild {
		return spawnerEnv{}, nil
	}
	if e.apiToken == "" {
		return spawnerEnv{}, fmt.Errorf("a session child serves the API token minted by whatever spawns it, and none was given (%s)", ingress.TokenEnv)
	}
	return e, nil
}

// environ returns e as NAME=value entries: the environment a re-exec of this
// same launch is handed, since the process's own no longer holds them.
func (e spawnerEnv) environ() []string {
	var env []string
	if e.ingressSecret != "" {
		env = append(env, ingress.SecretEnv+"="+e.ingressSecret)
	}
	if e.apiToken != "" {
		env = append(env, ingress.TokenEnv+"="+e.apiToken)
	}
	if s := e.supervisor; s.Addr != "" {
		env = append(env,
			ingress.SupervisorAddrEnv+"="+s.Addr,
			ingress.SupervisorTokenEnv+"="+s.Token,
			ingress.SupervisorSessionEnv+"="+s.Session)
	}
	return env
}
