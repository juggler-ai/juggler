//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/extmanifest"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

// saveSettings makes gs the whole settings document, through the same locked
// write every setting change takes.
func saveSettings(t *testing.T, gs *GlobalSettings) {
	t.Helper()
	if _, err := UpdateGlobalSettings(func(stored *GlobalSettings) bool {
		*stored = *gs
		return true
	}); err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}
}

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
	saveSettings(t, &GlobalSettings{Updates: UpdateSettings{Mode: UpdateModeNotify}})
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
	saveSettings(t, in)
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
	saveSettings(t, in)
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
	saveSettings(t, in)
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
	saveSettings(t, in)
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

func TestSaveLoadGlobalSettingsModelLimitsRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	in := &GlobalSettings{
		Models: ModelSettings{
			Hidden: map[string][]string{"mistral": {"mistral-embed"}},
			Limits: map[string]map[string]ModelLimits{
				"deepseek":   {"deepseek-v4-pro": {ContextWindow: 1000000, MaxOutputTokens: 384000}},
				"openrouter": {"z-ai/glm-4.6": {ContextWindow: 200000}},
			},
		},
	}
	saveSettings(t, in)
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if got := gs.ModelLimitsFor("deepseek", "deepseek-v4-pro"); got.ContextWindow != 1000000 || got.MaxOutputTokens != 384000 {
		t.Fatalf("deepseek limits = %+v, want {1000000 384000}", got)
	}
	// One limit without the other: the unset field stays zero so the provider's
	// own output cap continues to apply.
	if got := gs.ModelLimitsFor("openrouter", "z-ai/glm-4.6"); got.ContextWindow != 200000 || got.MaxOutputTokens != 0 {
		t.Fatalf("openrouter limits = %+v, want {200000 0}", got)
	}
	// Nothing set is the zero value, not a panic on a missing provider or model.
	if got := gs.ModelLimitsFor("deepseek", "deepseek-v4-flash"); !got.IsZero() {
		t.Fatalf("unset model limits = %+v, want zero", got)
	}
	if got := gs.ModelLimitsFor("nosuchprovider", "whatever"); !got.IsZero() {
		t.Fatalf("unknown provider limits = %+v, want zero", got)
	}
	// The sections are independent.
	if !gs.IsModelHidden("mistral", "mistral-embed") {
		t.Fatal("hidden list lost when limits were saved alongside it")
	}
}

func TestNormalizeModelSettingsCleansLimits(t *testing.T) {
	userpathstest.Isolate(t)
	deepseek := map[string]ModelLimits{
		"negative":   {ContextWindow: -5, MaxOutputTokens: 8192},
		"blank-both": {ContextWindow: 0, MaxOutputTokens: 0},
		"":           {ContextWindow: 4096},
	}
	// Assigned rather than written as a literal: the padding is the point of the
	// case, and a padded map-key literal is a lint error.
	deepseek[" deepseek-v4-pro "] = ModelLimits{ContextWindow: 1000000}
	in := &GlobalSettings{Models: ModelSettings{Limits: map[string]map[string]ModelLimits{
		"deepseek": deepseek,
		"gemini":   {"gemini-3-pro": {ContextWindow: -1}}, // nothing usable ⇒ provider goes
	}}}
	saveSettings(t, in)
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if got := gs.ModelLimitsFor("deepseek", "deepseek-v4-pro"); got.ContextWindow != 1000000 {
		t.Fatalf("trimmed model id = %+v, want the entry under the trimmed key", got)
	}
	// A negative is not an override; the sibling field it was posted with still is.
	if got := gs.ModelLimitsFor("deepseek", "negative"); got.ContextWindow != 0 || got.MaxOutputTokens != 8192 {
		t.Fatalf("negative window = %+v, want {0 8192}", got)
	}
	for _, id := range []string{"blank-both", ""} {
		if _, ok := gs.Models.Limits["deepseek"][id]; ok {
			t.Fatalf("entry %q kept, want dropped", id)
		}
	}
	if _, ok := gs.Models.Limits["gemini"]; ok {
		t.Fatal("provider with no usable overrides kept, want dropped")
	}
}

func TestLoadGlobalSettingsKeepsUnknownProviderModelLimits(t *testing.T) {
	userpathstest.Isolate(t)
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Same contract as the hidden lists: a provider this build doesn't register
	// must not cost the user the numbers they set for it.
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "settings.json"),
		[]byte(`{"models":{"limits":{"notaprovider":{"some-model":{"contextWindow":123456}}}}}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if got := gs.ModelLimitsFor("notaprovider", "some-model"); got.ContextWindow != 123456 {
		t.Fatalf("unknown provider limits = %+v, want {123456 0}", got)
	}
}

func TestLoadGlobalSettingsMissingFileNoModelLimits(t *testing.T) {
	userpathstest.Isolate(t)
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Models.Limits != nil {
		t.Fatalf("missing file limits = %v, want nil", gs.Models.Limits)
	}
	if !gs.ModelLimitsFor("deepseek", "deepseek-v4-pro").IsZero() {
		t.Fatal("nothing is overridden on a fresh install")
	}
}

func TestUpdateGlobalSettingsMergesOntoDisk(t *testing.T) {
	userpathstest.Isolate(t)
	saveSettings(t, &GlobalSettings{
		Updates: UpdateSettings{Mode: UpdateModeNotify},
		Network: NetworkSettings{Proxy: ProxySettings{Mode: ProxyModeManual, URL: "http://127.0.0.1:7890"}},
	})
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
	saveSettings(t, &GlobalSettings{Updates: UpdateSettings{Mode: UpdateModeNotify}})
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

// The UI language belongs to the person, so it lives in settings.json and
// survives a round trip. A hand-edited value that is not a language tag reads as
// unset: it is written into the page's markup, and a typo must cost the
// translation, not the page.
func TestGlobalSettingsUILocale(t *testing.T) {
	userpathstest.Isolate(t)
	saveSettings(t, &GlobalSettings{UILocale: "en-XA"})
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.UILocale != "en-XA" {
		t.Fatalf("round-trip uiLocale = %q, want en-XA", gs.UILocale)
	}

	path := filepath.Join(userpaths.ConfigDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"uiLocale":"\"><b>x"}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err = LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.UILocale != "" {
		t.Fatalf("a value that is not a language tag must read as unset, got %q", gs.UILocale)
	}
}

func TestIsValidUILocale(t *testing.T) {
	for _, ok := range []string{"en", "fr", "en-XA", "zh-Hant-TW", "pt-BR", "es-419", "fil",
		"zh-hant-tw", "FR", "sr-Latn-RS", "de-CH-1996", "ca-ES-valencia"} {
		if !IsValidUILocale(ok) {
			t.Errorf("IsValidUILocale(%q) = false, want true", ok)
		}
	}
	// The last group are well-shaped enough for a loose pattern but rejected
	// by Intl in the browser, where they would make every formatter throw.
	for _, bad := range []string{"", "e", "english", "en_GB", "en-", "-en", "en-XA-", "en XA", "\"><b>", "zh-Hant-TW-aaaaaaaaa",
		"en-US-abc", "en-12", "en-US-US", "en-Latn-abcd", "abc-de-fg-hi"} {
		if IsValidUILocale(bad) {
			t.Errorf("IsValidUILocale(%q) = true, want false", bad)
		}
	}
}

// A tag is stored in canonical case, the case catalogue files are named in: the
// embedded asset tree is case-sensitive, so `FR` would never find fr.json.
func TestNormalizeUILocaleCanonicalCase(t *testing.T) {
	cases := map[string]string{
		"zh-hant-tw":     "zh-Hant-TW",
		"FR":             "fr",
		"EN-xa":          "en-XA",
		"es-419":         "es-419",
		"de-ch-1996":     "de-CH-1996",
		"SR-LATN":        "sr-Latn",
		"ca-es-VALENCIA": "ca-ES-valencia",
		"IW-il":          "he-IL",
		"sh":             "sr-Latn",
		"en-BU":          "en-MM",
		"en-Latn":        "en-Latn",
		"zz-ZZ-abcde":    "zz-ZZ-abcde",
		"en-US-abc":      "",
	}
	for in, want := range cases {
		if got := NormalizeUILocale(in); got != want {
			t.Errorf("NormalizeUILocale(%q) = %q, want %q", in, got, want)
		}
	}
}

// An extension's catalogue is named for its locale, and the server looks it up
// by the user's UI language — so the two must agree on what a language tag is.
func TestExtensionCatalogueLocalesMatchUILocales(t *testing.T) {
	for _, tag := range []string{"en", "fr", "en-XA", "zh-Hant-TW", "pt-BR", "es-419", "fil",
		"", "e", "english", "en_GB", "en-", "-en", "en-XA-", "en XA", "\"><b>", "zh-Hant-TW-aaaaaaaaa",
		"zh-hant-tw", "de-CH-1996", "en-US-abc", "en-12", "en-US-US", "en-Latn-abcd"} {
		if IsValidUILocale(tag) != extmanifest.IsLocaleTag(tag) {
			t.Errorf("%q: IsValidUILocale = %v, extmanifest.IsLocaleTag = %v", tag, IsValidUILocale(tag), extmanifest.IsLocaleTag(tag))
		}
	}
}
