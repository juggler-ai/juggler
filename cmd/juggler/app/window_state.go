//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package app

import (
	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server"
)

// Window geometry is per-project session state (stored in the project's
// .juggler/session.json via SessionManager), NOT a single machine-wide file.
// Keying it by project gives every project's windows their own slots with no
// cross-process write race, and reopening a project restores its window where
// you left it. Within a project it is keyed by window role; this app has only
// the main window, so that is the only slot it reads or writes.
//
// loadWindowState reads the saved geometry for the currently-open project, or
// the zero value (→ default centred window) when this project has never saved
// one (e.g. its first launch, or an ephemeral no-project session).
func loadWindowState(srv *server.Server) core.WindowState {
	sm := srv.SessionManager()
	if sm == nil {
		return core.WindowState{}
	}
	ws, _ := sm.GetWindowState(core.WindowRoleMain)
	return ws
}

// saveWindowState persists geometry to the currently-open project's session.
// SwitchProject swaps the SessionManager, so a window that has changed project
// naturally saves to (and on next launch restores from) the project it is now
// showing.
func saveWindowState(srv *server.Server, s core.WindowState) error {
	sm := srv.SessionManager()
	if sm == nil {
		return nil
	}
	return sm.SetWindowState(core.WindowRoleMain, s)
}

// Off-screen recovery (e.g. saved on a now-disconnected monitor) is handled
// by AppKit's constrainFrameRect — macOS pulls a window placed outside any
// visible screen back to a usable one on the next display cycle. No extra
// Go-side clamp needed.
