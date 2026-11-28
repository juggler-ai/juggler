//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package pagetmpl

import (
	"bytes"
	htmltemplate "html/template"
	"io/fs"
	"strings"
	"testing"

	"golang.org/x/net/html"

	"juggler/web"
)

// The pages drawn with this package, each as the files parsed for it (the page
// first) and a function giving its data with every string set to s and every
// flag to on.
type page struct {
	name  string
	files []string
	data  func(s string, on bool) any
}

type machineConfig struct {
	Token  string   `json:"token"`
	Host   string   `json:"host"`
	Local  bool     `json:"local"`
	Panels []string `json:"panels,omitempty"`
}

type standInButton struct {
	Label, Action, Busy string
	Primary             bool
}

func catalogOf(s string, on bool) map[string]string {
	if !on {
		return nil
	}
	return map[string]string{"Hello": s, s: "Bonjour"}
}

var pages = []page{
	{
		name:  "session",
		files: []string{"index.html", "shell/window-shell.html"},
		data: func(s string, on bool) any {
			n := 0
			if on {
				n = 110
			}
			return struct {
				StaticVersion, AssetBase, WailsBase, CSPNonce, APIToken, BasePath string
				HarnessPage, IsDevMode, IsWindow, RemoteViewer, UILocalePinned    bool
				WindowZoom, MachineZoom, ProjectZoom                              int
				WindowThemeMode, MachineThemeMode, ProjectThemeMode               string
				HTMLLang, UILocale, ProjectKey                                    string
				UICatalog                                                         map[string]string
			}{
				StaticVersion: s, AssetBase: s, WailsBase: s, CSPNonce: s, APIToken: s, BasePath: s,
				HarnessPage: on, IsDevMode: on, IsWindow: on, RemoteViewer: on, UILocalePinned: on,
				WindowZoom: n, MachineZoom: n, ProjectZoom: n,
				WindowThemeMode: s, MachineThemeMode: s, ProjectThemeMode: s,
				HTMLLang: s, UILocale: s, ProjectKey: s, UICatalog: catalogOf(s, on),
			}
		},
	},
	{
		name:  "sessions",
		files: []string{"machine/index.html", "shell/window-shell.html"},
		data: func(s string, on bool) any {
			return struct {
				AssetBase, WailsBase, ThemeMode, Theme, CSPNonce, HTMLLang, UILocale string
				IsWindow, Embed, OwnsTheme                                           bool
				UICatalog                                                            map[string]string
				Config                                                               machineConfig
			}{
				AssetBase: s, WailsBase: s, ThemeMode: s, Theme: s, CSPNonce: s, HTMLLang: s, UILocale: s,
				IsWindow: on, Embed: on, OwnsTheme: on, UICatalog: catalogOf(s, on),
				Config: machineConfig{Token: s, Host: s, Local: on, Panels: []string{s}},
			}
		},
	},
	{
		name:  "stand-in",
		files: []string{"shell/stand-in.html", "shell/window-shell.html"},
		data: func(s string, on bool) any {
			return struct {
				HTMLLang, UILocale, Title, CheckAction           string
				UICatalog                                        map[string]string
				Message                                          []string
				Buttons                                          []standInButton
				AssetBase, WailsBase, CSPNonce, Theme, ThemeMode string
				IsWindow, OwnsTheme                              bool
			}{
				HTMLLang: s, UILocale: s, Title: s, CheckAction: s, UICatalog: catalogOf(s, on),
				Message:   []string{s, s},
				Buttons:   []standInButton{{Label: s, Action: s, Busy: s, Primary: on}, {Label: s, Action: s}},
				AssetBase: s, WailsBase: s, CSPNonce: s, Theme: s, ThemeMode: s,
				IsWindow: on, OwnsTheme: on,
			}
		},
	},
}

func render(t *testing.T, p page, data any) string {
	t.Helper()
	tmpl, err := ParseFS(web.Files, p.files...)
	if err != nil {
		t.Fatalf("ParseFS(%v): %v", p.files, err)
	}
	var b bytes.Buffer
	if err := tmpl.Execute(&b, data); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	return b.String()
}

func renderStd(t *testing.T, p page, data any) string {
	t.Helper()
	tmpl, err := htmltemplate.ParseFS(web.Files, p.files...)
	if err != nil {
		t.Fatalf("html/template ParseFS(%v): %v", p.files, err)
	}
	var b bytes.Buffer
	if err := tmpl.Execute(&b, data); err != nil {
		t.Fatalf("html/template Execute: %v", err)
	}
	return b.String()
}

// With values that need no escaping in any context, every page renders byte
// for byte as html/template renders it, both with every branch taken and with
// none.
func TestPagesRenderAsHTMLTemplateDoes(t *testing.T) {
	for _, p := range pages {
		for _, on := range []bool{true, false} {
			data := p.data("fr", on)
			got, want := render(t, p, data), renderStd(t, p, data)
			if got != want {
				i := 0
				for i < len(got) && i < len(want) && got[i] == want[i] {
					i++
				}
				from := max(0, i-80)
				t.Errorf("%s (on=%v) differs from html/template at byte %d:\n got  …%s…\n want …%s…",
					p.name, on, i, got[from:min(len(got), i+80)], want[from:min(len(want), i+80)])
			}
		}
	}
}

// hostile is a value that would end any context it was copied into raw: an
// attribute, a JavaScript string of either quote, a script element, a line.
const hostile = "Z\"'`<>&\u2028</script><b x=\"1\">Z"

// structure is the page's elements and their attribute names, in order, and
// the number of script elements: what a value must never change.
func structure(t *testing.T, out string) []string {
	t.Helper()
	var shape []string
	z := html.NewTokenizer(strings.NewReader(out))
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return shape
		case html.StartTagToken, html.EndTagToken, html.SelfClosingTagToken:
			name, more := z.TagName()
			entry := tt.String() + ":" + string(name)
			for more {
				var key []byte
				key, _, more = z.TagAttr()
				entry += " " + string(key)
			}
			shape = append(shape, entry)
		}
	}
}

// Values that would break out of any context they were copied into raw leave
// every page's element structure as it is, and never appear unescaped.
func TestHostileValuesLeaveThePageStructureAlone(t *testing.T) {
	for _, p := range pages {
		for _, on := range []bool{true, false} {
			benign := render(t, p, p.data("fr", on))
			out := render(t, p, p.data(hostile, on))
			if got, want := structure(t, out), structure(t, benign); strings.Join(got, "\n") != strings.Join(want, "\n") {
				t.Errorf("%s (on=%v): hostile values changed the element structure\n got  %v\n want %v", p.name, on, got, want)
			}
			if strings.Contains(out, "\"'`<") || strings.Contains(out, "</script><b") {
				t.Errorf("%s (on=%v): a hostile value appears unescaped", p.name, on)
			}
		}
	}
}

func execString(t *testing.T, src string, data any) (string, error) {
	t.Helper()
	tmpl := New()
	if err := tmpl.Parse("t.html", src); err != nil {
		return "", err
	}
	var b bytes.Buffer
	err := tmpl.Execute(&b, data)
	return b.String(), err
}

type vals struct {
	S string
	N int
	B bool
	M map[string]string
	L []string
}

// Each context gets its own escaping.
func TestEscapingByContext(t *testing.T) {
	v := vals{S: `a"b'c<d>&e\f` + "\u2028", N: 3, B: true, M: map[string]string{"k": "</script>"}}
	cases := []struct{ src, want string }{
		{`<p>{{.S}}</p>`, `<p>a&#34;b&#39;c&lt;d&gt;&amp;e\f` + "\u2028" + `</p>`},
		{`<p title="{{.S}}">`, `<p title="a&#34;b&#39;c&lt;d&gt;&amp;e\f` + "\u2028" + `">`},
		{`<p title='{{.N}}'>`, `<p title='3'>`},
		{`<script>var s = "{{.S}}";</script>`, `<script>var s = "a\u0022b\u0027c\u003cd\u003e\u0026e\u005cf\u2028";</script>`},
		{`<script>var s = '{{.S}}';</script>`, `<script>var s = 'a\u0022b\u0027c\u003cd\u003e\u0026e\u005cf\u2028';</script>`},
		{`<script>var b = {{.B}}, n = {{.N}};</script>`, `<script>var b =  true , n =  3 ;</script>`},
		{`<script type="application/json">{{.M}}</script>`, `<script type="application/json">{"k":"\u003c/script\u003e"}</script>`},
		{`<script>var s = {{.S}};</script>`, `<script>var s = "a\"b'c\u003cd\u003e\u0026e\\f\u2028";</script>`},
		{`<a href="{{.S}}/x">`, `<a href="a%22b%27c%3cd%3e&amp;e%5cf%e2%80%a8/x">`},
		{`<a href="javascript:{{.S}}">`, `<a href="javascript:a%22b%27c%3cd%3e&amp;e%5cf%e2%80%a8">`},
	}
	for _, c := range cases {
		got, err := execString(t, c.src, v)
		if err != nil {
			t.Errorf("%s: %v", c.src, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s:\n got  %s\n want %s", c.src, got, c.want)
		}
	}
}

// A URL attribute that a value begins is refused a scheme other than http,
// https or mailto, as html/template refuses it.
func TestURLAttributeRefusesUnsafeSchemes(t *testing.T) {
	for _, c := range []struct{ s, want string }{
		{"javascript:alert(1)", `<a href="#ZgotmplZ">`},
		{"JavaScript:alert(1)", `<a href="#ZgotmplZ">`},
		{"data:text/html,x", `<a href="#ZgotmplZ">`},
		{"https://example.com/a?b=c", `<a href="https://example.com/a?b=c">`},
		{"/p/key/v1", `<a href="/p/key/v1">`},
		{"", `<a href="">`},
	} {
		got, err := execString(t, `<a href="{{.S}}">`, vals{S: c.s})
		if err != nil {
			t.Fatalf("%q: %v", c.s, err)
		}
		if got != c.want {
			t.Errorf("%q: got %s, want %s", c.s, got, c.want)
		}
	}
}

// What a template may not do is refused when it is parsed, not drawn wrong.
func TestRefusals(t *testing.T) {
	for _, src := range []string{
		`<a href={{.S}}>`,                    // unquoted attribute
		`<a {{.S}}>`,                         // inside a tag
		`<style>p { color: {{.S}} }</style>`, // CSS
		`<p style="color: {{.S}}">`,          // CSS attribute
		`<a onclick="go({{.S}})">`,           // event handler
		`<!-- {{.S}} -->`,                    // HTML comment
		"<script>var s = `{{.S}}`;</script>", // template literal
		`<script>// {{.S}}` + "\n</script>",  // line comment
		`<script>/* {{.S}} */</script>`,      // block comment
		`<script>var r = /{{.S}}/;</script>`, // regular expression
		`{{if .B}}<a href="{{end}}x">`,       // branches end in different contexts
		`{{range .L}}<p title="{{end}}">`,    // a loop that changes context
		`{{.S.T}}`,                           // a field of a field
		`{{printf "%s" .S}}`,                 // a function
		`{{if .B}}x`,                         // no end
		`x{{end}}`,                           // an end with nothing open
		`{{- .S}}`,                           // trim markers
		`<p>{{template "nope" .}}</p>`,       // a block nothing defines (at Execute)
	} {
		if _, err := execString(t, src, vals{}); err == nil {
			t.Errorf("%s: accepted", src)
		}
	}
}

// Branches, loops, blocks and the values they read.
func TestControl(t *testing.T) {
	type item struct {
		Name string
		On   bool
	}
	data := struct {
		B, F  bool
		S     string
		Items []item
		L     []string
	}{B: true, S: "s", Items: []item{{"a", true}, {"b", false}}, L: []string{"x", "y"}}
	tmpl := New()
	if err := tmpl.Parse("page.html", `{{/* a comment */}}{{if .B}}yes{{else}}no{{end}}{{if not .F}}!{{end}}`+
		`{{range .Items}}[{{.Name}}{{if .On}}+{{end}}]{{end}}{{range .L}}({{.}}){{end}}<p>{{template "blk" .}}</p>`); err != nil {
		t.Fatal(err)
	}
	if err := tmpl.Parse("shell.html", `{{/* only blocks */}}`+"\n"+`{{define "blk"}}<i>{{.S}}</i>{{end}}`); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err := tmpl.Execute(&b, data); err != nil {
		t.Fatal(err)
	}
	if got, want := b.String(), `yes![a+][b](x)(y)<p><i>s</i></p>`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

// The real templates parse: a template edited into a context this package
// refuses fails here, not on a page load.
func TestRealTemplatesParse(t *testing.T) {
	for _, p := range pages {
		if _, err := ParseFS(web.Files, p.files...); err != nil {
			t.Errorf("%s: %v", p.name, err)
		}
	}
	if _, err := fs.Stat(web.Shell, "shell/stand-in.html"); err != nil {
		t.Fatalf("stand-in page missing from web.Shell: %v", err)
	}
}
