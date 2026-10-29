//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package i18nextract

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
)

// translationFixture holds the catalogues both checkers are run over:
// CheckTranslation here and translationProblems() in scripts/i18n.
const translationFixture = "testdata/translation-check.json"

// i18nScript is the catalogue tooling this package ports.
const i18nScript = "../../../scripts/i18n"

// fixtureCase is one catalogue in the fixture and the problems it has.
type fixtureCase struct {
	Name            string            `json:"name"`
	Locale          string            `json:"locale"`
	Source          map[string]string `json:"source"`
	Translation     json.RawMessage   `json:"translation"`
	TranslationText *string           `json:"translationText"`
	Problems        []problemKind     `json:"problems"`
}

// problemKind is a problem as the fixture names it: where, and what kind.
type problemKind struct {
	Key  *string `json:"key"`
	Kind string  `json:"kind"`
}

func (k problemKind) String() string {
	if k.Key == nil {
		return "(file) " + k.Kind
	}
	quoted, _ := json.Marshal(*k.Key)
	return string(quoted) + " " + k.Kind
}

// text is the catalogue file's content.
func (c fixtureCase) text() []byte {
	if c.TranslationText != nil {
		return []byte(*c.TranslationText)
	}
	return c.Translation
}

func loadTranslationFixture(t *testing.T) []fixtureCase {
	t.Helper()
	data, err := os.ReadFile(translationFixture)
	if err != nil {
		t.Fatalf("read %s: %v", translationFixture, err)
	}
	var fixture struct {
		Cases []fixtureCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("parse %s: %v", translationFixture, err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("the fixture is empty")
	}
	return fixture.Cases
}

// kindsOf is what the fixture compares of a list of problems.
func kindsOf(problems []TranslationProblem) []problemKind {
	out := []problemKind{}
	for _, p := range problems {
		out = append(out, problemKind{Key: p.Key, Kind: p.Kind})
	}
	return out
}

func kindStrings(kinds []problemKind) []string {
	out := []string{}
	for _, k := range kinds {
		out = append(out, k.String())
	}
	return out
}

// CheckTranslation finds exactly the fixture's problems, in its order.
func TestCheckTranslationFixture(t *testing.T) {
	for _, c := range loadTranslationFixture(t) {
		t.Run(c.Name, func(t *testing.T) {
			got := kindStrings(kindsOf(CheckTranslation(c.Source, c.text(), c.Locale)))
			if want := kindStrings(c.Problems); !reflect.DeepEqual(got, want) {
				t.Errorf("problems = %q\nwant       %q", got, want)
			}
		})
	}
}

// nodeProblem is a problem as translationProblems() in scripts/i18n returns it.
type nodeProblem struct {
	Key     *string `json:"key"`
	Kind    string  `json:"kind"`
	Message string  `json:"message"`
}

// scripts/i18n's check finds the fixture's problems too, and words each one
// exactly as CheckTranslation does, so `juggler ext i18n check` and the
// repository's lint read alike.
func TestCheckTranslationMatchesScriptsI18n(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	cases := loadTranslationFixture(t)
	script, _ := filepath.Abs(i18nScript)
	fixture, _ := filepath.Abs(translationFixture)
	const program = `
const fs = require('fs');
const i18n = require(process.argv[1]);
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
i18n.loadSdk().then((sdk) => {
  const results = fixture.cases.map((c) => i18n.translationProblems(sdk, c.source,
    'translationText' in c ? c.translationText : JSON.stringify(c.translation), c.locale));
  process.stdout.write(JSON.stringify(results));
});`
	out, err := exec.Command(node, "-e", program, script, fixture).Output()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	var results [][]nodeProblem
	if err := json.Unmarshal(out, &results); err != nil {
		t.Fatalf("parse node output: %v\n%s", err, out)
	}
	if len(results) != len(cases) {
		t.Fatalf("node checked %d cases, want %d", len(results), len(cases))
	}
	for i, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var kinds []problemKind
			var messages []string
			for _, p := range results[i] {
				kinds = append(kinds, problemKind{Key: p.Key, Kind: p.Kind})
				messages = append(messages, p.Message)
			}
			if got, want := kindStrings(kinds), kindStrings(c.Problems); !reflect.DeepEqual(got, want) {
				t.Errorf("scripts/i18n problems = %q\nwant                   %q", got, want)
			}
			var goMessages []string
			for _, p := range CheckTranslation(c.Source, c.text(), c.Locale) {
				goMessages = append(goMessages, p.Message)
			}
			if !reflect.DeepEqual(messages, goMessages) {
				t.Errorf("messages differ:\nscripts/i18n %q\ngo           %q", messages, goMessages)
			}
		})
	}
}

// pluralCategoriesProgram prints, as JSON, the plural categories
// Intl.PluralRules gives every two- and three-letter language it supports.
const pluralCategoriesProgram = `
const letters = 'abcdefghijklmnopqrstuvwxyz';
const out = {};
for (const a of letters) for (const b of letters) for (const code of [a + b, ...[...letters].map((c) => a + b + c)]) {
  if (Intl.PluralRules.supportedLocalesOf([code]).length) {
    out[code] = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  }
}
process.stdout.write(JSON.stringify(out));`

// The plural categories table is what Node's Intl says: scripts/i18n asks
// Intl, so the two checks accept the same branches. When Node's CLDR data
// moves, regenerate the table with JUGGLER_I18N_WRITE_PLURALS=1. Both sides
// are compared in pluralOrder: the order resolvedOptions() lists them in
// differs between Node releases, and messages name them in pluralOrder.
func TestPluralCategoriesMatchIntl(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.Command(node, "-e", pluralCategoriesProgram).Output()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	var want map[string][]string
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatalf("parse node output: %v", err)
	}
	if os.Getenv("JUGGLER_I18N_WRITE_PLURALS") == "1" {
		if err := os.WriteFile(pluralCategoriesFile, serializePluralTable(want), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s: %d languages", pluralCategoriesFile, len(want))
		return
	}
	got := pluralTable()
	for lang, cats := range want {
		if !reflect.DeepEqual(got[lang], inPluralOrder(cats)) {
			t.Errorf("%s: table has %q, Intl has %q (regenerate: JUGGLER_I18N_WRITE_PLURALS=1)", lang, got[lang], cats)
		}
	}
	for lang := range got {
		if _, ok := want[lang]; !ok {
			t.Errorf("%s: in the table, but Intl has no plural rules for it (regenerate: JUGGLER_I18N_WRITE_PLURALS=1)", lang)
		}
	}
}

func TestPluralCategories(t *testing.T) {
	for locale, want := range map[string][]string{
		"fr": {"one", "many", "other"}, "pt-BR": {"one", "many", "other"}, "ja": {"other"},
		"zh-Hant-TW": {"other"}, "FR": {"one", "many", "other"},
		"xx": nil, "fr_FR": nil, "": nil, "-": nil,
	} {
		if got := PluralCategories(locale); !reflect.DeepEqual(got, want) {
			t.Errorf("PluralCategories(%q) = %q, want %q", locale, got, want)
		}
	}
}

// checkRoot is Go source whose messages make the catalogue
// `scripts/i18n check --go-root` holds a translation file to.
const checkRoot = "testdata/check-go"

// `scripts/i18n check` holds every translation file to its catalogue's
// messages — naming the file, the key and the problem — and `status` counts
// an empty translation as missing.
func TestScriptsI18nCheckValidatesTranslations(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	catalog := t.TempDir()
	run := func(args ...string) (string, bool) {
		cmd := exec.Command(node, append([]string{i18nScript}, append(args, "--go-root", checkRoot, "--catalog", catalog)...)...)
		out, err := cmd.CombinedOutput()
		return string(out), err == nil
	}
	if out, ok := run("extract"); !ok {
		t.Fatalf("extract failed:\n%s", out)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(catalog, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("fr.json", `{"Greeted {name}": "Salué {name}", "Saved": ""}`)
	if out, ok := run("check"); !ok {
		t.Fatalf("check failed on a good translation:\n%s", out)
	}
	if out, _ := run("status"); !strings.Contains(out, "fr: 1/2 (50%)") {
		t.Errorf("status does not count the empty translation as missing:\n%s", out)
	}

	write("fr.json", `{"Greeted {name}": "Salué {nom}", "Old wording": "Ancien"}`)
	out, ok := run("check")
	if ok {
		t.Fatalf("check passed a bad translation:\n%s", out)
	}
	for _, want := range []string{
		`/fr.json: "Greeted {name}": uses {nom}, which the English does not have`,
		`/fr.json: "Greeted {name}": drops {name}, which the English has`,
		`/fr.json: "Old wording": not in en.json — the English changed or was removed; retranslate it`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("check output lacks %q:\n%s", want, out)
		}
	}
}

// inPluralOrder is a sorted copy of categories, in pluralOrder.
func inPluralOrder(categories []string) []string {
	return slices.SortedFunc(slices.Values(categories), func(x, y string) int {
		return slices.Index(pluralOrder, x) - slices.Index(pluralOrder, y)
	})
}

// serializePluralTable is the text of pluralCategoriesFile for table: one
// language a line, sorted, each language's categories in pluralOrder.
func serializePluralTable(table map[string][]string) []byte {
	langs := make([]string, 0, len(table))
	for lang := range table {
		langs = append(langs, lang)
	}
	sort.Strings(langs)
	var b strings.Builder
	b.WriteString("{\n")
	for i, lang := range langs {
		cats, _ := json.Marshal(inPluralOrder(table[lang]))
		fmt.Fprintf(&b, "  %q: %s", lang, cats)
		if i < len(langs)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString("}\n")
	return []byte(b.String())
}
