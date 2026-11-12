//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/internal/lanfind"
)

// HandleVersion serves GET /api/version: the server's version, and the name of
// the machine it runs on (lanfind.MachineName), which a window on it from
// another computer shows it by.
func HandleVersion(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, map[string]any{"version": core.Version, "name": lanfind.MachineName()})
}
