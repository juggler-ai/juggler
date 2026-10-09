//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package handlers is the HTTP surface of the server: each handler decodes a
// request, asks the package that owns the answer, and encodes the reply.
//
// A handler lives here when it can be a method on a struct that server.New
// builds once and hands what it needs: a project-path func, a core store or the
// SessionManager, a WorkspaceLookup, and for anything the server owns a narrow
// callback or interface (SessionAPI's WorkerManager and Broadcaster, ConfigAPI's
// onCredsChanged). A handler lives in package server, as a method on *Server,
// when it reads the server's own running state: the provider cache, the
// in-memory settings and update checker, the WS hub, the engine client, the
// tunnel and LAN, shutdown, or the page and static-asset serving. Imports do not
// decide it: the only package out of reach from here is server itself. A
// handler that needs nothing injected at all is a plain function (stateless.go).
// TestServerHandlersReadServerState, in package server, enforces this from the
// other side.
//
// What Juggler keeps on disk is not decided here. Where each file lives (under
// a project's .juggler/, the user config directory or the cache), its format,
// and how it is written are core's: conversation folders (convdir.go), user
// commands (user_commands.go), skills and the marketplace's files (skills.go,
// skill_store.go), settings and credentials. A handler names no storage path
// and writes no file. It is handed a store's answer and turns a store's error
// into a status code.
//
// Reading the user's own project tree is different, and stays here: the file
// viewer, the git views, path completion and the project picker read the path
// the request is about. That path is the request's subject, not Juggler's
// storage. The one write of that kind is New Project's folder, which is the
// folder the user asked for. TestHandlersHoldNoStorage enforces all of this.
package handlers
