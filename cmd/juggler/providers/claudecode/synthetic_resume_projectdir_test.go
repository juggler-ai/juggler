//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"strings"
	"testing"
)

// TestProjectDirNameFromWorkingDir pins the encoding to the claude CLI's own
// `gw` function. The expected values are produced by running the CLI's exact
// JS encoder (verified against claude-code 2.1.160); see the cases below.
func TestProjectDirNameFromWorkingDir(t *testing.T) {
	longPath := "/a/" + strings.Repeat("b", 250) + "/c"
	// Encoded form is 255 chars (> 200), so it is truncated to 200 and the
	// base-36 hash of the ORIGINAL path is appended.
	longExpected := "-a-" + strings.Repeat("b", 197) + "-17lws1"

	cases := []struct {
		name string
		in   string
		want string
	}{
		{"unix simple", "/Users/jules/code/juggler", "-Users-jules-code-juggler"},
		{"dot and underscore", "/Users/jules/code/my_project.v2", "-Users-jules-code-my-project-v2"},
		{"windows path", `C:\Users\jules\project`, "C--Users-jules-project"},
		{"space and dot", "/tmp/foo bar.baz", "-tmp-foo-bar-baz"},
		{"empty", "", ""},
		{"over 200 chars hashed", longPath, longExpected},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ProjectDirName(tc.in); got != tc.want {
				t.Fatalf("ProjectDirName(%q)\n got = %q\nwant = %q", tc.in, got, tc.want)
			}
		})
	}

	// The long case must respect the 200-char cap before the hash suffix.
	if got := ProjectDirName(longPath); len(got) != 200+1+len("17lws1") {
		t.Fatalf("long encoded length = %d, want %d", len(got), 200+1+len("17lws1"))
	}
}
