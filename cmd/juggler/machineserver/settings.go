//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/webui"
	"juggler/internal/jlog"
)

// The settings the sessions page's Settings shows with no project open
// (web/js/components/settings-panel.js, server scope): the parts of the
// settings document that belong to this machine rather than to a project or a
// session — the UI language, the update mode, the proxy, where new projects
// keep their state and how long their transaction records are kept, and the
// machine's UI preferences. Every project's server
// watches the file and adopts what is saved here (server/settings_watcher.go).
//
// A session's own PUT /api/settings also writes models, web search and the
// allowed hosts. Those are refused here: they are judged against what only a
// session has (the providers this build registers, which its Settings tabs
// show), and the sessions page offers none of them. Only a caller on this
// machine may read or save any of it (localOnly): a viewer elsewhere has the
// page, but the document is this computer's.

// serverSettingsPatch is the body PUT /api/server/settings takes: any of the
// sections it owns, each optional. A key outside them is refused (decoded with
// DisallowUnknownFields), so a client cannot write a section through this route
// that it does not judge.
type serverSettingsPatch struct {
	UILocale *string `json:"uiLocale"`
	Updates  *struct {
		Mode *string `json:"mode"`
	} `json:"updates"`
	Network *struct {
		Proxy *core.ProxySettings `json:"proxy"`
	} `json:"network"`
	Projects *struct {
		StateOutside          *bool `json:"stateOutside"`
		TransactionMaxAgeDays *int  `json:"transactionMaxAgeDays"`
	} `json:"projects"`
	UI map[string]json.RawMessage `json:"ui"`
}

// handleGetSettings serves the settings document as stored, normalised as a
// session's GET /api/settings serves it. GET /api/server/settings; this
// machine only (localOnly).
func (s *Server) handleGetSettings(w http.ResponseWriter, _ *http.Request) {
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		jlog.Error("[machineserver] reading settings: %v", err)
	}
	writeJSON(w, http.StatusOK, gs)
}

// handlePutSettings saves the sections it is sent (serverSettingsPatch) onto
// the document as it stands on disk, judged as a session's PUT /api/settings
// judges them, and answers with the whole document as stored. The ui section
// is a patch: a key sent null is deleted. PUT /api/server/settings; this
// machine only (localOnly).
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<16))
	if err != nil {
		writeMessageError(w, http.StatusBadRequest, msg.New("invalid JSON body"))
		return
	}
	var patch serverSettingsPatch
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&patch); err != nil {
		writeMessageError(w, http.StatusBadRequest, msg.New("only the UI language, update mode, proxy, project state placement and UI preferences can be saved here"))
		return
	}
	if l := patch.UILocale; l != nil && *l != "" && !core.IsValidUILocale(*l) {
		writeMessageError(w, http.StatusBadRequest, msg.New("invalid UI language"))
		return
	}
	var mode *string
	if patch.Updates != nil {
		mode = patch.Updates.Mode
	}
	if mode != nil && *mode != "" && !core.IsKnownUpdateMode(*mode) {
		writeMessageError(w, http.StatusBadRequest, msg.New("invalid update mode"))
		return
	}
	var proxy *core.ProxySettings
	if patch.Network != nil {
		proxy = patch.Network.Proxy
	}
	if proxy != nil {
		if proxy.Mode != "" && !core.IsKnownProxyMode(proxy.Mode) {
			writeMessageError(w, http.StatusBadRequest, msg.New("invalid proxy mode"))
			return
		}
		if proxy.Mode == core.ProxyModeManual && !core.ValidProxyURL(proxy.URL) {
			writeMessageError(w, http.StatusBadRequest, msg.New("invalid proxy URL"))
			return
		}
	}
	var stateOutside *bool
	var txnMaxAge *int
	if patch.Projects != nil {
		stateOutside = patch.Projects.StateOutside
		txnMaxAge = patch.Projects.TransactionMaxAgeDays
	}
	if txnMaxAge != nil && !core.IsValidTransactionMaxAgeDays(*txnMaxAge) {
		writeMessageError(w, http.StatusBadRequest, msg.New("invalid transaction record age: {days}", "days", *txnMaxAge))
		return
	}

	var mergeErr error
	gs, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		if patch.UI != nil {
			ui, err := core.MergeUIPrefs(gs.UI, patch.UI)
			if err != nil {
				mergeErr = err
				return false
			}
			gs.UI = ui
		}
		if patch.UILocale != nil {
			gs.UILocale = *patch.UILocale
		}
		if mode != nil {
			gs.Updates.Mode = *mode
		}
		if proxy != nil {
			gs.Network.Proxy = *proxy
		}
		if stateOutside != nil {
			gs.Projects.StateOutside = *stateOutside
		}
		if txnMaxAge != nil {
			gs.Projects.TransactionMaxAgeDays = *txnMaxAge
		}
		return true
	})
	if mergeErr != nil {
		writeError(w, http.StatusBadRequest, mergeErr)
		return
	}
	if err != nil {
		if errors.Is(err, core.ErrUIPrefsRejected) {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		jlog.Error("[machineserver] saving settings: %v", err)
		writeMessageError(w, http.StatusInternalServerError, msg.New("Couldn't save settings"))
		return
	}
	writeJSON(w, http.StatusOK, gs)
}

// handleLocales serves the UI languages the asset tree has a catalogue for, as
// a session's GET /api/i18n/locales does: {"locales": [...]}, never null. GET
// /api/server/i18n/locales.
func (s *Server) handleLocales(w http.ResponseWriter, _ *http.Request) {
	locales := []string{}
	if s.assets != nil {
		if found := webui.AvailableLocales(s.assets); found != nil {
			locales = found
		}
	}
	writeJSON(w, http.StatusOK, struct {
		Locales []string `json:"locales"`
	}{locales})
}
