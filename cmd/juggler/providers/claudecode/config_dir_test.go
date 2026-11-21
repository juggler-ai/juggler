//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// TestProjectsDirFollowsClaudeConfigDir pins where the resume paths look for the
// CLI's session files. The CLI keeps them in <config dir>/projects, its config
// dir being $CLAUDE_CONFIG_DIR when set — joined and cleaned, and resolved
// against its own working directory when relative, which for a spawn is the
// conversation's. A resume that looks under ~/.claude/projects for a CLI that
// writes elsewhere fails silently: the synthetic session lands where the CLI
// never reads it, and the warm append finds no file and cold-starts.
func TestProjectsDirFollowsClaudeConfigDir(t *testing.T) {
	userpathstest.Isolate(t)
	home := os.Getenv("HOME")
	workingDir := filepath.Join(t.TempDir(), "proj")
	form := ProjectDirName(workingDir)
	custom := t.TempDir()

	cases := []struct {
		name, env, want string
	}{
		{"unset", "", filepath.Join(home, ".claude", "projects", form)},
		{"absolute", custom, filepath.Join(custom, "projects", form)},
		{"trailing separator", custom + string(filepath.Separator), filepath.Join(custom, "projects", form)},
		{"dot-dot", filepath.Join(custom, "x") + string(filepath.Separator) + "..", filepath.Join(custom, "projects", form)},
		{"relative", "rel-cfg", filepath.Join(workingDir, "rel-cfg", "projects", form)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CLAUDE_CONFIG_DIR", tc.env)
			if got := projectsDir(workingDir, ""); got != tc.want {
				t.Fatalf("projectsDir = %q; want %q", got, tc.want)
			}
			c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: "u1"}}
			if got, want := c.warmSessionPath(), filepath.Join(tc.want, "u1.jsonl"); got != want {
				t.Fatalf("warmSessionPath = %q; want %q", got, want)
			}
			// An extra account's CLI is given its own config dir, whatever
			// Juggler inherited.
			work := &Client{workingDir: workingDir, acct: account{name: "claudecode-work", configDir: custom},
				activeSession: &activeSession{sessionUUID: "u1"}}
			if got, want := work.warmSessionPath(), filepath.Join(custom, "projects", form, "u1.jsonl"); got != want {
				t.Fatalf("an extra account's warmSessionPath = %q; want %q", got, want)
			}
		})
	}
}
