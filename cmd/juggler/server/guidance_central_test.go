//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Guidance (tips, nudges, the usage record they read) lives in one directory,
// web/js/services/guidance/. Feature code reports usage with recordUsage and
// mounts <juggler-nudge>; it never reads or writes guidance state itself, and
// never decides on its own to show or retire a hint. These are the shapes that
// decision takes when it leaks out, so finding one anywhere else fails.
var guidanceLeaks = []struct {
	pattern *regexp.Regexp
	why     string
}{
	{regexp.MustCompile(`['"]juggler-(usage|guidance)['"]`), "guidance preferences are read and written only by services/guidance/"},
	{regexp.MustCompile(`\bmarkSeen\(`), "a tip is retired by the usage it names in the nudge catalogue, not by its call site"},
	{regexp.MustCompile(`tips-manager\.js`), "tips are entries in services/guidance/nudge-catalogue.js"},
}

const guidanceDir = "web/js/services/guidance/"

func TestGuidanceStaysCentral(t *testing.T) {
	const root = "../../../"
	for _, tree := range []string{"web/js", "web/extensions", "web/sdk"} {
		err := filepath.WalkDir(filepath.Join(root, tree), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".js") {
				return nil
			}
			rel := filepath.ToSlash(strings.TrimPrefix(path, filepath.Clean(root)+string(filepath.Separator)))
			if strings.HasPrefix(rel, guidanceDir) {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for i, line := range strings.Split(string(src), "\n") {
				for _, leak := range guidanceLeaks {
					if leak.pattern.MatchString(line) {
						t.Errorf("%s:%d: %s\n\t%s", rel, i+1, leak.why, strings.TrimSpace(line))
					}
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
