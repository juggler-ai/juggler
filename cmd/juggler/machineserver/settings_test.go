//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// TestSettingsAreThisMachines: the sessions page's Settings saves the parts of
// the settings document that are this computer's through the machine server,
// onto the document as it stands, and keeps the rest. It refuses a section
// only a session judges, a value a session would refuse, and any caller off
// this machine, reading or writing.
func TestSettingsAreThisMachines(t *testing.T) {
	userpathstest.Isolate(t)
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Connectivity.AllowedHosts = []string{"box.example"}
		gs.Models.Hidden = map[string][]string{"anthropic": {"old-model"}}
		gs.UI = map[string]json.RawMessage{"kept": json.RawMessage(`1`)}
		return true
	}); err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1)}
	local := httptest.NewServer(s.routes())
	defer local.Close()
	s.lan.Store(true)
	remote := httptest.NewServer(asCaller("192.168.1.20:54321", s.routes()))
	defer remote.Close()

	onDisk := func() *core.GlobalSettings {
		t.Helper()
		gs, err := core.LoadGlobalSettings()
		if err != nil {
			t.Fatal(err)
		}
		return gs
	}

	for _, put := range []string{
		`{"uiLocale":"fr"}`,
		`{"updates":{"mode":"notify"}}`,
		`{"network":{"proxy":{"mode":"manual","url":"http://proxy.example:3128"}}}`,
		`{"projects":{"stateOutside":true}}`,
		`{"ui":{"juggler-escape":"stop","kept":null}}`,
	} {
		code, body := lanCall(t, "PUT", local.URL+"/api/server/settings", put)
		var answer core.GlobalSettings
		if code != http.StatusOK || json.Unmarshal([]byte(body), &answer) != nil {
			t.Fatalf("PUT %s from this machine: %d %s", put, code, body)
		}
	}
	gs := onDisk()
	if gs.UILocale != "fr" || gs.Updates.Mode != core.UpdateModeNotify ||
		gs.Network.Proxy.Mode != core.ProxyModeManual || gs.Network.Proxy.URL != "http://proxy.example:3128" ||
		!gs.Projects.StateOutside {
		t.Fatalf("after the saves: %+v; want each saved", gs)
	}
	if _, kept := gs.UI["kept"]; kept || string(gs.UI["juggler-escape"]) != `"stop"` {
		t.Fatalf("ui after its patch: %v; want juggler-escape set and kept deleted", gs.UI)
	}
	if len(gs.Connectivity.AllowedHosts) != 1 || len(gs.Models.Hidden["anthropic"]) != 1 {
		t.Fatalf("sections this route does not own: %+v; want them kept", gs)
	}

	code, body := lanCall(t, "GET", local.URL+"/api/server/settings", "")
	var read core.GlobalSettings
	if code != http.StatusOK || json.Unmarshal([]byte(body), &read) != nil || read.UILocale != "fr" {
		t.Fatalf("GET from this machine: %d %s", code, body)
	}

	for _, c := range []struct {
		body string
		why  string
	}{
		{`{"models":{"hidden":{"anthropic":[]}}}`, "a section only a session judges"},
		{`{"connectivity":{"allowedHosts":[]}}`, "the allowed hosts"},
		{`{"webSearch":{"order":[]}}`, "web search"},
		{`{"updates":{"mode":"garbage"}}`, "an unknown update mode"},
		{`{"network":{"proxy":{"mode":"manual","url":""}}}`, "a manual proxy with no URL"},
		{`{"uiLocale":"not a tag"}`, "a UI language that is no language tag"},
		{`not json`, "a body that is not JSON"},
	} {
		if code, body := lanCall(t, "PUT", local.URL+"/api/server/settings", c.body); code != http.StatusBadRequest {
			t.Errorf("PUT of %s: %d %s; want 400", c.why, code, body)
		}
	}
	if after := onDisk(); after.Updates.Mode != core.UpdateModeNotify || len(after.Models.Hidden["anthropic"]) != 1 ||
		after.Network.Proxy.URL != "http://proxy.example:3128" || after.UILocale != "fr" {
		t.Fatalf("after refused saves: %+v; want nothing changed", after)
	}

	if code, body := lanCall(t, "GET", remote.URL+"/api/server/settings", ""); code != http.StatusForbidden {
		t.Errorf("GET from the LAN: %d %s; want 403", code, body)
	}
	if code, body := lanCall(t, "PUT", remote.URL+"/api/server/settings", `{"uiLocale":"de"}`); code != http.StatusForbidden {
		t.Errorf("PUT from the LAN: %d %s; want 403", code, body)
	}
	if gs := onDisk(); gs.UILocale != "fr" {
		t.Errorf("UI language after a LAN PUT: %q; want fr", gs.UILocale)
	}
}
