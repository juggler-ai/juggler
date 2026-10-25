//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

// StartupFailurePrefix opens the one line a server prints on stderr when it
// cannot start, followed by the error. It is shared because two binaries depend
// on it: the server writes it (reportStartupFailure, cmd/juggler/app), and the
// desktop app, which spawned that server and sees only its exit, finds the line
// in the server's stderr log to say why the window could not open.
const StartupFailurePrefix = "Couldn't start Juggler: "
