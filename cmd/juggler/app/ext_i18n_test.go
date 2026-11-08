//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// i18nFixture writes an extension with a catalogue directory, a tool using
// t() and a capability MANIFEST, and returns its root.
func i18nFixture(t *testing.T, manifest string) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		extManifestFile: manifest,
		"context-items/greet-context-item.js": `import ContextItem from 'juggler/context-item';
import { translator } from 'juggler/i18n';

const t = translator('@me/greet');

export default class GreetContextItem extends ContextItem {
  static MANIFEST = { id: 'greet', name: 'Greeter', description: 'Says hello' };

  getSummary() {
    return { summary: t('Greeted {name}', { name: 'x' }), details: t('Open', {}, { context: 'verb' }) };
  }
}
`,
		"_tests/greet-test.js": `import { t } from 'juggler/i18n';
t('A test is not shipped UI');
`,
	}
	for rel, content := range files {
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

const i18nManifest = `{
  "id": "@me/greet", "name": "Greet", "version": "1.0.0", "engineApi": "^1.0.0",
  "settings": [{ "key": "style", "label": "Greeting style", "type": "select", "options": ["Formal", "casual", "42"] }],
  "provides": { "contextItems": ["context-items/*-context-item.js"], "i18n": "i18n" }
}
`

// runI18nCLI runs `juggler ext i18n <args>`, returning its exit code and output.
func runI18nCLI(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := runExtI18n(args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

// extract writes en.json (every message, sorted) and en-XA.json; check passes
// on what it wrote and fails, naming the catalogue, once a t() literal changes.
func TestExtI18nExtractThenCheck(t *testing.T) {
	dir := i18nFixture(t, i18nManifest)
	code, out, errOut := runI18nCLI("extract", dir)
	if code != 0 {
		t.Fatalf("extract exit %d\nstdout: %s\nstderr: %s", code, out, errOut)
	}
	en, err := os.ReadFile(filepath.Join(dir, "i18n", "en.json"))
	if err != nil {
		t.Fatal(err)
	}
	want := `{
  "Formal": "Formal",
  "Greet": "Greet",
  "Greeted {name}": "Greeted {name}",
  "Greeter": "Greeter",
  "Greeting style": "Greeting style",
  "Says hello": "Says hello",
  "casual": "casual",
  "verb\u0004Open": "Open"
}
`
	if string(en) != want {
		t.Errorf("en.json =\n%s\nwant\n%s", en, want)
	}
	xa, err := os.ReadFile(filepath.Join(dir, "i18n", "en-XA.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(xa), `"Greeted {name}": "[Ĝŕééţéð {name} ··]"`) {
		t.Errorf("en-XA.json does not hold the pseudo-locale:\n%s", xa)
	}
	if !strings.Contains(out, "8 message(s)") {
		t.Errorf("extract output = %q, want the message count", out)
	}

	if code, out, errOut := runI18nCLI("check", dir); code != 0 {
		t.Fatalf("check failed on a fresh catalogue: exit %d\nstdout: %s\nstderr: %s", code, out, errOut)
	}

	src := filepath.Join(dir, "context-items", "greet-context-item.js")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, bytes.Replace(data, []byte("Greeted {name}"), []byte("Welcomed {name}"), 1), 0o644); err != nil {
		t.Fatal(err)
	}
	code, _, errOut = runI18nCLI("check", dir)
	if code != 1 {
		t.Fatalf("check of a stale catalogue: exit %d, want 1", code)
	}
	if !strings.Contains(errOut, "out of date") || !strings.Contains(errOut, "juggler ext i18n extract") {
		t.Errorf("check does not say what is stale and how to fix it: %s", errOut)
	}
}

// A translation whose English was reworded is reported by extract as stale.
func TestExtI18nExtractReportsStaleTranslations(t *testing.T) {
	dir := i18nFixture(t, i18nManifest)
	if err := os.MkdirAll(filepath.Join(dir, "i18n"), 0o755); err != nil {
		t.Fatal(err)
	}
	fr := `{ "Greeter": "Salueur", "Old wording": "Ancien" }`
	if err := os.WriteFile(filepath.Join(dir, "i18n", "fr.json"), []byte(fr), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := runI18nCLI("extract", dir)
	if code != 0 {
		t.Fatalf("extract exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "fr.json: 1 stale key(s)") || !strings.Contains(out, `"Old wording"`) {
		t.Errorf("extract did not report the stale key: %s", out)
	}
}

// check holds every translation to the extension's messages, naming the file,
// the key and the problem; a stale key fails it, and an empty value is merely
// untranslated.
func TestExtI18nCheckValidatesTranslations(t *testing.T) {
	dir := i18nFixture(t, i18nManifest)
	if code, _, errOut := runI18nCLI("extract", dir); code != 0 {
		t.Fatalf("extract exit %d: %s", code, errOut)
	}
	fr := filepath.Join(dir, "i18n", "fr.json")
	write := func(content string) {
		t.Helper()
		if err := os.WriteFile(fr, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(`{ "Greeted {name}": "Salué {name}", "Greeter": "", "verb\u0004Open": "Ouvrir" }`)
	if code, _, errOut := runI18nCLI("check", dir); code != 0 {
		t.Fatalf("check of a good translation: exit %d\n%s", code, errOut)
	}

	write(`{ "Greeted {name}": "Salué <b>{nom}</b>", "Old wording": "Ancien", "Greeter": 3 }`)
	code, _, errOut := runI18nCLI("check", dir)
	if code != 1 {
		t.Fatalf("check of a bad translation: exit %d, want 1\n%s", code, errOut)
	}
	label := filepath.ToSlash(filepath.Join(dir, "i18n", "fr.json"))
	for _, want := range []string{
		label + `: "Greeted {name}": uses {nom}, which the English does not have`,
		label + `: "Greeted {name}": drops {name}, which the English has`,
		label + `: "Greeted {name}": has HTML markup (<b>), which the English does not`,
		label + `: "Greeter": the translation is not a string`,
		label + `: "Old wording": not in en.json — the English changed or was removed; retranslate it`,
	} {
		if !strings.Contains(errOut, want) {
			t.Errorf("check output lacks %q:\n%s", want, errOut)
		}
	}

	write(`{ "Greeted {name}": "Salué {name}", }`)
	if code, _, errOut := runI18nCLI("check", dir); code != 1 || !strings.Contains(errOut, label+": does not parse as JSON") {
		t.Errorf("check of a file that is not JSON: exit %d\n%s", code, errOut)
	}
}

// pseudo regenerates en-XA.json from en.json as it stands.
func TestExtI18nPseudo(t *testing.T) {
	dir := i18nFixture(t, i18nManifest)
	if err := os.MkdirAll(filepath.Join(dir, "i18n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "i18n", "en.json"), []byte(`{"Close": "Close"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, errOut := runI18nCLI("pseudo", dir); code != 0 {
		t.Fatalf("pseudo exit %d: %s", code, errOut)
	}
	xa, err := os.ReadFile(filepath.Join(dir, "i18n", "en-XA.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(xa) != "{\n  \"Close\": \"[Çļöšé ··]\"\n}\n" {
		t.Errorf("en-XA.json = %q", xa)
	}
}

// A context that is not a literal would file the message under a key the
// runtime never asks for: extract refuses it, naming the call.
func TestExtI18nRefusesANonLiteralContext(t *testing.T) {
	dir := i18nFixture(t, i18nManifest)
	bad := "import { t } from 'juggler/i18n';\n\nt('Open', {}, { context: which });\n"
	if err := os.WriteFile(filepath.Join(dir, "context-items", "bad.js"), []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	code, _, errOut := runI18nCLI("extract", dir)
	if code != 1 {
		t.Fatalf("extract exit %d, want 1", code)
	}
	if !strings.Contains(errOut, filepath.ToSlash(filepath.Join(dir, "context-items", "bad.js"))+":3") ||
		!strings.Contains(errOut, "context must be a literal") {
		t.Errorf("the problem does not name the call: %s", errOut)
	}
	if code, _, _ := runI18nCLI("check", dir); code != 1 {
		t.Errorf("check exit %d, want 1", code)
	}
}

// An extension with no catalogue directory has nowhere to write one.
func TestExtI18nNeedsProvidesI18n(t *testing.T) {
	dir := i18nFixture(t, strings.Replace(i18nManifest, `, "i18n": "i18n"`, "", 1))
	for _, sub := range []string{"extract", "pseudo", "check"} {
		code, _, errOut := runI18nCLI(sub, dir)
		if code != 1 || !strings.Contains(errOut, "provides.i18n") {
			t.Errorf("%s: exit %d, stderr %q; want 1 naming provides.i18n", sub, code, errOut)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "i18n")); err == nil {
		t.Error("a catalogue directory was created")
	}
}

func TestExtI18nUsage(t *testing.T) {
	for _, args := range [][]string{nil, {"status"}, {"extract", "a", "b"}} {
		if code, _, errOut := runI18nCLI(args...); code != 2 || errOut == "" {
			t.Errorf("%q: exit %d, stderr %q; want 2 and usage", args, code, errOut)
		}
	}
}
