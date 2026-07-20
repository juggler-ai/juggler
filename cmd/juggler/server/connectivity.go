//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"

	"rsc.io/qr"
)

// setupConnectivityRoutes registers the /api/connectivity endpoints.
func (s *Server) setupConnectivityRoutes() {
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/connectivity", s.handleGetConnectivity).Methods("GET")
	api.HandleFunc("/connectivity/lan", s.handleSetLAN).Methods("POST")
	api.HandleFunc("/connectivity/tunnel", s.handleSetTunnel).Methods("POST")
	api.HandleFunc("/connectivity/qr", s.handleQRCode).Methods("GET")
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
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid request"})
		return
	}
	s.SetPublicMode(req.Enabled)
	handlers.WriteJSON(w, r, 0, map[string]any{"ok": true})
}

func (s *Server) handleSetTunnel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool   `json:"enabled"`
		Mode    string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid request"})
		return
	}
	if !req.Enabled {
		s.StopTunnel()
		handlers.WriteJSON(w, r, 0, map[string]any{"ok": true})
		return
	}
	// Validate against the registry: an empty mode selects the first
	// registered one (there is no WAN feature at all when none are).
	mode := TunnelMode(req.Mode)
	if mode == "" {
		modes := TunnelModes()
		if len(modes) == 0 {
			handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "no WAN tunnel modes are available in this build"})
			return
		}
		mode = modes[0].Mode
	} else if _, ok := findTunnelMode(mode); !ok {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": fmt.Sprintf("unknown tunnel mode %q", req.Mode)})
		return
	}
	tunnelURL, err := s.StartTunnelMode(mode)
	if err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	relay := false
	if info, ok := s.GetTunnelInfo(); ok {
		relay = info.Relay
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"ok": true, "tunnelURL": tunnelURL, "tunnelMode": string(mode), "relay": relay})
}

// handleQRCode serves a QR code SVG for the given ?url= query parameter.
// The SVG has a transparent background and uses fill="currentColor" so that
// inline-embedded markup inherits the surrounding text colour.
func (s *Server) handleQRCode(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		http.Error(w, "url param required", http.StatusBadRequest)
		return
	}
	code, err := qr.Encode(rawURL, qr.M)
	if err != nil {
		http.Error(w, "failed to encode QR", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	if _, err := w.Write([]byte(qrToSVG(code))); err != nil {
		jlog.Error("qr: write error: %v", err)
	}
}

// qrToSVG renders a QR code as an SVG with one rect per horizontal run of
// dark modules. fill="currentColor" lets inline-embedded SVG inherit the
// surrounding text colour; no background rect is emitted, so the SVG is
// transparent.
func qrToSVG(code *qr.Code) string {
	n := code.Size
	var b strings.Builder
	fmt.Fprintf(&b,
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges">`,
		n, n)
	b.WriteString(`<g fill="currentColor">`)
	for y := 0; y < n; y++ {
		x := 0
		for x < n {
			if !code.Black(x, y) {
				x++
				continue
			}
			runStart := x
			for x < n && code.Black(x, y) {
				x++
			}
			fmt.Fprintf(&b, `<rect x="%d" y="%d" width="%d" height="1"/>`, runStart, y, x-runStart)
		}
	}
	b.WriteString(`</g></svg>`)
	return b.String()
}
