//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package qrsvg draws a QR code as SVG markup, for a page to show a URL a
// phone can scan.
package qrsvg

import (
	"fmt"
	"strings"

	"rsc.io/qr"
)

// Encode returns text as a QR code (medium error correction) in SVG: one rect
// per horizontal run of dark modules, filled with currentColor so markup
// embedded inline takes the surrounding text colour, and no background, so it
// is transparent.
func Encode(text string) (string, error) {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return "", err
	}
	n := code.Size
	var b strings.Builder
	fmt.Fprintf(&b,
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges">`,
		n, n)
	b.WriteString(`<g fill="currentColor">`)
	for y := 0; y < n; y++ {
		x := 0
		for x < n {
			if !code.Black(x, y) {
				x++
				continue
			}
			runStart := x
			for x < n && code.Black(x, y) {
				x++
			}
			fmt.Fprintf(&b, `<rect x="%d" y="%d" width="%d" height="1"/>`, runStart, y, x-runStart)
		}
	}
	b.WriteString(`</g></svg>`)
	return b.String(), nil
}
