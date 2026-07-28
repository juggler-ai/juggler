//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

func TestLoadGlobalSettingsMissingFileDefaults(t *testing.T) {
	userpathstest.Isolate(t)
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Updates.Mode != UpdateModeAutomatic {
		t.Fatalf("missing file mode = %q, want %q", gs.Updates.Mode, UpdateModeAutomatic)
	}
}

func TestSaveLoadGlobalSettingsRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	if err := SaveGlobalSettings(&GlobalSettings{Updates: UpdateSettings{Mode: UpdateModeNotify}}); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Updates.Mode != UpdateModeNotify {
		t.Fatalf("round-trip mode = %q, want %q", gs.Updates.Mode, UpdateModeNotify)
	}
	// The file exists at the expected path with a canonical mode written out.
	if _, err := os.Stat(filepath.Join(userpaths.ConfigDir(), "settings.json")); err != nil {
		t.Fatalf("settings.json not written: %v", err)
	}
}

func TestLoadGlobalSettingsEmptyModeNormalises(t *testing.T) {
	userpathstest.Isolate(t)
	// A file present but with an empty mode must normalise to automatic.
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "settings.json"),
		[]byte(`{"updates":{}}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Updates.Mode != UpdateModeAutomatic {
		t.Fatalf("empty mode = %q, want %q", gs.Updates.Mode, UpdateModeAutomatic)
	}
}

func TestLoadGlobalSettingsCorruptDefaults(t *testing.T) {
	userpathstest.Isolate(t)
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "settings.json"),
		[]byte(`{not json`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err == nil {
		t.Fatal("expected a parse error for corrupt file")
	}
	if gs == nil || gs.Updates.Mode != UpdateModeAutomatic {
		t.Fatalf("corrupt file must fall back to automatic defaults, got %+v", gs)
	}
}

func TestSaveLoadGlobalSettingsConnectivityRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	in := &GlobalSettings{
		Updates:      UpdateSettings{Mode: UpdateModeOff},
		Connectivity: ConnectivitySettings{LANOnLaunch: true, WANOnLaunch: "p2p"},
	}
	if err := SaveGlobalSettings(in); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if !gs.Connectivity.LANOnLaunch || gs.Connectivity.WANOnLaunch != "p2p" {
		t.Fatalf("connectivity round-trip = %+v, want {LAN:true, WAN:p2p}", gs.Connectivity)
	}
	// Both sections survive a round trip side by side.
	if gs.Updates.Mode != UpdateModeOff {
		t.Fatalf("updates alongside connectivity = %q, want off", gs.Updates.Mode)
	}
}

func TestLoadGlobalSettingsConnectivityOnlyKeepsUpdateDefault(t *testing.T) {
	userpathstest.Isolate(t)
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// A file with only a connectivity section: the absent updates section must
	// normalise to the automatic default, and the connectivity keys are read.
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "settings.json"),
		[]byte(`{"connectivity":{"lanOnLaunch":true,"wanOnLaunch":"cloudflared"}}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if !gs.Connectivity.LANOnLaunch || gs.Connectivity.WANOnLaunch != "cloudflared" {
		t.Fatalf("connectivity not read: %+v", gs.Connectivity)
	}
	if gs.Updates.Mode != UpdateModeAutomatic {
		t.Fatalf("absent updates section = %q, want automatic default", gs.Updates.Mode)
	}
}

func TestSaveLoadGlobalSettingsNetworkRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	in := &GlobalSettings{
		Updates: UpdateSettings{Mode: UpdateModeOff},
		Network: NetworkSettings{Proxy: ProxySettings{Mode: ProxyModeManual, URL: "http://127.0.0.1:7890"}},
	}
	if err := SaveGlobalSettings(in); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Network.Proxy.Mode != ProxyModeManual || gs.Network.Proxy.URL != "http://127.0.0.1:7890" {
		t.Fatalf("proxy round-trip = %+v, want {manual, http://127.0.0.1:7890}", gs.Network.Proxy)
	}
	// Sections survive side by side.
	if gs.Updates.Mode != UpdateModeOff {
		t.Fatalf("updates alongside network = %q, want off", gs.Updates.Mode)
	}
}

func TestLoadGlobalSettingsMissingFileProxyDefault(t *testing.T) {
	userpathstest.Isolate(t)
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Network.Proxy.Mode != ProxyModeSystem {
		t.Fatalf("missing file proxy mode = %q, want %q", gs.Network.Proxy.Mode, ProxyModeSystem)
	}
}

func TestLoadGlobalSettingsEmptyProxyModeNormalises(t *testing.T) {
	userpathstest.Isolate(t)
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// A network section present but with an empty proxy mode normalises to system.
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "settings.json"),
		[]byte(`{"network":{"proxy":{"url":"http://p:8080"}}}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Network.Proxy.Mode != ProxyModeSystem {
		t.Fatalf("empty proxy mode = %q, want %q", gs.Network.Proxy.Mode, ProxyModeSystem)
	}
	if gs.Network.Proxy.URL != "http://p:8080" {
		t.Fatalf("proxy url not read: %q", gs.Network.Proxy.URL)
	}
}

func TestNormalizeProxyMode(t *testing.T) {
	cases := map[string]string{
		"":        ProxyModeSystem,
		"system":  ProxyModeSystem,
		"none":    ProxyModeNone,
		"manual":  ProxyModeManual,
		"garbage": ProxyModeSystem,
	}
	for in, want := range cases {
		if got := NormalizeProxyMode(in); got != want {
			t.Errorf("NormalizeProxyMode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsKnownProxyMode(t *testing.T) {
	for _, m := range []string{ProxyModeSystem, ProxyModeNone, ProxyModeManual} {
		if !IsKnownProxyMode(m) {
			t.Errorf("IsKnownProxyMode(%q) = false, want true", m)
		}
	}
	for _, m := range []string{"", "garbage", "SYSTEM"} {
		if IsKnownProxyMode(m) {
			t.Errorf("IsKnownProxyMode(%q) = true, want false", m)
		}
	}
}

func TestNormalizeUpdateMode(t *testing.T) {
	cases := map[string]string{
		"":          UpdateModeAutomatic,
		"automatic": UpdateModeAutomatic,
		"notify":    UpdateModeNotify,
		"off":       UpdateModeOff,
		"garbage":   UpdateModeAutomatic,
	}
	for in, want := range cases {
		if got := NormalizeUpdateMode(in); got != want {
			t.Errorf("NormalizeUpdateMode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsKnownUpdateMode(t *testing.T) {
	for _, m := range []string{UpdateModeAutomatic, UpdateModeNotify, UpdateModeOff} {
		if !IsKnownUpdateMode(m) {
			t.Errorf("IsKnownUpdateMode(%q) = false, want true", m)
		}
	}
	for _, m := range []string{"", "garbage", "AUTOMATIC"} {
		if IsKnownUpdateMode(m) {
			t.Errorf("IsKnownUpdateMode(%q) = true, want false", m)
		}
	}
}
