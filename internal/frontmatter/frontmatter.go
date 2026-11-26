//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package frontmatter reads the header of a "declarative" Juggler file — a user
// command, a tool hook, an Agent Skill's SKILL.md, an extension's identity
// preset — which begins with a flat YAML frontmatter block delimited by `---`
// lines, followed by a free-form markdown body. The parser is deliberately flat
// (scalar `key: value` pairs only, no nested YAML): the schemas are a handful of
// scalar fields, which keeps it dependency-free and tolerant of foreign formats
// on import (unknown keys are ignored, never rejected). Every loader of such a
// file goes through Split and ScanFields, so they all agree byte for byte on
// what a frontmatter block is.
package frontmatter

import (
	"fmt"
	"strings"
)

// Split separates a declarative file into its frontmatter lines (the raw lines
// strictly between the opening and closing `---` delimiters) and its body
// (everything after the closing delimiter, with a single leading newline
// trimmed). CRLF is normalised to LF first. A missing opening delimiter returns
// the whole text as the body with an error; a missing closing delimiter returns
// an empty body with an error — so a caller surfaces a broken file rather than
// dropping it, and never mistakes its header for its body.
func Split(data []byte) (fmLines []string, body string, err error) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || strings.TrimRight(lines[0], " \t") != "---" {
		return nil, strings.TrimLeft(text, "\n"), fmt.Errorf("missing YAML frontmatter (file must begin with a --- line)")
	}
	closeIdx := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimRight(lines[i], " \t") == "---" {
			closeIdx = i
			break
		}
	}
	if closeIdx < 0 {
		return nil, "", fmt.Errorf("unterminated frontmatter (missing closing --- line)")
	}
	body = strings.Join(lines[closeIdx+1:], "\n")
	body = strings.TrimPrefix(body, "\n")
	return lines[1:closeIdx], body, nil
}

// ScanFields walks the frontmatter lines produced by Split and invokes assign
// for each top-level `key: value` scalar pair. Blank lines and comment lines
// (leading `#`) are skipped; lines without a colon are ignored; values are
// unquoted (a single surrounding pair of matching quotes stripped). Keys are
// passed as written — case-sensitive. Indented lines — the children of a nested
// mapping like Claude-Code's `metadata:` — are skipped entirely, so a nested
// `name:` or `description:` can never stomp the real top-level field.
func ScanFields(fmLines []string, assign func(key, value string)) {
	for _, line := range fmLines {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			continue // nested-mapping child — top-level scalars only
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		value := unquoteScalar(strings.TrimSpace(line[colon+1:]))
		assign(key, value)
	}
}

// unquoteScalar strips a single matching pair of surrounding quotes and unescapes
// \" inside double quotes. Bare values are returned unchanged.
func unquoteScalar(v string) string {
	if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
		return strings.ReplaceAll(v[1:len(v)-1], `\"`, `"`)
	}
	if len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'' {
		return v[1 : len(v)-1]
	}
	return v
}
