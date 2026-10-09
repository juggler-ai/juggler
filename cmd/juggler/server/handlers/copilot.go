//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"

	"juggler/cmd/juggler/core"
)

// GitHub Copilot device-flow sign-in endpoints. The frontend (providers tab)
// calls start once, shows the user code, then polls until authorized; a
// successful authorization, a sign-out or a host change fires onCredsChanged so
// the Copilot row flips state without a manual reload.

// HandleCopilotDeviceStart begins the OAuth device flow (against the requested
// GitHub host, defaulting to github.com) and returns the user code + verification
// URL for the UI to display. The resolved host is echoed back so the client sends
// the same one when polling.
func (c *ConfigAPI) HandleCopilotDeviceStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host string `json:"host"`
	}
	// Body is optional: no host means github.com.
	_ = json.NewDecoder(r.Body).Decode(&req)
	code, err := core.StartCopilotDeviceLogin(r.Context(), req.Host)
	if err != nil {
		WriteError(w, r, http.StatusBadGateway, err.Error())
		return
	}
	WriteSuccess(w, r, map[string]any{
		"host":            req.Host,
		"deviceCode":      code.DeviceCode,
		"userCode":        code.UserCode,
		"verificationUri": code.VerificationURI,
		"expiresIn":       code.ExpiresIn,
		"interval":        code.Interval,
	})
}

// HandleCopilotDevicePoll performs one poll for the pending device code. On
// authorization it refreshes the provider list before responding.
func (c *ConfigAPI) HandleCopilotDevicePoll(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		DeviceCode string `json:"deviceCode"`
		Host       string `json:"host"`
	}](w, r)
	if !ok {
		return
	}
	status, err := core.PollCopilotDeviceLogin(r.Context(), req.Host, req.DeviceCode)
	if err != nil {
		WriteError(w, r, http.StatusBadGateway, err.Error())
		return
	}
	if status == core.CopilotLoginAuthorized {
		c.fireCredsChanged()
	}
	WriteSuccess(w, r, map[string]any{
		"status": string(status),
	})
}

// HandleCopilotSignOut clears a Juggler device-flow login and refreshes the
// provider list. It does not disturb an editor-managed login on disk.
func (c *ConfigAPI) HandleCopilotSignOut(w http.ResponseWriter, r *http.Request) {
	if err := core.SignOutCopilot(); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	c.fireCredsChanged()
	WriteSuccess(w, r, nil)
}

// HandleCopilotGetHost returns the GitHub host Copilot logins target (github.com
// or the saved *.ghe.com Enterprise Cloud tenant), so the UI can prefill it.
func (c *ConfigAPI) HandleCopilotGetHost(w http.ResponseWriter, r *http.Request) {
	WriteSuccess(w, r, map[string]any{
		"host": core.CopilotHost(),
	})
}

// HandleCopilotSetHost saves the preferred GitHub host (a *.ghe.com tenant, or
// github.com to reset to the public default) and refreshes the provider list so
// the Copilot row re-evaluates against the new host.
func (c *ConfigAPI) HandleCopilotSetHost(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Host string `json:"host"`
	}](w, r)
	if !ok {
		return
	}
	if err := core.SetCopilotHost(req.Host); err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	c.fireCredsChanged()
	WriteSuccess(w, r, map[string]any{
		"host": core.CopilotHost(),
	})
}
