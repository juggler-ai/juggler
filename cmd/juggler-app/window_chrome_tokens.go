//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"regexp"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"juggler/web"
)

// The app paints a little of a window itself — its native background, and the
// fallback bar over a page that is not Juggler's (foreign_page.go) — in the
// web UI's own colours, sizes and glyphs. Those are read from the web UI's
// sources in web.Shell, the copy the app links, never written down again
// here: the theme sheets' tokens (web/css/tokens/), the resize strip's height
// (web/css/layout/window-chrome.css), and the caption glyphs
// (web/js/components/window-caption-glyphs.js). TestWindowChromeTokensRead
// names a source that stops yielding one.

// chromeThemeTokens are one theme's colours, as CSS values.
type chromeThemeTokens struct {
	BG            string `json:"bg"`
	Raised        string `json:"raised"`
	Border        string `json:"border"`
	Text          string `json:"text"`
	TextSecondary string `json:"textSecondary"`
	OnAccent      string `json:"onAccent"`
}

// chromeTokens are the web UI's window chrome: its geometry, the caption close
// button's colours (the same in either theme), each theme's colours, and the
// caption glyphs.
type chromeTokens struct {
	Gutter      string                       `json:"gutter"`
	Strip       string                       `json:"strip"`
	CloseHover  string                       `json:"closeHover"`
	CloseActive string                       `json:"closeActive"`
	Themes      map[string]chromeThemeTokens `json:"themes"`
	Glyphs      json.RawMessage              `json:"glyphs"`
}

// windowChrome is the web UI's chrome, read once as the app starts. A source
// that no longer yields what is read here stops the app at once, rather than
// painting with nothing; the test above catches that first.
var windowChrome = mustReadChromeTokens(web.Shell)

// themeColours maps a page theme to the native window's background: the
// theme's --bg-primary.
var themeColours = map[string]application.RGBA{
	"dark":  mustHexColour(windowChrome.Themes["dark"].BG),
	"light": mustHexColour(windowChrome.Themes["light"].BG),
}

var (
	captionGlyphsJSON = regexp.MustCompile(`(?s)/\* caption-glyphs \*/(.*?)/\* end caption-glyphs \*/`)
	// The height of the strip along a window's top edge left to the OS's
	// resize zone, in its rule.
	resizeStripHeight = regexp.MustCompile(`(?s)\n\.window-resize-strip \{[^}]*?\n\s*height:\s*([^;]+);`)
)

func mustReadChromeTokens(fsys fs.FS) chromeTokens {
	tokens, err := readChromeTokens(fsys)
	if err != nil {
		panic("window chrome: " + err.Error())
	}
	return tokens
}

// readChromeTokens reads the chrome from the web UI's sources in fsys.
func readChromeTokens(fsys fs.FS) (chromeTokens, error) {
	var t chromeTokens
	sheet := func(name string) (string, error) {
		b, err := fs.ReadFile(fsys, name)
		return string(b), err
	}
	scale, err := sheet("css/tokens/scale.css")
	if err != nil {
		return t, err
	}
	chrome, err := sheet("css/layout/window-chrome.css")
	if err != nil {
		return t, err
	}
	m := resizeStripHeight.FindStringSubmatch(chrome)
	if m == nil {
		return t, fmt.Errorf("css/layout/window-chrome.css gives .window-resize-strip no height")
	}
	t.Strip = strings.TrimSpace(m[1])
	for _, f := range []struct {
		dst  *string
		name string
	}{
		{&t.Gutter, "window-traffic-light-gutter"},
		{&t.CloseHover, "window-close-hover-bg"},
		{&t.CloseActive, "window-close-active-bg"},
	} {
		if *f.dst, err = cssToken(scale, "css/tokens/scale.css", f.name); err != nil {
			return t, err
		}
	}
	t.Themes = map[string]chromeThemeTokens{}
	for _, theme := range []string{"dark", "light"} {
		name := "css/tokens/theme-" + theme + ".css"
		src, err := sheet(name)
		if err != nil {
			return t, err
		}
		var tt chromeThemeTokens
		for _, f := range []struct {
			dst  *string
			name string
		}{
			{&tt.BG, "bg-primary"},
			{&tt.Raised, "bg-raised"},
			{&tt.Border, "border-color"},
			{&tt.Text, "text-primary"},
			{&tt.TextSecondary, "text-secondary"},
			{&tt.OnAccent, "text-on-accent"},
		} {
			if *f.dst, err = cssToken(src, name, f.name); err != nil {
				return t, err
			}
		}
		t.Themes[theme] = tt
	}
	glyphs, err := sheet("js/components/window-caption-glyphs.js")
	if err != nil {
		return t, err
	}
	m = captionGlyphsJSON.FindStringSubmatch(glyphs)
	if m == nil || !json.Valid([]byte(m[1])) {
		return t, fmt.Errorf("window-caption-glyphs.js has no JSON between its caption-glyphs markers")
	}
	t.Glyphs = json.RawMessage(strings.TrimSpace(m[1]))
	return t, nil
}

// cssToken is custom property --name's value as sheet src declares it first.
func cssToken(src, sheet, name string) (string, error) {
	m := regexp.MustCompile(`(?m)^\s*--` + regexp.QuoteMeta(name) + `:\s*([^;]+);`).FindStringSubmatch(src)
	if m == nil {
		return "", fmt.Errorf("%s declares no --%s", sheet, name)
	}
	return strings.TrimSpace(m[1]), nil
}

// mustHexColour is a #rgb or #rrggbb colour as opaque RGBA.
func mustHexColour(c string) application.RGBA {
	hex := strings.TrimPrefix(c, "#")
	if len(hex) == 3 {
		hex = string([]byte{hex[0], hex[0], hex[1], hex[1], hex[2], hex[2]})
	}
	v, err := strconv.ParseUint(hex, 16, 32)
	if len(hex) != 6 || err != nil || !strings.HasPrefix(c, "#") {
		panic("window chrome: " + c + " is not a #rgb or #rrggbb colour")
	}
	return application.RGBA{Red: uint8(v >> 16), Green: uint8(v >> 8), Blue: uint8(v), Alpha: 255}
}
