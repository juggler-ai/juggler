//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"net/http"
	"strconv"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/tunnel"
	"juggler/internal/jlog"
)

// What opens whenever Juggler starts: the saved connectivity.lanOnLaunch and
// connectivity.wanOnLaunch, which every start reads (launchExposure). The
// sessions page shows and saves them here, beside its switches for LAN access
// and tunnels, and so does every session's Settings → Connectivity, whose
// /api/connectivity/launch passes the call on. This is their one writer: it
// changes only these keys of the settings document (core.UpdateGlobalSettings),
// and a session's own PUT /api/settings never writes them. Only a caller on
// this machine may read or save them (localOnly), as only one may switch them
// now.

// launchResponse is the GET/PUT /api/server/launch payload.
type launchResponse struct {
	LANOnLaunch bool   `json:"lanOnLaunch"`
	WANOnLaunch string `json:"wanOnLaunch"`
}

func launchOf(gs *core.GlobalSettings) launchResponse {
	return launchResponse{LANOnLaunch: gs.Connectivity.LANOnLaunch, WANOnLaunch: gs.Connectivity.WANOnLaunch}
}

// handleGetLaunch serves what opens whenever Juggler starts.
// GET /api/server/launch; this machine only (localOnly).
func (s *Server) handleGetLaunch(w http.ResponseWriter, _ *http.Request) {
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		jlog.Error("[machineserver] reading settings for what opens at start: %v", err)
	}
	writeJSON(w, http.StatusOK, launchOf(gs))
}

// handleSetLaunch saves the keys it is sent of what opens whenever Juggler
// starts, and answers with both as saved. A tunnel mode must be one this
// build has; "" saves none. PUT /api/server/launch {"lanOnLaunch": bool,
// "wanOnLaunch": "<mode>" | ""}, either or both; this machine only
// (localOnly).
func (s *Server) handleSetLaunch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		LANOnLaunch *bool   `json:"lanOnLaunch"`
		WANOnLaunch *string `json:"wanOnLaunch"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil ||
		(req.LANOnLaunch == nil && req.WANOnLaunch == nil) {
		writeMessageError(w, http.StatusBadRequest, msg.New("say what opens when Juggler starts: lanOnLaunch, true or false, or wanOnLaunch, a tunnel mode or \"\""))
		return
	}
	if m := req.WANOnLaunch; m != nil && *m != "" {
		if _, ok := tunnel.Find(tunnel.Mode(*m)); !ok {
			writeMessageError(w, http.StatusBadRequest, msg.New("unknown tunnel mode {mode}", "mode", strconv.Quote(*m)))
			return
		}
	}
	gs, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		if req.LANOnLaunch != nil {
			gs.Connectivity.LANOnLaunch = *req.LANOnLaunch
		}
		if req.WANOnLaunch != nil {
			gs.Connectivity.WANOnLaunch = *req.WANOnLaunch
		}
		return true
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, launchOf(gs))
}
