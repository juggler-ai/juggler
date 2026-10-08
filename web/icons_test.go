//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package web

import (
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// svgPathData matches the outline of an inline SVG icon.
var svgPathData = regexp.MustCompile(`<path[^>]*\sd="([^"]+)"`)

// TestAppIconsAreShared fails when one SVG outline is written out in more than
// one file under js/. An icon two places draw belongs in js/utils/icons.js and
// is imported from there; a component restating one that icons.js already
// exports is the same fault. The SDK and extensions are a different license
// tier, cannot import app utils/, and are out of scope.
func TestAppIconsAreShared(t *testing.T) {
	owners := map[string]map[string]bool{}
	err := fs.WalkDir(builtin, "js", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".js") {
			return err
		}
		src, err := builtin.ReadFile(p)
		if err != nil {
			return err
		}
		for _, m := range svgPathData.FindAllStringSubmatch(string(src), -1) {
			if owners[m[1]] == nil {
				owners[m[1]] = map[string]bool{}
			}
			owners[m[1]][p] = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(owners) == 0 {
		t.Fatal("found no inline SVG paths under js/ — the scan is looking in the wrong place")
	}
	for d, files := range owners {
		if len(files) < 2 {
			continue
		}
		names := make([]string, 0, len(files))
		for f := range files {
			names = append(names, f)
		}
		sort.Strings(names)
		head := d
		if len(head) > 40 {
			head = head[:40] + "…"
		}
		t.Errorf("icon %q is drawn in %d files; export it from js/utils/icons.js: %s",
			head, len(names), strings.Join(names, ", "))
	}
}
