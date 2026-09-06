//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
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

func TestSaveLoadGlobalSettingsHiddenModelsRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	in := &GlobalSettings{
		Updates: UpdateSettings{Mode: UpdateModeNotify},
		Models: ModelSettings{Hidden: map[string][]string{
			"mistral":    {"mistral-ocr-latest", "mistral-embed"},
			"openrouter": {"z-ai/glm-4.6"},
		}},
	}
	if err := SaveGlobalSettings(in); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	// Sorted on the way out, so the file is stable across saves.
	got := gs.Models.Hidden["mistral"]
	if len(got) != 2 || got[0] != "mistral-embed" || got[1] != "mistral-ocr-latest" {
		t.Fatalf("mistral hidden = %v, want sorted [mistral-embed mistral-ocr-latest]", got)
	}
	// A model id containing a slash survives intact — the reason the map is
	// keyed by provider rather than flattened to "provider/model".
	if got := gs.Models.Hidden["openrouter"]; len(got) != 1 || got[0] != "z-ai/glm-4.6" {
		t.Fatalf("openrouter hidden = %v, want [z-ai/glm-4.6]", got)
	}
	if !gs.IsModelHidden("mistral", "mistral-embed") {
		t.Fatal("IsModelHidden(mistral, mistral-embed) = false, want true")
	}
	if gs.IsModelHidden("mistral", "mistral-large-latest") {
		t.Fatal("IsModelHidden(mistral, mistral-large-latest) = true, want false")
	}
	if gs.IsModelHidden("nosuchprovider", "mistral-embed") {
		t.Fatal("IsModelHidden on an unknown provider = true, want false")
	}
	// Sections survive side by side.
	if gs.Updates.Mode != UpdateModeNotify {
		t.Fatalf("updates alongside models = %q, want notify", gs.Updates.Mode)
	}
}

func TestNormalizeModelSettingsCleansLists(t *testing.T) {
	userpathstest.Isolate(t)
	in := &GlobalSettings{Models: ModelSettings{Hidden: map[string][]string{
		"mistral": {" mistral-ocr-latest ", "mistral-embed", "mistral-embed", "", "   "},
		"openai":  {},        // no ids left ⇒ the provider key goes entirely
		"gemini":  {"", " "}, // only blanks ⇒ same
	}}}
	if err := SaveGlobalSettings(in); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	got := gs.Models.Hidden["mistral"]
	if len(got) != 2 || got[0] != "mistral-embed" || got[1] != "mistral-ocr-latest" {
		t.Fatalf("hidden = %v, want trimmed+deduped+sorted [mistral-embed mistral-ocr-latest]", got)
	}
	if _, ok := gs.Models.Hidden["openai"]; ok {
		t.Fatal("empty provider key kept, want dropped")
	}
	if _, ok := gs.Models.Hidden["gemini"]; ok {
		t.Fatal("blanks-only provider key kept, want dropped")
	}
}

func TestLoadGlobalSettingsKeepsUnknownProviderHiddenList(t *testing.T) {
	userpathstest.Isolate(t)
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// A provider the build doesn't register (removed key, pro-only provider, a
	// rename) must not have the user's curated list quietly destroyed.
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "settings.json"),
		[]byte(`{"models":{"hidden":{"notaprovider":["some-model"]}}}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if got := gs.Models.Hidden["notaprovider"]; len(got) != 1 || got[0] != "some-model" {
		t.Fatalf("unknown provider list = %v, want [some-model]", got)
	}
}

func TestLoadGlobalSettingsMissingFileNoHiddenModels(t *testing.T) {
	userpathstest.Isolate(t)
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Models.Hidden != nil {
		t.Fatalf("missing file hidden = %v, want nil", gs.Models.Hidden)
	}
	if gs.IsModelHidden("mistral", "mistral-large-latest") {
		t.Fatal("nothing is hidden on a fresh install")
	}
}

func TestUpdateGlobalSettingsMergesOntoDisk(t *testing.T) {
	userpathstest.Isolate(t)
	if err := SaveGlobalSettings(&GlobalSettings{
		Updates: UpdateSettings{Mode: UpdateModeNotify},
		Network: NetworkSettings{Proxy: ProxySettings{Mode: ProxyModeManual, URL: "http://127.0.0.1:7890"}},
	}); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}
	// A second process changes one field. It must not revert the rest, which is
	// what writing back its own copy of the document would have done.
	stored, err := UpdateGlobalSettings(func(gs *GlobalSettings) bool {
		gs.Connectivity.LANOnLaunch = true
		return true
	})
	if err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}
	if !stored.Connectivity.LANOnLaunch {
		t.Fatal("returned document missing the change")
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if !gs.Connectivity.LANOnLaunch {
		t.Fatal("change not persisted")
	}
	if gs.Updates.Mode != UpdateModeNotify {
		t.Fatalf("mode = %q, want it untouched at %q", gs.Updates.Mode, UpdateModeNotify)
	}
	if gs.Network.Proxy.URL != "http://127.0.0.1:7890" {
		t.Fatalf("proxy url = %q, want it untouched", gs.Network.Proxy.URL)
	}
}

func TestUpdateGlobalSettingsSkipsWriteWhenUnchanged(t *testing.T) {
	userpathstest.Isolate(t)
	if err := SaveGlobalSettings(&GlobalSettings{Updates: UpdateSettings{Mode: UpdateModeNotify}}); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}
	path := filepath.Join(userpaths.ConfigDir(), "settings.json")
	before, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// Returning false means "nothing to do" — a poller that runs every few
	// hours and changes a field once a day must not rewrite the file each time.
	if _, err := UpdateGlobalSettings(func(*GlobalSettings) bool { return false }); err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("file rewritten despite mutate reporting no change")
	}
}

func TestUpdateGlobalSettingsSerialisesConcurrentWriters(t *testing.T) {
	userpathstest.Isolate(t)
	// One machine, several project servers, all waking at once. Every increment
	// must survive: a lost update here is one writer silently reverting another.
	const writers = 8
	start := make(chan struct{})
	done := make(chan error, writers)
	for i := 0; i < writers; i++ {
		id := fmt.Sprintf("model-%d", i)
		go func() {
			<-start
			_, err := UpdateGlobalSettings(func(gs *GlobalSettings) bool {
				if gs.Models.Hidden == nil {
					gs.Models.Hidden = map[string][]string{}
				}
				gs.Models.Hidden["p"] = append(gs.Models.Hidden["p"], id)
				return true
			})
			done <- err
		}()
	}
	close(start)
	for i := 0; i < writers; i++ {
		if err := <-done; err != nil {
			t.Fatalf("writer %d: %v", i, err)
		}
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	// Distinct ids, so de-duplication can't mask a lost update: all eight have
	// to be there. Without the lock the last writer's copy wins and most vanish.
	if got := len(gs.Models.Hidden["p"]); got != writers {
		t.Fatalf("%d of %d concurrent writes survived: %v", got, writers, gs.Models.Hidden["p"])
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
