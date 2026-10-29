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

// TestLaunchSettingsAreThisMachines: the sessions page reads and saves what
// opens whenever Juggler starts — LAN access, and one tunnel mode — through
// the machine server, into the settings every session shares, beside what
// else is saved there. A caller off this machine neither reads nor changes
// them; a mode this build lacks is refused.
func TestLaunchSettingsAreThisMachines(t *testing.T) {
	userpathstest.Isolate(t)
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Connectivity.AllowedHosts = []string{"box.example"}
		gs.UILocale = "fr"
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

	type launch struct {
		LANOnLaunch bool   `json:"lanOnLaunch"`
		WANOnLaunch string `json:"wanOnLaunch"`
	}
	read := func(front string) launch {
		t.Helper()
		var got launch
		code, body := lanCall(t, "GET", front+"/api/server/launch", "")
		if err := json.Unmarshal([]byte(body), &got); code != http.StatusOK || err != nil {
			t.Fatalf("GET launch via %s: %d %s", front, code, body)
		}
		return got
	}
	if got := read(local.URL); got != (launch{}) {
		t.Fatalf("launch settings at the start: %+v, want none", got)
	}

	var got launch
	code, body := lanCall(t, "PUT", local.URL+"/api/server/launch", `{"lanOnLaunch":true}`)
	if err := json.Unmarshal([]byte(body), &got); code != http.StatusOK || err != nil || got != (launch{LANOnLaunch: true}) {
		t.Fatalf("PUT lanOnLaunch from this machine: %d %s", code, body)
	}
	code, body = lanCall(t, "PUT", local.URL+"/api/server/launch", `{"wanOnLaunch":"fwd-test"}`)
	if err := json.Unmarshal([]byte(body), &got); code != http.StatusOK || err != nil || got != (launch{LANOnLaunch: true, WANOnLaunch: "fwd-test"}) {
		t.Fatalf("PUT wanOnLaunch from this machine: %d %s; want it beside lanOnLaunch", code, body)
	}
	gs, err := core.LoadGlobalSettings()
	if err != nil || !gs.Connectivity.LANOnLaunch || gs.Connectivity.WANOnLaunch != "fwd-test" ||
		len(gs.Connectivity.AllowedHosts) != 1 || gs.UILocale != "fr" {
		t.Fatalf("settings after the saves: %+v (%v); want both saved, the rest kept", gs, err)
	}
	if code, body := lanCall(t, "GET", remote.URL+"/api/server/launch", ""); code != http.StatusForbidden {
		t.Errorf("GET launch from the LAN: %d %s; want 403", code, body)
	}

	for _, put := range []string{`{"lanOnLaunch":false}`, `{"wanOnLaunch":""}`} {
		if code, _ := lanCall(t, "PUT", remote.URL+"/api/server/launch", put); code != http.StatusForbidden {
			t.Errorf("PUT %s from the LAN: status %d, want 403", put, code)
		}
	}
	for _, c := range []struct {
		body string
		want int
	}{
		{`{"wanOnLaunch":"nope"}`, http.StatusBadRequest},
		{`{"lanOnLaunch":"yes"}`, http.StatusBadRequest},
		{`{}`, http.StatusBadRequest},
	} {
		if code, body := lanCall(t, "PUT", local.URL+"/api/server/launch", c.body); code != c.want {
			t.Errorf("PUT %s: %d %s, want %d", c.body, code, body, c.want)
		}
	}
	if got := read(local.URL); got != (launch{LANOnLaunch: true, WANOnLaunch: "fwd-test"}) {
		t.Errorf("after refused changes: %+v; want them unchanged", got)
	}

	code, body = lanCall(t, "PUT", local.URL+"/api/server/launch", `{"lanOnLaunch":false,"wanOnLaunch":""}`)
	if err := json.Unmarshal([]byte(body), &got); code != http.StatusOK || err != nil || got != (launch{}) {
		t.Errorf("PUT both off from this machine: %d %s", code, body)
	}
}
