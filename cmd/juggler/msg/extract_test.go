//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package msg

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// i18nScript is the catalogue tooling whose Go extraction these tests drive.
const i18nScript = "../../../scripts/i18n"

// runI18n runs scripts/i18n with args, returning its combined output and
// whether it exited zero. Skips when there is no node to run it with.
func runI18n(t *testing.T, args ...string) (string, bool) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.Command(node, append([]string{i18nScript}, args...)...).CombinedOutput()
	return string(out), err == nil
}

// readCatalog reads a catalogue file.
func readCatalog(t *testing.T, file string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	var messages map[string]string
	if err := json.Unmarshal(data, &messages); err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	return messages
}

// `scripts/i18n extract --go-root <dir> --catalog <dir>` collects the template
// of every msg.New, msg.NewCtx and msg.NewError call in the Go under the root
// — decoding interpreted and raw literals as the compiler does, and skipping
// comments, other strings and test files — into the catalogue directory.
func TestExtractGoMessages(t *testing.T) {
	catalog := t.TempDir()
	out, ok := runI18n(t, "extract", "--go-root", "testdata/extract/good", "--catalog", catalog)
	if !ok {
		t.Fatalf("extract failed:\n%s", out)
	}
	got := readCatalog(t, filepath.Join(catalog, "en.json"))
	want := map[string]string{
		"Plain":                           "Plain",
		"Model {name} not found":          "Model {name} not found",
		"Tab\there \"quoted\" café é A 😀": "Tab\there \"quoted\" café é A 😀",
		`raw {path} \n stays`:             `raw {path} \n stays`,
		"split across lines":              "split across lines",
		"verb\u0004Open":                  "Open",
		"Cannot reach {host}":             "Cannot reach {host}",
		"newline after paren":             "newline after paren",
		"after a rune":                    "after a rune",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("en.json keys = %q\nwant %q", sortedKeys(got), sortedKeys(want))
	}
	pseudo := readCatalog(t, filepath.Join(catalog, "en-XA.json"))
	if !reflect.DeepEqual(sortedKeys(pseudo), sortedKeys(want)) || !strings.HasPrefix(pseudo["Plain"], "[") {
		t.Errorf("en-XA.json = %q, want the pseudo-locale of every message", pseudo)
	}

	// check agrees with what extract wrote, and fails once it is stale.
	if out, ok := runI18n(t, "check", "--go-root", "testdata/extract/good", "--catalog", catalog); !ok {
		t.Fatalf("check failed on a fresh catalogue:\n%s", out)
	}
	if err := os.WriteFile(filepath.Join(catalog, "en.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, ok := runI18n(t, "check", "--go-root", "testdata/extract/good", "--catalog", catalog); ok {
		t.Fatalf("check passed a stale catalogue:\n%s", out)
	}
}

// `scripts/i18n coverage` passes a catalogue only when it has a file for each
// language web/i18n has, translating every message in its en.json.
func TestCoverageRequiresEveryLanguageInFull(t *testing.T) {
	catalog := t.TempDir()
	args := []string{"--go-root", "testdata/extract/good", "--catalog", catalog}
	if out, ok := runI18n(t, append([]string{"extract"}, args...)...); !ok {
		t.Fatalf("extract failed:\n%s", out)
	}
	source := readCatalog(t, filepath.Join(catalog, "en.json"))
	locales, err := filepath.Glob("../../../web/i18n/*.json")
	if err != nil {
		t.Fatal(err)
	}
	var languages []string
	for _, f := range locales {
		if name := strings.TrimSuffix(filepath.Base(f), ".json"); name != "en" && name != "en-XA" {
			languages = append(languages, name)
		}
	}
	if len(languages) == 0 {
		t.Fatal("web/i18n has no translations to hold the catalogue to")
	}

	if out, ok := runI18n(t, append([]string{"coverage"}, args...)...); ok {
		t.Fatalf("coverage passed a catalogue with no translations:\n%s", out)
	} else if !strings.Contains(out, languages[0]+".json") {
		t.Fatalf("coverage does not name the missing %s.json:\n%s", languages[0], out)
	}

	write := func(language string, messages map[string]string) {
		t.Helper()
		data, err := json.Marshal(messages)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(catalog, language+".json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, language := range languages {
		write(language, source)
	}
	if out, ok := runI18n(t, append([]string{"coverage"}, args...)...); !ok {
		t.Fatalf("coverage failed a fully translated catalogue:\n%s", out)
	}

	partial := map[string]string{}
	for k, v := range source {
		partial[k] = v
	}
	partial["Plain"] = ""
	write(languages[0], partial)
	out, ok := runI18n(t, append([]string{"coverage"}, args...)...)
	if ok {
		t.Fatalf("coverage passed a catalogue with an empty translation:\n%s", out)
	}
	if !strings.Contains(out, languages[0]+".json") || !strings.Contains(out, `"Plain"`) {
		t.Fatalf("coverage does not name the file and the untranslated key:\n%s", out)
	}
}

// A template that is not a literal would never be extracted, and so never
// translated: extraction refuses it.
func TestExtractRefusesANonLiteralTemplate(t *testing.T) {
	out, ok := runI18n(t, "extract", "--go-root", "testdata/extract/bad", "--catalog", t.TempDir())
	if ok {
		t.Fatalf("extract accepted msg.New(template):\n%s", out)
	}
	if !strings.Contains(out, "sample.go:7") || !strings.Contains(out, "string literal") {
		t.Fatalf("the problem does not name the call: %s", out)
	}
}

// sortedKeys lists a catalogue's keys, sorted, for a failure message.
func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
