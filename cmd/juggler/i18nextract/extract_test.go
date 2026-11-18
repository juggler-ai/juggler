//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package i18nextract

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// extensionContainers are the trees scripts/i18n generates extension
// catalogues for, relative to this package.
var extensionContainers = []string{"../../../web/extensions", "../../../examples/extensions"}

// TestCataloguesMatchScriptsI18n extracts every extension in the repo that has
// its own catalogue and compares the result, byte for byte, with the en.json
// and en-XA.json scripts/i18n wrote for it (which `scripts/i18n check`, run by
// lint, keeps current). An extension author's catalogue is then exactly what
// the built-in ones are.
func TestCataloguesMatchScriptsI18n(t *testing.T) {
	found := map[string]bool{}
	for _, container := range extensionContainers {
		entries, err := os.ReadDir(container)
		if err != nil {
			t.Fatalf("read %s: %v", container, err)
		}
		for _, entry := range entries {
			root := filepath.Join(container, entry.Name())
			if !entry.IsDir() {
				continue
			}
			if _, err := os.Stat(filepath.Join(root, "juggler.extension.json")); err != nil {
				continue
			}
			ext, err := Extract(root)
			if err == ErrNoCatalogue {
				continue
			}
			found[entry.Name()] = true
			t.Run(entry.Name(), func(t *testing.T) {
				if err != nil {
					t.Fatalf("Extract: %v", err)
				}
				if len(ext.Problems) > 0 {
					t.Errorf("problems: %q", ext.Problems)
				}
				compareFile(t, filepath.Join(ext.CatalogDir, "en.json"), Serialize(ext.Messages))
				compareFile(t, filepath.Join(ext.CatalogDir, "en-XA.json"), Serialize(Pseudo(ext.Messages)))
			})
		}
	}
	// Each of these has its own catalogue; finding fewer means the walk, not
	// the extraction, went wrong and the loop above passed vacuously.
	for _, name := range []string{"juggler-core", "juggler-mcp", "about-juggler", "search-backends", "hello-tool"} {
		if !found[name] {
			t.Errorf("no catalogue extracted for %s", name)
		}
	}
}

// compareFile fails when file's content, line endings aside, is not want,
// naming the first keys that differ.
func compareFile(t *testing.T, file string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	got = bytes.ReplaceAll(got, []byte("\r\n"), []byte("\n"))
	if bytes.Equal(got, want) {
		return
	}
	gotLines := strings.Split(string(got), "\n")
	wantLines := strings.Split(string(want), "\n")
	for i := 0; i < len(gotLines) || i < len(wantLines); i++ {
		var g, w string
		if i < len(gotLines) {
			g = gotLines[i]
		}
		if i < len(wantLines) {
			w = wantLines[i]
		}
		if g != w {
			t.Fatalf("%s differs from the Go extraction at line %d:\n file: %s\n   go: %s", file, i+1, g, w)
		}
	}
	t.Fatalf("%s differs from the Go extraction", file)
}

// jsCase is one module and what extraction must find in it.
type jsCase struct {
	name     string
	src      string
	want     []string // catalogue keys
	problems []string // substrings, one per problem, in order
}

// The shapes scripts/i18n accepts and refuses, each against the AST rule it
// follows: a call whose callee is a bare identifier bound by an import from an
// i18n module (or by `= translator(…)`), a static first argument, and an
// options argument whose context is readable.
var jsCases = []jsCase{
	{
		name: "a literal, a template and a concatenation",
		src: `import { t } from 'juggler/i18n';
t('Plain'); t(` + "`Template`" + `); t('Split ' + "across " + ` + "`lines`" + `); t(('Paren') + 'thesised');`,
		want: []string{"Paren" + "thesised", "Plain", "Split across lines", "Template"},
	},
	{
		name: "escapes are decoded as JS reads them",
		src: `import { t } from 'juggler/i18n';
t('Tab\there \'q\' \x41\u0042\u{43} \u00e9 \uD83D\uDE00 a\
b'); t(` + "`line\\nnext ${'$'}{x}`" + `);`,
		want: []string{"Tab\there 'q' ABC é 😀 ab"},
	},
	{
		name: "a raw newline in a template, CRLF normalised",
		src:  "import { t } from 'juggler/i18n';\r\nt(`one\r\ntwo`);",
		want: []string{"one\ntwo"},
	},
	{
		name: "aliases, markForTranslation and a relative i18n.js",
		src: `import { t as tr, markForTranslation as mark } from '../lib/i18n.js';
import { t as other } from './not-i18n.js';
tr('Aliased'); mark('Marked'); t('Unbound'); other('Elsewhere');`,
		want: []string{"Aliased", "Marked"},
	},
	{
		name: "translator() binds a t, wherever it is declared",
		src: `import { translator as tx } from 'juggler/i18n';
t('Used before the declaration');
const a = 1, t = tx('@me/ext');
let u = (tx('@me/ext'));
const { v = tx('x') } = {};
w = tx('x');
const z = tx('x').bind(null);
u('Via u'); v('Not v'); w('Not w'); z('Not z');`,
		want: []string{"Used before the declaration", "Via u"},
	},
	{
		name: "only a plain call is a message",
		src: `import { t } from 'juggler/i18n';
obj.t('Member'); obj?.t('Optional member'); new t('New'); function t2() {}
class A { t(x) { return x; } static t(y) {} }
const o = { t(z) {} };
t?.('Optional call'); t ('Spaced'); t/* c */('Commented');`,
		want: []string{"Commented", "Optional call", "Spaced"},
	},
	{
		name: "a call that is not static is skipped silently",
		src: `import { t } from 'juggler/i18n';
t(name); t(` + "`Hi ${name}`" + `); t('a' + b); t(-'x'); t('a' - 'b'); t(...xs); t(); t('a' ? 'b' : 'c');`,
		want: []string{},
	},
	{
		name: "comments, strings, templates and regexes hide calls",
		src: `import { t } from 'juggler/i18n';
// t('Line comment')
/* t('Block comment') */
const s = "t('In a string')";
const tpl = ` + "`t('In a template') ${t('In a substitution')} ${ {a: `nested ${t('Deep')}`}.a }`" + `;
const re = /t\('In a regex'\)[/]/g;
const div = a / b / t('After division');
if (x) /t('regex after if')/.test(y);
t('Last');`,
		want: []string{"After division", "Deep", "In a substitution", "Last"},
	},
	{
		name: "contexts",
		src: `import { t } from 'juggler/i18n';
t('Open', undefined, { context: 'verb' });
t('Open', {}, { 'context': ` + "`state`" + `, other: x });
t('Plain', {}, { other: 1 });
t('Empty context', {}, { context: '' });
t('No options', p, undefined);
t('Trailing', p, { context: 'c' },);`,
		want: []string{"Empty context", "No options", "Plain", "c\u0004Trailing", "state\u0004Open", "verb\u0004Open"},
	},
	{
		name: "unreadable options are refused",
		src: `import { t } from 'juggler/i18n';
t('A', {}, opts);
t('B', {}, { ...opts });
t('C', {}, { [key]: 'x' });
t('D', {}, { context: ctx });
t('E', {}, { context });
t('F', {}, { context: 'ok' }.x);`,
		want: []string{},
		problems: []string{
			"m.js:2: t() options must be an inline object literal with plain keys",
			"m.js:3: t() options must be an inline object literal",
			"m.js:4: t() options must be an inline object literal",
			"m.js:5: t() context must be a literal",
			"m.js:6: t() context must be a literal",
			"m.js:7: t() options must be an inline object literal",
		},
	},
	{
		name: "a capability's MANIFEST",
		src: `export default class X {
  static MANIFEST = {
    id: 'x', name: 'Display name', 'description': 'What ' + 'it does',
    addLabel: ` + "`Add one`" + `, eyebrow: 'Eyebrow', setupLabel: 'Set up',
    version: '1.0.0', author: 'Someone', other: 'Not collected', label: '123',
    recommendations: { bestFor: 'Best', avoidFor: 'Avoid', notes: ['Note one', , 'Note two', x], other: 'No' },
    [computed]: 'No', ...spread,
  };
  static OTHER = { name: 'Not a manifest' };
  MANIFEST = { name: 'Not static' };
}
const y = { MANIFEST: { name: 'Not a class field' } };
class Z { static MANIFEST = { name: 'Digits only: 42', description: '42' }; }
class W { static MANIFEST = { name: 'Member' }.x; }`,
		want: []string{"Add one", "Avoid", "Best", "Digits only: 42", "Display name", "Eyebrow", "Note one", "Note two", "Set up", "What it does"},
	},
	{
		name: "a MANIFEST ended by a newline, then a method",
		src: `class X {
  static MANIFEST = { name: 'First' }
  static GUIDANCE = 'g'
  method() { return 1; }
}`,
		want: []string{"First"},
	},
	{
		name: "a file that mentions neither i18n nor MANIFEST is not read",
		src:  `t('Nothing imports t here');`,
		want: []string{},
	},
	{
		name: "integer-like keys",
		src: `import { t } from 'juggler/i18n';
t('10'); t('9'); t('b'); t('A');`,
		want: []string{"10", "9", "A", "b"},
	},
}

func TestExtractJS(t *testing.T) {
	for _, c := range jsCases {
		t.Run(c.name, func(t *testing.T) {
			messages := map[string]string{}
			problems := extractJS([]byte(c.src), "m.js", messages)
			keys := make([]string, 0, len(messages))
			for k := range messages {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			want := append([]string{}, c.want...)
			sort.Strings(want)
			if !reflect.DeepEqual(keys, want) {
				t.Errorf("keys = %q\nwant %q", keys, want)
			}
			if len(problems) != len(c.problems) {
				t.Fatalf("problems = %q, want %d", problems, len(c.problems))
			}
			for i, p := range c.problems {
				if !strings.Contains(problems[i], p) {
					t.Errorf("problem %d = %q, want it to contain %q", i, problems[i], p)
				}
			}
		})
	}
}

// Serialize writes what JSON.stringify(sorted, null, 2) + '\n' writes: keys in
// UTF-16 order with integer-like keys first, JSON.stringify's escaping (not
// encoding/json's, which escapes <, > and &).
func TestSerialize(t *testing.T) {
	got := string(Serialize(map[string]string{
		"b": "<b> & \u2028", "a": "q\"\\\n\t\x01\x7f", "10": "ten", "9": "nine", "007": "x",
		"\uffff": "bmp", "😀": "astral", "verb\u0004Open": "Open",
	}))
	want := "{\n" +
		`  "9": "nine",` + "\n" +
		`  "10": "ten",` + "\n" +
		`  "007": "x",` + "\n" +
		`  "a": "q\"\\\n\t\u0001` + "\x7f" + `",` + "\n" +
		`  "b": "<b> & ` + "\u2028" + `",` + "\n" +
		`  "verb\u0004Open": "Open",` + "\n" +
		`  "😀": "astral",` + "\n" +
		`  "` + "\uffff" + `": "bmp"` + "\n" +
		"}\n"
	if got != want {
		t.Errorf("Serialize =\n%s\nwant\n%s", got, want)
	}
	if got := string(Serialize(map[string]string{})); got != "{}\n" {
		t.Errorf("empty = %q", got)
	}
}
