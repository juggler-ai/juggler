//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package web

import (
	"errors"
	"io/fs"
	"testing"
	"testing/fstest"
)

// TestFilesDefaultIsEmbedded proves the no-overlay path is the embedded tree
// itself — not a wrapper — so default serving is byte-identical to before the
// seam existed.
func TestFilesDefaultIsEmbedded(t *testing.T) {
	if Files != FS(&builtin) {
		t.Fatalf("Files should default to the raw embed.FS, got %T", Files)
	}
	data, err := Files.ReadFile("index.html")
	if err != nil || len(data) == 0 {
		t.Fatalf("embedded index.html unreadable: %v", err)
	}
}

func overlayFixture() fs.FS {
	return fstest.MapFS{
		"pro/pro.js": {Data: []byte("// pro asset")},
		"index.html": {Data: []byte("shadowed index")},
		"extensions/pro-ext/juggler.extension.json": {Data: []byte(`{}`)},
		"extensions/pro-ext/context-items/x.js":     {Data: []byte("//")},
	}
}

func TestOverlayFallsBackToBase(t *testing.T) {
	SetOverlay(overlayFixture())
	t.Cleanup(func() { SetOverlay(nil) })

	// File only in base: served from base.
	base, err := builtin.ReadFile("engine.html")
	if err != nil {
		t.Fatalf("base engine.html: %v", err)
	}
	got, err := Files.ReadFile("engine.html")
	if err != nil || string(got) != string(base) {
		t.Fatalf("base fallback broken: %v", err)
	}

	// File only in overlay: served from overlay.
	got, err = Files.ReadFile("pro/pro.js")
	if err != nil || string(got) != "// pro asset" {
		t.Fatalf("overlay file not served: %v (%q)", err, got)
	}

	// File in both: overlay wins.
	got, err = Files.ReadFile("index.html")
	if err != nil || string(got) != "shadowed index" {
		t.Fatalf("overlay should shadow base: %v (%q)", err, got)
	}

	// Missing in both: ErrNotExist.
	if _, err := Files.ReadFile("nope/nope.js"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("want ErrNotExist, got %v", err)
	}
}

// TestOverlayMergesExtensionDir is the seam extension discovery depends on:
// listing extensions/ must show base extensions (juggler-core) and overlay
// extensions (pro-ext) together.
func TestOverlayMergesExtensionDir(t *testing.T) {
	SetOverlay(overlayFixture())
	t.Cleanup(func() { SetOverlay(nil) })

	entries, err := fs.ReadDir(Files, "extensions")
	if err != nil {
		t.Fatalf("ReadDir(extensions): %v", err)
	}
	names := map[string]bool{}
	for _, e := range entries {
		names[e.Name()] = true
	}
	if !names["juggler-core"] || !names["pro-ext"] {
		t.Fatalf("merged listing missing entries: %v", names)
	}

	// fs.Glob routes through ReadDir and must see the merged view too.
	matches, err := fs.Glob(Files, "extensions/*/juggler.extension.json")
	if err != nil {
		t.Fatalf("Glob: %v", err)
	}
	found := map[string]bool{}
	for _, m := range matches {
		found[m] = true
	}
	if !found["extensions/juggler-core/juggler.extension.json"] ||
		!found["extensions/pro-ext/juggler.extension.json"] {
		t.Fatalf("Glob missed merged manifests: %v", matches)
	}
}

func TestSetOverlayNilRestoresEmbedded(t *testing.T) {
	SetOverlay(overlayFixture())
	SetOverlay(nil)
	if _, err := Files.ReadFile("pro/pro.js"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("nil overlay should restore the embedded tree")
	}
}
