//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
)

// GitHub Copilot device-flow sign-in endpoints. The frontend (providers tab)
// calls start once, shows the user code, then polls until authorized; a
// successful authorization or a sign-out triggers a provider refresh so the
// Copilot row flips state without a manual reload.

// handleCopilotDeviceStart begins the OAuth device flow and returns the user
// code + verification URL for the UI to display.
func (s *Server) handleCopilotDeviceStart(w http.ResponseWriter, r *http.Request) {
	code, err := core.StartCopilotDeviceLogin(r.Context())
	if err != nil {
		handlers.WriteJSON(w, r, http.StatusBadGateway, map[string]any{
			"success": false,
			"error":   err.Error(),
		})
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{
		"success":         true,
		"deviceCode":      code.DeviceCode,
		"userCode":        code.UserCode,
		"verificationUri": code.VerificationURI,
		"expiresIn":       code.ExpiresIn,
		"interval":        code.Interval,
	})
}

// handleCopilotDevicePoll performs one poll for the pending device code. On
// authorization it refreshes the provider list before responding.
func (s *Server) handleCopilotDevicePoll(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceCode string `json:"deviceCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "Invalid request body",
		})
		return
	}
	status, err := core.PollCopilotDeviceLogin(r.Context(), req.DeviceCode)
	if err != nil {
		handlers.WriteJSON(w, r, http.StatusBadGateway, map[string]any{
			"success": false,
			"error":   err.Error(),
		})
		return
	}
	if status == core.CopilotLoginAuthorized {
		s.RefreshProviders()
	}
	handlers.WriteJSON(w, r, 0, map[string]any{
		"success": true,
		"status":  string(status),
	})
}

// handleCopilotSignOut clears a Juggler device-flow login and refreshes the
// provider list. It does not disturb an editor-managed login on disk.
func (s *Server) handleCopilotSignOut(w http.ResponseWriter, r *http.Request) {
	if err := core.SignOutCopilot(); err != nil {
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   err.Error(),
		})
		return
	}
	s.RefreshProviders()
	handlers.WriteJSON(w, r, 0, map[string]any{"success": true})
}
