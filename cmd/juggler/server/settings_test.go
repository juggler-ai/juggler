//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/updatecheck"
	"juggler/internal/userpaths/userpathstest"
)

// manifestTestServer returns an httptest server serving a manifest advertising
// latest, plus a channel that receives once per request hit.
func manifestTestServer(t *testing.T, latest string) (*httptest.Server, chan struct{}) {
	t.Helper()
	hits := make(chan struct{}, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits <- struct{}{}
		_, _ = w.Write([]byte(`{"schema":"juggler-version","schemaVersion":1,"latest":"` + latest +
			`","notice":{"id":"n1","severity":"info"}}`))
	}))
	t.Cleanup(srv.Close)
	return srv, hits
}

func TestHandleGetSettingsDefault(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	rec := httptest.NewRecorder()
	s.handleGetSettings(rec, httptest.NewRequest("GET", "/api/settings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d", rec.Code)
	}
	var gs core.GlobalSettings
	if err := json.Unmarshal(rec.Body.Bytes(), &gs); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if gs.Updates.Mode != core.UpdateModeAutomatic {
		t.Fatalf("default mode = %q, want %q", gs.Updates.Mode, core.UpdateModeAutomatic)
	}
}

func TestHandlePutSettingsValid(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(`{"updates":{"mode":"notify"}}`))
	s.handlePutSettings(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body.String())
	}
	if got := s.updateMode(); got != core.UpdateModeNotify {
		t.Fatalf("mode after PUT = %q, want %q", got, core.UpdateModeNotify)
	}
	// Persisted: a fresh store reads it back.
	if gs, _ := core.LoadGlobalSettings(); gs.Updates.Mode != core.UpdateModeNotify {
		t.Fatalf("persisted mode = %q, want %q", gs.Updates.Mode, core.UpdateModeNotify)
	}
}

func TestHandlePutSettingsInvalidMode(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(`{"updates":{"mode":"garbage"}}`))
	s.handlePutSettings(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode status = %d, want 400", rec.Code)
	}
	if got := s.updateMode(); got != core.UpdateModeAutomatic {
		t.Fatalf("mode after rejected PUT = %q, want unchanged automatic", got)
	}
}

func TestHandlePutSettingsOffToOnKicksCheck(t *testing.T) {
	userpathstest.Isolate(t)
	srv, hits := manifestTestServer(t, "v9.9.9")
	s := &Server{settings: newSettingsStore()}
	s.updateChecker = updatecheck.New(updatecheck.Config{
		URL:            srv.URL,
		CurrentVersion: "v0.0.1",
		Enabled:        func() bool { return s.updateMode() != core.UpdateModeOff },
	})

	// Start from off, then flip to automatic — that must kick an immediate check.
	if err := s.settings.set(core.GlobalSettings{Updates: core.UpdateSettings{Mode: core.UpdateModeOff}}, nil); err != nil {
		t.Fatalf("seed off: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(`{"updates":{"mode":"automatic"}}`))
	s.handlePutSettings(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d", rec.Code)
	}
	select {
	case <-hits:
	case <-time.After(3 * time.Second):
		t.Fatal("off→on did not kick an update check")
	}
}

// putSettings issues a PUT /api/settings with body and asserts the status code.
func putSettings(t *testing.T, s *Server, body string, wantCode int) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handlePutSettings(rec, httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body)))
	if rec.Code != wantCode {
		t.Fatalf("PUT %s: status = %d, want %d (body %s)", body, rec.Code, wantCode, rec.Body.String())
	}
}

func TestHandlePutSettingsMergesConnectivityAndUpdates(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	// A partial PUT must merge, not replace: setting one section leaves the other
	// untouched. Set updates, then connectivity, and confirm both persist.
	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)
	putSettings(t, s, `{"connectivity":{"allowedHosts":["box.tailnet.ts.net"]}}`, http.StatusOK)

	gs := s.settings.get()
	if gs.Updates.Mode != core.UpdateModeNotify {
		t.Fatalf("updates clobbered by connectivity PUT: mode=%q", gs.Updates.Mode)
	}
	if len(gs.Connectivity.AllowedHosts) != 1 {
		t.Fatalf("connectivity not saved: %+v", gs.Connectivity)
	}

	// A later updates-only PUT must not wipe the connectivity section.
	putSettings(t, s, `{"updates":{"mode":"off"}}`, http.StatusOK)
	if gs := s.settings.get(); len(gs.Connectivity.AllowedHosts) != 1 {
		t.Fatalf("connectivity clobbered by later updates PUT: %+v", gs.Connectivity)
	}
}

// The preferences that follow the person rather than the project or the window
// — tips they have seen, what Escape does, whether the bell rings — ride the
// settings document as one opaque map. Nothing in Go reads them; these pin the
// merge semantics the viewer depends on and the bounds that keep the file from
// growing without limit.

// wantUserPref asserts one key of the stored ui section. Compared compacted,
// since the settings file is written indented and a stored value has been
// through it: the value round-trips, the exact bytes do not.
func wantUserPref(t *testing.T, s *Server, key, want string) {
	t.Helper()
	got, ok := s.settings.get().UI[key]
	if !ok {
		t.Fatalf("no stored value for %q", key)
	}
	var gotBuf, wantBuf bytes.Buffer
	if err := json.Compact(&gotBuf, got); err != nil {
		t.Fatalf("compact %s: %v", got, err)
	}
	if err := json.Compact(&wantBuf, []byte(want)); err != nil {
		t.Fatalf("compact %s: %v", want, err)
	}
	if gotBuf.String() != wantBuf.String() {
		t.Fatalf("%q: got %s want %s", key, got, want)
	}
}

func TestHandlePutSettingsUIPrefsMergeAndDelete(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	putSettings(t, s, `{"ui":{"juggler-tips":{"seen":["a"]},"juggler-tool-grouping":true}}`, http.StatusOK)
	// A second PUT naming one key leaves the other alone: the viewer sends the
	// preference it just changed, not the whole document.
	putSettings(t, s, `{"ui":{"juggler-tool-grouping":false}}`, http.StatusOK)
	wantUserPref(t, s, "juggler-tips", `{"seen":["a"]}`)
	wantUserPref(t, s, "juggler-tool-grouping", `false`)

	// Null is how a viewer drops one it no longer has.
	putSettings(t, s, `{"ui":{"juggler-tips":null}}`, http.StatusOK)
	if _, ok := s.settings.get().UI["juggler-tips"]; ok {
		t.Fatal("null must delete the key")
	}
	wantUserPref(t, s, "juggler-tool-grouping", `false`)
}

func TestHandlePutSettingsUIPrefsPreserveOtherSections(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)
	putSettings(t, s, `{"ui":{"juggler-tool-grouping":true}}`, http.StatusOK)
	if mode := s.settings.get().Updates.Mode; mode != core.UpdateModeNotify {
		t.Fatalf("updates clobbered by a ui PUT: mode=%q", mode)
	}

	putSettings(t, s, `{"updates":{"mode":"off"}}`, http.StatusOK)
	wantUserPref(t, s, "juggler-tool-grouping", `true`)
}

func TestHandlePutSettingsUIPrefsOverTheBoundsRejected(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	putSettings(t, s, `{"ui":{"kept":1}}`, http.StatusOK)
	putSettings(t, s, `{"ui":{"big":"`+strings.Repeat("x", 9<<10)+`"}}`, http.StatusBadRequest)

	ui := s.settings.get().UI
	if len(ui) != 1 || string(ui["kept"]) != `1` {
		t.Fatalf("a refused patch must leave the document alone: got %v", ui)
	}
}

// TestHandlePutSettingsAllowedHosts: a valid list is stored, a patch to another
// section leaves it alone, and a name the server would skip at
// startup is refused here instead, leaving the stored list unchanged.
func TestHandlePutSettingsAllowedHosts(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}
	putSettings(t, s, `{"connectivity":{"allowedHosts":["box.tailnet.ts.net"]}}`, http.StatusOK)
	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)
	if got := s.settings.get().Connectivity.AllowedHosts; len(got) != 1 || got[0] != "box.tailnet.ts.net" {
		t.Fatalf("allowedHosts after an updates patch = %q, want [box.tailnet.ts.net]", got)
	}

	putSettings(t, s, `{"connectivity":{"allowedHosts":["*.ts.net"]}}`, http.StatusBadRequest)
	if got := s.settings.get().Connectivity.AllowedHosts; len(got) != 1 || got[0] != "box.tailnet.ts.net" {
		t.Fatalf("rejected PUT changed allowedHosts to %q, want unchanged", got)
	}
}

// TestSettingsPutLeavesLaunchChoicesToTheMachineServer: what opens whenever
// Juggler starts is the machine server's to save (PUT /api/server/launch, which
// a session reaches through /api/connectivity/launch). A session's settings PUT
// writes neither key, whoever sends it and whatever it says, and saving any
// other part of the document — connectivity's allowed hosts included — keeps
// what the machine server saved since this session last read the file.
func TestSettingsPutLeavesLaunchChoicesToTheMachineServer(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}
	put := func(r *http.Request) {
		t.Helper()
		rec := httptest.NewRecorder()
		s.handlePutSettings(rec, r)
		if rec.Code != http.StatusOK {
			t.Fatalf("PUT %s: status = %d, want 200 (body %s)", r.URL, rec.Code, rec.Body.String())
		}
	}
	onDisk := func() core.ConnectivitySettings {
		t.Helper()
		gs, err := core.LoadGlobalSettings()
		if err != nil {
			t.Fatal(err)
		}
		return gs.Connectivity
	}

	put(localRequest(http.MethodPut, "/api/settings", `{"connectivity":{"lanOnLaunch":true,"wanOnLaunch":"nope"}}`))
	put(remoteRequest(http.MethodPut, "/api/settings", `{"connectivity":{"lanOnLaunch":true,"wanOnLaunch":"`+testTunnelMode+`"}}`))
	if c := onDisk(); c.LANOnLaunch || c.WANOnLaunch != "" {
		t.Fatalf("a settings PUT saved what opens at start: %+v", c)
	}

	// The machine server saves them behind this session's back.
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Connectivity.LANOnLaunch, gs.Connectivity.WANOnLaunch = true, testTunnelMode
		return true
	}); err != nil {
		t.Fatal(err)
	}
	put(localRequest(http.MethodPut, "/api/settings", `{"connectivity":{"allowedHosts":["box.tailnet.ts.net"]}}`))
	put(localRequest(http.MethodPut, "/api/settings", `{"connectivity":{"lanOnLaunch":false,"wanOnLaunch":""}}`))
	if c := onDisk(); !c.LANOnLaunch || c.WANOnLaunch != testTunnelMode || len(c.AllowedHosts) != 1 {
		t.Fatalf("after a session's saves: %+v, want the machine server's LAN and %s kept beside the allowed host", c, testTunnelMode)
	}
}

func TestHandlePutSettingsHiddenModelsRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-hidden-models-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		test:            testCapabilities{offlineProviders: true},
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}

	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":["b-model","a-model","a-model"]}}}`, http.StatusOK)
	gs := s.settings.get()
	// Stored de-duplicated and sorted, so the file is stable across saves.
	if got := gs.Models.Hidden[providerName]; len(got) != 2 || got[0] != "a-model" || got[1] != "b-model" {
		t.Fatalf("hidden after PUT = %v, want [a-model b-model]", got)
	}
	if !gs.IsModelHidden(providerName, "a-model") {
		t.Fatal("IsModelHidden = false after hiding")
	}

	// GET reflects it.
	rec := httptest.NewRecorder()
	s.handleGetSettings(rec, httptest.NewRequest("GET", "/api/settings", nil))
	var out core.GlobalSettings
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Models.Hidden[providerName]) != 2 {
		t.Fatalf("GET hidden = %v, want two entries", out.Models.Hidden[providerName])
	}

	// Un-hiding is an explicit empty array. Merging into a non-nil map cannot
	// express a deletion by omission, so this is the only gesture that clears it.
	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":[]}}}`, http.StatusOK)
	if got := s.settings.get().Models.Hidden[providerName]; len(got) != 0 {
		t.Fatalf("hidden after clearing = %v, want empty", got)
	}
}

func TestHandlePutSettingsHiddenModelsMergePreservesOtherSections(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-hidden-merge-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		test:            testCapabilities{offlineProviders: true},
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}

	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)
	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":["a-model"]}}}`, http.StatusOK)
	if got := s.settings.get().Updates.Mode; got != core.UpdateModeNotify {
		t.Fatalf("updates clobbered by models PUT: mode=%q", got)
	}
	// And a later updates-only PUT must not wipe the hidden list.
	putSettings(t, s, `{"updates":{"mode":"off"}}`, http.StatusOK)
	if got := s.settings.get().Models.Hidden[providerName]; len(got) != 1 || got[0] != "a-model" {
		t.Fatalf("hidden clobbered by later updates PUT: %v", got)
	}
}

func TestHandlePutSettingsUnknownProviderRejected(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-hidden-reject-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		test:            testCapabilities{offlineProviders: true},
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}
	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":["a-model"]}}}`, http.StatusOK)

	// A provider this build doesn't register is rejected, and nothing is stored.
	putSettings(t, s, `{"models":{"hidden":{"nosuchprovider":["x"]}}}`, http.StatusBadRequest)
	gs := s.settings.get()
	if _, ok := gs.Models.Hidden["nosuchprovider"]; ok {
		t.Fatal("rejected PUT stored an unknown provider key")
	}
	if got := gs.Models.Hidden[providerName]; len(got) != 1 || got[0] != "a-model" {
		t.Fatalf("rejected PUT disturbed the valid list: %v", got)
	}
}

func TestHandlePutSettingsModelLimitsRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-model-limits-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		test:            testCapabilities{offlineProviders: true},
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}

	putSettings(t, s, `{"models":{"limits":{"`+providerName+`":{"big-model":{"contextWindow":1000000,"maxOutputTokens":64000}}}}}`, http.StatusOK)
	gs := s.settings.get()
	if got := gs.ModelLimitsFor(providerName, "big-model"); got.ContextWindow != 1000000 || got.MaxOutputTokens != 64000 {
		t.Fatalf("limits after PUT = %+v, want {1000000 64000}", got)
	}

	// GET reflects it.
	rec := httptest.NewRecorder()
	s.handleGetSettings(rec, httptest.NewRequest("GET", "/api/settings", nil))
	var out core.GlobalSettings
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := out.ModelLimitsFor(providerName, "big-model"); got.ContextWindow != 1000000 {
		t.Fatalf("GET limits = %+v, want the stored override", got)
	}

	// A provider that is named has its whole set replaced, so this drops the
	// first model's override and installs another's in one request.
	putSettings(t, s, `{"models":{"limits":{"`+providerName+`":{"other-model":{"contextWindow":8000}}}}}`, http.StatusOK)
	gs = s.settings.get()
	if !gs.ModelLimitsFor(providerName, "big-model").IsZero() {
		t.Fatal("naming a provider must replace its whole set, not merge into it")
	}
	if got := gs.ModelLimitsFor(providerName, "other-model"); got.ContextWindow != 8000 {
		t.Fatalf("replacement entry = %+v, want {8000 0}", got)
	}

	// Clearing the last override is an explicit empty object, mirroring the
	// empty array that un-hides a provider's last hidden model.
	putSettings(t, s, `{"models":{"limits":{"`+providerName+`":{}}}}`, http.StatusOK)
	if got := s.settings.get().Models.Limits[providerName]; len(got) != 0 {
		t.Fatalf("limits after clearing = %v, want empty", got)
	}
}

func TestHandlePutSettingsModelLimitsMergePreservesOtherSections(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-limits-merge-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		test:            testCapabilities{offlineProviders: true},
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}

	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":["a-model"]}}}`, http.StatusOK)
	putSettings(t, s, `{"models":{"limits":{"`+providerName+`":{"a-model":{"contextWindow":250000}}}}}`, http.StatusOK)
	// The two model sections are independent: setting a limit must not un-hide.
	gs := s.settings.get()
	if !gs.IsModelHidden(providerName, "a-model") {
		t.Fatal("hidden list cleared by a limits PUT")
	}
	// And an unrelated section's PUT must not wipe the overrides.
	putSettings(t, s, `{"updates":{"mode":"off"}}`, http.StatusOK)
	gs = s.settings.get()
	if got := gs.ModelLimitsFor(providerName, "a-model"); got.ContextWindow != 250000 {
		t.Fatalf("limits clobbered by a later updates PUT: %+v", got)
	}
}

func TestHandlePutSettingsModelLimitsRejected(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-limits-reject-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		test:            testCapabilities{offlineProviders: true},
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}
	putSettings(t, s, `{"models":{"limits":{"`+providerName+`":{"a-model":{"contextWindow":250000}}}}}`, http.StatusOK)

	// A provider this build doesn't register, and a negative limit, are both
	// refused outright — and neither disturbs what was already stored.
	putSettings(t, s, `{"models":{"limits":{"nosuchprovider":{"m":{"contextWindow":1}}}}}`, http.StatusBadRequest)
	putSettings(t, s, `{"models":{"limits":{"`+providerName+`":{"a-model":{"contextWindow":-1}}}}}`, http.StatusBadRequest)
	gs := s.settings.get()
	if _, ok := gs.Models.Limits["nosuchprovider"]; ok {
		t.Fatal("rejected PUT stored an unknown provider key")
	}
	if got := gs.ModelLimitsFor(providerName, "a-model"); got.ContextWindow != 250000 {
		t.Fatalf("rejected PUT disturbed the stored override: %+v", got)
	}
}

// TestHandlePutSettingsErrorCarriesMessage: a refused PUT answers with its
// English in error, as ever, and the message the UI translates beside it — the
// template and the values it names, never the sentence with them baked in.
func TestHandlePutSettingsErrorCarriesMessage(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-error-message-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		test:            testCapabilities{offlineProviders: true},
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}
	cases := []struct {
		body, english, key string
		params             map[string]any
	}{
		{`{"updates":{"mode":"garbage"}}`, "invalid update mode", "invalid update mode", nil},
		{
			`{"models":{"limits":{"` + providerName + `":{"a-model":{"contextWindow":-1}}}}}`,
			"negative model limit for " + providerName + " a-model",
			"negative model limit for {provider} {model}",
			map[string]any{"provider": providerName, "model": "a-model"},
		},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		s.handlePutSettings(rec, httptest.NewRequest("PUT", "/api/settings", strings.NewReader(tc.body)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("PUT %s: status = %d, want 400", tc.body, rec.Code)
		}
		var env struct {
			Error   string `json:"error"`
			Message *struct {
				Key    string         `json:"key"`
				Params map[string]any `json:"params"`
			} `json:"message"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("decode %s: %v", rec.Body.String(), err)
		}
		if env.Error != tc.english {
			t.Errorf("PUT %s: error = %q, want %q", tc.body, env.Error, tc.english)
		}
		if env.Message == nil || env.Message.Key != tc.key {
			t.Fatalf("PUT %s: message = %+v, want key %q", tc.body, env.Message, tc.key)
		}
		for name, want := range tc.params {
			if got := env.Message.Params[name]; got != want {
				t.Errorf("PUT %s: params.%s = %v, want %v", tc.body, name, got, want)
			}
		}
	}
}

// TestHandlePutSettingsStaleUnknownProviderDoesNotBlockPut pins the scope of the
// unknown-provider rejection: it covers the provider keys a request actually
// sends, not the ones the handler inherits from the stored document. A
// settings.json holding entries for a provider this build does not register — a
// custom endpoint the user deleted, or one written by a newer build — must sit
// inert rather than making every later PUT fail, including PUTs to unrelated
// sections.
func TestHandlePutSettingsStaleUnknownProviderDoesNotBlockPut(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-stale-live-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	// Seed the file directly. The API refuses to post these keys, so writing
	// through core is the only way to reach the state a deleted provider leaves.
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Hidden = map[string][]string{"deleted-instance": {"m"}}
		gs.Models.Limits = map[string]map[string]core.ModelLimits{
			"deleted-instance": {"m": {ContextWindow: 1000}},
		}
		return true
	}); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
	s := &Server{
		settings:        newSettingsStore(),
		test:            testCapabilities{offlineProviders: true},
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}
	if got := s.settings.get().Models.Hidden["deleted-instance"]; len(got) != 1 {
		t.Fatalf("seeded hidden entry did not survive load: %v", got)
	}

	// An unrelated section still saves.
	putSettings(t, s, `{"updates":{"mode":"off"}}`, http.StatusOK)
	if got := s.settings.get().Updates.Mode; got != core.UpdateModeOff {
		t.Fatalf("mode after PUT = %q, want off", got)
	}
	// So do both model sections, for a provider that is registered.
	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":["a-model"]}}}`, http.StatusOK)
	putSettings(t, s, `{"models":{"limits":{"`+providerName+`":{"a-model":{"contextWindow":250000}}}}}`, http.StatusOK)

	// The stale entries are preserved, not quietly destroyed: a provider can be
	// absent because its registration is pending, and core keeps unknown keys for
	// exactly that reason.
	gs := s.settings.get()
	if got := gs.Models.Hidden["deleted-instance"]; len(got) != 1 || got[0] != "m" {
		t.Fatalf("stale hidden entry = %v, want it preserved", got)
	}
	if got := gs.ModelLimitsFor("deleted-instance", "m"); got.ContextWindow != 1000 {
		t.Fatalf("stale limit entry = %+v, want it preserved", got)
	}

	// A request that does name an unknown provider is still refused.
	putSettings(t, s, `{"models":{"hidden":{"nosuchprovider":["x"]}}}`, http.StatusBadRequest)
	putSettings(t, s, `{"models":{"limits":{"nosuchprovider":{"m":{"contextWindow":1}}}}}`, http.StatusBadRequest)
}

func TestSameModelLimits(t *testing.T) {
	a := map[string]map[string]core.ModelLimits{"p": {"m": {ContextWindow: 1000}}}
	if !sameModelLimits(a, map[string]map[string]core.ModelLimits{"p": {"m": {ContextWindow: 1000}}}) {
		t.Error("identical maps reported different")
	}
	if sameModelLimits(a, map[string]map[string]core.ModelLimits{"p": {"m": {ContextWindow: 2000}}}) {
		t.Error("changed window reported same")
	}
	if sameModelLimits(a, map[string]map[string]core.ModelLimits{"p": {"m": {ContextWindow: 1000, MaxOutputTokens: 8}}}) {
		t.Error("added output cap reported same")
	}
	if sameModelLimits(a, map[string]map[string]core.ModelLimits{"p": {"n": {ContextWindow: 1000}}}) {
		t.Error("different model key reported same")
	}
	if sameModelLimits(a, map[string]map[string]core.ModelLimits{"q": {"m": {ContextWindow: 1000}}}) {
		t.Error("different provider key reported same")
	}
	if !sameModelLimits(nil, map[string]map[string]core.ModelLimits{}) {
		t.Error("nil and empty must compare equal")
	}
}

func TestSameHiddenModels(t *testing.T) {
	a := map[string][]string{"p": {"x", "y"}}
	if !sameHiddenModels(a, map[string][]string{"p": {"x", "y"}}) {
		t.Error("identical maps reported different")
	}
	if sameHiddenModels(a, map[string][]string{"p": {"x"}}) {
		t.Error("shorter list reported same")
	}
	if sameHiddenModels(a, map[string][]string{"p": {"x", "y"}, "q": {"z"}}) {
		t.Error("extra provider reported same")
	}
	if sameHiddenModels(a, map[string][]string{"q": {"x", "y"}}) {
		t.Error("different provider key reported same")
	}
	if !sameHiddenModels(nil, map[string][]string{}) {
		t.Error("nil and empty must compare equal")
	}
}

func TestHandleManualUpdateCheckBypassesOff(t *testing.T) {
	userpathstest.Isolate(t)
	srv, hits := manifestTestServer(t, "v9.9.9")
	s := &Server{settings: newSettingsStore()}
	s.updateChecker = updatecheck.New(updatecheck.Config{
		URL:            srv.URL,
		CurrentVersion: "v0.0.1",
		Enabled:        func() bool { return s.updateMode() != core.UpdateModeOff },
	})
	if err := s.settings.set(core.GlobalSettings{Updates: core.UpdateSettings{Mode: core.UpdateModeOff}}, nil); err != nil {
		t.Fatalf("seed off: %v", err)
	}

	rec := httptest.NewRecorder()
	s.handleManualUpdateCheck(rec, httptest.NewRequest("POST", "/api/update-status/check", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("manual check status = %d", rec.Code)
	}
	select {
	case <-hits:
	case <-time.After(3 * time.Second):
		t.Fatal("manual check must reach the server even while off")
	}
	var st updatecheck.Status
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !st.UpdateAvailable {
		t.Fatalf("manual check should surface the available update, got %+v", st)
	}
}
