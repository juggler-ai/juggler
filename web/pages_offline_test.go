//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package web

import (
	"os"
	"regexp"
	"testing"
)

// offOriginAsset matches a script or stylesheet a page loads from another
// host.
var offOriginAsset = regexp.MustCompile(`<(?:script|link)\b[^>]*\b(?:src|href)="(?:https?:)?//[^"]*"`)

// TestPagesLoadOnlyTheirOwnAssets: the app, the engine and the test runner
// load every script and stylesheet from their own server. A parser-blocking
// script from another host holds the whole page until that host answers, so
// the app cannot start offline, and a connection to it that stalls freezes
// every lane of a test pool's window at once.
func TestPagesLoadOnlyTheirOwnAssets(t *testing.T) {
	for _, page := range []string{"index.html", "engine.html", "js-tests/headless-test.html"} {
		data, err := os.ReadFile(page)
		if err != nil {
			t.Fatalf("reading %s: %v", page, err)
		}
		for _, m := range offOriginAsset.FindAll(data, -1) {
			t.Errorf("%s loads an asset from another host: %s", page, m)
		}
	}
}
