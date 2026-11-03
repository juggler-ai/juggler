//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// newTestConfigAPI builds a ConfigAPI with an isolated credentials store
// (JUGGLER_CONFIG_DIR) and a temp project path, so a test never touches the
// developer's real ~/.juggler/credentials.json.
func newTestConfigAPI(t *testing.T) *ConfigAPI {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	project := t.TempDir()
	api, err := NewConfigAPI(func() string { return project }, nil, nil)
	if err != nil {
		t.Fatalf("NewConfigAPI: %v", err)
	}
	return api
}

// TestSetProviderEnabledAcceptsOAuthProviders: an OAuth provider gets the same
// switch a keyless one has; an API-key provider still has nothing to switch.
func TestSetProviderEnabledAcceptsOAuthProviders(t *testing.T) {
	api := newTestConfigAPI(t)
	provider.RegisterProvider(provider.ProviderInfo{
		Name:       "handler_oauth",
		AuthType:   provider.AuthTypeOAuthBearer,
		AuthSource: "handler_oauth_src",
	}, nil)
	provider.RegisterProvider(provider.ProviderInfo{
		Name:          "handler_apikey",
		AuthType:      provider.AuthTypeAPIKey,
		ConfigKeyName: "handler_apikey_key",
	}, nil)

	post := func(name string, enabled bool) int {
		raw, _ := json.Marshal(map[string]any{"provider": name, "enabled": enabled})
		rec := httptest.NewRecorder()
		api.HandleSetProviderEnabled(rec, httptest.NewRequest(http.MethodPost, "/api/config/provider-enabled", bytes.NewReader(raw)))
		return rec.Code
	}

	if code := post("handler_oauth", false); code != http.StatusOK {
		t.Fatalf("switching an OAuth provider off = %d, want 200", code)
	}
	if !api.credStore.IsProviderSwitchedOff("handler_oauth") {
		t.Fatal("the switch must be persisted")
	}
	if code := post("handler_apikey", false); code != http.StatusBadRequest {
		t.Fatalf("switching an API-key provider = %d, want 400", code)
	}
}

// getAutoCompactDisabled drives HandleGetConfig and returns the
// autoCompactDisabled field from the payload.
func getAutoCompactDisabled(t *testing.T, api *ConfigAPI) bool {
	t.Helper()
	rec := httptest.NewRecorder()
	api.HandleGetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/config = %d, want 200", rec.Code)
	}
	var payload struct {
		AutoCompactDisabled bool `json:"autoCompactDisabled"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode GET payload: %v", err)
	}
	return payload.AutoCompactDisabled
}

// putConfig drives HandleUpdateConfig with the given JSON body.
func putConfig(t *testing.T, api *ConfigAPI, body map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	api.HandleUpdateConfig(rec, httptest.NewRequest(http.MethodPut, "/api/config", bytes.NewReader(raw)))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /api/config = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

// TestAutoCompactDisabledRoundTrip pins the config round-trip for the global
// auto-compaction switch: default is enabled (false disabled), PUT true
// persists, and PUT false clears it back to the default.
func TestAutoCompactDisabledRoundTrip(t *testing.T) {
	api := newTestConfigAPI(t)

	if getAutoCompactDisabled(t, api) {
		t.Fatal("default autoCompactDisabled = true, want false (enabled by default)")
	}

	putConfig(t, api, map[string]any{"auto_compact_disabled": true})
	if !getAutoCompactDisabled(t, api) {
		t.Fatal("after PUT true, autoCompactDisabled = false, want true")
	}

	putConfig(t, api, map[string]any{"auto_compact_disabled": false})
	if getAutoCompactDisabled(t, api) {
		t.Fatal("after PUT false, autoCompactDisabled = true, want false (cleared)")
	}
}

// TestCompactKeepRecentPercentRoundTrip pins the keep-recent setting's config
// round-trip: absent by default (the worker's default applies), a PUT persists,
// and a blank PUT clears it.
func TestCompactKeepRecentPercentRoundTrip(t *testing.T) {
	api := newTestConfigAPI(t)
	get := func() string {
		t.Helper()
		rec := httptest.NewRecorder()
		api.HandleGetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
		var payload struct {
			CompactKeepRecentPercent string `json:"compactKeepRecentPercent"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode GET payload: %v", err)
		}
		return payload.CompactKeepRecentPercent
	}

	if got := get(); got != "" {
		t.Fatalf("default compactKeepRecentPercent = %q, want empty", got)
	}
	putConfig(t, api, map[string]any{"compact_keep_recent_percent": " 45 "})
	if got := get(); got != "45" {
		t.Fatalf("after PUT, compactKeepRecentPercent = %q, want 45", got)
	}
	putConfig(t, api, map[string]any{"compact_keep_recent_percent": ""})
	if got := get(); got != "" {
		t.Fatalf("after blank PUT, compactKeepRecentPercent = %q, want empty", got)
	}
}

// TestLMStudioHostRoundTrip pins the settings field behind the LM Studio
// provider's host row: PUT stores the raw credential the provider reads, GET
// hands it back to the form, and an empty PUT clears it back to the default.
func TestLMStudioHostRoundTrip(t *testing.T) {
	api := newTestConfigAPI(t)
	get := func() string {
		t.Helper()
		rec := httptest.NewRecorder()
		api.HandleGetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
		var payload struct {
			LMStudioHost string `json:"lmstudioHost"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode GET payload: %v", err)
		}
		return payload.LMStudioHost
	}

	if got := get(); got != "" {
		t.Fatalf("default lmstudioHost = %q, want empty (the provider's own default)", got)
	}
	putConfig(t, api, map[string]any{"lmstudio_host": "http://192.168.1.20:1234"})
	if got := get(); got != "http://192.168.1.20:1234" {
		t.Fatalf("after PUT, lmstudioHost = %q, want the saved host", got)
	}
	putConfig(t, api, map[string]any{"lmstudio_host": ""})
	if got := get(); got != "" {
		t.Fatalf("after clearing, lmstudioHost = %q, want empty", got)
	}
}

// getAutoNameConfig drives HandleGetConfig and returns the autoNameDisabled and
// autoNameInstruction fields from the payload.
func getAutoNameConfig(t *testing.T, api *ConfigAPI) (bool, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	api.HandleGetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/config = %d, want 200", rec.Code)
	}
	var payload struct {
		AutoNameDisabled    bool   `json:"autoNameDisabled"`
		AutoNameInstruction string `json:"autoNameInstruction"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode GET payload: %v", err)
	}
	return payload.AutoNameDisabled, payload.AutoNameInstruction
}

// TestAutoNameDisabledRoundTrip pins the config round-trip for the global tab
// auto-naming switch: default is enabled (false disabled), PUT true persists,
// and PUT false clears it back to the default.
func TestAutoNameDisabledRoundTrip(t *testing.T) {
	api := newTestConfigAPI(t)

	if disabled, _ := getAutoNameConfig(t, api); disabled {
		t.Fatal("default autoNameDisabled = true, want false (enabled by default)")
	}

	putConfig(t, api, map[string]any{"auto_name_disabled": true})
	if disabled, _ := getAutoNameConfig(t, api); !disabled {
		t.Fatal("after PUT true, autoNameDisabled = false, want true")
	}

	putConfig(t, api, map[string]any{"auto_name_disabled": false})
	if disabled, _ := getAutoNameConfig(t, api); disabled {
		t.Fatal("after PUT false, autoNameDisabled = true, want false (cleared)")
	}
}

// TestAutoNameInstructionRoundTrip pins the custom auto-name instruction:
// default empty, PUT a value persists (trimmed), and PUT blank clears it.
func TestAutoNameInstructionRoundTrip(t *testing.T) {
	api := newTestConfigAPI(t)

	if _, instr := getAutoNameConfig(t, api); instr != "" {
		t.Fatalf("default autoNameInstruction = %q, want empty", instr)
	}

	putConfig(t, api, map[string]any{"auto_name_instruction": "  Name it after the file touched  "})
	if _, instr := getAutoNameConfig(t, api); instr != "Name it after the file touched" {
		t.Fatalf("after PUT, autoNameInstruction = %q, want trimmed value", instr)
	}

	putConfig(t, api, map[string]any{"auto_name_instruction": ""})
	if _, instr := getAutoNameConfig(t, api); instr != "" {
		t.Fatalf("after PUT blank, autoNameInstruction = %q, want empty (cleared)", instr)
	}
}

// getReplySuggestionsDisabled drives HandleGetConfig and returns the
// replySuggestionsDisabled field from the payload.
func getReplySuggestionsDisabled(t *testing.T, api *ConfigAPI) bool {
	t.Helper()
	rec := httptest.NewRecorder()
	api.HandleGetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/config = %d, want 200", rec.Code)
	}
	var payload struct {
		ReplySuggestionsDisabled bool `json:"replySuggestionsDisabled"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode GET payload: %v", err)
	}
	return payload.ReplySuggestionsDisabled
}

// TestReplySuggestionsDisabledRoundTrip pins the config round-trip for the
// reply-suggestions switch. The default matters more here than for its
// siblings: nothing server-side reads this key, so the shipped-on behaviour
// rests entirely on the absent key reading as "not disabled".
func TestReplySuggestionsDisabledRoundTrip(t *testing.T) {
	api := newTestConfigAPI(t)

	if getReplySuggestionsDisabled(t, api) {
		t.Fatal("default replySuggestionsDisabled = true, want false (enabled by default)")
	}

	putConfig(t, api, map[string]any{"reply_suggestions_disabled": true})
	if !getReplySuggestionsDisabled(t, api) {
		t.Fatal("after PUT true, replySuggestionsDisabled = false, want true")
	}

	putConfig(t, api, map[string]any{"reply_suggestions_disabled": false})
	if getReplySuggestionsDisabled(t, api) {
		t.Fatal("after PUT false, replySuggestionsDisabled = true, want false (cleared)")
	}
}

// TestDisabledFlagsAreIndependent pins that the three off switches sharing
// storeDisabledFlag keep their own keys. They are now one code path, so a
// mistyped key would silently make one switch operate another.
func TestDisabledFlagsAreIndependent(t *testing.T) {
	api := newTestConfigAPI(t)

	putConfig(t, api, map[string]any{"reply_suggestions_disabled": true})

	if !getReplySuggestionsDisabled(t, api) {
		t.Fatal("replySuggestionsDisabled = false, want true")
	}
	if getAutoCompactDisabled(t, api) {
		t.Fatal("disabling reply suggestions also disabled auto-compaction")
	}
	if disabled, _ := getAutoNameConfig(t, api); disabled {
		t.Fatal("disabling reply suggestions also disabled auto-naming")
	}
}

// TestAutoNameDefaultPromptEchoed pins that whatever built-in naming prompt the
// server sets on the API is echoed verbatim in the config GET, so the settings
// UI can show it as the custom-instruction placeholder. Uses a sentinel, not a
// copy of the real prompt — that string is owned solely by server/auto_name.go
// (autoNameTitleInstruction) and wired here by the server; duplicating it in the
// test would just create a second copy to drift.
func TestAutoNameDefaultPromptEchoed(t *testing.T) {
	api := newTestConfigAPI(t)
	const builtin = "test-sentinel-default-prompt"
	api.AutoNameDefaultPrompt = builtin

	rec := httptest.NewRecorder()
	api.HandleGetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/config = %d, want 200", rec.Code)
	}
	var payload struct {
		AutoNameDefaultPrompt string `json:"autoNameDefaultPrompt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode GET payload: %v", err)
	}
	if payload.AutoNameDefaultPrompt != builtin {
		t.Fatalf("autoNameDefaultPrompt = %q, want %q", payload.AutoNameDefaultPrompt, builtin)
	}
}
