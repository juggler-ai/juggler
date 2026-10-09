//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"

	"juggler/cmd/juggler/core"
)

// HandleListUserHooks serves GET /api/user-hooks: every hook file in
// ~/.juggler/hooks, malformed ones included with Error set. Read-only — hook
// files are written by hand (or by the agent's ordinary file tools), and the
// plugin watcher reloads the registries when one changes. The format and the
// reasons there is no project scope are core/user_hooks.go's.
func HandleListUserHooks(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, core.ListUserHooks(core.UserHookDir()))
}
