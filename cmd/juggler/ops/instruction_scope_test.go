//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"os"
	"path/filepath"
	"testing"
)

// TestResolveAdmitsGlobalInstructionFilesOnly pins the one widening of the read
// scope that no grant asked for: a conversation may read the user's global
// AGENTS.md (and its listed siblings) in the two global instruction folders,
// and nothing else there. <ConfigDir> also holds credentials.json, so a
// widening by folder rather than by exact name would hand the model the keys.
func TestResolveAdmitsGlobalInstructionFilesOnly(t *testing.T) {
	base := t.TempDir()
	t.Setenv("JUGGLER_SKILLS_USER_DIR", base)
	juggler := filepath.Join(base, "juggler")
	agents := filepath.Join(base, "agents")
	for _, dir := range []string{juggler, agents, filepath.Join(juggler, "skills")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path string) string {
		t.Helper()
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}

	admitted := []string{
		write(filepath.Join(juggler, "AGENTS.md")),
		write(filepath.Join(juggler, "AGENTS.local.md")),
		write(filepath.Join(agents, "AGENTS.md")),
		write(filepath.Join(agents, "CLAUDE.local.md")),
	}
	refused := []string{
		write(filepath.Join(juggler, "credentials.json")),
		write(filepath.Join(juggler, "skills", "AGENTS.md")),
		write(filepath.Join(base, "AGENTS.md")),
		filepath.Join(juggler, "..", "AGENTS.md"),
	}

	scope := NewPathScope(t.TempDir(), nil)
	for _, path := range admitted {
		if _, err := scope.Resolve(path); err != nil {
			t.Errorf("Resolve(%s) refused a global instruction file: %v", path, err)
		}
	}
	for _, path := range refused {
		if _, err := scope.Resolve(path); err == nil {
			t.Errorf("Resolve(%s) admitted a path outside the project that is not a global instruction file", path)
		}
	}
}
