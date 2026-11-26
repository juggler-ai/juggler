//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package extmanifest

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"testing/fstest"

	"juggler/web"
)

func TestParseRejectsUnknownFields(t *testing.T) {
	// DisallowUnknownFields: a typo'd key is surfaced, not silently dropped.
	_, err := Parse([]byte(`{"id":"@x/y","name":"Y","version":"1.0.0","permision":["x"],` +
		`"provides":{"commands":["c/*.js"]}}`))
	if err == nil {
		t.Fatal("expected unknown-field error, got nil")
	}
}

func TestParseInvalidJSON(t *testing.T) {
	if _, err := Parse([]byte("{ not json")); err == nil {
		t.Fatal("expected parse error, got nil")
	}
}

func TestValidate(t *testing.T) {
	good := Manifest{
		ID: "@x/y", Name: "Y", Version: "1.0.0", EngineAPI: "^1.0.0",
		Provides: Provides{Commands: []string{"commands/*.js"}},
	}
	cases := []struct {
		name    string
		mutate  func(m Manifest) Manifest
		wantErr bool
	}{
		{"valid", func(m Manifest) Manifest { return m }, false},
		{"missing id", func(m Manifest) Manifest { m.ID = ""; return m }, true},
		{"missing name", func(m Manifest) Manifest { m.Name = ""; return m }, true},
		{"missing version", func(m Manifest) Manifest { m.Version = ""; return m }, true},
		{"no capabilities", func(m Manifest) Manifest { m.Provides = Provides{}; return m }, true},
		{"infoCards only is a capability", func(m Manifest) Manifest {
			m.Provides = Provides{InfoCards: []string{"cards/*-card.js"}}
			return m
		}, false},
		{"systemPrompt only is a capability", func(m Manifest) Manifest {
			m.Provides = Provides{SystemPrompt: "system-prompt-contribution.js"}
			return m
		}, false},
		{"blank systemPrompt is not a capability", func(m Manifest) Manifest {
			m.Provides = Provides{SystemPrompt: "   "}
			return m
		}, true},
		{"blank engineApi ok", func(m Manifest) Manifest { m.EngineAPI = ""; return m }, false},
		{"incompatible engineApi", func(m Manifest) Manifest { m.EngineAPI = "^2.0.0"; return m }, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := Validate(c.mutate(good), "1.0.0")
			if (err != nil) != c.wantErr {
				t.Errorf("Validate err = %v, wantErr = %v", err, c.wantErr)
			}
		})
	}
}

func TestValidateSettings(t *testing.T) {
	defaults := func(v string) json.RawMessage { return json.RawMessage(v) }
	good := []Setting{
		{Key: "name", Type: "string", Label: "Name", Default: defaults(`"Ada"`)},
		{Key: "token", Type: "secret", Label: "Token"},
		{Key: "enabled", Type: "boolean", Label: "Enabled", Default: defaults(`true`)},
		{Key: "limit", Type: "number", Label: "Limit", Default: defaults(`5`)},
		{Key: "mode", Type: "enum", Label: "Mode", Options: []string{"fast", "deep"}, Default: defaults(`"fast"`)},
		{Key: "base_url", Type: "url", Label: "Base URL", Default: defaults(`"https://example.com/api"`), Scope: "global"},
		{Key: "policy", Type: "text", Label: "Policy", Default: defaults(`"line one\nline two"`), Capability: "strategy:auto-approve"},
	}
	if err := ValidateSettings(good); err != nil {
		t.Fatalf("ValidateSettings(valid): %v", err)
	}

	cases := []struct {
		name    string
		setting Setting
	}{
		{"invalid key", Setting{Key: "../key", Type: "string", Label: "Key"}},
		{"duplicate enum option", Setting{Key: "mode", Type: "enum", Label: "Mode", Options: []string{"x", "x"}}},
		{"missing enum options", Setting{Key: "mode", Type: "enum", Label: "Mode"}},
		{"options on string", Setting{Key: "name", Type: "string", Label: "Name", Options: []string{"x"}}},
		{"unknown type", Setting{Key: "name", Type: "object", Label: "Name"}},
		{"missing label", Setting{Key: "name", Type: "string"}},
		{"project scope", Setting{Key: "name", Type: "string", Label: "Name", Scope: "project"}},
		{"secret default", Setting{Key: "token", Type: "secret", Label: "Token", Default: defaults(`"secret"`)}},
		{"wrong default type", Setting{Key: "enabled", Type: "boolean", Label: "Enabled", Default: defaults(`"yes"`)}},
		{"invalid URL default", Setting{Key: "host", Type: "url", Label: "Host", Default: defaults(`"relative"`)}},
		{"invalid enum default", Setting{Key: "mode", Type: "enum", Label: "Mode", Options: []string{"x"}, Default: defaults(`"y"`)}},
		{"options on text", Setting{Key: "policy", Type: "text", Label: "Policy", Options: []string{"x"}}},
		{"wrong text default type", Setting{Key: "policy", Type: "text", Label: "Policy", Default: defaults(`3`)}},
		{"capability without type", Setting{Key: "name", Type: "string", Label: "Name", Capability: "auto-approve"}},
		{"capability without id", Setting{Key: "name", Type: "string", Label: "Name", Capability: "strategy:"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateSettings([]Setting{tc.setting}); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
	if err := ValidateSettings([]Setting{good[0], good[0]}); err == nil {
		t.Fatal("expected duplicate key error")
	}
}

func TestParseSettingsDefaultsScopeToGlobal(t *testing.T) {
	manifest, err := Parse([]byte(`{
		"id":"@x/y","name":"Y","version":"1.0.0","engineApi":"^1.0.0",
		"settings":[{"key":"enabled","type":"boolean","label":"Enabled","default":true}],
		"provides":{"commands":["commands/*.js"]}
	}`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if err := Validate(manifest, "1.0.0"); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := manifest.Settings[0].EffectiveScope(); got != "global" {
		t.Fatalf("EffectiveScope = %q, want global", got)
	}
}

func TestWarnings(t *testing.T) {
	// A blank engineApi disables the compat check silently — warn, don't error.
	if w := Warnings(Manifest{ID: "x", Name: "X", Version: "1.0.0"}); len(w) != 1 {
		t.Errorf("blank engineApi: got %d warnings %v, want 1", len(w), w)
	}
	// A declared range is fine — no warnings.
	if w := Warnings(Manifest{ID: "x", Name: "X", Version: "1.0.0", EngineAPI: "^1.0.0"}); len(w) != 0 {
		t.Errorf("declared engineApi: got %d warnings %v, want 0", len(w), w)
	}
}

func TestSatisfiesEngineAPI(t *testing.T) {
	cases := []struct {
		rng, version string
		want         bool
	}{
		{"*", "1.0.0", true},
		{"", "9.9.9", true},
		{"1.0.0", "1.0.0", true},
		{"1.0.0", "1.0.1", false},
		{"^1.0.0", "1.0.0", true},
		{"^1.0.0", "1.4.2", true},
		{"^1.2.0", "1.1.0", false},
		{"^1.2.0", "1.2.0", true},
		{"^1.0.0", "2.0.0", false},
		{"^2.0.0", "1.0.0", false},
		{"garbage", "1.0.0", false},
	}
	for _, c := range cases {
		if got := SatisfiesEngineAPI(c.rng, c.version); got != c.want {
			t.Errorf("SatisfiesEngineAPI(%q, %q) = %v, want %v", c.rng, c.version, got, c.want)
		}
	}
}

// TestSatisfiesEngineAPISharedVectors runs the SAME fixture the JS
// satisfiesEngineApi test consumes (web/js-tests/fixtures/engineapi-vectors.json),
// so the Go and JS implementations can't drift apart without a test failing.
func TestSatisfiesEngineAPISharedVectors(t *testing.T) {
	const fixture = "../../../web/js-tests/fixtures/engineapi-vectors.json"
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("read shared vector fixture %s: %v", fixture, err)
	}
	var vectors []struct {
		Range   string `json:"range"`
		Version string `json:"version"`
		Want    bool   `json:"want"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(vectors) == 0 {
		t.Fatal("shared vector fixture is empty")
	}
	for _, v := range vectors {
		if got := SatisfiesEngineAPI(v.Range, v.Version); got != v.Want {
			t.Errorf("SatisfiesEngineAPI(%q, %q) = %v, want %v", v.Range, v.Version, got, v.Want)
		}
	}
}

func TestReadEngineAPIVersion(t *testing.T) {
	// Reads ENGINE_API_VERSION from sdk/version.js when present.
	fsys := fstest.MapFS{
		"sdk/version.js": {Data: []byte("export const ENGINE_API_VERSION = '1.4.0';")},
	}
	if v := ReadEngineAPIVersion(fsys); v != "1.4.0" {
		t.Errorf("ReadEngineAPIVersion = %q, want 1.4.0", v)
	}
	// No sdk/version.js → falls back to the compiled-in default.
	if v := ReadEngineAPIVersion(fstest.MapFS{}); v != DefaultEngineAPIVersion {
		t.Errorf("fallback = %q, want %q", v, DefaultEngineAPIVersion)
	}
}

func TestExpandGlobs(t *testing.T) {
	fsys := fstest.MapFS{
		"context-items/read-context-item.js":  {Data: []byte("//")},
		"context-items/write-context-item.js": {Data: []byte("//")},
		"context-items/edit-base.js":          {Data: []byte("// not matched")},
		"README.md":                           {Data: []byte("ignore")},
	}
	got, err := ExpandGlobs(fsys, []string{"context-items/*-context-item.js"})
	if err != nil {
		t.Fatalf("ExpandGlobs: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("got %d matches %v, want 2", len(got), got)
	}
}

func TestExpandGlobsDeduplicates(t *testing.T) {
	fsys := fstest.MapFS{"a/x-context-item.js": {Data: []byte("//")}}
	// Two overlapping globs must not yield the same file twice.
	got, err := ExpandGlobs(fsys, []string{"a/*.js", "a/x-context-item.js"})
	if err != nil {
		t.Fatalf("ExpandGlobs: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("got %v, want one de-duplicated match", got)
	}
}

func TestExpandGlobsTraversalGuard(t *testing.T) {
	fsys := fstest.MapFS{"x-context-item.js": {Data: []byte("//")}}
	for _, g := range []string{"../../../etc/passwd", "../secrets/*.js", "/etc/*.js", "", "..", "a/../../b"} {
		if _, err := ExpandGlobs(fsys, []string{g}); err == nil {
			t.Errorf("expected traversal rejection for %q", g)
		}
	}
}

func TestExpandGlobsAllowsDotDotInFilename(t *testing.T) {
	// A filename that merely CONTAINS ".." is not a traversal — it must resolve.
	fsys := fstest.MapFS{
		"context-items/foo..bar-context-item.js": {Data: []byte("//")},
		"weird..name/x-context-item.js":          {Data: []byte("//")},
	}
	got, err := ExpandGlobs(fsys, []string{"context-items/*-context-item.js", "weird..name/x-context-item.js"})
	if err != nil {
		t.Fatalf("ExpandGlobs rejected a legit '..'-in-name path: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("got %v, want both '..'-in-name files", got)
	}
}

func TestParseAcceptsI18nWithoutCountingItAsACapability(t *testing.T) {
	m, err := Parse([]byte(`{"id":"@x/y","name":"Y","version":"1.0.0","provides":{"i18n":"i18n"}}`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if m.Provides.I18n != "i18n" {
		t.Fatalf("Provides.I18n = %q, want i18n", m.Provides.I18n)
	}
	// Catalogues translate capabilities; on their own they provide nothing.
	if err := Validate(m, "1.1.0"); err == nil {
		t.Fatal("an extension providing only catalogues must not validate")
	}
}

func TestCanonicalLocaleTagAliases(t *testing.T) {
	// Intl.getCanonicalLocales keeps explicit scripts and unknown subtags, but
	// resolves language, region and variant aliases before catalogue lookup.
	cases := map[string]string{
		"IW-il": "he-IL", "ji": "yi", "in-ID": "id-ID",
		"sh": "sr-Latn", "mo": "ro", "tl": "fil", "cmn": "zh",
		"en-BU": "en-MM", "en-Latn": "en-Latn",
		"ja-Latn-hepburn-heploc": "ja-Latn-alalc97",
		"zz-ZZ-abcde":            "zz-ZZ-abcde", "en-XA": "en-XA",
		"zh-hant-tw": "zh-Hant-TW", "de-CH-1996": "de-CH-1996",
		"no": "no", "nb": "nb", "cnr": "sr-ME", "sh-Cyrl": "sr-Cyrl",
		"hy-SU": "hy-AM", "sr-CS": "sr-RS", "en-AN": "en-CW",
		"iw-ZZ-abcde": "he-ZZ-abcde", "en-Zzzz": "en-Zzzz",
		"ja-Latn-hepburn-alalc97": "ja-Latn-alalc97-hepburn",
		"hy-arevmda":              "hyw", "sgn-DE": "gsg", "en-arevela": "en",
		"de-1901-1901": "", "en-abcde-ABCDE": "",
		"en-US-abc": "", "en_GB": "",
	}
	for in, want := range cases {
		if got := CanonicalLocaleTag(in); got != want {
			t.Errorf("CanonicalLocaleTag(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReadCatalogsLocaleAliases(t *testing.T) {
	catalogs, err := ReadCatalogs(fstest.MapFS{
		"i18n/iw.json":    {Data: []byte(`{"Hello":"שלום"}`)},
		"i18n/he-IL.json": {Data: []byte(`{"Bye":"להתראות"}`)},
	}, ".", "i18n")
	if err != nil {
		t.Fatalf("ReadCatalogs: %v", err)
	}
	for _, locale := range []string{"iw-IL", "he-IL"} {
		got := MergeChain(catalogs, LocaleChain(locale))
		if got["Hello"] != "שלום" || got["Bye"] != "להתראות" {
			t.Errorf("catalogues for %q = %v, want both regional and aliased base messages", locale, got)
		}
	}
}

func TestLocaleChain(t *testing.T) {
	cases := map[string][]string{
		"zh-Hant-TW": {"zh-Hant-TW", "zh-Hant", "zh"},
		"zh-hant-tw": {"zh-Hant-TW", "zh-Hant", "zh"},
		"FR":         {"fr"},
		"en-US-abc":  nil,
		"fr":         {"fr"},
		"en-XA":      {"en-XA"},
		"en-GB":      {"en-GB"},
		"en":         nil,
		"":           nil,
		"../x":       nil,
	}
	for locale, want := range cases {
		got := LocaleChain(locale)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("LocaleChain(%q) = %v, want %v", locale, got, want)
		}
	}
}

func TestReadCatalogs(t *testing.T) {
	ok := fstest.MapFS{
		"ext/i18n/en-XA.json":   {Data: []byte(`{"Hello":"[Ĥéļļö ··]"}`)},
		"ext/i18n/zh-Hant.json": {Data: []byte(`{}`)},
		"ext/i18n/pt-br.json":   {Data: []byte(`{"Hello":"Olá"}`)},
		"ext/i18n/README.md":    {Data: []byte("not a catalogue")},
	}
	got, err := ReadCatalogs(ok, "ext", "i18n")
	if err != nil {
		t.Fatalf("ReadCatalogs: %v", err)
	}
	// Keyed by canonical tag, as LocaleChain looks them up: pt-br.json is pt-BR.
	if len(got) != 3 || got["en-XA"]["Hello"] != "[Ĥéļļö ··]" || got["zh-Hant"] == nil || got["pt-BR"]["Hello"] != "Olá" {
		t.Fatalf("catalogues = %v, want en-XA, zh-Hant and pt-BR", got)
	}

	bad := map[string]struct {
		fsys fstest.MapFS
		dir  string
	}{
		"missing directory":   {fstest.MapFS{"ext/x.js": {Data: []byte("//")}}, "i18n"},
		"escapes the root":    {ok, "../i18n"},
		"absolute":            {ok, "/i18n"},
		"not a locale tag":    {fstest.MapFS{"ext/i18n/en_GB.json": {Data: []byte(`{}`)}}, "i18n"},
		"not json":            {fstest.MapFS{"ext/i18n/fr.json": {Data: []byte(`{`)}}, "i18n"},
		"a non-string value":  {fstest.MapFS{"ext/i18n/fr.json": {Data: []byte(`{"Hello":1}`)}}, "i18n"},
		"nested, not flat":    {fstest.MapFS{"ext/i18n/fr.json": {Data: []byte(`{"a":{"b":"c"}}`)}}, "i18n"},
		"an array, not a map": {fstest.MapFS{"ext/i18n/fr.json": {Data: []byte(`["a"]`)}}, "i18n"},
	}
	for name, c := range bad {
		if _, err := ReadCatalogs(c.fsys, "ext", c.dir); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

// DefaultEngineAPIVersion is the fallback for when web/sdk/version.js cannot be
// read, so it must say what that file says: a stale fallback would judge
// extensions against an SDK the host does not ship.
func TestDefaultEngineAPIVersionMatchesSDK(t *testing.T) {
	if got := ReadEngineAPIVersion(web.Files); got != DefaultEngineAPIVersion {
		t.Fatalf("web/sdk/version.js says %q but DefaultEngineAPIVersion is %q — bump them together", got, DefaultEngineAPIVersion)
	}
}

// TestParsePreset pins the identity-preset file format extension authors write
// to: the shared frontmatter, a required name, a non-empty body — and every way
// a header could leak into the prompt is an error instead.
func TestParsePreset(t *testing.T) {
	cases := []struct {
		name, src     string
		want          Preset
		wantErrSubstr string
	}{
		{name: "fields and body", src: "---\nname: \"A \\\"b\\\"\"\ndescription: 'd: e'\nother: x\n---\n\n  body\n",
			want: Preset{Path: "p/assistant.md", Stem: "assistant", Name: `A "b"`, Description: "d: e", Content: "body"}},
		{name: "CRLF and trailing spaces on fences", src: "--- \r\nname: A\r\n---\t\r\nbody\r\n",
			want: Preset{Path: "p/assistant.md", Stem: "assistant", Name: "A", Content: "body"}},
		{name: "keys are case-sensitive", src: "---\nName: A\n---\nbody", wantErrSubstr: "name"},
		{name: "no frontmatter", src: "name: A\nbody", wantErrSubstr: "missing YAML frontmatter"},
		{name: "unterminated", src: "---\nname: A\nbody", wantErrSubstr: "unterminated"},
		{name: "empty body", src: "---\nname: A\n---\n  \n", wantErrSubstr: "no prompt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParsePreset("p/assistant.md", []byte(tc.src))
			if tc.wantErrSubstr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErrSubstr) {
					t.Fatalf("err = %v, want one containing %q", err, tc.wantErrSubstr)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %+v, %v; want %+v", got, err, tc.want)
			}
		})
	}
}

// TestReadPresetsKeepsFirstOfAStem pins that two files with one stem (from two
// globs) do not both claim the id: the first keeps it, the second is reported.
func TestReadPresetsKeepsFirstOfAStem(t *testing.T) {
	fsys := fstest.MapFS{
		"a/x.md": {Data: []byte("---\nname: First\n---\nbody")},
		"b/x.md": {Data: []byte("---\nname: Second\n---\nbody")},
	}
	got, problems := ReadPresets(fsys, []string{"a/x.md", "b/x.md"})
	if len(got) != 1 || got[0].Name != "First" || len(problems) != 1 {
		t.Fatalf("got %+v, problems %v", got, problems)
	}
}
