//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"testing"
	"testing/fstest"
)

// TestStaticVersionIsContentHash pins the contract the immutable caching of
// /v<staticVersion>/ rests on: the version is a function of exactly the served
// bytes (and the build), so a restart of the same build keeps the browser's
// cache, while any change to a served file — in any tree — moves every URL.
func TestStaticVersionIsContentHash(t *testing.T) {
	tree := func(edit func(fstest.MapFS)) fstest.MapFS {
		m := fstest.MapFS{
			"js/app.js":          {Data: []byte("export const a = 1;\n")},
			"js/lib/util.js":     {Data: []byte("export const b = 2;\n")},
			"css/base/reset.css": {Data: []byte("* { margin: 0 }\n")},
			"index.html":         {Data: []byte("<html></html>\n")},
		}
		if edit != nil {
			edit(m)
		}
		return m
	}
	overlay := func(data string) fstest.MapFS {
		return fstest.MapFS{"extensions/pro/main.js": {Data: []byte(data)}}
	}
	version := func(t *testing.T, salt string, base, over fstest.MapFS) string {
		t.Helper()
		v, err := hashStaticVersion(salt,
			versionedTree{fsys: base, roots: []string{"css", "js", "extensions"}},
			versionedTree{fsys: over, roots: []string{"extensions"}},
		)
		if err != nil {
			t.Fatalf("hashStaticVersion: %v", err)
		}
		if v == "" {
			t.Fatal("hashStaticVersion returned an empty version")
		}
		return v
	}

	want := version(t, "v1.0.0", tree(nil), overlay("x"))
	if got := version(t, "v1.0.0", tree(nil), overlay("x")); got != want {
		t.Errorf("same trees gave %q then %q; the version must be deterministic", want, got)
	}

	changed := map[string]struct {
		salt       string
		base, over fstest.MapFS
	}{
		"one file's content": {"v1.0.0", tree(func(m fstest.MapFS) { m["js/lib/util.js"] = &fstest.MapFile{Data: []byte("export const b = 3;\n")} }), overlay("x")},
		"a file added":       {"v1.0.0", tree(func(m fstest.MapFS) { m["css/new.css"] = &fstest.MapFile{Data: []byte("")} }), overlay("x")},
		"a file renamed":     {"v1.0.0", tree(func(m fstest.MapFS) { m["js/app2.js"] = m["js/app.js"]; delete(m, "js/app.js") }), overlay("x")},
		"the overlay":        {"v1.0.0", tree(nil), overlay("y")},
		"the build version":  {"v1.0.1", tree(nil), overlay("x")},
	}
	for name, c := range changed {
		if got := version(t, c.salt, c.base, c.over); got == want {
			t.Errorf("changing %s left the version at %q", name, got)
		}
	}

	// A file under no served root is never fetched through /v<ver>/, so it
	// must not invalidate the cache.
	unserved := tree(func(m fstest.MapFS) { m["index.html"] = &fstest.MapFile{Data: []byte("<html>changed</html>\n")} })
	if got := version(t, "v1.0.0", unserved, overlay("x")); got != want {
		t.Errorf("changing an unserved file moved the version from %q to %q", want, got)
	}
}
