//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package handlers is the HTTP surface of the server: each handler decodes a
// request, asks the package that owns the answer, and encodes the reply.
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
