//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package apipaths names the HTTP endpoints that are spoken across a process
// boundary, so that each one is spelled in exactly one place.
//
// Most API paths belong to a single process: the server registers the route and
// the viewer's JavaScript calls it, and a rename is caught the moment the app is
// exercised. The handful here are different. Each is registered by the server
// (cmd/juggler/server/routes.go) and called by a SECOND Go process — the
// desktop app opening a window, the machine server supervising its child, or
// `juggler run` — and some are named a third time in apiAuthExempt
// (cmd/juggler/server/api_auth.go), which lets the desktop app's calls through
// because it holds no per-instance API token.
//
// Namings that must agree, in several binaries, with the compiler blind to
// all of it: a rename that reached the route but missed the gate would leave a
// route silently locked (or, worse in the other direction, silently open), and
// the failure would show up as a window that will not remember its size rather
// than as anything a build or a test could see. Naming them once removes the
// possibility rather than documenting it.
package apipaths

// Prefix is the root every API route hangs off. The server mounts its routes on
// a subrouter for it, so a registration there names the path with Prefix
// removed (see the apiRoute helper in cmd/juggler/server/routes.go).
const Prefix = "/api"

const (
	// Health answers "is a Juggler server listening here at all". Probed by the
	// browser-suite harness (cmd/juggler-test) while waiting for the --test
	// server it spawned to accept; a --test server checks no token.
	Health = Prefix + "/health"

	// HealthActive reports whether any conversation is running a turn: a
	// read, asking no worker anything. Polled, with the child's API token, by
	// the machine server supervising it (machineserver/activity.go); the
	// viewer reads it too, with its page's.
	HealthActive = Prefix + "/health/active"

	// HealthRetire conditionally quiesces an idle child and closes work admission.
	// The supervising process calls it with the child's API token.
	HealthRetire = Prefix + "/health/retire"

	// HealthInstance identifies the server answering: its project path, pid,
	// start time and relaunch generation. Gated by the API token like any route
	// that says what the project is; the integration suites read it to prove
	// which child the machine server's proxy reached.
	HealthInstance = Prefix + "/health/instance"

	// OneShot runs one prompt unattended in a new conversation and answers
	// with how it went, holding the request open until then. `juggler run`
	// calls it on the session child it spawned, with the token it minted for
	// that child.
	OneShot = Prefix + "/one-shot"

	// SessionWindowState is one window role's saved frame, stored with the
	// project's session. Read and written by the desktop app around the viewer
	// page's lifetime — before it has loaded, and as it closes.
	SessionWindowState = Prefix + "/session/window-state"

	// SessionPinboardBoards creates and deletes the board a detached window
	// holds. The desktop app DELETEs one as that window closes, having no page
	// and so no token; that method on this path is the only write the token gate
	// lets through unauthenticated.
	SessionPinboardBoards = Prefix + "/session/pinboard/boards"

	// WebSocket is the viewer's live connection. The upgrade authenticates
	// itself — the token rides as a ?token= query param, since a WebSocket
	// handshake cannot carry a custom header — so the middleware steps aside
	// for it (see websocket_loop.go).
	WebSocket = Prefix + "/ws"
)
