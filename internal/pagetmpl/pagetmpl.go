//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package pagetmpl draws the HTML pages the server and the desktop app fill in
// per response (web/index.html, web/machine/index.html, web/shell/*.html):
// html/template's syntax and contextual escaping, cut down to what those pages
// use.
//
// It exists for the binary's size. html/template's Execute looks fields up
// with reflect.Value.MethodByName, and one call like that anywhere in a
// program makes the linker keep every exported method of every type the
// program reaches, used or not — most of the provider SDKs' API surface. This
// package reads fields with FieldByName, which costs nothing of the kind.
//
// What a template may contain:
//
//	{{.Field}}  {{.}}                       a value, escaped for where it stands
//	{{if .Field}} {{if not .Field}} {{else}} {{end}}
//	{{range .Field}} … {{end}}              over a slice; . is each element
//	{{define "name"}} … {{end}}             a block, in any file but the page's
//	{{template "name" .}}                   a block, called in HTML text
//	{{/* comment */}}
//
// Contexts are worked out from the template text when it is parsed, as
// html/template works them out, and each value is escaped for its own: HTML
// text or a quoted attribute (HTML-escaped), a URL attribute (normalised, and
// refused a scheme other than http, https or mailto where the value begins
// it), JavaScript outside a string (a JSON value) and inside a quoted string
// (its characters \u-escaped, which is also valid JSON). A value anywhere
// else — an unquoted attribute, CSS, an event handler, an HTML or JavaScript
// comment, a template literal, a regular expression — is refused at parse
// time, as is a branch or loop whose arms end in different contexts.
package pagetmpl

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Template is a page and the blocks it may call.
type Template struct {
	page   []node
	parsed bool
	blocks map[string][]node
}

// New is an empty template; the first file Parse is given is the page.
func New() *Template {
	return &Template{blocks: map[string][]node{}}
}

// ParseFS parses the named files of fsys, the page first.
func ParseFS(fsys fs.FS, names ...string) (*Template, error) {
	t := New()
	for _, name := range names {
		b, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil, err
		}
		if err := t.Parse(name, string(b)); err != nil {
			return nil, err
		}
	}
	return t, nil
}

// Execute draws the page with data, and writes it to w only once it is whole.
func (t *Template) Execute(w io.Writer, data any) error {
	var b bytes.Buffer
	if err := t.exec(&b, t.page, reflect.ValueOf(data)); err != nil {
		return err
	}
	_, err := w.Write(b.Bytes())
	return err
}

// ── The parse tree ──────────────────────────────────────────────────────────

type node interface{}

type textNode string

// valueCtx is how a value is escaped: the context its action stands in.
type valueCtx int

const (
	ctxHTML    valueCtx = iota // HTML text, or a quoted attribute value
	ctxURL                     // a URL attribute's value, which the value begins
	ctxURLPart                 // a URL attribute's value, after its start
	ctxJS                      // JavaScript outside any string: a JSON value
	ctxJSStr                   // inside a quoted JavaScript string
)

type valueNode struct {
	field string // "" for the dot itself
	ctx   valueCtx
	pos   string
}

type ifNode struct {
	field     string
	not       bool
	then, els []node
}

type rangeNode struct {
	field string
	body  []node
	pos   string
}

type callNode struct {
	name string
	pos  string
}

// ── Lexical context ─────────────────────────────────────────────────────────

type lexState int

const (
	sText lexState = iota
	sTagName
	sTag
	sAttrName
	sAfterAttrName
	sBeforeValue
	sValue
	sValueUnquoted
	sComment
	sScript
	sJSStr
	sJSTmpl
	sJSLineComment
	sJSBlockComment
	sJSRegexp
	sStyle
)

type triState int

const (
	yes triState = iota
	no
	unknown
)

// lexCtx is where the lexer stands in the page. Every field is comparable, so
// two arms of a branch can be checked to end in the same place.
type lexCtx struct {
	st           lexState
	quote        byte   // sValue, sJSStr
	tag          string // the tag being read, lower case
	closing      bool   // the tag is an end tag
	attr         string // the attribute being read, lower case
	valueStarted bool   // sValue: the value holds something already
	regexp       triState
	escaped      bool // sJSStr, sJSTmpl, sJSRegexp: the last character was a backslash
	inClass      bool // sJSRegexp: inside [...]
	word         string
}

// essential is the part of a context two arms of a branch must agree on.
func (c lexCtx) essential() lexCtx {
	c.regexp, c.word = 0, ""
	return c
}

// join is where a branch whose arms end in a and b ends, or an error.
func join(a, b lexCtx) (lexCtx, bool) {
	if a.essential() != b.essential() {
		return a, false
	}
	if a.regexp != b.regexp {
		a.regexp = unknown
	}
	return a, true
}

func isIdentByte(c byte) bool {
	return c == '_' || c == '$' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= 0x80
}

func isNameByte(c byte) bool {
	return c == '-' || c == '!' || c == ':' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

// endsRawText reports whether s begins the end tag of the raw-text element
// tag: "</tag" followed by a space, a slash or a '>', as a browser ends it.
func endsRawText(s, tag string) bool {
	n := len(tag) + 2
	if !hasPrefixFold(s, "</"+tag) {
		return false
	}
	return len(s) == n || isSpace(s[n]) || s[n] == '/' || s[n] == '>'
}

// keywords after which a slash begins a regular expression, not a division.
var regexpKeywords = map[string]bool{
	"return": true, "typeof": true, "case": true, "do": true, "else": true, "in": true,
	"instanceof": true, "new": true, "throw": true, "void": true, "delete": true, "yield": true, "await": true,
}

func (c *lexCtx) endWord() {
	if c.word == "" {
		return
	}
	if regexpKeywords[c.word] {
		c.regexp = yes
	} else {
		c.regexp = no
	}
	c.word = ""
}

func (c *lexCtx) endTag() {
	tag, closing := c.tag, c.closing
	*c = lexCtx{st: sText}
	if closing {
		return
	}
	switch tag {
	case "script":
		c.st, c.regexp = sScript, yes
	case "style":
		c.st = sStyle
	}
}

func isComment(st lexState) bool {
	return st == sComment || st == sJSLineComment || st == sJSBlockComment
}

// lex advances c over the literal text s, and returns s without its HTML and
// JavaScript comments, as html/template draws it: a line comment leaves its
// newline, and a block comment a space, so no two tokens run together.
func (c *lexCtx) lex(s string) (string, error) {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		rest := s[i:]
		before, start, keep := c.st, i, false
		switch c.st {
		case sText:
			switch {
			case strings.HasPrefix(rest, "<!--"):
				c.st = sComment
				i += 3
			case ch == '<' && len(rest) > 1 && (isNameByte(rest[1]) && rest[1] != '-' && rest[1] != ':'):
				*c = lexCtx{st: sTagName}
			case ch == '<' && len(rest) > 2 && rest[1] == '/' && isNameByte(rest[2]):
				*c = lexCtx{st: sTagName, closing: true}
				i++
			}
		case sTagName:
			switch {
			case isNameByte(ch):
				c.tag += strings.ToLower(string(ch))
			case ch == '>':
				c.endTag()
			default:
				c.st = sTag
			}
		case sTag:
			switch {
			case ch == '>':
				c.endTag()
			case isSpace(ch) || ch == '/':
			default:
				c.st, c.attr = sAttrName, strings.ToLower(string(ch))
			}
		case sAttrName:
			switch {
			case ch == '=':
				c.st = sBeforeValue
			case ch == '>':
				c.endTag()
			case isSpace(ch):
				c.st = sAfterAttrName
			case ch == '/':
				c.st = sTag
			default:
				c.attr += strings.ToLower(string(ch))
			}
		case sAfterAttrName:
			switch {
			case ch == '=':
				c.st = sBeforeValue
			case ch == '>':
				c.endTag()
			case isSpace(ch) || ch == '/':
			default:
				c.st, c.attr = sAttrName, strings.ToLower(string(ch))
			}
		case sBeforeValue:
			switch {
			case ch == '"' || ch == '\'':
				c.st, c.quote, c.valueStarted = sValue, ch, false
			case ch == '>':
				c.endTag()
			case isSpace(ch):
			default:
				c.st = sValueUnquoted
			}
		case sValue:
			if ch == c.quote {
				c.st, c.quote, c.attr, c.valueStarted = sTag, 0, "", false
			} else {
				c.valueStarted = true
			}
		case sValueUnquoted:
			switch {
			case isSpace(ch):
				c.st, c.attr = sTag, ""
			case ch == '>':
				c.endTag()
			}
		case sComment:
			if strings.HasPrefix(rest, "-->") {
				c.st = sText
				i += 2
			}
		case sStyle:
			if endsRawText(rest, "style") {
				*c = lexCtx{st: sTagName, tag: "style", closing: true}
				i += len("</style") - 1
			}
		case sScript, sJSStr, sJSTmpl, sJSLineComment, sJSBlockComment, sJSRegexp:
			if endsRawText(rest, "script") {
				*c = lexCtx{st: sTagName, tag: "script", closing: true}
				i += len("</script") - 1
				keep = true
				break
			}
			skip, err := c.lexJS(ch, rest)
			if err != nil {
				return "", err
			}
			i += skip
		}
		switch after := c.st; {
		case keep || !isComment(before) && !isComment(after):
			out.WriteString(s[start : i+1])
		case before == sJSLineComment && !isComment(after):
			out.WriteByte('\n')
		case before == sJSBlockComment && !isComment(after):
			out.WriteByte(' ')
		}
	}
	c.endWord()
	return out.String(), nil
}

// lexJS advances c over the JavaScript character ch, rest being ch and what
// follows it in the same literal text, and returns how many bytes after ch it
// consumed with it (the second character of a "//", "/*" or "*/").
func (c *lexCtx) lexJS(ch byte, rest string) (int, error) {
	switch c.st {
	case sScript:
		if isIdentByte(ch) {
			c.word += string(ch)
			return 0, nil
		}
		c.endWord()
		switch {
		case ch == '"' || ch == '\'':
			c.st, c.quote, c.escaped = sJSStr, ch, false
		case ch == '`':
			c.st, c.escaped = sJSTmpl, false
		case strings.HasPrefix(rest, "//"):
			c.st = sJSLineComment
			return 1, nil
		case strings.HasPrefix(rest, "/*"):
			c.st = sJSBlockComment
			return 1, nil
		case ch == '/':
			switch c.regexp {
			case yes:
				c.st, c.escaped, c.inClass = sJSRegexp, false, false
			case unknown:
				return 0, fmt.Errorf("a '/' that could begin a regular expression or be a division, after a branch")
			default:
				c.regexp = yes
			}
		case isSpace(ch):
		case ch == ')' || ch == ']':
			c.regexp = no
		default:
			c.regexp = yes
		}
	case sJSStr:
		switch {
		case c.escaped:
			c.escaped = false
		case ch == '\\':
			c.escaped = true
		case ch == c.quote || ch == '\n':
			c.st, c.quote, c.regexp = sScript, 0, no
		}
	case sJSTmpl:
		switch {
		case c.escaped:
			c.escaped = false
		case ch == '\\':
			c.escaped = true
		case ch == '`':
			c.st, c.regexp = sScript, no
		}
	case sJSLineComment:
		if ch == '\n' {
			c.st = sScript
		}
	case sJSBlockComment:
		if strings.HasPrefix(rest, "*/") {
			c.st = sScript
			return 1, nil
		}
	case sJSRegexp:
		switch {
		case c.escaped:
			c.escaped = false
		case ch == '\\':
			c.escaped = true
		case ch == '[':
			c.inClass = true
		case ch == ']':
			c.inClass = false
		case ch == '/' && !c.inClass:
			c.st, c.regexp = sScript, no
		}
	}
	return 0, nil
}

// urlAttrs are the attributes whose values are URLs (html/template's list).
var urlAttrs = map[string]bool{
	"action": true, "archive": true, "background": true, "cite": true, "classid": true, "codebase": true,
	"data": true, "formaction": true, "href": true, "icon": true, "longdesc": true, "manifest": true,
	"poster": true, "profile": true, "src": true, "srcset": true, "usemap": true, "xmlns": true,
}

// valueContext is how a value standing at c is escaped, and c once it is
// drawn, or an error for a context values may not stand in.
func valueContext(c lexCtx) (valueCtx, lexCtx, error) {
	switch c.st {
	case sText:
		return ctxHTML, c, nil
	case sValue:
		switch {
		case strings.HasPrefix(c.attr, "on"):
			return 0, c, fmt.Errorf("a value in the event handler attribute %q", c.attr)
		case c.attr == "style":
			return 0, c, fmt.Errorf("a value in a style attribute")
		case urlAttrs[c.attr] || strings.Contains(c.attr, "url") || strings.Contains(c.attr, "uri"):
			vc := ctxURLPart
			if !c.valueStarted {
				vc = ctxURL
			}
			c.valueStarted = true
			return vc, c, nil
		}
		c.valueStarted = true
		return ctxHTML, c, nil
	case sScript:
		c.regexp = no
		return ctxJS, c, nil
	case sJSStr:
		return ctxJSStr, c, nil
	}
	return 0, c, fmt.Errorf("a value where none may stand (%s)", stateNames[c.st])
}

var stateNames = map[lexState]string{
	sTagName: "a tag name", sTag: "inside a tag", sAttrName: "an attribute name",
	sAfterAttrName: "inside a tag", sBeforeValue: "an unquoted attribute value",
	sValueUnquoted: "an unquoted attribute value", sComment: "an HTML comment",
	sJSTmpl: "a JavaScript template literal", sJSLineComment: "a JavaScript comment",
	sJSBlockComment: "a JavaScript comment", sJSRegexp: "a JavaScript regular expression",
	sStyle: "a style element",
}

// ── Parsing ─────────────────────────────────────────────────────────────────

var (
	fieldRe = regexp.MustCompile(`^\.([A-Za-z_][A-Za-z0-9_]*)?$`)
	ifRe    = regexp.MustCompile(`^if\s+(not\s+)?(\.[A-Za-z_][A-Za-z0-9_]*)$`)
	rangeRe = regexp.MustCompile(`^range\s+(\.[A-Za-z_][A-Za-z0-9_]*)$`)
	defRe   = regexp.MustCompile(`^define\s+"([^"]+)"$`)
	callRe  = regexp.MustCompile(`^template\s+"([^"]+)"\s+\.$`)
)

type frameKind int

const (
	frameRoot frameKind = iota
	frameIf
	frameRange
	frameDefine
)

type frame struct {
	kind   frameKind
	nodes  *[]node
	start  lexCtx // the context the frame began in
	ifn    *ifNode
	inElse bool
	thenAt lexCtx // where the if's first arm ended
	rng    *rangeNode
	name   string
	pos    string
}

// Parse adds the file name holding text: the page itself if it is the first,
// and otherwise only blocks.
func (t *Template) Parse(name, text string) error {
	src := text
	first := !t.parsed
	t.parsed = true
	var root []node
	cur := lexCtx{st: sText}
	stack := []*frame{{kind: frameRoot, nodes: &root, start: cur}}
	top := func() *frame { return stack[len(stack)-1] }
	add := func(n node) { f := top(); *f.nodes = append(*f.nodes, n) }

	for len(text) > 0 {
		open := strings.Index(text, "{{")
		lit := text
		if open >= 0 {
			lit = text[:open]
		}
		if lit != "" {
			drawn, err := cur.lex(lit)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			if drawn != "" {
				add(textNode(drawn))
			}
		}
		if open < 0 {
			break
		}
		at := len(src) - len(text) + open
		pos := fmt.Sprintf("%s:%d", name, strings.Count(src[:at], "\n")+1)
		rest := text[open+2:]
		var body string
		if strings.HasPrefix(rest, "/*") {
			end := strings.Index(rest, "*/}}")
			if end < 0 {
				return fmt.Errorf("%s: unclosed comment", pos)
			}
			text = rest[end+4:]
			continue
		}
		end := strings.Index(rest, "}}")
		if end < 0 {
			return fmt.Errorf("%s: unclosed action", pos)
		}
		body, text = rest[:end], rest[end+2:]
		if strings.HasPrefix(body, "-") || strings.HasSuffix(body, "-") {
			return fmt.Errorf("%s: trim markers are not supported", pos)
		}
		action := strings.TrimSpace(body)
		switch {
		case fieldRe.MatchString(action):
			vc, next, err := valueContext(cur)
			if err != nil {
				return fmt.Errorf("%s: {{%s}}: %w", pos, action, err)
			}
			cur = next
			add(&valueNode{field: strings.TrimPrefix(action, "."), ctx: vc, pos: pos})
		case ifRe.MatchString(action):
			m := ifRe.FindStringSubmatch(action)
			n := &ifNode{field: m[2][1:], not: m[1] != ""}
			add(n)
			stack = append(stack, &frame{kind: frameIf, nodes: &n.then, start: cur, ifn: n, pos: pos})
		case action == "else":
			f := top()
			if f.kind != frameIf || f.inElse {
				return fmt.Errorf("%s: {{else}} outside an {{if}}", pos)
			}
			f.inElse, f.thenAt, f.nodes = true, cur, &f.ifn.els
			cur = f.start
		case rangeRe.MatchString(action):
			n := &rangeNode{field: rangeRe.FindStringSubmatch(action)[1][1:], pos: pos}
			add(n)
			stack = append(stack, &frame{kind: frameRange, nodes: &n.body, start: cur, rng: n, pos: pos})
		case defRe.MatchString(action):
			if len(stack) != 1 || first {
				return fmt.Errorf("%s: {{define}} must stand at the top level of a file of blocks", pos)
			}
			var body []node
			stack = append(stack, &frame{kind: frameDefine, nodes: &body, start: cur,
				name: defRe.FindStringSubmatch(action)[1], pos: pos})
			cur = lexCtx{st: sText}
		case callRe.MatchString(action):
			if cur.st != sText {
				return fmt.Errorf("%s: {{template}} outside HTML text (%s)", pos, stateNames[cur.st])
			}
			add(&callNode{name: callRe.FindStringSubmatch(action)[1], pos: pos})
		case action == "end":
			f := top()
			var ok bool
			switch f.kind {
			case frameIf:
				if f.inElse {
					cur, ok = join(f.thenAt, cur)
				} else {
					cur, ok = join(cur, f.start)
				}
				if !ok {
					return fmt.Errorf("%s: the {{if}} at %s ends in different contexts", pos, f.pos)
				}
			case frameRange:
				if cur, ok = join(cur, f.start); !ok {
					return fmt.Errorf("%s: the {{range}} at %s ends in a different context from where it began", pos, f.pos)
				}
			case frameDefine:
				if cur.essential() != (lexCtx{st: sText}) {
					return fmt.Errorf("%s: the block %q ends outside HTML text", pos, f.name)
				}
				t.blocks[f.name] = *f.nodes
				cur = f.start
			default:
				return fmt.Errorf("%s: {{end}} with nothing open", pos)
			}
			stack = stack[:len(stack)-1]
		default:
			return fmt.Errorf("%s: {{%s}} is not supported", pos, action)
		}
	}
	if len(stack) != 1 {
		return fmt.Errorf("%s: the action at %s is never ended", name, top().pos)
	}
	if first {
		t.page = root
		return nil
	}
	for _, n := range root {
		if s, ok := n.(textNode); !ok || strings.TrimSpace(string(s)) != "" {
			return fmt.Errorf("%s: a file of blocks holds something outside its blocks", name)
		}
	}
	return nil
}

// ── Executing ───────────────────────────────────────────────────────────────

func (t *Template) exec(b *bytes.Buffer, nodes []node, dot reflect.Value) error {
	for _, n := range nodes {
		switch n := n.(type) {
		case textNode:
			b.WriteString(string(n))
		case *valueNode:
			v, err := field(dot, n.field)
			if err != nil {
				return fmt.Errorf("%s: %w", n.pos, err)
			}
			if err := writeValue(b, n.ctx, v); err != nil {
				return fmt.Errorf("%s: %w", n.pos, err)
			}
		case *ifNode:
			v, err := field(dot, n.field)
			if err != nil {
				return err
			}
			arm := n.els
			if truth(v) != n.not {
				arm = n.then
			}
			if err := t.exec(b, arm, dot); err != nil {
				return err
			}
		case *rangeNode:
			v, err := field(dot, n.field)
			if err != nil {
				return fmt.Errorf("%s: %w", n.pos, err)
			}
			v = indirect(v)
			if !v.IsValid() {
				continue
			}
			if v.Kind() != reflect.Slice && v.Kind() != reflect.Array {
				return fmt.Errorf("%s: {{range}} over a %s", n.pos, v.Kind())
			}
			for i := range v.Len() {
				if err := t.exec(b, n.body, v.Index(i)); err != nil {
					return err
				}
			}
		case *callNode:
			blk, ok := t.blocks[n.name]
			if !ok {
				return fmt.Errorf("%s: no block %q", n.pos, n.name)
			}
			if err := t.exec(b, blk, dot); err != nil {
				return err
			}
		}
	}
	return nil
}

func indirect(v reflect.Value) reflect.Value {
	for v.IsValid() && (v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface) {
		if v.IsNil() {
			return reflect.Value{}
		}
		v = v.Elem()
	}
	return v
}

// field is dot's field name, or dot itself for "". A map's missing key is its
// zero value; a struct's missing or unexported field is an error.
func field(dot reflect.Value, name string) (reflect.Value, error) {
	if name == "" {
		return dot, nil
	}
	d := indirect(dot)
	switch {
	case !d.IsValid():
		return reflect.Value{}, nil
	case d.Kind() == reflect.Struct:
		sf, ok := d.Type().FieldByName(name)
		if !ok || !sf.IsExported() {
			return reflect.Value{}, fmt.Errorf("%s has no exported field %s", d.Type(), name)
		}
		return d.FieldByIndex(sf.Index), nil
	case d.Kind() == reflect.Map && d.Type().Key().Kind() == reflect.String:
		v := d.MapIndex(reflect.ValueOf(name).Convert(d.Type().Key()))
		if !v.IsValid() {
			return reflect.Zero(d.Type().Elem()), nil
		}
		return v, nil
	}
	return reflect.Value{}, fmt.Errorf("can't read the field %s of a %s", name, d.Kind())
}

func truth(v reflect.Value) bool {
	v = indirect(v)
	if !v.IsValid() {
		return false
	}
	switch v.Kind() {
	case reflect.Bool:
		return v.Bool()
	case reflect.String, reflect.Slice, reflect.Map, reflect.Array:
		return v.Len() > 0
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int() != 0
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return v.Uint() != 0
	case reflect.Float32, reflect.Float64:
		return v.Float() != 0
	}
	return true
}

// scalar is v as text, for a context that takes only a string, number or bool.
func scalar(v reflect.Value) (string, error) {
	v = indirect(v)
	if !v.IsValid() {
		return "", nil
	}
	switch v.Kind() {
	case reflect.String:
		return v.String(), nil
	case reflect.Bool:
		return strconv.FormatBool(v.Bool()), nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.FormatInt(v.Int(), 10), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return strconv.FormatUint(v.Uint(), 10), nil
	case reflect.Float32, reflect.Float64:
		return strconv.FormatFloat(v.Float(), 'g', -1, 64), nil
	}
	return "", fmt.Errorf("a %s where only a string, number or bool may stand", v.Kind())
}

func writeValue(b *bytes.Buffer, vc valueCtx, v reflect.Value) error {
	if vc == ctxJS {
		var x any
		if iv := indirect(v); iv.IsValid() {
			x = iv.Interface()
		}
		j, err := json.Marshal(x)
		if err != nil {
			return err
		}
		// Spaced out, as html/template spaces it, when it begins or ends like
		// an identifier or a number, so it cannot run into a keyword beside
		// it ("in", "typeof").
		first, _ := utf8.DecodeRune(j)
		last, _ := utf8.DecodeLastRune(j)
		pad := isJSIdentRune(first) || isJSIdentRune(last)
		if pad {
			b.WriteByte(' ')
		}
		b.Write(j)
		if pad {
			b.WriteByte(' ')
		}
		return nil
	}
	s, err := scalar(v)
	if err != nil {
		return err
	}
	switch vc {
	case ctxHTML:
		htmlEscape(b, s)
	case ctxURL:
		if i := strings.IndexByte(s, ':'); i >= 0 && !strings.Contains(s[:i], "/") {
			switch strings.ToLower(s[:i]) {
			case "http", "https", "mailto":
			default:
				s = "#ZgotmplZ"
			}
		}
		htmlEscape(b, normaliseURL(s))
	case ctxURLPart:
		htmlEscape(b, normaliseURL(s))
	case ctxJSStr:
		jsStrEscape(b, s)
	}
	return nil
}

func isJSIdentRune(r rune) bool {
	return r == '_' || r == '$' || unicode.IsLetter(r) || unicode.IsDigit(r)
}

func htmlEscape(b *bytes.Buffer, s string) {
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&#34;")
		case '\'':
			b.WriteString("&#39;")
		case '+':
			b.WriteString("&#43;")
		case 0:
			b.WriteString("\uFFFD")
		default:
			b.WriteRune(r)
		}
	}
}

// normaliseURL percent-encodes every byte of s that may not stand in a URL,
// keeping the reserved characters and existing escapes, as html/template's
// URL normaliser does.
func normaliseURL(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			strings.IndexByte("-._~!#$&*+,/:;=?@[]%", c) >= 0:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02x", c)
		}
	}
	return b.String()
}

// JSString is s escaped for the inside of a quoted JavaScript or JSON string,
// as a value standing in one is drawn: for a page filled in by plain
// substitution rather than drawn by a Template.
func JSString(s string) string {
	var b bytes.Buffer
	jsStrEscape(&b, s)
	return b.String()
}

// jsStrEscape writes s for the inside of a quoted JavaScript string of either
// quote: anything but a letter, a digit or harmless punctuation as \uXXXX,
// which a JSON string accepts too.
func jsStrEscape(b *bytes.Buffer, s string) {
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch {
		case r < utf8.RuneSelf && (r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			strings.ContainsRune(" -_.,:;!?@#$%()*+=[]{}|~^/", r)):
			b.WriteRune(r)
		case r == utf8.RuneError && size == 1:
			b.WriteString(`\ufffd`)
		case r > 0xFFFF:
			r -= 0x10000
			fmt.Fprintf(b, `\u%04x\u%04x`, 0xD800+(r>>10), 0xDC00+(r&0x3FF))
		default:
			fmt.Fprintf(b, `\u%04x`, r)
		}
	}
}
