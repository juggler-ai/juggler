//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"net"
	"net/http"
	"strconv"

	"juggler/cmd/juggler/server/handlers"
)

// setupConnectivityRoutes registers the /api/connectivity endpoints.
func (s *Server) setupConnectivityRoutes() {
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/connectivity", s.handleGetConnectivity).Methods("GET")
	api.HandleFunc("/connectivity/lan", s.handleSetLAN).Methods("POST")
	api.HandleFunc("/connectivity/tunnel", s.handleSetTunnel).Methods("POST")
	api.HandleFunc("/connectivity/qr", handlers.HandleQRCode).Methods("GET")
}

func (s *Server) handleGetConnectivity(w http.ResponseWriter, r *http.Request) {
	port := s.getPort()
	lanURLs := []string{}
	if s.publicMode.Load() {
		for _, a := range getLANAddresses() {
			lanURLs = append(lanURLs, fmt.Sprintf("http://%s/", net.JoinHostPort(a.ip, strconv.Itoa(port))))
		}
	}
	tunnelMode := ""
	tunnelRelay := false
	if info, ok := s.GetTunnelInfo(); ok {
		tunnelMode = string(info.Mode)
		tunnelRelay = info.Relay
	}
	// The WAN section of the UI is driven entirely by this list: a build with
	// no registered tunnel modes reports an empty list and shows no WAN UI.
	wanModes := []map[string]any{}
	for _, spec := range TunnelModes() {
		wanModes = append(wanModes, map[string]any{
			"mode":            string(spec.Mode),
			"title":           spec.Title,
			"description":     spec.Description,
			"startLabel":      spec.StartLabel,
			"relayNote":       spec.RelayNote,
			"unavailableHint": spec.UnavailableHint,
			"available":       spec.IsAvailable(),
		})
	}
	// One descriptor per connected viewer (this client included). The UI excludes
	// itself by id to show how many OTHER clients share the session.
	clients := s.hub.viewerClients()
	// The persistent WebRTC identity fingerprint (stable across restarts), or ""
	// when the server is using ephemeral per-connection certificates. Exposed so
	// the UI can show a stable device identity and a remote client can pin it.
	peerIdentity, _ := s.PeerIdentityFingerprint()
	handlers.WriteJSON(w, r, 0, map[string]any{
		"lanEnabled":    s.publicMode.Load(),
		"lanURLs":       lanURLs,
		"tunnelEnabled": s.IsTunnelActive(),
		"tunnelURL":     s.GetTunnelURL(),
		"tunnelMode":    tunnelMode,
		"tunnelRelay":   tunnelRelay,
		"wanModes":      wanModes,
		"clientCount":   len(clients),
		"clients":       clients,
		"peerIdentity":  peerIdentity,
	})
}

func (s *Server) handleSetLAN(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		Enabled bool `json:"enabled"`
	}](w, r)
	if !ok {
		return
	}
	s.SetPublicMode(req.Enabled)
	handlers.WriteSuccess(w, r, nil)
}

func (s *Server) handleSetTunnel(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		Enabled bool   `json:"enabled"`
		Mode    string `json:"mode"`
	}](w, r)
	if !ok {
		return
	}
	if !req.Enabled {
		s.StopTunnel()
		handlers.WriteSuccess(w, r, nil)
		return
	}
	// Validate against the registry: an empty mode selects the first
	// registered one (there is no WAN feature at all when none are).
	mode := TunnelMode(req.Mode)
	if mode == "" {
		modes := TunnelModes()
		if len(modes) == 0 {
			handlers.WriteError(w, r, http.StatusBadRequest, "no WAN tunnel modes are available in this build")
			return
		}
		mode = modes[0].Mode
	} else if _, ok := findTunnelMode(mode); !ok {
		handlers.WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("unknown tunnel mode %q", req.Mode))
		return
	}
	tunnelURL, err := s.StartTunnelMode(mode)
	if err != nil {
		handlers.WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	relay := false
	if info, ok := s.GetTunnelInfo(); ok {
		relay = info.Relay
	}
	handlers.WriteSuccess(w, r, map[string]any{"tunnelURL": tunnelURL, "tunnelMode": string(mode), "relay": relay})
}
